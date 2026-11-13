// Which tabs an agent session may reach. In the default mode, "agent tabs", a session reaches the tabs it
// opened (and those its pages opened from its input) plus the tabs the user shares in the toolbar popup;
// every other tab stays hidden: agents do not see its title or address, cannot bind, read, drive, close
// or move it. A window is the session's only when the session owns every tab in it: sharing a tab lets
// agents use that tab, not its window. The session sees only windows with a tab it may reach, and
// changes, focuses, activates tabs in or moves tabs into only its own windows. In "all tabs" mode, which the user chooses in the popup, sessions reach every tab, as
// before. The mode and the shares live in extension storage, which only the extension's pages and
// service worker can use, not its content scripts (see service-worker.js); agents cannot open those
// pages (see guard.js) or run JavaScript in its content scripts (see cdp.js).
//
// The session of a request comes from the hub's envelope, not from the request's parameters, so a
// session cannot act as another.

import { loadAgentState, tabOwner } from "./agent-state.js";
import { PAUSED_ERROR, isPaused } from "./pause.js";

const AGENT_TABS = "agent-tabs";
export const ALL_TABS = "all-tabs";

const name = chrome.runtime.getManifest().name;

// The mode and the shares are read from storage at every check, not kept in memory: a copy would be
// renewed only when the change event reaches the service worker, a moment after the popup's write, and
// a request in that moment would still see a share the user had stopped.
export async function accessMode() {
  const { accessMode: mode } = await chrome.storage.local.get("accessMode");
  return mode === ALL_TABS ? ALL_TABS : AGENT_TABS;
}

export function setAccessMode(mode) {
  return chrome.storage.local.set({ accessMode: mode === ALL_TABS ? ALL_TABS : AGENT_TABS });
}

// Shares end when the browser restarts, as tab IDs do.
export async function sharedTabs() {
  const { sharedTabs: ids } = await chrome.storage.session.get("sharedTabs");
  return new Set(Array.isArray(ids) ? ids : []);
}

// Changes the shares one change at a time. The popups and the service worker change them (a click on
// Stop, a shared tab that closes), and each change reads the list and writes it back, so two at once
// would undo each other and could bring back a share the user stopped. A Web Lock holds across all of
// the extension's pages and its worker; the browser releases it when the context holding it ends.
// `change` edits the set of tab IDs and returns false when it left it as it was.
function changeShares(change) {
  return navigator.locks.request("sharedTabs", async () => {
    const ids = await sharedTabs();
    if (change(ids) === false) return;
    await chrome.storage.session.set({ sharedTabs: [...ids] });
  });
}

export function setShared(tabId, shared) {
  return changeShares((ids) => {
    if (shared) ids.add(tabId);
    else ids.delete(tabId);
  });
}

// Shared tabs that closed, for a while: closing a tab is not stopping its share, so a download that the
// shared tab turned into (and closed for) is still the sharing sessions' (see downloads.js).
const CLOSED_SHARE_MEMORY_MS = 30_000;
const closedShares = new Set();

export function endShareOfClosedTab(tabId) {
  return changeShares((ids) => {
    if (!ids.delete(tabId)) return false;
    // Marked before the share is removed, so the removal does not read as the user stopping it.
    closedShares.add(tabId);
    setTimeout(() => closedShares.delete(tabId), CLOSED_SHARE_MEMORY_MS);
  });
}

export function wasSharedWhenClosed(tabId) {
  return closedShares.has(tabId);
}

// One reading of the mode, the shares and the tab owners, with the access rules over it. A listing reads
// storage once for all of its tabs; a check before an action takes a new reading.
async function accessReading() {
  const [mode, shared, { tabs }] = await Promise.all([accessMode(), sharedTabs(), loadAgentState()]);
  const owns = (sessionId, tabId) => Boolean(sessionId) && tabs[tabId]?.sessionId === sessionId;
  return {
    // Whether the session may use the tab.
    reaches: (sessionId, tabId) => mode === ALL_TABS || shared.has(tabId) || owns(sessionId, tabId),
    // Whether it may also close, discard, pin, move or group it. Those change the user's tab strip or lose
    // what the user has in the tab: a share covers using the tab, not that; "all tabs" mode covers it.
    rearranges: (sessionId, tabId) => mode === ALL_TABS || owns(sessionId, tabId),
    // Whether the window, which holds `windowTabs`, is the session's: it has tabs, and the session owns
    // every one of them. Agent tabs open in the user's windows, so a window with an agent tab is not the
    // session's for that alone; nor is a window with a shared tab, which the user shared alone.
    ownsWindow: (sessionId, windowTabs) => mode === ALL_TABS || (windowTabs.length > 0 && windowTabs.every((tab) => owns(sessionId, tab.id))),
  };
}

// Whether `sessionId` may reach the tab.
export async function mayAccess(sessionId, tabId) {
  return (await accessReading()).reaches(sessionId, tabId);
}

