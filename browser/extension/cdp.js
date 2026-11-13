// Chrome DevTools Protocol sessions over chrome.debugger. A tab stays attached while in use and is
// detached after a quiet period, which also removes the browser's "started debugging" bar. The module
// also tracks per-tab state that CDP only reports as events (open JavaScript dialogs, console output,
// network requests, out-of-process frames) and when the agent last pressed a button or key in a tab.

import { PAUSED_ERROR, isPaused, onPausedChange, setPaused } from "./pause.js";
import { LOAD_PAGE_HINT, PASSWORD_MANAGER_ELEMENTS, ignore, isPressInput, logFailure, unresponsivePageError } from "./shared.js";

/** @typedef {import("./shared.js").PageDialog} PageDialog */
/** @typedef {import("./shared.js").FrameInfo} FrameInfo */
/** @typedef {import("./shared.js").PageState} PageState */
/** @typedef {import("./shared.js").ConsoleEntry} ConsoleEntry */
/** @typedef {import("./shared.js").NetworkEntry} NetworkEntry */
/** @typedef {import("devtools-protocol/types/protocol-mapping.js").ProtocolMapping.Events} CdpEvents */
/** @typedef {import("./shared.js").CdpCommands} CdpCommands */
/** @typedef {Record<string, unknown>} CommandParams */

const PROTOCOL_VERSION = "1.3";
const IDLE_DETACH_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
// A page that does not take input within this time is stuck; waiting longer only blocks the agent.
const INPUT_TIMEOUT_MS = 5_000;
const MAX_CONSOLE_ENTRIES = 500;
const MAX_REQUESTS = 300;
// Commands that still work while a JavaScript dialog blocks the page. Reading the page's size and
// capturing it are not among them: behind a dialog they get no reply.
const DIALOG_SAFE_METHODS = new Set(["Page.handleJavaScriptDialog", "Fetch.continueResponse", "Fetch.disable"]);

// A tab without a page answers no command; each would wait for its timeout. That is a tab whose renderer
// crashed, or one the browser has not loaded since it started; the browser reports both as unloaded. (A
// tab it discarded to free memory is reported apart, see the service worker.)
const NO_PAGE = `This tab has no loaded page: it crashed, or the browser has not loaded it yet. ${LOAD_PAGE_HINT}`;

/** @param {number} tabId */
export async function hasNoPage(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab?.status === "unloaded" && !tab.discarded;
}

/**
 * A request that has not finished: the child session it started in (null for the tab's own target), its
 * frame and URL.
 * @typedef {{ session: string | null, frameId: string | undefined, url: string }} InflightRequest
 */
/** @typedef {NetworkEntry & { id: string }} RequestEntry */
/**
 * The debugger session of an attached tab and the page state CDP reported as events.
 * @typedef {object} DebuggerSession
 * @property {number} lastUsed
 * @property {PageDialog | null} dialog
 * @property {ConsoleEntry[]} console
 * @property {(() => void)[]} dialogWaiters Called when a JavaScript dialog opens.
 * @property {(() => void)[]} crashWaiters Called when the tab's renderer crashes.
 * @property {Map<string, unknown>} objectGroups "<session>:<context unique ID>:<object handle>" -> the
 *   object group a command named for it, as the command gave it
 * @property {Map<string, string>} pageContexts "<session>:<context ID or unique ID>" -> unique ID of a page's own context
 * @property {Map<string, Omit<FrameInfo, "frameId">>} frames Cross-origin frames by frame ID
 * @property {RequestEntry[]} requests
 * @property {Map<string, InflightRequest>} inflight By request ID
 * @property {number} attachedAt
 * @property {number | null} networkActivityAt
 */
/**
 * A CDP event as listeners get it: the tab, the event's name and parameters, and the child session it
 * came from (undefined for the tab's own target).
 * @typedef {{ [M in keyof CdpEvents]: [tabId: number, method: M, params: CdpEvents[M] extends [infer P] ? P : undefined, source: string | undefined] }[keyof CdpEvents]} CdpEvent
 */
/** @typedef {(...event: CdpEvent) => void} CdpEventListener */

/** @type {Map<number, DebuggerSession>} */
const sessions = new Map();
/** @type {Set<CdpEventListener>} */
const eventListeners = new Set();
// Child session id -> frame id of cross-origin frames, kept after the sessions end: the next attach gives
// the frames new sessions, and a command for an earlier one goes to the frame's new session.
/** @type {Map<string, string>} */
const frameOfSession = new Map();
const MAX_REMEMBERED_FRAME_SESSIONS = 1_000;

// Returns a function that removes the listener.
/**
 * @param {CdpEventListener} listener
 * @returns {() => void}
 */
export function onCdpEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

// The user's "Cancel" on the browser's debugging bar detaches every tab; it pauses agents until resumed.
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (tabId !== undefined) sessions.delete(tabId);
  if (reason === "canceled_by_user") setPaused(true).catch(logFailure("Pausing agents after the user canceled debugging"));
});

onPausedChange((paused) => {
  if (paused) for (const tabId of [...sessions.keys()]) detach(tabId).catch(ignore("detach catches its own failures"));
});

