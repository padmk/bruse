// Values and rules that the extension and the MCP server must agree on. This is a plain module without
// chrome.* or Node APIs, so the extension loads it directly and the MCP server imports it from here.

// Local port of the MCP hub, which the extension's offscreen document connects to.
export const HUB_PORT = 47615;

/**
 * A rejection handler for a promise whose failure does not matter; `reason` says why, for the reader.
 * @param {string} reason
 * @returns {(error: unknown) => undefined}
 */
export const ignore = (reason) => () => undefined;

/**
 * A rejection handler that logs the failure of `what` (to standard error in Node.js), for work nobody
 * waits for whose failure must still show.
 * @param {string} what
 * @returns {(error: unknown) => undefined}
 */
export const logFailure = (what) => (error) => {
  console.error(`${what} failed:`, error);
};

/** @typedef {import("devtools-protocol").Protocol.Page.DialogType} DialogType */

/**
 * @typedef {object} TabInfo
 * @property {number} id
 * @property {number} windowId
 * @property {boolean} active
 * @property {string} [title]
 * @property {string} [url]
 * @property {number} groupId
 * @property {number} [lastAccessed]
 * @property {string} [pendingUrl]
 * @property {string} [status]
 */

/**
 * @typedef {object} BrowserInfo
 * @property {string} name
 * @property {string} userAgent
 * @property {string} version
 * @property {string | null} build
 * @property {string} id
 * @property {boolean} paused
 * @property {{ mode: string, hiddenTabs: number }} access
 * @property {string} [problem] Why the extension runs no agent requests, when it cannot.
 */

/**
 * @typedef {object} PageDialog
 * @property {DialogType} type
 * @property {string} message
 * @property {string} [defaultPrompt]
 * @property {string} url
 */

/**
 * A cross-origin frame with its own debugger session.
 * @typedef {object} FrameInfo
 * @property {string} frameId
 * @property {string} sessionId
 * @property {string} url
 * @property {string | null} parentSessionId
 */

/**
 * @typedef {object} PageState
 * @property {PageDialog | null} dialog
 * @property {FrameInfo[]} frames
 * @property {number} inflightRequests
 * @property {number} networkQuietMs
 */

/**
 * @typedef {object} ConsoleEntry
 * @property {string} level
 * @property {string} message
 * @property {string} [url]
 * @property {string} timestamp
 */

/**
 * @typedef {object} NetworkEntry
 * @property {string} method
 * @property {string} url
 * @property {string} [type]
 * @property {string} timestamp
 * @property {number} [status]
 * @property {string} [error]
 */

/** @typedef {{ sessionId: string | null, mark: string | null }} AgentTabEntry */
/** @typedef {{ id: string, url?: string, title?: string, lastVisitTime?: number, visitCount?: number, typedCount?: number }} HistoryEntry */
/** @typedef {{ path: string, url: string, mime: string }} DownloadInfo */

/** @typedef {{ tabId: number }} TabParams */

/**
 * Parameters and result of each request the MCP server sends the extension.
 * @typedef {{
 *   "browser.info": { params: {}, result: BrowserInfo },
 *   "tabs.list": { params: {}, result: TabInfo[] },
 *   "tabs.get": { params: TabParams, result: TabInfo },
 *   "tabs.selected": { params: {}, result: TabInfo | null },
 *   "tabs.create": { params: { url?: string, sessionId?: string }, result: TabInfo },
 *   "tabs.navigate": { params: TabParams & { url: string }, result: TabInfo },
 *   "tabs.history": { params: TabParams & { direction: "back" | "forward" | "reload" }, result: TabInfo },
 *   "tabs.waitForLoad": { params: TabParams & { timeoutMs?: number }, result: { loaded: boolean } },
 *   "tabs.close": { params: TabParams, result: null },
 *   "tabs.mark": { params: TabParams & { mark: string | null }, result: null },
 *   "tabs.agent": { params: {}, result: Record<string, AgentTabEntry> },
 *   "session.end": { params: { sessionId?: string }, result: { closed: number } },
 *   "session.cancel": { params: { before: number }, result: { cancelled: number } },
 *   "cdp": { params: TabParams & { method: string, params?: object, sessionId?: string | null, timeoutMs?: number }, result: unknown },
 *   "page.state": { params: TabParams, result: PageState },
 *   "page.console": { params: TabParams, result: ConsoleEntry[] },
 *   "page.network": { params: TabParams, result: NetworkEntry[] },
 *   "history.search": { params: { text?: string, startTime?: number, endTime?: number, maxResults?: number }, result: HistoryEntry[] },
 *   "downloads.wait": { params: TabParams & { timeoutMs?: number }, result: DownloadInfo },
 *   "browser.manage": { params: { namespace: string, method: string, args?: unknown[] }, result: unknown },
 *   "extension.reload": { params: {}, result: null },
 * }} Protocol
 */

/** @typedef {import("devtools-protocol/types/protocol-mapping.js").ProtocolMapping.Commands} CdpCommands */
/**
 * Sends a raw DevTools Protocol command to one target and resolves with the reply, typed by the
 * protocol's definition of `method`.
 * @typedef {<C extends CdpMethod>(method: C, params?: CdpCommands[C]["paramsType"][0]) => Promise<CdpCommands[C]["returnType"]>} CdpSender
 */
