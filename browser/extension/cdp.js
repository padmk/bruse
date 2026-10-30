// Chrome DevTools Protocol sessions over chrome.debugger. A tab stays attached while in use and is
// detached after a quiet period, which also removes the browser's "started debugging" bar. The module
// also tracks per-tab state that CDP only reports as events (open JavaScript dialogs, console output,
// network requests, out-of-process frames) and when the agent last pressed a button or key in a tab.

import { PAUSED_ERROR, isPaused, onPausedChange, setPaused } from "./pause.js";
import { PASSWORD_MANAGER_ELEMENTS, isPressInput, unresponsivePageError } from "./shared.js";

const PROTOCOL_VERSION = "1.3";
const IDLE_DETACH_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
// A page that does not take input within this time is stuck; waiting longer only blocks the agent.
const INPUT_TIMEOUT_MS = 5_000;
const MAX_CONSOLE_ENTRIES = 500;
const MAX_REQUESTS = 300;
// Commands that still work while a JavaScript dialog blocks the page.
const DIALOG_SAFE_METHODS = new Set(["Page.handleJavaScriptDialog", "Page.captureScreenshot", "Page.getLayoutMetrics", "Fetch.continueResponse", "Fetch.disable"]);

const sessions = new Map(); // tabId -> { lastUsed, dialog, console, requests, inflight (request id -> { session, frameId, url }), frames }
const eventListeners = new Set();
// Child session id -> frame id of cross-origin frames, kept after the sessions end: the next attach gives
// the frames new sessions, and a command for an earlier one goes to the frame's new session.
const frameOfSession = new Map();
const MAX_REMEMBERED_FRAME_SESSIONS = 1_000;

// Returns a function that removes the listener.
export function onCdpEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

// The user's "Cancel" on the browser's debugging bar detaches every tab; it pauses agents until resumed.
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  sessions.delete(tabId);
  if (reason === "canceled_by_user") setPaused(true);
});

onPausedChange((paused) => {
  if (paused) for (const tabId of [...sessions.keys()]) detach(tabId);
});

// Child frames in other processes (cross-origin iframes) are separate targets with their own session.
function enableChildSession(tabId, sessionId) {
  for (const [method, params] of [
    ["Page.enable", {}],
    ["Runtime.enable", {}],
    ["Network.enable", {}],
    ["DOM.enable", {}],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
  ]) {
    rawSend(tabId, method, params, sessionId).catch(() => {});
  }
}

