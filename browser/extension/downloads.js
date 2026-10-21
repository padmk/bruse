// Downloads by tab. A page that starts a download reports its URL over the debugger
// (Page.downloadWillBegin); the downloads API then reports the item without saying which tab started
// it. Each report is paired with the first unpaired item at that URL, in either order, so two tabs
// downloading the same URL get one file each. A tab waiting for a download takes its own next one.
// A download that starts in a tab the waiting tab opened from the agent's input counts for the waiting
// tab. Downloads that no tab reported are never handed out.

import { cdp, onCdpEvent, sinceAgentInput } from "./cdp.js";
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
const EARLY_INPUT_MS = 1_500;
const intercepting = new Map(); // tab id -> timer that ends the interception
const RENDERED_TYPES = /^(text\/|image\/|audio\/|video\/|application\/(xhtml\+xml|xml|json|pdf|javascript))/i;

function stopIntercepting(tabId) {
  if (!intercepting.has(tabId)) return;
  clearTimeout(intercepting.get(tabId));
  intercepting.delete(tabId);
  cdp(tabId, "Fetch.disable", {}).catch(() => {});
}

// Interception starts as early as possible, before it is known whether the agent opened the tab,
// because the response may come within milliseconds: when the tab is created, if a waiting tab's page
// just reported an opening after the agent's input, or at the latest when the browser reports the tab
// with its opener. A tab that turns out to be the user's is let go and its report ignored.
const pageOpenedAt = new Map(); // waiting tab id -> when its page last reported an opening

onCdpEvent((tabId, method) => {
  if (method === "Page.windowOpen" && waitingTab(tabId) !== null) pageOpenedAt.set(tabId, Date.now());
});

function intercept(tabId) {
  if (intercepting.has(tabId)) return;
  undecided.set(tabId, undecided.get(tabId) ?? []);
  intercepting.set(tabId, setTimeout(() => stopIntercepting(tabId), INTERCEPT_MS));
  cdp(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] }).catch(() => intercepting.delete(tabId));
}

chrome.tabs.onCreated.addListener((tab) => {
  const opening = [...pageOpenedAt].some(([source, at]) => Date.now() - at < EARLY_INPUT_MS && sinceAgentInput(source) < EARLY_INPUT_MS);
  if (opening) intercept(tab.id);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
  if (waitingTab(sourceTabId) === null || sinceAgentInput(sourceTabId) > EARLY_INPUT_MS) return;
  popups.set(tabId, { url, at: Date.now(), endedAt: null });
  intercept(tabId);
});

const agentOpened = new Map(); // tab id -> whether the agent opened it, once known
const undecided = new Map(); // new tab id -> download ids that wait for that decision
onTabOpened((openerTabId, tabId, url, byAgent) => {
  agentOpened.set(tabId, byAgent);
  const held = undecided.get(tabId) ?? [];
  undecided.delete(tabId);
  if (byAgent) for (const downloadId of held) assign(downloadId, tabId);
  if (!byAgent) {
    stopIntercepting(tabId);
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i].tabId === tabId) reports.splice(i, 1);
  }
});

onCdpEvent((tabId, method, params) => {
  if (method !== "Fetch.requestPaused" || !intercepting.has(tabId)) return;
  const header = (name) => params.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const isFile = /attachment/i.test(header("content-disposition")) || (params.responseStatusCode < 300 && !RENDERED_TYPES.test(header("content-type")));
  const redirect = params.responseStatusCode >= 300 && params.responseStatusCode < 400;
  if (isFile && agentOpened.get(tabId) !== false) reportDownload(tabId, params.request.url);
  cdp(tabId, "Fetch.continueResponse", { requestId: params.requestId }).catch(() => {});
  // A redirect is followed by the response that decides.
  if (!redirect) stopIntercepting(tabId);
});

// When the held response was missed (the server answered before interception started), a popup the
// agent opened counts as the source of a download only if all of this holds: the download's URL is the
// URL the popup was opened for, the download was created after the popup, the popup's navigation ended
// without showing a page within moments of the download, and exactly one download and one popup fit.
// Anything ambiguous stays unassigned.
const FALLBACK_MATCH_MS = 1_000;
const popups = new Map(); // popup tab id -> { url, at, endedAt }

function popupEnded(tabId) {
  const popup = popups.get(tabId);
  if (!popup || popup.endedAt !== null) return;
  popup.endedAt = Date.now();
  // Wait a moment for a download item that comes right after the navigation ended.
  setTimeout(() => matchPopup(tabId), FALLBACK_MATCH_MS);
}

function matchPopup(tabId) {
  const popup = popups.get(tabId);
  popups.delete(tabId);
  if (!popup || agentOpened.get(tabId) === false) return;
  const items = unpairedItems.filter((item) => item.urls.includes(popup.url) && item.at >= popup.at && Math.abs(item.at - popup.endedAt) < FALLBACK_MATCH_MS);
  const rivals = [...popups.values()].filter((other) => other.url === popup.url && other.endedAt !== null && Math.abs(other.endedAt - popup.endedAt) < FALLBACK_MATCH_MS);
  if (items.length !== 1 || rivals.length) return;
  unpairedItems.splice(unpairedItems.indexOf(items[0]), 1);
  assign(items[0].id, tabId);
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => frameId === 0 && popups.delete(tabId));
chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId }) => frameId === 0 && popupEnded(tabId));

chrome.tabs.onRemoved.addListener((tabId) => {
  popupEnded(tabId);
  pageOpenedAt.delete(tabId);
  clearTimeout(intercepting.get(tabId));
  intercepting.delete(tabId);
  agentOpened.delete(tabId);
  undecided.delete(tabId);
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
  // A new tab whose opening is still being judged gets its downloads once that is decided.
  if (undecided.has(sourceTabId)) return undecided.get(sourceTabId).push(downloadId);
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
// A tab's own report that it downloads a URL. The browser reports a download (Page.downloadWillBegin,
// or a response the extension holds) before it creates the item, so a report only pairs with an item
// created after it; an item that already exists is someone else's, however close in time.
function reportDownload(tabId, url) {
  reports.push({ tabId, url, at: Date.now() });
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