// Child frames in other processes (cross-origin iframes) are separate targets with their own session.
/** @param {number} tabId @param {string} sessionId */
function enableChildSession(tabId, sessionId) {
  /** @type {[string, CommandParams][]} */
  const commands = [
    ["Page.enable", {}],
    ["Runtime.enable", {}],
    ["Network.enable", {}],
    ["DOM.enable", {}],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
  ];
  for (const [method, params] of commands) {
    rawSend(tabId, method, params, sessionId).catch(ignore("a frame that cannot be enabled is gone or reports less; its commands fail on their own"));
  }
}

chrome.debugger.onEvent.addListener(({ tabId, sessionId: source }, name, data) => {
  // Events of targets other than tabs come without a tab ID; this module attaches to tabs only.
  if (tabId === undefined) return;
  const session = sessions.get(tabId);
  if (!session) return;
  // The browser sends each event with the parameters the protocol defines for its name.
  const event = /** @type {CdpEvent} */ ([tabId, name, data, source]);
  const [, method, params] = event;
  /** @param {string | number} id */
  const contextKey = (id) => `${source ?? "main"}:${id}`;
  if (method === "Target.attachedToTarget") {
    if (params.targetInfo.type === "iframe") {
      session.frames.set(params.targetInfo.targetId, { sessionId: params.sessionId, url: params.targetInfo.url, parentSessionId: source ?? null });
      frameOfSession.set(params.sessionId, params.targetInfo.targetId);
      tabOfFrameSession.set(params.sessionId, tabId);
      const oldest = frameOfSession.keys().next();
      if (frameOfSession.size > MAX_REMEMBERED_FRAME_SESSIONS && !oldest.done) frameOfSession.delete(oldest.value);
      enableChildSession(tabId, params.sessionId);
    } else if (params.targetInfo.type === "worker") {
      // A dedicated worker's script request starts in the page's session and reports no end there.
      // Request URLs come without the fragment, the target's URL keeps it.
      const scriptUrl = params.targetInfo.url.split("#")[0];
      dropRequests(session, (r) => r.url === scriptUrl);
    }
  } else if (method === "Target.detachedFromTarget") {
    for (const key of session.objectGroups.keys()) if (key.startsWith(`${params.sessionId}:`)) session.objectGroups.delete(key);
    for (const [frameId, frame] of session.frames) if (frame.sessionId === params.sessionId) session.frames.delete(frameId);
    for (const key of session.pageContexts.keys()) if (key.startsWith(`${params.sessionId}:`)) session.pageContexts.delete(key);
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
  } else if (method === "Inspector.targetCrashed" && !source) {
    // The tab's renderer is gone: commands in flight end now, and the session, whose state described the
    // lost page, ends with it. The next command attaches anew once the tab has a page again.
    for (const fail of session.crashWaiters.splice(0)) fail();
    detach(tabId).catch(ignore("detach catches its own failures"));
  } else if (method === "Runtime.executionContextCreated") {
    // Only the page's own contexts count; extensions' content scripts run and log in isolated ones.
    // Both the numeric ID and the unique ID map to the unique ID, by which commands are sent.
    if (params.context.auxData?.isDefault) {
      session.pageContexts.set(contextKey(params.context.id), params.context.uniqueId);
      if (params.context.uniqueId) session.pageContexts.set(contextKey(params.context.uniqueId), params.context.uniqueId);
    }
  } else if (method === "Runtime.executionContextDestroyed") {
    // A later context (such as a content script's world) may get the same ID.
    const unique = session.pageContexts.get(contextKey(params.executionContextId)) ?? params.executionContextUniqueId;
    for (const key of session.objectGroups.keys()) if (key.startsWith(`${source ?? "main"}:${unique}:`)) session.objectGroups.delete(key);
    session.pageContexts.delete(contextKey(params.executionContextId));
    session.pageContexts.delete(contextKey(params.executionContextUniqueId));
  } else if (method === "Runtime.executionContextsCleared") {
    for (const key of session.objectGroups.keys()) if (key.startsWith(`${source ?? "main"}:`)) session.objectGroups.delete(key);
    for (const key of session.pageContexts.keys()) if (key.startsWith(`${source ?? "main"}:`)) session.pageContexts.delete(key);
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
  for (const listener of eventListeners) listener(...event);
});

// Dropping requests counts as network activity, so the quiet period starts over.
/** @param {DebuggerSession} session @param {(request: InflightRequest) => boolean} matches */
function dropRequests(session, matches) {
  for (const [requestId, request] of session.inflight) {
    if (!matches(request)) continue;
    session.inflight.delete(requestId);
    session.networkActivityAt = Date.now();
  }
}

/** @param {DebuggerSession} session @param {string} level @param {string} message @param {string | undefined} url */
function pushConsole(session, level, message, url) {
  session.console.push({ level, message, url, timestamp: new Date().toISOString() });
  if (session.console.length > MAX_CONSOLE_ENTRIES) session.console.shift();
}

chrome.alarms.create("cdp-idle-detach", { periodInMinutes: 0.5 }).catch(logFailure("Creating the idle detach alarm"));
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name !== "cdp-idle-detach") return;
  (async () => {
    const now = Date.now();
    for (const [tabId, session] of sessions) {
      if (now - session.lastUsed > IDLE_DETACH_MS && !session.dialog) await detach(tabId);
    }
  })().catch(ignore("detach catches its own failures"));
});