chrome.debugger.onEvent.addListener(({ tabId, sessionId: source }, method, params) => {
  const session = sessions.get(tabId);
  if (!session) return;
  const contextKey = (id) => `${source ?? "main"}:${id}`;
  if (method === "Target.attachedToTarget") {
    if (params.targetInfo.type === "iframe") {
      session.frames.set(params.targetInfo.targetId, { sessionId: params.sessionId, url: params.targetInfo.url, parentSessionId: source ?? null });
      frameOfSession.set(params.sessionId, params.targetInfo.targetId);
      tabOfFrameSession.set(params.sessionId, tabId);
      if (frameOfSession.size > MAX_REMEMBERED_FRAME_SESSIONS) frameOfSession.delete(frameOfSession.keys().next().value);
      enableChildSession(tabId, params.sessionId);
    } else if (params.targetInfo.type === "worker") {
      // A dedicated worker's script request starts in the page's session and reports no end there.
      // Request URLs come without the fragment, the target's URL keeps it.
      const scriptUrl = params.targetInfo.url.split("#")[0];
      dropRequests(session, (r) => r.url === scriptUrl);
    }
  } else if (method === "Target.detachedFromTarget") {
    for (const [frameId, frame] of session.frames) if (frame.sessionId === params.sessionId) session.frames.delete(frameId);
    for (const key of session.pageContexts) if (key.startsWith(`${params.sessionId}:`)) session.pageContexts.delete(key);
    // Requests of a frame that went away report no end. A cross-origin frame's target ID is its frame ID.
    dropRequests(session, (r) => r.session === params.sessionId || r.frameId === params.targetId);
  } else if (method === "Page.frameDetached") {
    // A frame that moves to another process ("swap") keeps loading there.
    if (params.reason !== "swap") dropRequests(session, (r) => r.frameId === params.frameId);
  } else if (method === "Page.javascriptDialogOpening") {
    session.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, url: params.url };
    for (const resolve of session.dialogWaiters.splice(0)) resolve();
  } else if (method === "Page.javascriptDialogClosed") {
    session.dialog = null;
  } else if (method === "Runtime.executionContextCreated") {
    // Only the page's own contexts count; extensions' content scripts run and log in isolated ones.
    if (params.context.auxData?.isDefault) {
      session.pageContexts.add(contextKey(params.context.id));
      if (params.context.uniqueId) session.pageContexts.add(contextKey(params.context.uniqueId));
    }
  } else if (method === "Runtime.executionContextDestroyed") {
    // A later context (such as a content script's world) may get the same ID.
    session.pageContexts.delete(contextKey(params.executionContextId));
    session.pageContexts.delete(contextKey(params.executionContextUniqueId));
  } else if (method === "Runtime.executionContextsCleared") {
    for (const key of session.pageContexts) if (key.startsWith(`${source ?? "main"}:`)) session.pageContexts.delete(key);
  } else if (method === "Runtime.consoleAPICalled") {
    if (!session.pageContexts.has(contextKey(params.executionContextId))) return;
    const message = params.args.map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "").join(" ");
    pushConsole(session, params.type === "warning" ? "warn" : params.type, message, params.stackTrace?.callFrames?.[0]?.url);
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    if (details.executionContextId && !session.pageContexts.has(contextKey(details.executionContextId))) return;
    pushConsole(session, "error", details.exception?.description ?? details.text, details.url);
  } else if (method === "Network.requestWillBeSent") {
    // Keyed by request ID alone: a frame's document request can start in the parent's session and
    // finish in the session of the frame's new process.
    session.inflight.set(params.requestId, { session: source ?? null, frameId: params.frameId, url: params.request.url });
    session.networkActivityAt = Date.now();
    session.requests.push({ id: params.requestId, method: params.request.method, url: params.request.url, type: params.type, timestamp: new Date().toISOString() });
    if (session.requests.length > MAX_REQUESTS) session.requests.shift();
  } else if (method === "Network.responseReceived") {
    const request = session.requests.findLast((r) => r.id === params.requestId);
    if (request) request.status = params.response.status;
  } else if (method === "Network.loadingFinished") {
    session.inflight.delete(params.requestId);
    session.networkActivityAt = Date.now();
  } else if (method === "Network.loadingFailed") {
    session.inflight.delete(params.requestId);
    session.networkActivityAt = Date.now();
    const request = session.requests.findLast((r) => r.id === params.requestId);
    if (request) request.error = params.errorText;
  } else if (method === "Log.entryAdded") {
    pushConsole(session, params.entry.level === "verbose" ? "debug" : params.entry.level, params.entry.text, params.entry.url);
  }
  for (const listener of eventListeners) listener(tabId, method, params, source);
});

// Dropping requests counts as network activity, so the quiet period starts over.
function dropRequests(session, matches) {
  for (const [requestId, request] of session.inflight) {
    if (!matches(request)) continue;
    session.inflight.delete(requestId);
    session.networkActivityAt = Date.now();
  }
}

function pushConsole(session, level, message, url) {
  session.console.push({ level, message, url, timestamp: new Date().toISOString() });
  if (session.console.length > MAX_CONSOLE_ENTRIES) session.console.shift();
}

chrome.alarms.create("cdp-idle-detach", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== "cdp-idle-detach") return;
  const now = Date.now();
  for (const [tabId, session] of sessions) {
    if (now - session.lastUsed > IDLE_DETACH_MS && !session.dialog) await detach(tabId);
  }
});

function rawSend(tabId, method, params = {}, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const limit = timeoutMs ?? (method.startsWith("Input.") ? INPUT_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
    const timer = setTimeout(
      () => reject(new Error(limit < COMMAND_TIMEOUT_MS ? unresponsivePageError(method, limit / 1000) : `${method} timed out`)),
      limit,
    );
    const target = sessionId ? { tabId, sessionId } : { tabId };
    chrome.debugger.sendCommand(target, method, params, (result) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(result);
    });
  });
}

const attaching = new Map(); // tabId -> Promise<session> while the first attach is in flight

