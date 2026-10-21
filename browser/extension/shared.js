// Values and rules that the extension and the MCP server must agree on. This is a plain module without
// chrome.* or Node APIs, so the extension loads it directly and the MCP server imports it from here.

// Local port of the MCP hub, which the extension's offscreen document connects to.
export const HUB_PORT = 47615;

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
export function isPressInput(cdpMethod, params) {
  const type = params?.type;
  return (cdpMethod === "Input.dispatchMouseEvent" && type === "mousePressed") || (cdpMethod === "Input.dispatchKeyEvent" && (type === "keyDown" || type === "rawKeyDown"));
}

// Element names of password managers' in-page UI (menu wrappers, buttons), as the source of a regular
// expression so that it can also be passed into page scripts.
export const PASSWORD_MANAGER_ELEMENTS = "^(com-1password|com-bitwarden|bitwarden-|lastpass-|dashlane-|protonpass-)";

// Error of a command that a page did not take in time (it may be stuck in an endless script). The MCP
// server recognizes it to stop retrying.
export function unresponsivePageError(method, seconds) {
  return `The page did not respond within ${seconds} s (${method}); it may be busy, for example running an endless script`;
}

export function isUnresponsivePageError(message) {
  return /The page did not respond within /.test(message ?? "");
}