/**
 * @param {number} tabId
 * @param {string} method
 * @param {CommandParams} [params]
 * @param {string | null} [sessionId]
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
function rawSend(tabId, method, params = {}, sessionId, timeoutMs) {
  const owner = sessions.get(tabId);
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
      else {
        if (sessions.get(tabId) === owner) rememberObjectGroups(owner, method, params, result, sessionId);
        resolve(result);
      }
    });
  });
}

/** @type {Map<number, Promise<DebuggerSession>>} tabId -> the first attach while it is in flight */
const attaching = new Map();

// Concurrent commands for a tab share one attach.
// The tab each frame session was attached in.
/** @type {Map<string, number>} frame session id -> tab id */
const tabOfFrameSession = new Map();
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
/**
 * Who a debugger command is for: an agent session's request, or the extension's own work.
 * @typedef {{ session: string | null } | typeof EXTENSION_WORK} Caller
 */
/** @typedef {(tabId: number, caller: Caller) => Promise<boolean>} DebugGate */
/** @type {DebugGate} */
let mayDebug = async () => true;

export const EXTENSION_WORK = Object.freeze({ extension: true });
const NO_ACCESS = "No agent session may use this tab now (the user stopped sharing it or changed the access setting)";

/** @param {DebugGate} gate */
export function setDebugGate(gate) {
  mayDebug = gate;
}

/** @param {number} tabId @param {Caller} caller */
async function requireDebugAccess(tabId, caller) {
  if (caller !== EXTENSION_WORK && !(caller && "session" in caller)) throw new Error("A debugger command was sent without its caller");
  if (!(await mayDebug(tabId, caller))) throw new Error(NO_ACCESS);
}

/** @param {number} tabId @returns {Promise<DebuggerSession>} */
function attach(tabId) {
  const existing = sessions.get(tabId);
  if (existing) {
    existing.lastUsed = Date.now();
    return Promise.resolve(existing);
  }
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attachNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

/** @param {number} tabId @returns {Promise<DebuggerSession>} */
async function attachNow(tabId) {
  if (await isPaused()) throw new Error(PAUSED_ERROR);
  // An attach is shared by concurrent callers, so it asks whether any session may use the tab; each
  // caller's own access is checked once it completes (withDebuggerAccess).
  await requireDebugAccess(tabId, EXTENSION_WORK);
  if (await hasNoPage(tabId)) throw new Error(NO_PAGE);
  let reattached = false;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    // The service worker may have restarted while this extension's session stayed attached.
    if (!(error instanceof Error && /already attached/i.test(error.message))) throw error;
    reattached = true;
  }
  /** @type {DebuggerSession} */
  const session = { lastUsed: Date.now(), dialog: null, console: [], dialogWaiters: [], crashWaiters: [], objectGroups: new Map(), pageContexts: new Map(), frames: new Map(), requests: [], inflight: new Map(), attachedAt: Date.now(), networkActivityAt: null };
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
  // A crash while the attach was in flight found no session to end; one that comes from now on does.
  if (await hasNoPage(tabId)) {
    await detach(tabId);
    throw new Error(NO_PAGE);
  }
  // After a service worker restart the session is still attached but its state is gone. Turning
  // auto-attach and Runtime off first makes the browser report frames and execution contexts again.
  if (reattached) {
    await rawSend(tabId, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(ignore("the reset only makes the browser report frames again; the next command turns auto-attach on"));
    await rawSend(tabId, "Runtime.disable").catch(ignore("the reset only makes the browser report contexts again; Runtime.enable follows"));
  }
  await rawSend(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(ignore("without auto-attach the tab works, only its cross-origin frames get no session"));
  // Background tabs are throttled and may skip rendering; keep them live for input and screenshots.
  const enabled = Promise.all([
    rawSend(tabId, "Page.enable"),
    rawSend(tabId, "Runtime.enable"),
    rawSend(tabId, "Log.enable"),
    rawSend(tabId, "Network.enable"),
    rawSend(tabId, "DOM.enable"),
    rawSend(tabId, "Accessibility.enable"),
    rawSend(tabId, "Page.setWebLifecycleState", { state: "active" }),
    rawSend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }),
  ]).catch(ignore("a domain that cannot be enabled reports less; the commands that need it fail on their own"));
  // A page that opened a JavaScript dialog while no debugger was attached reports it now and completes
  // the other commands only once the dialog is answered; the session is ready for that answer.
  /** @type {(() => void) | undefined} */
  let waiter;
  await Promise.race([enabled, new Promise((resolve) => session.dialogWaiters.push((waiter = () => resolve(undefined))))]);
  session.dialogWaiters = session.dialogWaiters.filter((w) => w !== waiter);
  return session;
}

