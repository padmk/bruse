// Chrome DevTools Protocol sessions over chrome.debugger. A tab stays attached while in use and is
// detached after a quiet period, which also removes the browser's "started debugging" bar. The module
// also tracks per-tab state that CDP only reports as events: open JavaScript dialogs and console output.

const PROTOCOL_VERSION = "1.3";
const IDLE_DETACH_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_CONSOLE_ENTRIES = 500;
const MAX_REQUESTS = 300;
// Commands that still work while a JavaScript dialog blocks the page.
const DIALOG_SAFE_METHODS = new Set(["Page.handleJavaScriptDialog", "Page.captureScreenshot", "Page.getLayoutMetrics"]);

const sessions = new Map(); // tabId -> { lastUsed, dialog, console, requests, inflight (request id -> { session, frameId }), frames }
const eventListeners = new Set();

// Returns a function that removes the listener.
export function onCdpEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

chrome.debugger.onDetach.addListener(({ tabId }) => sessions.delete(tabId));

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
      enableChildSession(tabId, params.sessionId);
    }
  } else if (method === "Target.detachedFromTarget") {
    for (const [frameId, frame] of session.frames) if (frame.sessionId === params.sessionId) session.frames.delete(frameId);
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
    // Only the page's own contexts count; other extensions' content scripts log into isolated ones.
    if (params.context.auxData?.isDefault) session.pageContexts.add(contextKey(params.context.id));
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
    session.inflight.set(params.requestId, { session: source ?? null, frameId: params.frameId });
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

function dropRequests(session, matches) {
  for (const [requestId, request] of session.inflight) if (matches(request)) session.inflight.delete(requestId);
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

function rawSend(tabId, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS);
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
// did, and removes no more than those frames.
async function removeForeignExtensionFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (ownOrigin) => {
      // Without focus the password manager does not bring its menu back right away.
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      for (const host of document.querySelectorAll("com-1password-button, com-1password-menu")) host.remove();
      const roots = [document];
      for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll("*")) {
          const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
          if (shadow) roots.push(shadow);
          if (el.tagName === "IFRAME" && el.src.startsWith("chrome-extension://") && !el.src.startsWith(ownOrigin)) {
            // Only the frame goes, and the wrapper element only of a known password manager menu,
            // which would otherwise put the frame back.
            const host = el.getRootNode().host;
            if (host && /^(com-1password|com-bitwarden|bitwarden-|lastpass-|dashlane-|protonpass-)/i.test(host.localName)) host.remove();
            else el.remove();
          }
        }
      }
    },
    args: [`chrome-extension://${chrome.runtime.id}/`],
  });
}

const FOREIGN_FRAME_ERROR = /chrome-extension:\/\/ URL of different extension/;

// Runs a CDP command on a tab, attaching first when needed. When another extension's frame blocks
// debugger access, the frame is removed and the command retried once.
const FILE_CHOOSER_INTERCEPT_MS = 60_000;
const interceptTimers = new Map(); // tab id -> timer that switches file chooser interception off

export async function cdp(tabId, method, params, sessionId) {
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
  try {
    return await sendChecked(tabId, method, params, sessionId);
  } catch (error) {
    if (!FOREIGN_FRAME_ERROR.test(error.message)) throw error;
    await removeForeignExtensionFrames(tabId).catch(() => {});
    await detach(tabId);
    return sendChecked(tabId, method, params, sessionId);
  }
}

async function sendChecked(tabId, method, params, sessionId) {
  const session = await attach(tabId);
  if (session.dialog && !DIALOG_SAFE_METHODS.has(method) && !method.startsWith("Input.")) {
    throw new Error(`A JavaScript ${session.dialog.type} dialog is open on this tab ("${session.dialog.message}"); handle it with getJsDialog() first`);
  }
  const isInput = method.startsWith("Input.");
  // While a dialog is open the page handles no input; further events of the same action are skipped.
  if (isInput && session.dialog) return {};
  if (DIALOG_SAFE_METHODS.has(method)) return rawSend(tabId, method, params, sessionId);
  // A command that makes the page open a modal dialog does not complete until the dialog closes. Input
  // finishes when the dialog opens; other commands fail with a pointer to getJsDialog().
  let waiter;
  const dialogOpened = new Promise((resolve) => session.dialogWaiters.push((waiter = resolve)));
  try {
    return await Promise.race([
      rawSend(tabId, method, params, sessionId),
      dialogOpened.then(() => {
        if (isInput) return {};
        throw new Error(`A JavaScript ${session.dialog?.type ?? ""} dialog opened while ${method} was running; handle it with getJsDialog()`);
      }),
    ]);
  } finally {
    session.dialogWaiters = session.dialogWaiters.filter((w) => w !== waiter);
  }
}

export async function tabState(tabId) {
  const session = await attach(tabId);
  const frames = [...session.frames].map(([frameId, frame]) => ({ frameId, ...frame }));
  const quietMs = session.inflight.size ? 0 : Date.now() - (session.networkActivityAt ?? session.attachedAt);
  return { dialog: session.dialog, frames, inflightRequests: session.inflight.size, networkQuietMs: quietMs };
}

export function consoleLogs(tabId) {
  return sessions.get(tabId)?.console ?? [];
}

export function networkRequests(tabId) {
  return (sessions.get(tabId)?.requests ?? []).map(({ id, ...request }) => request);
}
