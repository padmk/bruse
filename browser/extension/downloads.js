// Downloads by tab. A page that starts a download reports its URL over the debugger
// (Page.downloadWillBegin); the downloads API then reports the item without saying which tab started
// it. Each report is paired with the first unpaired item at that URL, in either order, so two tabs
// downloading the same URL get one file each. A tab waiting for a download takes its own next one.
// A download from a tab without the debugger (typically a tab the waiting page just opened for it) is
// never reported; after a short grace it goes to the one waiting tab that opened a tab recently, or to
// the only waiting tab.

import { cdp, onCdpEvent } from "./cdp.js";
import { onTabOpened } from "./sessions.js";

const UNREPORTED_GRACE_MS = 1_500;
const OPENER_WINDOW_MS = 30_000;
const MAX_REMEMBERED = 200;
const openedAt = new Map(); // opener tab id -> when it last opened a tab
onTabOpened((openerTabId) => openedAt.set(openerTabId, Date.now()));

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

const PAIRING_WINDOW_MS = 30_000;
const reports = []; // { tabId, url, at } not yet paired with an item
const unpairedItems = []; // { id, urls, at }
const owners = new Map(); // download id -> tab id
const finished = new Map(); // download id -> "complete" | "interrupted"
const waiters = new Set(); // { tabId, since, claimed: download id | null, settle }

function expire(list) {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > PAIRING_WINDOW_MS) list.splice(i, 1);
}

function assign(downloadId, tabId) {
  remember(owners, downloadId, tabId);
  for (const waiter of waiters) {
    if (waiter.claimed === null && waiter.tabId === tabId) {
      waiter.claimed = downloadId;
      break;
    }
  }
  update(downloadId);
}

function assignUnreported(downloadId) {
  const index = unpairedItems.findIndex((item) => item.id === downloadId);
  if (index < 0) return;
  const open = [...waiters].filter((waiter) => waiter.claimed === null);
  const openers = open.filter((waiter) => Date.now() - (openedAt.get(waiter.tabId) ?? 0) < OPENER_WINDOW_MS);
  const tabs = new Set((openers.length ? openers : open).map((waiter) => waiter.tabId));
  if (tabs.size !== 1) return;
  unpairedItems.splice(index, 1);
  assign(downloadId, [...tabs][0]);
}

function update(downloadId) {
  for (const waiter of waiters) if (waiter.claimed === downloadId && finished.has(downloadId)) waiter.settle(downloadId, finished.get(downloadId));
}

onCdpEvent((tabId, method, params) => {
  if (method !== "Page.downloadWillBegin") return;
  expire(unpairedItems);
  const index = unpairedItems.findIndex((item) => item.urls.includes(params.url));
  if (index >= 0) assign(unpairedItems.splice(index, 1)[0].id, tabId);
  else reports.push({ tabId, url: params.url, at: Date.now() });
});

chrome.downloads.onCreated.addListener((item) => {
  expire(reports);
  const urls = [item.url, item.finalUrl].filter(Boolean);
  const index = reports.findIndex((report) => urls.includes(report.url));
  if (index >= 0) assign(item.id, reports.splice(index, 1)[0].tabId);
  else {
    unpairedItems.push({ id: item.id, urls, at: Date.now() });
    setTimeout(() => assignUnreported(item.id), UNREPORTED_GRACE_MS);
  }
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