/** @param {number} tabId */
export async function detach(tabId) {
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(ignore("the debugger is detached already, or the tab is gone"));
}

// How long a tab gets to close before closeTab reports that it stayed open.
const CLOSE_TIMEOUT_MS = 10_000;
// How long closeTab waits for the tab to report its dialogs before it closes the tab.
const CLOSE_ENABLE_WAIT_MS = 1_000;

// Closes a tab and resolves once it is gone. After input, a page with a beforeunload handler asks
// whether to leave, and a page may have another JavaScript dialog open. With no debugger attached
// nothing can answer a dialog: the tab stays open, its page stops responding and the browser's own close
// call never settles. So the debugger is attached while the tab closes and accepts every dialog of the
// tab, also one that was open before. This is the extension's own work on a tab the caller may close,
// so it does not ask the access gate; it sends the page nothing but those answers.
/** @param {number} tabId */
export async function closeTab(tabId) {
  const target = { tabId };
  /** @param {string} [sessionId] */
  const accept = (sessionId) => chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : target, "Page.handleJavaScriptDialog", { accept: true }).catch(ignore("no dialog is open, or the tab is gone"));
  const wasOpen = Boolean(sessions.get(tabId)?.dialog);
  // The tab's commands end here; its dialogs are this function's to answer, not an agent's.
  sessions.delete(tabId);
  /** @param {chrome.debugger.DebuggerSession} source @param {string} method */
  const answer = (source, method) => {
    if (source.tabId === tabId && method === "Page.javascriptDialogOpening") accept(source.sessionId).catch(ignore("accept catches its own failures"));
  };
  /** @type {((id: number) => void) | undefined} */
  let onRemoved;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  chrome.debugger.onEvent.addListener(answer);
  try {
    // Fails when the debugger is attached already or cannot attach (an internal page); both are fine.
    await chrome.debugger.attach(target, PROTOCOL_VERSION).catch(ignore("attached already, or the tab cannot be debugged; it closes either way"));
    if (wasOpen) await accept();
    // Page.enable reports a dialog that opened while no debugger was attached, and completes only once
    // that dialog is answered, so it is not waited for longer than a page without one takes.
    const enabled = chrome.debugger.sendCommand(target, "Page.enable").catch(ignore("without the debugger the tab closes as it can"));
    await Promise.race([enabled, new Promise((resolve) => setTimeout(resolve, CLOSE_ENABLE_WAIT_MS))]);
    await new Promise((resolve, reject) => {
      const removed = (/** @type {number} */ id) => {
        if (id === tabId) resolve(undefined);
      };
      onRemoved = removed;
      chrome.tabs.onRemoved.addListener(removed);
      timer = setTimeout(() => reject(new Error(`Tab ${tabId} did not close within ${CLOSE_TIMEOUT_MS / 1000} s`)), CLOSE_TIMEOUT_MS);
      chrome.tabs.remove(tabId).catch(reject);
    });
  } catch (error) {
    // The tab is still there, with no session that would detach the debugger later.
    await chrome.debugger.detach(target).catch(ignore("the debugger is detached already, or the tab is gone"));
    throw error;
  } finally {
    clearTimeout(timer);
    if (onRemoved) chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.debugger.onEvent.removeListener(answer);
  }
}

// Removes frames that other extensions injected into the page (for example password manager menus).
// The browser refuses debugger access to a tab while such a frame is present; this runs only after it
// did, and removes no more than those frames and known password manager wrappers that hold frames. Each
// frame of the page is scripted on its own, so one that cannot be scripted does not stop the others.
// Returns { removed, remaining, errors }: the elements removed, how many other extensions' frames the
// page still holds a moment later, and why frames could not be scripted.
/** @typedef {{ removed: number, remaining: number, errors: string[] }} FrameRemoval */
/** @param {number} tabId @returns {Promise<FrameRemoval>} */
async function removeForeignExtensionFrames(tabId) {
  // The browser lists the page's own frames only, which are the ones that can hold such a frame.
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [{ frameId: 0, url: "" }];
  /** @type {FrameRemoval} */
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
          report.errors.push(errorMessage(error));
        }
      }),
  );
  return report;
}

// Runs as a content script in one frame of the page. Returns { removed, remaining }: the elements it
// removed, and the other extensions' frames found after `settleMs` (a wrapper may put its frame back).
/**
 * @param {string} ownOrigin
 * @param {string} passwordManagerElements
 * @param {number} settleMs
 * @returns {Promise<{ removed: number, remaining: number }>}
 */