// Concurrent commands for a tab share one attach.
// The tab each frame session was attached in.
const tabOfFrameSession = new Map(); // frame session id -> tab id
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, owner] of tabOfFrameSession) if (owner === tabId) tabOfFrameSession.delete(sessionId);
});

// The tabs the debugger is attached to.
export function attachedTabIds() {
  return [...sessions.keys()];
}

// Whether the agent session behind a command may use the tab now, or, for the extension's own work,
// whether any session may (see access.js); the service worker sets it. Every command names its caller:
// { session } for an agent's request, or EXTENSION_WORK (download interception); a missing caller is a
// programming error, not a fallback. It is
// asked before the debugger attaches, again once an attach completes, before every command and before
// each recovery step that changes the page, so a share the user stops or an access setting the user
// changes while a command, an attach or a recovery is in flight ends it instead of letting it reach the
// tab.
let mayDebug = async () => true;

export const EXTENSION_WORK = Object.freeze({ extension: true });
const NO_ACCESS = "No agent session may use this tab now (the user stopped sharing it or changed the access setting)";

export function setDebugGate(gate) {
  mayDebug = gate;
}

async function requireDebugAccess(tabId, caller) {
  if (caller !== EXTENSION_WORK && !(caller && "session" in caller)) throw new Error("A debugger command was sent without its caller");
  if (!(await mayDebug(tabId, caller))) throw new Error(NO_ACCESS);
}

function attach(tabId) {
  const existing = sessions.get(tabId);
  if (existing) {
    existing.lastUsed = Date.now();
    return Promise.resolve(existing);
  }
  if (!attaching.has(tabId)) attaching.set(tabId, attachNow(tabId).finally(() => attaching.delete(tabId)));
  return attaching.get(tabId);
}

async function attachNow(tabId) {
  if (await isPaused()) throw new Error(PAUSED_ERROR);
  // An attach is shared by concurrent callers, so it asks whether any session may use the tab; each
  // caller's own access is checked once it completes (withDebuggerAccess).
  await requireDebugAccess(tabId, EXTENSION_WORK);
  let reattached = false;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    // The service worker may have restarted while this extension's session stayed attached.
    if (!/already attached/i.test(error.message)) throw error;
    reattached = true;
  }
  const session = { lastUsed: Date.now(), dialog: null, console: [], dialogWaiters: [], pageContexts: new Set(), frames: new Map(), requests: [], inflight: new Map(), attachedAt: Date.now(), networkActivityAt: null };
  sessions.set(tabId, session);
  // A pause that came while the attach was in flight found no session to detach; one that comes from
  // now on finds this one.
  if (await isPaused()) {
    await detach(tabId);
    throw new Error(PAUSED_ERROR);
  }
  if (!(await mayDebug(tabId, EXTENSION_WORK))) {
    await detach(tabId);
    throw new Error(NO_ACCESS);
  }
  // After a service worker restart the session is still attached but its state is gone. Turning
  // auto-attach and Runtime off first makes the browser report frames and execution contexts again.
  if (reattached) {
    await rawSend(tabId, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    await rawSend(tabId, "Runtime.disable").catch(() => {});
  }
  await rawSend(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  // Background tabs are throttled and may skip rendering; keep them live for input and screenshots.
  await Promise.all([
    rawSend(tabId, "Page.enable"),
    rawSend(tabId, "Runtime.enable"),
    rawSend(tabId, "Log.enable"),
    rawSend(tabId, "Network.enable"),
    rawSend(tabId, "DOM.enable"),
    rawSend(tabId, "Accessibility.enable"),
    rawSend(tabId, "Page.setWebLifecycleState", { state: "active" }),
    rawSend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }),
  ]).catch(() => {});
  return session;
}

