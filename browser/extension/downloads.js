// Downloads by tab. A page that starts a download reports its URL over the debugger
// (Page.downloadWillBegin); the downloads API then reports the item without saying which tab started
// it. Each report is paired with the first unpaired item at that URL, in either order, so two tabs
// downloading the same URL get one file each. A tab waiting for a download takes its own next one.
// A download that starts in a tab the waiting tab opened from the agent's input counts for the waiting
// tab. Downloads that no tab reported are never handed out.

import { EXTENSION_WORK, cdp, onCdpEvent, sinceAgentInput } from "./cdp.js";
import { ALL_TABS, accessMode, sharedTabs, wasSharedWhenClosed } from "./access.js";
import { tabOwner } from "./agent-state.js";
import { agentOpenerChain, onTabOpened, rememberedOwner } from "./sessions.js";
import { PAUSED_ERROR, onPausedChange } from "./pause.js";
import { AGENT_INPUT_WINDOW_MS } from "./shared.js";

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
  cdp(tabId, "Fetch.disable", {}, undefined, undefined, EXTENSION_WORK).catch(() => {});
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
  cdp(tabId, "Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Response" }] }, undefined, undefined, EXTENSION_WORK).catch(() => intercepting.delete(tabId));
}

// Tabs the agent or the user creates have no opener; only a page's opening can be a download.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  const opening = [...pageOpenedAt].some(([source, at]) => Date.now() - at < AGENT_INPUT_WINDOW_MS && sinceAgentInput(source) < AGENT_INPUT_WINDOW_MS);
  if (opening) intercept(tab.id);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
  // The page's reported opening has its tab now.
  pageOpenedAt.delete(sourceTabId);
  if (waitingTab(sourceTabId) === null || sinceAgentInput(sourceTabId) > AGENT_INPUT_WINDOW_MS) return;
  const popup = { url, at: Date.now(), endedAt: null, referrer: null };
  popups.set(tabId, popup);
  chrome.tabs.get(sourceTabId).then((source) => (popup.referrer = source.url), () => {});
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
  if (isFile && agentOpened.get(tabId) !== false) reportDownload(tabId, params.request.url, "held");
  cdp(tabId, "Fetch.continueResponse", { requestId: params.requestId }, undefined, undefined, EXTENSION_WORK).catch(() => {});
  // A redirect is followed by the response that decides.
  if (!redirect) stopIntercepting(tabId);
});

// When the held response was missed (the server answered before interception started), a popup the
// agent opened counts as the source of a download only if all of this holds: the download's URL is the
// URL the popup was opened for, its referrer is the page that opened the popup, it was created after
// the popup, the popup's navigation ended without showing a page within moments of the download, and
// exactly one download and one popup fit.
// Anything ambiguous stays unassigned.
const FALLBACK_MATCH_MS = 1_000;
const popups = new Map(); // popup tab id -> { url, at, endedAt, referrer }
const endedPopups = []; // popups whose navigation ended, kept for a while to judge ambiguity

function popupEnded(tabId) {
  const popup = popups.get(tabId);
  if (!popup || popup.endedAt !== null) return;
  popup.endedAt = Date.now();
  endedPopups.push(popup);
  // Wait a moment for a download item that comes right after the navigation ended.
  setTimeout(() => matchPopup(tabId), FALLBACK_MATCH_MS);
}

// A referrer may be cut to the origin by the page's referrer policy.
function referredBy(referrer, page) {
  if (!referrer || !page) return false;
  try {
    return referrer === page || referrer === `${new URL(page).origin}/`;
  } catch {
    return false;
  }
}

function matchPopup(tabId) {
  const popup = popups.get(tabId);
  popups.delete(tabId);
  for (let i = endedPopups.length - 1; i >= 0; i--) if (Date.now() - endedPopups[i].endedAt > 3 * FALLBACK_MATCH_MS) endedPopups.splice(i, 1);
  if (!popup || agentOpened.get(tabId) === false) return;
  // The download was asked for by the page that opened the popup.
  const items = unpairedItems.filter(
    (item) => item.urls.includes(popup.url) && item.at >= popup.at && Math.abs(item.at - popup.endedAt) < FALLBACK_MATCH_MS && referredBy(item.referrer, popup.referrer),
  );
  const rivals = endedPopups.filter((other) => other !== popup && other.url === popup.url && Math.abs(other.endedAt - popup.endedAt) < FALLBACK_MATCH_MS);
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
const reports = []; // { tabId, url, source: "held" | "debugger", at } not yet paired with an item
const unpairedItems = []; // { id, urls, at }
const owners = new Map(); // download id -> tab id
const finished = new Map(); // download id -> "complete" | "interrupted"
const waiters = new Set(); // { tabId, claimed: download id | null, settle, fail, supersede }

function expire(list) {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > PAIRING_WINDOW_MS) list.splice(i, 1);
}