async function removeFramesInDocument(ownOrigin, passwordManagerElements, settleMs) {
  const wrapper = new RegExp(passwordManagerElements, "i");
  // Only HTML elements can host a shadow root.
  /** @param {Element} el */
  const shadowOf = (el) => (el instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(el) : null) ?? el.shadowRoot;
  /** @param {Element} el */
  const isForeignFrame = (el) => el.tagName === "IFRAME" && "src" in el && typeof el.src === "string" && el.src.startsWith("chrome-extension://") && !el.src.startsWith(ownOrigin);
  // Every element of the document and of the shadow roots below it, open or closed.
  /** @param {ParentNode} root */
  const allElements = (root) => {
    /** @type {Element[]} */
    const elements = [];
    const roots = [root];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        elements.push(el);
        const shadow = shadowOf(el);
        if (shadow) roots.push(shadow);
      }
    }
    return elements;
  };
  /** @param {Element} el */
  const holdsFrame = (el) => {
    const shadow = shadowOf(el);
    return [...allElements(el), ...(shadow ? allElements(shadow) : [])].some((child) => child.tagName === "IFRAME");
  };
  /** @type {Set<Element>} */
  const doomed = new Set();
  for (const el of allElements(document)) {
    // A known password manager's wrapper, also inside the page's shadow roots, goes as a whole when it
    // holds a frame (whatever that frame's URL looks like from here): it would put the frame back.
    if (/^com-1password-(button|menu)$/.test(el.localName) || (wrapper.test(el.localName) && holdsFrame(el))) doomed.add(el);
    else if (isForeignFrame(el)) {
      // Otherwise only the frame goes, or the known password manager wrapper whose shadow root holds it.
      const root = el.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : null;
      doomed.add(host && wrapper.test(host.localName) ? host : el);
    }
  }
  // Without focus the password manager does not bring its menu back right away.
  const active = document.activeElement;
  if (doomed.size && active && active !== document.body && "blur" in active && typeof active.blur === "function") active.blur();
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
/**
 * @template T
 * @param {number} tabId
 * @param {(session: DebuggerSession) => Promise<T>} task
 * @param {Caller} caller
 * @returns {Promise<T>}
 */
async function withDebuggerAccess(tabId, task, caller) {
  /** @type {FrameRemoval[]} */
  const removals = [];
  let resent = false;
  for (;;) {
    /** @type {DebuggerSession | undefined} */
    let session;
    await requireDebugAccess(tabId, caller);
    try {
      session = await attach(tabId);
      // The attach may be shared with other callers and outlast the caller's access.
      await requireDebugAccess(tabId, caller);
      return await task(session);
    } catch (error) {
      const message = errorMessage(error);
      const detached = Boolean(session) && NOT_ATTACHED_ERROR.test(message);
      if (!detached && !FOREIGN_FRAME_ERROR.test(message)) throw error;
      if (detached && sessions.get(tabId) === session) await detach(tabId);
      if (detached && !resent) {
        resent = true;
        continue;
      }
      if (removals.length >= FOREIGN_FRAME_RETRIES) throw new Error(foreignFrameFailure(message, removals));
      // Removing frames changes the page, so the caller's access is checked again after the failed attempt.
      await requireDebugAccess(tabId, caller);
      const removal = await removeForeignExtensionFrames(tabId);
      if (detached && !removal.removed) throw error;
      removals.push(removal);
      await detach(tabId);
    }
  }
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} message @param {FrameRemoval[]} removals */
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
/**
 * @param {number} tabId
 * @param {DebuggerSession} session
 * @param {string | null | undefined} sessionId
 */
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
/** @type {Map<number, ReturnType<typeof setTimeout>>} tab id -> timer that switches file chooser interception off */
const interceptTimers = new Map();

/** @type {Map<number, number>} tab id -> when the agent last pressed a button or key in it */
const agentInputAt = new Map();

// Milliseconds since the agent last pressed a mouse button or key in the tab (Infinity if never).
/** @param {number} tabId */
export function sinceAgentInput(tabId) {
  const at = agentInputAt.get(tabId);
  return at === undefined ? Infinity : Date.now() - at;
}

chrome.tabs.onRemoved.addListener((tabId) => agentInputAt.delete(tabId));

// Runs a CDP command on a tab, attaching first when needed. When another extension's frame blocks
// debugger access, the frame is removed and the command retried (see withDebuggerAccess). `timeoutMs`
// shortens the wait for commands that should be quick, so a stuck page fails them early.
/**
 * The parameters of a CDP command by its name; a name the protocol package does not know takes any.
 * @template {string} M
 * @typedef {M extends keyof CdpCommands
 *   ? CdpCommands[M]["paramsType"] extends [] ? Record<string, never> | undefined
 *   : CdpCommands[M]["paramsType"] extends [infer P] ? P
 *   : CdpCommands[M]["paramsType"] extends [(infer P)?] ? P | undefined
 *   : never
 *   : CommandParams | undefined} CdpParams
 */
/**
 * The result of a CDP command by its name.
 * @template {string} M
 * @typedef {M extends keyof CdpCommands ? CdpCommands[M]["returnType"] : unknown} CdpResult
 */
/**
 * @template {string} M
 * @param {number} tabId
 * @param {M} method
 * @param {CdpParams<M>} commandParams
 * @param {string | null | undefined} sessionId
 * @param {number | undefined} timeoutMs
 * @param {Caller} caller
 * @returns {Promise<CdpResult<M>>}
 */
