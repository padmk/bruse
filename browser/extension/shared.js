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

// The manifest as the fingerprint sees it: with sorted keys, so that rewriting the file changes nothing
// while any change to its content, such as a permission or the version, counts.
function canonicalManifest(text) {
  const sorted = (value) =>
    Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(JSON.parse(text)));
}

// A fingerprint of the extension's code: SHA-256 over manifest.json (see canonicalManifest) and every
// file it reaches through the manifest, module imports, HTML script and style links and quoted page
// names such as "offscreen.html", read with `readText(path)` (a path relative to the extension folder).
// The extension reports it, and the installer and the benchmark compute it from a folder, so they can
// tell whether the browser runs that folder's code; the version alone stays the same between releases.
export async function extensionBuild(readText) {
  const files = new Map();
  const visit = async (file) => {
    if (files.has(file)) return;
    const raw = await readText(file);
    files.set(file, file === "manifest.json" ? canonicalManifest(raw) : raw);
    const text = files.get(file);
    const found = file === "manifest.json"
      ? [JSON.parse(text).background?.service_worker, JSON.parse(text).action?.default_popup]
      : [...text.matchAll(/from\s+"\.\/([\w.-]+)"|import\(\s*"\.\/([\w.-]+)"\s*\)|(?:src|href)="([\w.-]+\.(?:js|css))"|"([\w-]+\.html)"/g)].map((m) => m.slice(1).find(Boolean));
    for (const next of found) if (next) await visit(next);
  };
  await visit("manifest.json");
  const data = new TextEncoder().encode([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, text]) => `${name}\0${text}`).join("\0"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return { hash: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""), files: [...files.keys()].sort() };
}
