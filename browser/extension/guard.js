// Checks every agent request before the service worker runs it. Agents open and drive web pages (and
// blank, data and file pages) only: never the extension's own pages, which hold the user's switches,
// nor the browser's internal pages. Raw DevTools commands are limited to domains that act on the page
// in the tab they are sent to; within those, commands that reach the browser's cookie store or cache,
// or register scripts to run in whatever page the tab loads next, are refused. Domains that reach
// other targets (Target, Browser), storage of any origin (Storage, DOMStorage, IndexedDB,
// CacheStorage), certificate checks (Security) or the machine (SystemInfo) are not on the list.

const name = chrome.runtime.getManifest().name;

const AGENT_SCHEMES = new Set(["http:", "https:", "about:", "data:", "file:", "blob:"]);

const ALLOWED_CDP_DOMAINS = new Set(["Accessibility", "Animation", "CSS", "DOM", "DOMSnapshot", "Emulation", "Input", "Log", "Network", "Overlay", "Page", "Performance", "Runtime"]);
const REFUSED_CDP = new Set([
  "Page.addScriptToEvaluateOnNewDocument",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
]);

function cdpAllowed(method) {
  return typeof method === "string" && ALLOWED_CDP_DOMAINS.has(method.split(".")[0]) && !REFUSED_CDP.has(method);
}

// Requests that read or act on the page of params.tabId.
const PAGE_METHODS = new Set(["cdp", "page.state", "page.console", "page.network", "tabs.history", "tabs.navigate", "downloads.wait"]);

// A relative address would open inside the extension, so only absolute ones pass.
function checkUrl(url) {
  if (url === undefined || url === null || url === "") return;
  let scheme;
  try {
    scheme = new URL(String(url)).protocol;
  } catch {
    throw new Error(`${name} lets agents open only absolute web addresses, not ${JSON.stringify(url)}`);
  }
  if (!AGENT_SCHEMES.has(scheme)) throw new Error(`${name} does not let agents open or use ${scheme} pages`);
}

async function checkTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  checkUrl(tab.url);
  checkUrl(tab.pendingUrl);
}

// Management methods that take addresses: windows.create({ url }) opens them, and a bookmark's address
// opens when the user clicks it.
function checkManagement({ namespace, method, args = [] }) {
  const [first, second] = args;
  if (namespace === "windows" && method === "create") for (const url of [first?.url ?? []].flat()) checkUrl(url);
  if (namespace === "bookmarks" && method === "create") checkUrl(first?.url);
  if (namespace === "bookmarks" && method === "update") checkUrl(second?.url);
}

// Throws when the request must not run.
export async function checkRequest(method, params) {
  if (method === "tabs.create" || method === "tabs.navigate") checkUrl(params.url);
  if (method === "cdp") {
    if (!cdpAllowed(params.method)) throw new Error(`${name} does not let agents send ${params.method}`);
    if (params.method === "Page.navigate") checkUrl(params.params?.url);
  }
  if (PAGE_METHODS.has(method)) await checkTab(params.tabId);
  if (method === "browser.manage") checkManagement(params);
}