// Why the waiting session may have a file that `tabId` downloaded, or null: "all-tabs" (the mode lets
// it use every tab), "share" (the user shares the tab, also one that closed as it turned into the
// download) or "owner" (the session owns the tab, also a popup that closed and was opened for it). A wait
// in one tab never receives a file from a tab of another session that its tab opened.
async function proofOfAccess(sessionId, tabId) {
  if ((await accessMode()) === ALL_TABS) return "all-tabs";
  // The tab may close during this check; tab IDs are not reused, so a share it closed with still counts.
  if ((await sharedTabs()).has(tabId) || wasSharedWhenClosed(tabId)) return "share";
  const open = await chrome.tabs.get(tabId).then(() => true, () => false);
  const owner = open ? await tabOwner(tabId) : rememberedOwner(tabId);
  return sessionId && owner === sessionId ? "owner" : null;
}

// A download's pairing with its source tab, made when the download is matched and withdrawn when that
// match proves ambiguous (also before a deferred match is made); a grant that a waiting call holds
// refers to it.
const pairings = new Map(); // download id -> { valid }

async function assign(downloadId, sourceTabId) {
  // A new tab whose opening is still being judged gets its downloads once that is decided.
  if (undecided.has(sourceTabId)) return undecided.get(sourceTabId).push(downloadId);
  const pairing = pairings.get(downloadId) ?? { valid: true };
  if (!pairing.valid) return;
  remember(pairings, downloadId, pairing);
  const tabId = waitingTab(sourceTabId) ?? sourceTabId;
  remember(owners, downloadId, tabId);
  for (const waiter of [...waiters]) {
    if (waiter.claimed !== null || waiter.tabId !== tabId) continue;
    const proof = await proofOfAccess(waiter.sessionId, sourceTabId);
    // The pairing may have been withdrawn, or the waiter claimed or ended, while access was checked.
    if (!pairing.valid) return;
    if (!proof || waiter.claimed !== null || !waiters.has(waiter)) continue;
    // From here the grant, not the tab, decides: the tab may close (a popup that turned into the
    // download) without taking the file away; the user stopping the share or switching modes does.
    waiter.claimed = downloadId;
    waiter.grant = { source: sourceTabId, proof, pairing, revoked: false };
    break;
  }
  update(downloadId);
}

// The user's explicit changes end grants that rested on them: stopping the share of a tab that is still
// open (a closed tab's share ends with it, which is no revocation), or switching to agent tabs.
// Decided at once, so a download that completes meanwhile cannot slip past the revocation.
chrome.storage.onChanged.addListener((changes, area) => {
  const revoke = (matches) => {
    for (const waiter of waiters) {
      if (!waiter.grant || waiter.grant.revoked || !matches(waiter.grant)) continue;
      waiter.grant.revoked = true;
      waiter.fail(new Error("The user stopped sharing the tab the download came from, or changed which tabs agents may use"));
    }
  };
  if (area === "local" && changes.accessMode?.newValue !== undefined && changes.accessMode.newValue !== ALL_TABS) revoke((grant) => grant.proof === "all-tabs");
  if (area === "session" && "sharedTabs" in changes) {
    // Only shares this change removed; a tab that closed is marked before its share is removed (access.js).
    const now = new Set(changes.sharedTabs.newValue ?? []);
    const stopped = new Set((changes.sharedTabs.oldValue ?? []).filter((tabId) => !now.has(tabId) && !wasSharedWhenClosed(tabId)));
    revoke((grant) => grant.proof === "share" && stopped.has(grant.source));
  }
});

// Pausing ends every wait, so no file reaches an agent after the user paused.
onPausedChange((paused) => {
  if (paused) for (const waiter of [...waiters]) waiter.fail(new Error(PAUSED_ERROR));
});

const pairedAt = new Map(); // download id -> when a report paired it

function update(downloadId) {
  const wait = (pairedAt.get(downloadId) ?? 0) + AMBIGUITY_MS - Date.now();
  if (wait > 0) return void setTimeout(() => update(downloadId), wait);
  pairedAt.delete(downloadId);
  for (const waiter of waiters) if (waiter.claimed === downloadId && finished.has(downloadId)) waiter.settle(downloadId, finished.get(downloadId));
}

// A tab's own report that it downloads a URL. The browser reports a download (Page.downloadWillBegin,
// or a response the extension holds) before it creates the item, so a report only pairs with an item
// created after it; an item that already exists is someone else's, however close in time.
function reportDownload(tabId, url, source) {
  reports.push({ tabId, url, source, at: Date.now() });
}