export async function detach(tabId) {
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

// Removes frames that other extensions injected into the page (for example password manager menus).
// The browser refuses debugger access to a tab while such a frame is present; this runs only after it
// did, and removes no more than those frames and known password manager wrappers that hold frames. Each
// frame of the page is scripted on its own, so one that cannot be scripted does not stop the others.
// Returns { removed, remaining, errors }: the elements removed, how many other extensions' frames the
// page still holds a moment later, and why frames could not be scripted.
async function removeForeignExtensionFrames(tabId) {
  // The browser lists the page's own frames only, which are the ones that can hold such a frame.
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [{ frameId: 0, url: "" }];
  const report = { removed: 0, remaining: 0, errors: [] };
  await Promise.all(
    frames
      .filter((frame) => !frame.url.startsWith("chrome-extension://"))
      .map(async ({ frameId }) => {
        try {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            func: removeFramesInDocument,
            args: [`chrome-extension://${chrome.runtime.id}/`, PASSWORD_MANAGER_ELEMENTS, FOREIGN_FRAME_SETTLE_MS],
          });
          report.removed += injection?.result?.removed ?? 0;
          report.remaining += injection?.result?.remaining ?? 0;
        } catch (error) {
          report.errors.push(error.message);
        }
      }),
  );
  return report;
}

// Runs as a content script in one frame of the page. Returns { removed, remaining }: the elements it
// removed, and the other extensions' frames found after `settleMs` (a wrapper may put its frame back).
async function removeFramesInDocument(ownOrigin, passwordManagerElements, settleMs) {
  const wrapper = new RegExp(passwordManagerElements, "i");
  const shadowOf = (el) => chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
  const isForeignFrame = (el) => el.tagName === "IFRAME" && el.src.startsWith("chrome-extension://") && !el.src.startsWith(ownOrigin);
  // Every element of the document and of the shadow roots below it, open or closed.
  const allElements = (root) => {
    const elements = [];
    const roots = [root];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        elements.push(el);
        if (shadowOf(el)) roots.push(shadowOf(el));
      }
    }
    return elements;
  };
  const holdsFrame = (el) => [...allElements(el), ...(shadowOf(el) ? allElements(shadowOf(el)) : [])].some((child) => child.tagName === "IFRAME");
  const doomed = new Set();
  for (const el of allElements(document)) {
    // A known password manager's wrapper, also inside the page's shadow roots, goes as a whole when it
    // holds a frame (whatever that frame's URL looks like from here): it would put the frame back.
    if (/^com-1password-(button|menu)$/.test(el.localName) || (wrapper.test(el.localName) && holdsFrame(el))) doomed.add(el);
    else if (isForeignFrame(el)) {
      // Otherwise only the frame goes, or the known password manager wrapper whose shadow root holds it.
      const host = el.getRootNode().host;
      doomed.add(host && wrapper.test(host.localName) ? host : el);
    }
  }
  // Without focus the password manager does not bring its menu back right away.
  if (doomed.size && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  for (const el of doomed) el.remove();
  if (!doomed.size) return { removed: 0, remaining: 0 };
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return { removed: doomed.size, remaining: allElements(document).filter(isForeignFrame).length };
}

const FOREIGN_FRAME_ERROR = /chrome-extension:\/\/ URL of different extension/;
// The browser detached the debugger before the command was sent, for example because such a frame appeared.
const NOT_ATTACHED_ERROR = /Debugger is not attached to the tab/;
// Attempts at restoring debugger access after the first failure, and how long after a removal the page
// is checked for frames that came back.
const FOREIGN_FRAME_RETRIES = 3;
const FOREIGN_FRAME_SETTLE_MS = 200;
// How long a command for a frame waits for the frame's new session after the debugger attached anew.
const FRAME_SESSION_WAIT_MS = 2_000;

// Attaches to the tab when needed and runs `task(session)`. When another extension's frame blocks
// debugger access, the frames are removed, the debugger attaches anew and the task runs again, a bounded
// number of times; the final error says what removal did. The block shows as an error of the attach or
// of a command, or as a command that found the debugger detached by the browser (it was not run); such a
// command is sent again once, and then counts as blocked if removal finds such frames in the page.
async function withDebuggerAccess(tabId, task, caller) {
  const removals = [];
  let resent = false;
  for (;;) {
    let session;
    await requireDebugAccess(tabId, caller);
    try {
      session = await attach(tabId);
      // The attach may be shared with other callers and outlast the caller's access.
      await requireDebugAccess(tabId, caller);
      return await task(session);
    } catch (error) {
      const detached = Boolean(session) && NOT_ATTACHED_ERROR.test(error.message);
      if (!detached && !FOREIGN_FRAME_ERROR.test(error.message)) throw error;
      if (detached && sessions.get(tabId) === session) await detach(tabId);
      if (detached && !resent) {
        resent = true;
        continue;
      }
      if (removals.length >= FOREIGN_FRAME_RETRIES) throw new Error(foreignFrameFailure(error.message, removals));
      // Removing frames changes the page, so the caller's access is checked again after the failed attempt.
      await requireDebugAccess(tabId, caller);
      const removal = await removeForeignExtensionFrames(tabId);
      if (detached && !removal.removed) throw error;
      removals.push(removal);
      await detach(tabId);
    }
  }
}

