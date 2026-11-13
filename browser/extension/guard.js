// Checks every agent request before the service worker runs it. Agents open and drive web pages (and
// blank, data and file pages) only: never the extension's own pages, which hold the user's switches,
// nor the browser's internal pages. Raw DevTools commands are limited to domains that act on the page
// in the tab they are sent to. In Network and Page, which also hold commands that reach the browser's
// cookie store or cache, register scripts for whatever page the tab loads next, choose where downloads
// go or bring the window to the front, only the listed commands pass, so a command added in a later
// browser version is refused until it is listed. Domains that reach other targets (Target, Browser),
// storage of any origin (Storage, DOMStorage, IndexedDB, CacheStorage), certificate checks (Security)
// or the machine (SystemInfo) are not on the list.

import { isRecord } from "./sender.js";
import { actsOn } from "./shared.js";

/** @typedef {import("./shared.js").Method} Method */

const name = chrome.runtime.getManifest().name;

const AGENT_SCHEMES = new Set(["http:", "https:", "about:", "data:", "file:", "blob:"]);
const ABOUT_PAGES = new Set(["blank", "srcdoc"]);

const ALLOWED_CDP_DOMAINS = new Set(["Accessibility", "Animation", "CSS", "DOM", "DOMSnapshot", "Emulation", "Input", "Log", "Overlay", "Performance", "Runtime"]);
const ALLOWED_CDP_METHODS = new Set([
  ...["enable", "disable", "getResponseBody", "getRequestPostData", "searchInResponseBody", "streamResourceContent", "replayXHR", "setAttachDebugStack", "setExtraHTTPHeaders", "setUserAgentOverride", "setCacheDisabled", "setBypassServiceWorker", "setBlockedURLs", "canEmulateNetworkConditions", "emulateNetworkConditions", "emulateNetworkConditionsByRule", "overrideNetworkState"].map((m) => `Network.${m}`),
  ...["enable", "disable", "navigate", "reload", "stopLoading", "getNavigationHistory", "navigateToHistoryEntry", "getFrameTree", "getResourceTree", "getResourceContent", "searchInResource", "getLayoutMetrics", "captureScreenshot", "captureSnapshot", "printToPDF", "startScreencast", "stopScreencast", "screencastFrameAck", "handleJavaScriptDialog", "setInterceptFileChooserDialog", "setLifecycleEventsEnabled", "setBypassCSP", "setDocumentContent", "getAppManifest", "removeScriptToEvaluateOnNewDocument", "close", "crash"].map((m) => `Page.${m}`),
]);

/** @param {unknown} method */
function cdpAllowed(method) {
  return typeof method === "string" && (ALLOWED_CDP_DOMAINS.has(method.split(".")[0]) || ALLOWED_CDP_METHODS.has(method));
}

// A relative address would open inside the extension, so only absolute ones pass.
/** @param {unknown} url */
function checkUrl(url) {
  if (url === undefined || url === null || url === "") return;
  let scheme;
  try {
    scheme = new URL(String(url)).protocol;
  } catch {
    throw new Error(`${name} lets agents open only absolute web addresses, not ${JSON.stringify(url)}`);
  }
  if (!AGENT_SCHEMES.has(scheme)) throw new Error(`${name} does not let agents open or use ${scheme} pages`);
  // The browser turns other about: addresses, such as about:settings, into its internal pages.
  if (scheme === "about:" && !ABOUT_PAGES.has(new URL(String(url)).pathname)) throw new Error(`${name} lets agents open only about:blank and about:srcdoc, not ${JSON.stringify(url)}`);
}

/** @param {unknown} tabId */
async function checkTab(tabId) {
  if (typeof tabId !== "number") throw new Error(`${name} needs the ID of the tab, not ${JSON.stringify(tabId)}`);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  checkUrl(tab.url);
  checkUrl(tab.pendingUrl);
}

// Management methods that take addresses: windows.create({ url }) opens them, and a bookmark's address
// opens when the user clicks it.
/** @param {Record<string, unknown>} params */
function checkManagement({ namespace, method, args = [] }) {
  if (!Array.isArray(args)) throw new Error("browser.manage takes the method's arguments as an array");
  /** @type {unknown[]} */
  const list = args;
  const [first, second] = list.map((arg) => (isRecord(arg) ? arg.url : undefined));
  if (namespace === "windows" && method === "create") for (const url of [first ?? []].flat()) checkUrl(url);
  if (namespace === "bookmarks" && method === "create") checkUrl(first);
  if (namespace === "bookmarks" && method === "update") checkUrl(second);
}

// Throws when the request must not run. It reads `params` as the hub sent them, each field unknown.
/** @param {Method} method @param {Record<string, unknown>} params */
export async function checkRequest(method, params) {
  if (method === "tabs.create" || method === "tabs.navigate") checkUrl(params.url);
  if (method === "cdp") {
    if (!cdpAllowed(params.method)) throw new Error(`${name} does not let agents send ${String(params.method)}`);
    if (params.method === "Page.navigate") checkUrl(isRecord(params.params) ? params.params.url : undefined);
  }
  // Requests that read or act on the page of params.tabId.
  if (actsOn(method, "page")) await checkTab(params.tabId);
  if (method === "browser.manage") checkManagement(params);
}