export async function cdp(tabId, method, commandParams, sessionId, timeoutMs, caller) {
  // Every object is a record of its fields; the checks below read them by name.
  const params = /** @type {CommandParams | undefined} */ (commandParams);
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
        rawSend(tabId, method, { enabled: false }).catch(ignore("a tab that cannot take the command is gone or has no page that intercepts"));
      }, FILE_CHOOSER_INTERCEPT_MS));
    }
  }
  const result = await withDebuggerAccess(tabId, async (session) => sendChecked(tabId, session, method, params, await currentFrameSession(tabId, session, sessionId), timeoutMs, caller), caller);
  // The browser replies to a command with the result the protocol defines for its name.
  return /** @type {CdpResult<M>} */ (result);
}

// Commands that can name their context by its unique ID instead of the numeric one given.
const UNIQUE_CONTEXT_OF = new Map([["Runtime.evaluate", "contextId"], ["Runtime.callFunctionOn", "executionContextId"]]);
// A remote object handle is "<isolate>.<context id>.<object id>"; the context is the one the object lives in.
const ZERO_ISOLATE_HANDLE = /^-?0+\./;
const OBJECT_HANDLE = /^-?\d+\.(-?\d+)\.-?\d+$/;

// The remote object handles a command uses: top-level `objectId` and keys such as `prototypeObjectId`,
// and the arguments of Runtime.callFunctionOn. Values passed by value are page data, not handles.
/** @param {string} method @param {CommandParams} params @returns {unknown[]} */
function objectHandles(method, params) {
  const handles = Object.entries(params).filter(([key]) => key === "objectId" || key.endsWith("ObjectId")).map(([, handle]) => handle);
  if (method === "Runtime.callFunctionOn" && Array.isArray(params.arguments)) {
    /** @type {unknown[]} */
    const args = params.arguments;
    for (const argument of args) if (argument && typeof argument === "object" && "objectId" in argument) handles.push(argument.objectId);
  }
  return handles;
}

// Protocol contracts for allowed node-handle consumers. Other zero-isolate consumers are refused.
/** @type {Map<string, "backendNodeId" | "nodeId">} */
const NODE_HANDLE_CONTRACTS = new Map();
for (const method of ["DOM.describeNode", "DOM.scrollIntoViewIfNeeded", "DOM.focus", "DOM.getBoxModel",
  "DOM.getContentQuads", "DOM.getOuterHTML", "DOM.setFileInputFiles", "DOM.setTextMarker",
  "Accessibility.getPartialAXTree", "Accessibility.getAXNodeAndAncestors", "Accessibility.queryAXTree",
  "Overlay.highlightNode", "Overlay.highlightSourceOrder"]) NODE_HANDLE_CONTRACTS.set(method, "backendNodeId");
NODE_HANDLE_CONTRACTS.set("DOM.requestNode", "nodeId");

// `handle` is what a command or a reply gave as an object handle, read as a string.
/** @param {DebuggerSession} session @param {string | null | undefined} sessionId @param {unknown} handle */
function groupKey(session, sessionId, handle) {
  const context = session.pageContexts.get(`${sessionId ?? "main"}:${OBJECT_HANDLE.exec(String(handle ?? ""))?.[1]}`);
  return `${sessionId ?? "main"}:${context}:${handle}`;
}

// A RemoteObjectId contains no group name. Remember groups from replies without inspecting page data
// returned by value. Property descriptors carry RemoteObjects in their value fields, so recurse there.
/**
 * @param {DebuggerSession | undefined} session
 * @param {string} method
 * @param {CommandParams} params
 * @param {unknown} reply
 * @param {string | null | undefined} sessionId
 */