function foreignFrameFailure(message, removals) {
  const removed = removals.reduce((sum, removal) => sum + removal.removed, 0);
  const remaining = removals.at(-1)?.remaining ?? 0;
  const errors = [...new Set(removals.flatMap((removal) => removal.errors))];
  const details = [`${removed} elements removed`, `${remaining} of another extension's frames back in the page afterwards`];
  if (errors.length) details.push(`removal failed: ${errors.join("; ")}`);
  return (
    `${message}. Another extension's frame in the page (such as a password manager's menu) blocks debugger access to this tab, ` +
    `and removing such frames did not restore it after ${removals.length} attempts (${details.join("; ")}). ` +
    "Close that extension's menu or turn the extension off for this site, then retry."
  );
}

// A frame's session from an earlier attach ended with it: the command goes to the frame's new session,
// which the browser reports shortly after attaching.
async function currentFrameSession(tabId, session, sessionId) {
  if (!sessionId || [...session.frames.values()].some((frame) => frame.sessionId === sessionId)) return sessionId;
  const frameId = frameOfSession.get(sessionId);
  if (frameId === undefined) return sessionId;
  const deadline = Date.now() + FRAME_SESSION_WAIT_MS;
  for (;;) {
    const frame = session.frames.get(frameId);
    if (frame) return frame.sessionId;
    if (Date.now() > deadline || sessions.get(tabId) !== session) {
      throw new Error("The frame's debugger session ended when the debugger attached to the tab again, and the frame has no new session; call getAXState() again");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const FILE_CHOOSER_INTERCEPT_MS = 60_000;
const interceptTimers = new Map(); // tab id -> timer that switches file chooser interception off

const agentInputAt = new Map(); // tab id -> when the agent last pressed a button or key in it

// Milliseconds since the agent last pressed a mouse button or key in the tab (Infinity if never).
export function sinceAgentInput(tabId) {
  return agentInputAt.has(tabId) ? Date.now() - agentInputAt.get(tabId) : Infinity;
}

chrome.tabs.onRemoved.addListener((tabId) => agentInputAt.delete(tabId));

// Runs a CDP command on a tab, attaching first when needed. When another extension's frame blocks
// debugger access, the frame is removed and the command retried (see withDebuggerAccess). `timeoutMs`
// shortens the wait for commands that should be quick, so a stuck page fails them early.
export async function cdp(tabId, method, params, sessionId, timeoutMs, caller) {
  // A frame session is used only with the tab it was attached in, so access to one tab never reaches
  // another. (After the debugger attached anew, currentFrameSession maps an old session to the frame's new one.)
  if (sessionId && tabOfFrameSession.get(sessionId) !== tabId) {
    throw new Error("This frame does not belong to the tab; call getAXState() again");
  }
  if (isPressInput(method, params)) agentInputAt.set(tabId, Date.now());
  // File chooser interception that nobody switches off (the agent's code was stopped) would leave the
  // tab's file inputs dead; it ends on its own after a while.
  if (method === "Page.setInterceptFileChooserDialog" && !sessionId) {
    clearTimeout(interceptTimers.get(tabId));
    interceptTimers.delete(tabId);
    if (params?.enabled) {
      interceptTimers.set(tabId, setTimeout(() => {
        interceptTimers.delete(tabId);
        rawSend(tabId, method, { enabled: false }).catch(() => {});
      }, FILE_CHOOSER_INTERCEPT_MS));
    }
  }
  return withDebuggerAccess(tabId, async (session) => sendChecked(tabId, session, method, params, await currentFrameSession(tabId, session, sessionId), timeoutMs, caller), caller);
}

// Parameters by which commands pick the JavaScript context they run in.
const CONTEXT_PARAMS = ["contextId", "uniqueContextId", "executionContextId"];
// A remote object handle is "<isolate>.<context id>.<object id>"; the context is the one the object lives in.
const OBJECT_HANDLE = /^-?\d+\.(-?\d+)\.-?\d+$/;

// The remote object handles in a command's parameters at any depth: `objectId` and keys such as
// `prototypeObjectId`, including those inside arrays (Runtime.callFunctionOn's `arguments`).
function* objectHandles(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "objectId" || key.endsWith("ObjectId")) yield item;
    else yield* objectHandles(item);
  }
}

// Raw commands run JavaScript and use objects only in the page's own (default) contexts of the target
// they go to, never in an isolated world where this or another extension's content script runs with
// extension APIs. The contexts are known from Runtime events, so commands that stop them are refused.
function requirePageContext(session, method, params = {}, sessionId) {
  if (method === "Runtime.disable") {
    throw new Error("Agents may not send Runtime.disable: the page's own contexts are told from isolated worlds by Runtime events");
  }
  if (!params || typeof params !== "object") return;
  if (method === "Runtime.addBinding" && params.executionContextId === undefined && params.executionContextName === undefined) {
    throw new Error("Runtime.addBinding needs the executionContextId of one of the page's own contexts; without it the binding reaches isolated worlds such as extensions' content scripts too");
  }
  const contexts = CONTEXT_PARAMS.filter((key) => params[key] !== undefined).map((key) => params[key]);
  for (const handle of objectHandles(params)) contexts.push(typeof handle === "string" ? OBJECT_HANDLE.exec(handle)?.[1] : undefined);
  if (params.executionContextName === undefined && contexts.every((id) => id !== undefined && session.pageContexts.has(`${sessionId ?? "main"}:${id}`))) return;
  throw new Error(
    "Agents may run JavaScript only in the page's own contexts, not in isolated worlds such as extensions' content scripts, " +
      "and use only objects from those contexts; leave out the context parameter to use the page's main context",
  );
}

async function sendChecked(tabId, session, method, params, sessionId, timeoutMs, caller) {
  await requireDebugAccess(tabId, caller);
  // The session may have been detached while access was checked; withDebuggerAccess then attaches anew,
  // which asks the gate again.
  if (sessions.get(tabId) !== session) throw new Error("Debugger is not attached to the tab");
  requirePageContext(session, method, params, sessionId);
  if (session.dialog && !DIALOG_SAFE_METHODS.has(method) && !method.startsWith("Input.")) {
    throw new Error(`A JavaScript ${session.dialog.type} dialog is open on this tab ("${session.dialog.message}"); handle it with getJsDialog() first`);
  }
  const isInput = method.startsWith("Input.");
  // While a dialog is open the page handles no input; further events of the same action are skipped.
  if (isInput && session.dialog) return {};
  if (DIALOG_SAFE_METHODS.has(method)) return rawSend(tabId, method, params, sessionId, timeoutMs);
  // A command that makes the page open a modal dialog does not complete until the dialog closes. Input
  // finishes when the dialog opens; other commands fail with a pointer to getJsDialog().
  let waiter;
  const dialogOpened = new Promise((resolve) => session.dialogWaiters.push((waiter = resolve)));
  try {
    return await Promise.race([
      rawSend(tabId, method, params, sessionId, timeoutMs),
      dialogOpened.then(() => {
        if (isInput) return {};
        throw new Error(`A JavaScript ${session.dialog?.type ?? ""} dialog opened while ${method} was running; handle it with getJsDialog()`);
      }),
    ]);
  } finally {
    session.dialogWaiters = session.dialogWaiters.filter((w) => w !== waiter);
  }
}

export function tabState(tabId, caller) {
  return withDebuggerAccess(tabId, async (session) => {
    const frames = [...session.frames].map(([frameId, frame]) => ({ frameId, ...frame }));
    const quietMs = session.inflight.size ? 0 : Date.now() - (session.networkActivityAt ?? session.attachedAt);
    return { dialog: session.dialog, frames, inflightRequests: session.inflight.size, networkQuietMs: quietMs };
  }, caller);
}

export function consoleLogs(tabId) {
  return sessions.get(tabId)?.console ?? [];
}

export function networkRequests(tabId) {
  return (sessions.get(tabId)?.requests ?? []).map(({ id, ...request }) => request);
}