// Whether `sessionId` may close, discard, pin, move or group the tab.
export async function mayRearrange(sessionId, tabId) {
  return (await accessReading()).rearranges(sessionId, tabId);
}

// Whether any session may reach the tab: a tab nobody may reach keeps no debugger attached.
export async function anyoneMayAccess(tabId) {
  if ((await accessMode()) === ALL_TABS) return true;
  if ((await sharedTabs()).has(tabId)) return true;
  return Boolean(await tabOwner(tabId));
}

// The sessions that may use the tab now, for routing the tab's events: null for every session (all tabs
// mode, or a shared tab), the owner, or nobody.
export async function audienceOf(tabId) {
  if ((await accessMode()) === ALL_TABS || (await sharedTabs()).has(tabId)) return null;
  const owner = await tabOwner(tabId);
  return owner ? [owner] : [];
}

// The sessions in both audiences (null meaning every session).
export function bothAudiences(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((sessionId) => b.includes(sessionId));
}

function notSharedError(tabId) {
  return new Error(
    `Tab ${tabId} is not one of this session's tabs, and the user has not shared it. ${name} lets agents use the tabs they open and the tabs the user shares. Ask the user to switch to that tab and click "Share this tab" in the ${name} toolbar popup, then retry; or open the page in your own tab with cua.createBrowserTab.`,
  );
}

function sharedNotOwnError(tabId) {
  return new Error(`Tab ${tabId} is shared with agents, so its place in the tab strip stays the user's, and so does closing it: agents may not close, discard, pin, move or group it.`);
}

function notOwnWindowError(windowId) {
  return new Error(
    `Window ${windowId} holds tabs that are not this session's. Agents may change, focus, switch tabs in and move tabs into only windows whose every tab they opened; a tab the user shares does not share its window. Open your own window with management.windows.create.`,
  );
}

// A tab that closed is nobody's anymore, so a request for it would read as one for a hidden tab. Sharing
// cannot bring it back, so in every access mode the agent is told that the tab is gone. Tab IDs are not
// reused. Resolves with the tab.
export async function existingTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`Tab ${tabId} does not exist: it was closed (by the agent, the user or its page), or the ID is wrong. List the open tabs with cua.listTabs(), or open the page again with cua.createBrowserTab.`);
  return tab;
}

export async function requireAccess(sessionId, tabId) {
  await existingTab(tabId);
  if (!(await mayAccess(sessionId, tabId))) throw notSharedError(tabId);
}

// The check right before an agent's action takes effect: agents are not paused, and the session may use
// the tabs in `reach`, rearrange those in `rearrange` (close, discard, pin, move or group them) and change
// the windows in `windows`. It takes one new reading, so a pause, a share the user stopped or a change of
// the access mode while the action was being prepared stops it. The caller acts right after it resolves,
// with no other await in between: a check made before an await may no longer hold after it.
export async function requireAgentEffect(sessionId, { reach = [], rearrange = [], windows = [] } = {}) {
  for (const windowId of windows) if (!Number.isInteger(windowId) || windowId < 0) throw new Error(`Name the window by its ID, not ${JSON.stringify(windowId)}`);
  const [paused, reading, windowTabs] = await Promise.all([isPaused(), accessReading(), Promise.all(windows.map((windowId) => chrome.tabs.query({ windowId })))]);
  if (paused) throw new Error(PAUSED_ERROR);
  // A refused tab that closed meanwhile is reported as gone.
  const refuse = async (tabId, error) => {
    await existingTab(tabId);
    return error;
  };
  for (const tabId of reach) if (!reading.reaches(sessionId, tabId)) throw await refuse(tabId, notSharedError(tabId));
  for (const tabId of rearrange) {
    if (!reading.rearranges(sessionId, tabId)) throw await refuse(tabId, reading.reaches(sessionId, tabId) ? sharedNotOwnError(tabId) : notSharedError(tabId));
  }
  windows.forEach((windowId, i) => {
    if (!reading.ownsWindow(sessionId, windowTabs[i])) throw notOwnWindowError(windowId);
  });
}

// A request that closes, discards, pins, moves or groups the tab is refused early when the session may not.
export function requireOwnTab(sessionId, tabId) {
  return requireAgentEffect(sessionId, { rearrange: [tabId] });
}

// Whether the session sees the window: it holds a tab the session may reach.
export async function seesWindow(sessionId, windowId) {
  for (const tab of await chrome.tabs.query({ windowId })) if (await mayAccess(sessionId, tab.id)) return true;
  return false;
}

// The tabs of a list that the session may reach, and how many others there are.
export async function visibleTabs(sessionId, tabs) {
  const reading = await accessReading();
  const shown = tabs.filter((tab) => reading.reaches(sessionId, tab.id));
  return { shown, hidden: tabs.length - shown.length };
}