function rememberObjectGroups(session, method, params, reply, sessionId) {
  if (!session) return;
  const group = params.objectGroup ?? session.objectGroups.get(groupKey(session, sessionId, params.objectId ?? params.promiseObjectId ?? params.errorObjectId ?? params.prototypeObjectId));
  if (method === "Runtime.releaseObjectGroup") {
    for (const [key, value] of session.objectGroups) {
      if (key.startsWith(`${sessionId ?? "main"}:`) && value === params.objectGroup) session.objectGroups.delete(key);
    }
  } else if (method === "Runtime.releaseObject") {
    session.objectGroups.delete(groupKey(session, sessionId, params.objectId));
  }
  /** @param {unknown} value */
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if ("type" in value && typeof value.type === "string" && ("objectId" in value || "value" in value || "description" in value)) {
      if ("objectId" in value && value.objectId && group !== undefined) session.objectGroups.set(groupKey(session, sessionId, value.objectId), group);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(reply);
}

// Raw commands run JavaScript and use objects only in the page's own (default) contexts of the target
// they go to, never in an isolated world where this or another extension's content script runs with
// extension APIs. The contexts are known from Runtime events, so commands that stop them are refused.
// Numeric context IDs start again in a new renderer process, and the browser delivers a command sent
// before a cross-process navigation to the new process, so a numeric ID could name an isolated world
// there. Commands are therefore sent with unique context IDs, which differ between processes; returns
// the parameters to send.
/**
 * @param {DebuggerSession} session
 * @param {string} method
 * @param {CommandParams | undefined} params
 * @param {string | null | undefined} sessionId
 * @returns {CommandParams}
 */
function requirePageContext(session, method, params = {}, sessionId) {
  if (method === "Runtime.disable") {
    throw new Error("Agents may not send Runtime.disable: the page's own contexts are told from isolated worlds by Runtime events");
  }
  if (method === "Runtime.addBinding") {
    throw new Error("Agents may not send Runtime.addBinding: it names its context only by numeric ID or by name, which can reach isolated worlds such as extensions' content scripts");
  }
  if (!params || typeof params !== "object") return params;
  /** @param {unknown} id */
  const uniqueId = (id) => (id === undefined ? undefined : session.pageContexts.get(`${sessionId ?? "main"}:${id}`));
  const numericKey = UNIQUE_CONTEXT_OF.get(method);
  let sent = params;
  if (numericKey && params[numericKey] !== undefined && params.uniqueContextId === undefined && uniqueId(params[numericKey]) !== undefined) {
    const { [numericKey]: id, ...rest } = params;
    sent = { ...rest, uniqueContextId: uniqueId(id) };
  }
  const numeric = ["contextId", "executionContextId", "executionContextName"].some((key) => sent[key] !== undefined);
  const contextKnown = sent.uniqueContextId === undefined || uniqueId(sent.uniqueContextId) !== undefined;
  const handles = objectHandles(method, sent);
  /** @type {string[]} */
  const knownHandles = [];
  for (const handle of handles) if (typeof handle === "string" && uniqueId(OBJECT_HANDLE.exec(handle)?.[1]) !== undefined) knownHandles.push(handle);
  if (!numeric && contextKnown && knownHandles.length === handles.length) {
    if (method === "Runtime.callFunctionOn") {
      // Every handle is a known string here, the top-level objectId among them.
      const target = typeof sent.objectId === "string" ? sent.objectId : undefined;
      const context = target ? uniqueId(OBJECT_HANDLE.exec(target)?.[1]) : sent.uniqueContextId;
      if (handles.length && !context) throw new Error("Object arguments require an explicit page context");
      if (target) {
        const { objectId, functionDeclaration, arguments: args = [], ...rest } = sent;
        if (!Array.isArray(args)) throw new Error("Runtime.callFunctionOn takes its arguments as an array");
        /** @type {unknown[]} */
        const argumentList = args;
        // Arrow declarations can see this wrapper's arguments; avoiding that requires eval or another call.
        const objectGroup = sent.objectGroup ?? session.objectGroups.get(groupKey(session, sessionId, objectId));
        return { ...rest, ...(objectGroup === undefined ? {} : { objectGroup }), uniqueContextId: context,
          functionDeclaration: `function () { return Reflect.apply((${functionDeclaration}), arguments[0], Array.prototype.slice.call(arguments, 1)); }`,
          arguments: [{ objectId }, ...argumentList] };
      }
      return sent;
    }
    if (knownHandles.some((handle) => ZERO_ISOLATE_HANDLE.test(handle)) && !NODE_HANDLE_CONTRACTS.has(method)) {
      throw new Error(`${method} cannot safely use a zero-isolate object handle; use Runtime.callFunctionOn with a page context instead`);
    }
    return sent;
  }
  throw new Error(
    "Agents may run JavaScript only in the page's own contexts, not in isolated worlds such as extensions' content scripts, " +
      "and use only objects from those contexts; leave out the context parameter to use the page's main context, or name " +
      "one by uniqueContextId (Runtime.evaluate and Runtime.callFunctionOn also take its numeric ID)",
  );
}

/**
 * @param {number} tabId
 * @param {DebuggerSession} session
 * @param {string} method
 * @param {CommandParams | undefined} params
 * @param {string | null | undefined} sessionId
 * @param {number | undefined} timeoutMs
 * @param {Caller} caller
 * @returns {Promise<unknown>}
 */
async function sendChecked(tabId, session, method, params, sessionId, timeoutMs, caller) {
  await requireDebugAccess(tabId, caller);
  // The session may have been detached while access was checked; withDebuggerAccess then attaches anew,
  // which asks the gate again.
  if (sessions.get(tabId) !== session) throw new Error("Debugger is not attached to the tab");
  params = requirePageContext(session, method, params, sessionId);
  requireNoDialog(session, method);
  // Node commands have no unique context selector. Resolve the handle inside its pinned world first;
  // backend node IDs identify DOM nodes, not JavaScript objects in another world's object table.
  if (NODE_HANDLE_CONTRACTS.has(method) && typeof params?.objectId === "string" && ZERO_ISOLATE_HANDLE.test(params.objectId)) {
    const objectGroup = `node-conversion-${crypto.randomUUID()}`;
    const pinned = requirePageContext(session, "Runtime.callFunctionOn", {
      objectId: params.objectId, objectGroup, functionDeclaration: "function () { return this; }",
      serializationOptions: { serialization: "deep", additionalParameters: { maxNodeDepth: 0 } },
    }, sessionId);
    const reply = await executeWithDialog(tabId, session, "Runtime.callFunctionOn", pinned, sessionId, timeoutMs)
      .finally(() => {
        // Release can wait behind a modal dialog too; cleanup must not delay the dialog error.
        rawSend(tabId, "Runtime.releaseObjectGroup", { objectGroup }, sessionId).catch(ignore("the group goes with its context; a failed release only keeps the object longer"));
      });
    // The browser replies to a command with the result the protocol defines for its name.
    const { result, exceptionDetails } = /** @type {CdpResult<"Runtime.callFunctionOn">} */ (reply);
    const node = result?.deepSerializedValue;
    if (exceptionDetails || node?.type !== "node" || !node.value?.backendNodeId) throw new Error("The object is not a page DOM node");
    const { objectId, ...rest } = params;
    await requireDebugAccess(tabId, caller);
    if (sessions.get(tabId) !== session) throw new Error("Debugger is not attached to the tab");
    if (NODE_HANDLE_CONTRACTS.get(method) === "nodeId") {
      const pushed = await executeWithDialog(tabId, session, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [node.value.backendNodeId] }, sessionId, timeoutMs);
      const { nodeIds } = /** @type {CdpResult<"DOM.pushNodesByBackendIdsToFrontend">} */ (pushed);
      return { nodeId: nodeIds[0] };
    }
    params = { ...rest, backendNodeId: node.value.backendNodeId };
  }
  return executeWithDialog(tabId, session, method, params, sessionId, timeoutMs);
}

