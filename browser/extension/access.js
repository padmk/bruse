// Which tabs an agent session may reach. In the default mode, "agent tabs", a session reaches the tabs it
// opened (and those its pages opened from its input) plus the tabs the user shares in the toolbar popup;
// every other tab stays hidden: agents do not see its title or address, cannot bind, read, drive, close
// or rearrange it. In "all tabs" mode, which the user chooses in the popup, sessions reach every tab, as
// before. The mode and the shares live in extension storage, which only the extension's pages change;
// agents cannot open those pages (see guard.js).
//
// The session of a request comes from the hub's envelope, not from the request's parameters, so a
// session cannot act as another.

import { tabOwner } from "./agent-state.js";

export const AGENT_TABS = "agent-tabs";
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

export async function setShared(tabId, shared) {
  const ids = await sharedTabs();
  if (shared) ids.add(tabId);
  else ids.delete(tabId);
  await chrome.storage.session.set({ sharedTabs: [...ids] });
}

// Shared tabs that closed, for a while: closing a tab is not stopping its share, so a download that the
// shared tab turned into (and closed for) is still the sharing sessions' (see downloads.js).
const CLOSED_SHARE_MEMORY_MS = 30_000;
const closedShares = new Set();

export async function endShareOfClosedTab(tabId) {
  if (!(await sharedTabs()).has(tabId)) return;
  closedShares.add(tabId);
  setTimeout(() => closedShares.delete(tabId), CLOSED_SHARE_MEMORY_MS);
  await setShared(tabId, false);
}

export function wasSharedWhenClosed(tabId) {
  return closedShares.has(tabId);
}

// Whether `sessionId` may reach the tab.
export async function mayAccess(sessionId, tabId) {
  if ((await accessMode()) === ALL_TABS) return true;
  if ((await sharedTabs()).has(tabId)) return true;
  return Boolean(sessionId) && (await tabOwner(tabId)) === sessionId;
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

export function notSharedError(tabId) {
  return new Error(
    `Tab ${tabId} is not one of this session's tabs, and the user has not shared it. ${name} lets agents use the tabs they open and the tabs the user shares. Ask the user to switch to that tab and click "Share this tab" in the ${name} toolbar popup, then retry; or open the page in your own tab with cua.createBrowserTab.`,
  );
}

export async function requireAccess(sessionId, tabId) {
  if (!(await mayAccess(sessionId, tabId))) throw notSharedError(tabId);
}

// The tabs of a list that the session may reach, and how many others there are.
export async function visibleTabs(sessionId, tabs) {
  const shown = [];
  for (const tab of tabs) if (await mayAccess(sessionId, tab.id)) shown.push(tab);
  return { shown, hidden: tabs.length - shown.length };
}