onCdpEvent((tabId, method, params) => {
  if (method === "Page.downloadWillBegin") reportDownload(tabId, params.url, "debugger");
});

// A report pairs with the first item at its URL created after it; the tab's own item follows its report
// within moments. If a second item at that URL comes within AMBIGUITY_MS of the report without a report
// of its own, either could be the tab's: the pairing is withdrawn and the waiting call fails instead of
// returning someone else's file. Paired downloads are handed out only after that window.
const AMBIGUITY_MS = 150;
const recentPairs = []; // { urls, at, itemId } report pairings still open to doubt

chrome.downloads.onCreated.addListener((item) => {
  expire(reports);
  // The popup fallback looks only at items from the last moments, so older ones can go.
  expire(unpairedItems);
  const now = Date.now();
  const urls = [item.url, item.finalUrl].filter(Boolean);
  for (let i = recentPairs.length - 1; i >= 0; i--) if (now - recentPairs[i].at > AMBIGUITY_MS) recentPairs.splice(i, 1);
  const index = reports.findIndex((report) => urls.includes(report.url) && now - report.at < REPORT_MATCH_MS);
  if (index >= 0) {
    const [report] = reports.splice(index, 1);
    // A held response and Page.downloadWillBegin may both report this download; the other report must
    // not pair with another tab's item. Two reports from one source are two downloads.
    const twin = reports.findIndex((other) => other.tabId === report.tabId && other.url === report.url && other.source !== report.source);
    if (twin >= 0) reports.splice(twin, 1);
    recentPairs.push({ urls, at: report.at, itemId: item.id });
    pairedAt.set(item.id, report.at);
    return assign(item.id, report.tabId);
  }
  const doubted = recentPairs.find((pair) => pair.urls.some((url) => urls.includes(url)));
  if (doubted) withdraw(doubted.itemId);
  unpairedItems.push({ id: item.id, urls, at: now, referrer: item.referrer });
});

function withdraw(downloadId) {
  owners.delete(downloadId);
  if (pairings.has(downloadId)) pairings.get(downloadId).valid = false;
  else remember(pairings, downloadId, { valid: false });
  for (const waiter of waiters) {
    if (waiter.claimed === downloadId) waiter.fail(new Error("Another download of the same URL started at the same moment, so it is unclear which file came from this tab; check the downloads folder"));
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
  remember(finished, delta.id, delta.state.current);
  if (owners.has(delta.id)) update(delta.id);
});

// Resolves with the next download the tab starts once it completes. A newer wait for the same tab
// replaces an older one that got nothing (for example one left by an earlier call), so the newer one
// gets the next download.
// `caller` is the agent request's { session }; the file goes to it only from a tab it may use.
export function waitForDownload(tabId, timeoutMs, caller) {
  // Attaching makes sure the tab reports downloads; the waiter is registered first so nothing is missed.
  cdp(tabId, "Page.enable", {}, undefined, undefined, caller).catch(() => {});
  return new Promise((resolve, reject) => {
    const waiter = {
      tabId,
      sessionId: caller?.session ?? null,
      claimed: null,
      grant: null,
      settle: async (downloadId, state) => {
        clearTimeout(timer);
        owners.delete(downloadId);
        finished.delete(downloadId);
        // The grant made when the download was matched decides, not the state of a tab that may have
        // closed. The waiter and its pairing stay registered until the result goes out, so that stopping
        // the share, switching modes or a doubted match while the item is looked up still ends the grant.
        const granted = () => waiters.has(waiter) && waiter.grant && !waiter.grant.revoked && waiter.grant.pairing.valid;
        const withdrawn = () => new Error("The download's match with this tab was withdrawn or its access revoked");
        try {
          if (!granted()) throw withdrawn();
          if (state === "interrupted") throw new Error("Download was interrupted");
          const [item] = await chrome.downloads.search({ id: downloadId });
          if (!granted()) throw withdrawn();
          if (!item) throw new Error("The download is no longer in the browser's list of downloads");
          resolve({ path: item.filename, url: item.finalUrl ?? item.url, mime: item.mime });
        } catch (error) {
          reject(error);
        } finally {
          waiters.delete(waiter);
          pairings.delete(downloadId);
        }
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error("The tab started no download that completed in time"));
    }, timeoutMs);
    for (const older of waiters) if (older.tabId === tabId && older.claimed === null) older.supersede();
    waiter.fail = (error) => {
      clearTimeout(timer);
      waiters.delete(waiter);
      reject(error);
    };
    waiter.supersede = () => waiter.fail(new Error("A newer wait for a download on this tab replaced this one"));
    waiters.add(waiter);
  });
}