/** @param {DebuggerSession} session @param {string} method */
function requireNoDialog(session, method) {
  if (session.dialog && !DIALOG_SAFE_METHODS.has(method) && !method.startsWith("Input.")) {
    throw new Error(`A JavaScript ${session.dialog.type} dialog is open on this tab ("${session.dialog.message}"); handle it with getJsDialog() first`);
  }
}

// Sends a command and rejects when the tab's renderer crashes before the reply, which then never comes.
/**
 * @param {number} tabId
 * @param {DebuggerSession} session
 * @param {string} method
 * @param {CommandParams | undefined} params
 * @param {string | null | undefined} sessionId
 * @param {number | undefined} timeoutMs
 */
function sendUnlessCrashed(tabId, session, method, params, sessionId, timeoutMs) {
  /** @type {(() => void) | undefined} */
  let waiter;
  const crashed = new Promise((_, reject) => session.crashWaiters.push((waiter = () => reject(new Error(`The page of this tab crashed while ${method} was running. ${LOAD_PAGE_HINT}`)))));
  return Promise.race([rawSend(tabId, method, params, sessionId, timeoutMs), crashed]).finally(() => {
    session.crashWaiters = session.crashWaiters.filter((w) => w !== waiter);
  });
}

/**
 * @param {number} tabId
 * @param {DebuggerSession} session
 * @param {string} method
 * @param {CommandParams | undefined} params
 * @param {string | null | undefined} sessionId
 * @param {number | undefined} timeoutMs
 * @returns {Promise<unknown>}
 */
async function executeWithDialog(tabId, session, method, params, sessionId, timeoutMs) {
  requireNoDialog(session, method);
  const isInput = method.startsWith("Input.");
  // While a dialog is open the page handles no input; further events of the same action are skipped.
  if (isInput && session.dialog) return {};
  if (DIALOG_SAFE_METHODS.has(method)) return sendUnlessCrashed(tabId, session, method, params, sessionId, timeoutMs);
  // A command that makes the page open a modal dialog does not complete until the dialog closes. Input
  // finishes when the dialog opens; other commands fail with a pointer to getJsDialog().
  /** @type {(() => void) | undefined} */
  let waiter;
  const dialogOpened = new Promise((resolve) => session.dialogWaiters.push((waiter = () => resolve(undefined))));
  try {
    return await Promise.race([
      sendUnlessCrashed(tabId, session, method, params, sessionId, timeoutMs),
      dialogOpened.then(() => {
        if (isInput) return {};
        throw new Error(`A JavaScript ${session.dialog?.type ?? ""} dialog opened while ${method} was running; handle it with getJsDialog()`);
      }),
    ]);
  } finally {
    session.dialogWaiters = session.dialogWaiters.filter((w) => w !== waiter);
  }
}

/** @param {number} tabId @param {Caller} caller @returns {Promise<PageState>} */
export function tabState(tabId, caller) {
  return withDebuggerAccess(tabId, async (session) => {
    const frames = [...session.frames].map(([frameId, frame]) => ({ frameId, ...frame }));
    const quietMs = session.inflight.size ? 0 : Date.now() - (session.networkActivityAt ?? session.attachedAt);
    return { dialog: session.dialog, frames, inflightRequests: session.inflight.size, networkQuietMs: quietMs };
  }, caller);
}

// The JavaScript dialog open in the tab, as far as the attached debugger reported one, or null.
/** @param {number} tabId */
export function openDialog(tabId) {
  return sessions.get(tabId)?.dialog ?? null;
}

/** @param {number} tabId @returns {ConsoleEntry[]} */
export function consoleLogs(tabId) {
  return sessions.get(tabId)?.console ?? [];
}

/** @param {number} tabId @returns {NetworkEntry[]} */
export function networkRequests(tabId) {
  return (sessions.get(tabId)?.requests ?? []).map(({ id, ...request }) => request);
}