/** @typedef {Extract<keyof CdpCommands, string>} CdpMethod */

/** @typedef {keyof Protocol} Method */
/**
 * Sends a request to the extension and resolves with its result. (tabs.create and session.end also name
 * the session in their parameters, where extensions before 0.18.0 took it from.)
 * @typedef {<M extends Method>(method: M, ...params: {} extends Params<M> ? [params?: Params<M>] : [params: Params<M>]) => Promise<Result<M>>} BrowserCall
 */
/**
 * @template {Method} M
 * @typedef {Protocol[M]["params"]} Params
 */
/**
 * @template {Method} M
 * @typedef {Protocol[M]["result"]} Result
 */

/**
 * What a request acts on, which decides the checks before the extension runs it:
 * "browser": nothing in particular; "tab": the tab in params.tabId, which the session must be allowed to
 * use (checked first, so a request for a hidden tab learns nothing about it); "page": also that tab's
 * page, whose address must be one agents may use (guard.js); "loaded-page": also needs the page loaded,
 * which a tab the browser discarded to free memory no longer has.
 * @typedef {"browser" | "tab" | "page" | "loaded-page"} MethodScope
 */

/**
 * @typedef {object} MethodRules
 * @property {MethodScope} scope
 * @property {boolean} readOnly Only reads state: the server resends it when the hub exits or the extension disconnects while it is in flight.
 * @property {boolean} pauseExempt Runs while the user has paused agents.
 * @property {boolean} sessionless Runs for a hub too old to say which session a request comes from, and while the extension refuses agent requests (BrowserInfo.problem).
 */

/** @type {(scope: MethodScope, flags?: Partial<Omit<MethodRules, "scope">>) => MethodRules} */
const rules = (scope, { readOnly = false, pauseExempt = false, sessionless = false } = {}) => ({ scope, readOnly, pauseExempt, sessionless });

/**
 * Every request the extension takes and how it is checked. browser.info only reads the state, so it runs
 * while agents are paused; session.end closes no tab while paused (sessions.js closes the session's tabs
 * when the user resumes); session.cancel only stops the session's requests in flight, so it runs while
 * paused too; extension.reload does not run while paused, because a reload would end the
 * user's tab shares. tabs.navigate and tabs.history load a new page, so they do not need a loaded one.
 * @type {{ readonly [M in Method]: MethodRules }}
 */
export const PROTOCOL = Object.freeze({
  "browser.info": rules("browser", { readOnly: true, pauseExempt: true, sessionless: true }),
  "tabs.list": rules("browser", { readOnly: true }),
  "tabs.get": rules("tab", { readOnly: true }),
  "tabs.selected": rules("browser", { readOnly: true }),
  "tabs.create": rules("browser"),
  "tabs.navigate": rules("page"),
  "tabs.history": rules("page"),
  "tabs.waitForLoad": rules("tab", { readOnly: true }),
  "tabs.close": rules("tab"),
  "tabs.mark": rules("tab"),
  "tabs.agent": rules("browser", { readOnly: true }),
  "session.end": rules("browser", { pauseExempt: true }),
  "session.cancel": rules("browser", { pauseExempt: true }),
  cdp: rules("loaded-page"),
  "page.state": rules("loaded-page", { readOnly: true }),
  "page.console": rules("loaded-page", { readOnly: true }),
  "page.network": rules("loaded-page", { readOnly: true }),
  "history.search": rules("browser", { readOnly: true }),
  "downloads.wait": rules("loaded-page"),
  "browser.manage": rules("browser"),
  "extension.reload": rules("browser", { sessionless: true }),
});

/**
 * The rules of `method`, or undefined for a method the extension does not take.
 * @param {unknown} method
 * @returns {MethodRules | undefined}
 */
export function methodRules(method) {
  return typeof method === "string" && Object.hasOwn(PROTOCOL, method) ? PROTOCOL[/** @type {Method} */ (method)] : undefined;
}

const SCOPE_DEPTH = { browser: 0, tab: 1, page: 2, "loaded-page": 3 };

/**
 * Whether `method` acts at least on `scope` (a page method also acts on its tab).
 * @param {unknown} method
 * @param {Exclude<MethodScope, "browser">} scope
 */
export function actsOn(method, scope) {
  const found = methodRules(method);
  return found !== undefined && SCOPE_DEPTH[found.scope] >= SCOPE_DEPTH[scope];
}

// Raw DevTools commands that only read the page, so a cdp request with one is read-only too.
const READ_ONLY_CDP = /^(DOM\.(getDocument|describeNode|getContentQuads|getBoxModel|getFrameOwner|resolveNode)|Accessibility\.|Page\.(getFrameTree|getLayoutMetrics|captureScreenshot)|Runtime\.(getProperties|releaseObject|releaseObjectGroup))$/;

/**
 * Whether a request only reads state (see MethodRules.readOnly).
 * @param {string} method
 * @param {unknown} params
 */
