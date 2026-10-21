// Downloads by tab. A page that starts a download reports its URL over the debugger
// (Page.downloadWillBegin); the downloads API then reports the item without saying which tab started
// it. Each report is paired with the first unpaired item at that URL, in either order, so two tabs
// downloading the same URL get one file each. A tab waiting for a download takes its own next one.
// A download that starts in a tab the waiting tab opened counts for the waiting tab. Such tabs are
// attached as soon as they open so that they report their downloads; a tab that turns into a download
// before that (a link to an attachment with target=_blank) is matched by the URL the browser reported
// it was opened for. Downloads with no such evidence are never handed out.

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

const OPENED_TAB_WINDOW_MS = 15_000;
const ABORT_MATCH_MS = 2_000;
// Tabs that waiting tabs opened from the agent's input and that may turn into a download (a link to an
// attachment with target=_blank) before they can report it. Such a download is theirs only with two
// pieces of evidence: an item at the URL the tab was opened for, and the tab's own navigation ending
// without a page (it turned into the download) at about the same time. A tab that shows a page is
// dropped. Any other download at that URL stays unassigned.
const openedTabs = []; // { tabId, url, at, endedAt }
const candidates = []; // { itemId, tabId, at } items at an opened tab's URL, awaiting its navigation's end

onTabOpened((openerTabId, tabId, url, byAgent) => {
  if (!byAgent || waitingTab(openerTabId) === null) return;
  cdp(tabId, "Page.enable", {}).catch(() => {});
  // The tab exists before its download does, so only later downloads can be its own.
  openedTabs.push({ tabId, url, at: Date.now(), endedAt: null });
});

function dropOpenedTab(tabId) {
  const index = openedTabs.findIndex((tab) => tab.tabId === tabId);
  if (index >= 0) openedTabs.splice(index, 1);
  for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].tabId === tabId) candidates.splice(i, 1);
}

function navigationEnded(tabId) {
  const tab = openedTabs.find((entry) => entry.tabId === tabId);
  if (!tab) return;
  tab.endedAt = Date.now();
  const index = candidates.findIndex((c) => c.tabId === tabId && Math.abs(tab.endedAt - c.at) < ABORT_MATCH_MS);
  if (index >= 0) {
    const [candidate] = candidates.splice(index, 1);
    dropOpenedTab(tabId);
    const item = unpairedItems.findIndex((entry) => entry.id === candidate.itemId);
    if (item < 0) return; // a report of the tab already paired it
    unpairedItems.splice(item, 1);
    assign(candidate.itemId, tabId);
  }
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => frameId === 0 && dropOpenedTab(tabId));
chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId }) => frameId === 0 && navigationEnded(tabId));
chrome.tabs.onRemoved.addListener((tabId) => navigationEnded(tabId));

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

onCdpEvent((tabId, method, params) => {
  if (method !== "Page.downloadWillBegin") return;
  expire(unpairedItems);
  // A report and its item come within moments of each other; an older item at the URL is someone else's.
  const index = unpairedItems.findIndex((item) => item.urls.includes(params.url) && Date.now() - item.at < REPORT_MATCH_MS);
  if (index >= 0) assign(unpairedItems.splice(index, 1)[0].id, tabId);
  else reports.push({ tabId, url: params.url, at: Date.now() });
});

chrome.downloads.onCreated.addListener((item) => {
  expire(reports);
  const urls = [item.url, item.finalUrl].filter(Boolean);
  const index = reports.findIndex((report) => urls.includes(report.url) && Date.now() - report.at < REPORT_MATCH_MS);
  if (index >= 0) return assign(item.id, reports.splice(index, 1)[0].tabId);
  unpairedItems.push({ id: item.id, urls, at: Date.now() });
  for (let i = openedTabs.length - 1; i >= 0; i--) if (Date.now() - openedTabs[i].at > OPENED_TAB_WINDOW_MS) openedTabs.splice(i, 1);
  const opened = openedTabs.find((tab) => urls.includes(tab.url));
  if (!opened) return;
  if (opened.endedAt !== null && Date.now() - opened.endedAt < ABORT_MATCH_MS) {
    unpairedItems.pop();
    dropOpenedTab(opened.tabId);
    return assign(item.id, opened.tabId);
  }
  candidates.push({ itemId: item.id, tabId: opened.tabId, at: Date.now() });
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
