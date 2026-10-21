// Downloads by tab. A page that starts a download reports its URL over the debugger
// (Page.downloadWillBegin); the downloads API then reports the item without saying which tab started
// it. Each report is paired with the first unpaired item at that URL, in either order, so two tabs
// downloading the same URL get one file each. A tab waiting for a download takes its own next one.
// A download that starts in a tab the waiting tab opened from the agent's input counts for the waiting
// tab. Downloads that no tab reported are never handed out.

import { cdp, onCdpEvent } from "./cdp.js";
import { agentOpenerChain, onTabOpened } from "./sessions.js";

const MAX_REMEMBERED = 200;

// The tab waiting for a download from `tabId`: the tab itself or a tab whose agent actions opened it
// (directly or not; a tab the user opened ends the chain), or null when none of them waits.
function waitingTab(tabId) {
  for (const tab of [tabId, ...agentOpenerChain(tabId)]) {
    for (const waiter of waiters) if (waiter.claimed === null && waiter.tabId === tab) return tab;
  }
  return null;
}

// Tabs that waiting tabs opened from the agent's input may turn into a download (a link to an
// attachment with target=_blank) before the debugger could report it. Their first document response is
// held for a moment instead: when it is a file rather than a page, the tab reports that download itself,
// like Page.downloadWillBegin does, and the response goes on. Nothing is matched by URL alone.
const INTERCEPT_MS = 15_000;
const intercepting = new Map(); // tab id -> timer that ends the interception
const RENDERED_TYPES = /^(text\/|image\/|audio\/|video\/|application\/(xhtml\+xml|xml|json|pdf|javascript))/i;

function stopIntercepting(tabId) {
  if (!intercepting.has(tabId)) return;
  clearTimeout(intercepting.get(tabId));
  intercepting.delete(tabId);
  cdp(tabId, "Fetch.disable", {}).catch(() => {});
}

onTabOpened((openerTabId, tabId, url, byAgent) => {
  if (!byAgent || waitingTab(openerTabId) === null) return;
  intercepting.set(tabId, setTimeout(() => stopIntercepting(tabId), INTERCEPT_MS));
  cdp(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] }).catch(() => intercepting.delete(tabId));
});

onCdpEvent((tabId, method, params) => {
  if (method !== "Fetch.requestPaused" || !intercepting.has(tabId)) return;
  const header = (name) => params.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const isFile = /attachment/i.test(header("content-disposition")) || (params.responseStatusCode < 300 && !RENDERED_TYPES.test(header("content-type")));
  const redirect = params.responseStatusCode >= 300 && params.responseStatusCode < 400;
  if (isFile) reportDownload(tabId, params.request.url);
  cdp(tabId, "Fetch.continueResponse", { requestId: params.requestId }).catch(() => {});
  // A redirect is followed by the response that decides.
  if (!redirect) stopIntercepting(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(intercepting.get(tabId));
  intercepting.delete(tabId);
});

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

const PAIRING_WINDOW_MS = 30_000;
const REPORT_MATCH_MS = 2_000;
const reports = []; // { tabId, url, at } not yet paired with an item
const unpairedItems = []; // { id, urls, at }
const owners = new Map(); // download id -> tab id
const finished = new Map(); // download id -> "complete" | "interrupted"
const waiters = new Set(); // { tabId, since, claimed: download id | null, settle }

function expire(list) {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > PAIRING_WINDOW_MS) list.splice(i, 1);
}

function assign(downloadId, sourceTabId) {
  const tabId = waitingTab(sourceTabId) ?? sourceTabId;
  remember(owners, downloadId, tabId);
  for (const waiter of waiters) {
    if (waiter.claimed === null && waiter.tabId === tabId) {
      waiter.claimed = downloadId;
      break;
    }
  }
  update(downloadId);
}

function update(downloadId) {
  for (const waiter of waiters) if (waiter.claimed === downloadId && finished.has(downloadId)) waiter.settle(downloadId, finished.get(downloadId));
}

// A tab's own report that it downloads a URL. A report and its item come within moments of each
// other; an older item at the URL is someone else's.
function reportDownload(tabId, url) {
  expire(unpairedItems);
  const index = unpairedItems.findIndex((item) => item.urls.includes(url) && Date.now() - item.at < REPORT_MATCH_MS);
  if (index >= 0) assign(unpairedItems.splice(index, 1)[0].id, tabId);
  else reports.push({ tabId, url, at: Date.now() });
}

onCdpEvent((tabId, method, params) => {
  if (method === "Page.downloadWillBegin") reportDownload(tabId, params.url);
});

chrome.downloads.onCreated.addListener((item) => {
  expire(reports);
  const urls = [item.url, item.finalUrl].filter(Boolean);
  const index = reports.findIndex((report) => urls.includes(report.url) && Date.now() - report.at < REPORT_MATCH_MS);
  if (index >= 0) return assign(item.id, reports.splice(index, 1)[0].tabId);
  unpairedItems.push({ id: item.id, urls, at: Date.now() });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
  remember(finished, delta.id, delta.state.current);
  if (owners.has(delta.id)) update(delta.id);
});

// Resolves with the next download the tab starts once it completes. A newer wait for the same tab
// replaces an older one that got nothing (for example one left by an earlier call), so the newer one
// gets the next download.
export function waitForDownload(tabId, timeoutMs) {
  // Attaching makes sure the tab reports downloads; the waiter is registered first so nothing is missed.
  cdp(tabId, "Page.enable", {}).catch(() => {});
  return new Promise((resolve, reject) => {
    const waiter = {
      tabId,
      claimed: null,
      settle: async (downloadId, state) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        owners.delete(downloadId);
        finished.delete(downloadId);
        if (state === "interrupted") return reject(new Error("Download was interrupted"));
        const [item] = await chrome.downloads.search({ id: downloadId });
        resolve({ path: item.filename, url: item.finalUrl ?? item.url, mime: item.mime });
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error("The tab started no download that completed in time"));
    }, timeoutMs);
    for (const older of waiters) if (older.tabId === tabId && older.claimed === null) older.supersede();
    waiter.supersede = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
      reject(new Error("A newer wait for a download on this tab replaced this one"));
    };
    waiters.add(waiter);
  });
}