export function isReadOnly(method, params) {
  if (methodRules(method)?.readOnly) return true;
  const cdpMethod = method === "cdp" && params && typeof params === "object" && "method" in params ? params.method : undefined;
  return typeof cdpMethod === "string" && READ_ONLY_CDP.test(cdpMethod);
}

// WebExtensions methods available through the `management` capability; the service worker calls only these.
export const MANAGEMENT_METHODS = {
  windows: ["getAll", "get", "getCurrent", "getLastFocused", "create", "update", "remove"],
  tabs: ["query", "get", "update", "move", "group", "ungroup", "remove", "reload", "duplicate", "discard"],
  tabGroups: ["query", "get", "update", "move"],
  bookmarks: ["search", "getTree", "getChildren", "getRecent", "get", "create", "update", "move", "remove", "removeTree"],
};

// How long after the agent's input in a tab an opening by its page counts as caused by that input.
export const AGENT_INPUT_WINDOW_MS = 1_500;

// Input that can make a page open a tab or window: a pressed mouse button or key. Pointer moves and
// inserted text cannot.
/** @param {string} cdpMethod @param {{ type?: unknown } | null | undefined} params */
export function isPressInput(cdpMethod, params) {
  const type = params?.type;
  return (cdpMethod === "Input.dispatchMouseEvent" && type === "mousePressed") || (cdpMethod === "Input.dispatchKeyEvent" && (type === "keyDown" || type === "rawKeyDown"));
}

// Element names of password managers' in-page UI (menu wrappers, buttons), as the source of a regular
// expression so that it can also be passed into page scripts.
export const PASSWORD_MANAGER_ELEMENTS = "^(com-1password|com-bitwarden|bitwarden-|lastpass-|dashlane-|protonpass-)";

// Error of a command that a page did not take in time (it may be stuck in an endless script). The MCP
// server recognizes it to stop retrying.
/** @param {string} method @param {number} seconds */
export function unresponsivePageError(method, seconds) {
  return `The page did not respond within ${seconds} s (${method}); it may be busy, for example running an endless script`;
}

/** @param {string | null | undefined} message */
export function isUnresponsivePageError(message) {
  return /The page did not respond within /.test(message ?? "");
}

// How the error of a tab whose page is gone (discarded, crashed or never loaded) ends. The MCP server
// recognizes it to bind such a tab without its state, so that the agent can load the page again.
export const LOAD_PAGE_HINT = "Load it with tab.reload() or tab.goto(url), then read the state.";

/** @param {string | null | undefined} message */
export function isPageGoneError(message) {
  return (message ?? "").includes(LOAD_PAGE_HINT);
}

// The manifest as the fingerprint sees it: with sorted keys, so that rewriting the file changes nothing
// while any change to its content, such as a permission or the version, counts.
/** @param {string} text */
function canonicalManifest(text) {
  /** @type {(value: unknown) => unknown} */
  const sorted = (value) =>
    Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, sorted(entry)])) : value;
  return JSON.stringify(sorted(JSON.parse(text)));
}

// A fingerprint of the extension's code: SHA-256 over manifest.json (see canonicalManifest) and every
// file it reaches through the manifest, module imports, HTML script and style links and quoted page
// names such as "offscreen.html", read with `readText(path)` (a path relative to the extension folder).
// The extension reports it, and the installer and the benchmark compute it from a folder, so they can
// tell whether the browser runs that folder's code; the version alone stays the same between releases.
/** @param {(path: string) => Promise<string>} readText */
export async function extensionBuild(readText) {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @param {string} file @returns {Promise<void>} */
  const visit = async (file) => {
    if (files.has(file)) return;
    const raw = await readText(file);
    const text = file === "manifest.json" ? canonicalManifest(raw) : raw;
    files.set(file, text);
    /** @type {unknown[]} */
    const found = file === "manifest.json"
      ? [JSON.parse(text).background?.service_worker, JSON.parse(text).action?.default_popup]
      : [...text.matchAll(/from\s+"\.\/([\w.-]+)"|import\(\s*"\.\/([\w.-]+)"\s*\)|(?:src|href)="([\w.-]+\.(?:js|css))"|"([\w-]+\.html)"/g)].map((m) => m.slice(1).find(Boolean));
    for (const next of found) if (typeof next === "string" && next) await visit(next);
  };
  await visit("manifest.json");
  const data = new TextEncoder().encode([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, text]) => `${name}\0${text}`).join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return { hash: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""), files: [...files.keys()].sort() };
}

// Native host name shared by setup and the extension.
export const PAIRING_HOST = "org.bruse.pairing";

// Why the extension could not answer the hub's challenge: the codes it sends in a `pairing-failed`
// message before it authenticates, and what each means. The hub words its error from this list only,
// so a process posing as the extension cannot put text of its own into an agent's error.
export const PAIRING_FAILURES = {
  "host-missing": "the browser did not find the native pairing host",
  "host-forbidden": "the browser does not let the extension start the native pairing host",
  "host-failed": "the native pairing host did not provide the pairing secret",
};
