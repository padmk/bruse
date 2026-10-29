// Agent sessions: tabs an agent session opened, the one agent tab group per window that holds the tabs
// of all live sessions, and cleanup when a session ends or its server is gone. State lives in
// chrome.storage.local so it survives service worker restarts and extension reloads, while MCP servers
// keep their sessions; tab and group IDs change when the browser starts, so it starts empty then.

import { loadAgentState as load, saveAgentState as save } from "./agent-state.js";
import { anyoneMayAccess } from "./access.js";
import { detach, onCdpEvent, sinceAgentInput } from "./cdp.js";
import { AGENT_INPUT_WINDOW_MS } from "./shared.js";

const GROUP_TITLE = "Claude";
const GROUP_COLOR = "orange";
// Marked tabs survive session cleanup: deliverables are results for the user, handoffs wait for later work.
const KEPT_MARKS = new Set(["deliverable", "handoff"]);

// Read-modify-write operations on the state run one at a time so concurrent requests do not
// overwrite each other's changes.
let queue = Promise.resolve();
function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

chrome.runtime.onStartup.addListener(() => serialized(() => chrome.storage.local.remove("agentState")));

chrome.tabs.onRemoved.addListener((tabId) =>
  serialized(async () => {
    const state = await load();
    if (!state.tabs[tabId]) return;
    delete state.tabs[tabId];
    await save(state);
  }),
);

// Tabs that pages open (target=_blank links, window.open, also with noopener) are reported by the
// browser together with the tab that opened them. A tab that a session's page opened in response to
// the agent's input belongs to that session. Other new tabs, including ones the user opens from such a
// page or moves into the agent group, belong to none.
const openedListeners = new Set();
const agentAncestorsOf = new Map(); // tab id -> tabs whose agent actions led to it, nearest first

// A page opened a tab from an agent action when both hold: the page itself reported the opening
// (Page.windowOpen: a link click or window.open, unlike the browser's own context menu commands) and
// the agent pressed a button or key in that tab just before, and that tab is not the one the user is
// looking at (the active tab of the focused window, where a click may be the user's). Other tabs
// opened from agent pages stay the user's.
const WINDOW_OPEN_MATCH_MS = 2_000;
const pageOpens = new Map(); // tab id -> [{ url, at, sessionId }] openings its page reported

// The session that caused an opening is fixed when the page reports it, from the input just before; an
// input that arrives while the browser's report is processed cannot change it.
onCdpEvent((tabId, method, params) => {
  if (method !== "Page.windowOpen") return;
  const list = (pageOpens.get(tabId) ?? []).filter((open) => Date.now() - open.at < WINDOW_OPEN_MATCH_MS);
  list.push({ url: normalizedUrl(params.url), at: Date.now(), sessionId: openingSession(tabId) });
  pageOpens.set(tabId, list);
});

function normalizedUrl(url) {
  if (!url || url === "about:blank") return "";
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

// The page's report of an opening of `url`, { url, at, sessionId }, or null.
function takePageOpen(tabId, url) {
  const list = pageOpens.get(tabId) ?? [];
  const index = list.findIndex((open) => open.url === normalizedUrl(url) && Date.now() - open.at < WINDOW_OPEN_MATCH_MS);
  return index >= 0 ? list.splice(index, 1)[0] : null;
}

export function onTabOpened(listener) {
  openedListeners.add(listener);
}

// When each session last pressed a button or key in each tab, so that a tab opened from an agent's input
// goes to the session that caused it. One entry per session, so no number of inputs from one session
// hides another's.
const inputSessions = new Map(); // tab id -> Map session id -> time of its latest press

export function noteAgentInput(tabId, sessionId) {
  if (!sessionId) return;
  if (!inputSessions.has(tabId)) inputSessions.set(tabId, new Map());
  inputSessions.get(tabId).set(sessionId, Date.now());
}

// The one session that pressed input in the tab within the input window, or null when none or several
// did: an opening that two sessions may have caused belongs to neither.
export function openingSession(tabId) {
  const recent = [...(inputSessions.get(tabId) ?? new Map())].filter(([, at]) => Date.now() - at < AGENT_INPUT_WINDOW_MS);
  return recent.length === 1 ? recent[0][0] : null;
}

// The tabs whose agent-caused openings led to this tab, nearest first; empty for a tab the user opened.
export function agentOpenerChain(tabId) {
  return agentAncestorsOf.get(tabId) ?? [];
}

// A tab that turned into a download closes at once; its download is matched to it a moment later (see
// downloads.js), so its openers stay known for a while. Tab IDs are not reused.
const REMOVED_TAB_MEMORY_MS = 10_000;
// The session each tab opened from an agent's input was given, kept for a while after the tab closes:
// a popup that turns into a download closes before its download is matched (see downloads.js).
const openedFor = new Map(); // tab id -> session id

export function rememberedOwner(tabId) {
  return openedFor.get(tabId) ?? null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  setTimeout(() => agentAncestorsOf.delete(tabId), REMOVED_TAB_MEMORY_MS);
  setTimeout(() => openedFor.delete(tabId), REMOVED_TAB_MEMORY_MS);
  pageOpens.delete(tabId);
  inputSessions.delete(tabId);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId, url }) => {
  const source = await chrome.tabs.get(sourceTabId).catch(() => null);
  const sourceInFront = source?.active && (await chrome.windows.get(source.windowId).catch(() => null))?.focused;
  const recentInput = sinceAgentInput(sourceTabId) < AGENT_INPUT_WINDOW_MS && !sourceInFront;
  // The page's report may arrive just after the browser's.
  let reported = takePageOpen(sourceTabId, url);
  if (!reported && recentInput) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    reported = takePageOpen(sourceTabId, url);
  }
  const byAgent = recentInput && Boolean(reported);
  if (byAgent) agentAncestorsOf.set(tabId, [sourceTabId, ...agentOpenerChain(sourceTabId)].slice(0, 8));
  // The new tab gets its owner before listeners hear of it, so the report goes to that session.
  const owned = byAgent
    ? await serialized(async () => {
        const state = await load();
        // The session recorded with the page's report; an opening it could not attribute has no owner.
        const sessionId = reported.sessionId;
        if (!sessionId || state.tabs[tabId]) return null;
        state.tabs[tabId] = { sessionId, mark: null };
        openedFor.set(tabId, sessionId);
        await save(state);
        return { sessionId, state };
      })
    : null;
  for (const listener of openedListeners) listener(sourceTabId, tabId, url, byAgent);
  if (owned) serialized(() => keepInBackground(tabId, sourceTabId, owned.sessionId, owned.state));
});

const KEEP_BACKGROUND_CHECKS = 7;

// A popup window or foreground tab opened by an agent page would cover the user's work: it becomes a
// background tab in the session's group, next to the opener, and the tab the user had active stays so.
async function keepInBackground(tabId, sourceTabId, sessionId, state) {
  const [tab, source] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.get(sourceTabId)]).catch(() => []);
  if (!tab || !source) return;
  if (tab.windowId !== source.windowId) await chrome.tabs.move(tabId, { windowId: source.windowId, index: -1 }).catch(() => {});
  const groupId = await agentGroup(source.windowId, state);
  if (groupId !== undefined) await chrome.tabs.group({ tabIds: [tabId], groupId }).catch(() => {});
  // The browser may activate the new tab before or after it is reported; for a moment, any activation of
  // it is undone in favor of the tab the user had.
  const windowId = source.windowId;
  const previous = currentActive.get(windowId) === tabId ? lastActive.get(windowId) : currentActive.get(windowId);
  if (previous === undefined || previous === tabId) return;
  for (let i = 0; i < KEEP_BACKGROUND_CHECKS; i++) {
    if ((await chrome.tabs.get(tabId).catch(() => null))?.active) {
      await chrome.tabs.update(previous, { active: true }).catch(() => {});
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// The active tab of each window before the latest switch, so that a tab activated by a page can be undone.
const lastActive = new Map(); // window id -> tab id
const currentActive = new Map();
// The service worker may start long after the last switch; begin with the tabs active now.
chrome.tabs.query({ active: true }).then((tabs) => {
  for (const tab of tabs) if (!currentActive.has(tab.windowId)) currentActive.set(tab.windowId, tab.id);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (currentActive.has(windowId)) lastActive.set(windowId, currentActive.get(windowId));
  currentActive.set(windowId, tabId);
});

// The window's agent group, if it still exists there.
async function agentGroup(windowId, state) {
  const groupId = state.windowGroups[windowId];
  if (groupId === undefined) return undefined;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  return group?.windowId === windowId ? groupId : undefined;
}

// Sessions that ended, oldest first, and the tabs being created for each session: a session may end
// while one of its tabs is still being created, and that tab then closes instead of outliving it. An
// ended session is forgotten once more than MAX_ENDED_SESSIONS ended after it and none of its tabs is
// being created.
const MAX_ENDED_SESSIONS = 200;
const endedSessions = new Set();
const creating = new Map(); // session id -> number of tabs being created

function rememberEnded(sessionId) {
  endedSessions.delete(sessionId);
  endedSessions.add(sessionId);
  for (const id of endedSessions) {
    if (endedSessions.size <= MAX_ENDED_SESSIONS) break;
    if (!creating.has(id)) endedSessions.delete(id);
  }
}

// Opens a tab for the session with `create()` (which resolves with the new tab) and records it as the
// session's, in the agent group. A tab whose session ended meanwhile is closed, and the call fails.
export async function createAgentTab(sessionId, create) {
  creating.set(sessionId, (creating.get(sessionId) ?? 0) + 1);
  try {
    const tab = await create();
    await serialized(() => groupAgentTabNow(tab.id, sessionId));
    return tab;
  } finally {
    const count = creating.get(sessionId) - 1;
    if (count) creating.set(sessionId, count);
    else creating.delete(sessionId);
  }
}

async function groupAgentTabNow(tabId, sessionId) {
  const state = await load();
  if (endedSessions.has(sessionId)) {
    if (!KEPT_MARKS.has(state.tabs[tabId]?.mark)) await chrome.tabs.remove(tabId).catch(() => {});
    throw new Error("The agent session ended while its tab was being created; the tab was closed");
  }
  // Ownership is recorded even if grouping fails, so that the session's end still closes the tab.
  state.tabs[tabId] = { sessionId, mark: null };
  try {
    const { windowId } = await chrome.tabs.get(tabId);
    const groupId = await agentGroup(windowId, state);
    if (groupId !== undefined) {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      const created = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      await chrome.tabGroups.update(created, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
      state.windowGroups[windowId] = created;
    }
  } finally {
    await save(state);
  }
}

export function markTab(tabId, mark) {
  return serialized(() => markTabNow(tabId, mark));
}

async function markTabNow(tabId, mark) {
  const state = await load();
  state.tabs[tabId] ??= { sessionId: null, mark: null };
  state.tabs[tabId].mark = mark;
  await save(state);
  return null;
}

export async function agentTabs() {
  return (await load()).tabs;
}


// Closes the session's unmarked tabs (those it opened and those its pages opened) and forgets the
// session. Its marked tabs leave the agent group: they are the user's now. When no live session has a
// tab in a window's group anymore, the remaining tabs (ones the user moved there or opened from an agent
// page) leave it too, so the group goes away.
export function endSession(sessionId) {
  return serialized(() => {
    reaped.delete(sessionId);
    return endSessionNow(sessionId);
  });
}

async function endSessionNow(sessionId) {
  rememberEnded(sessionId);
  const state = await load();
  const toClose = [];
  const kept = [];
  for (const [tabId, entry] of Object.entries(state.tabs)) {
    if (entry.sessionId !== sessionId) continue;
    if (KEPT_MARKS.has(entry.mark)) kept.push(Number(tabId));
    else toClose.push(Number(tabId));
    delete state.tabs[tabId];
  }
  await save(state);
  // One by one, so a tab that is already gone does not keep the others open.
  await Promise.all(toClose.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  await Promise.all(kept.map((tabId) => chrome.tabs.ungroup(tabId).catch(() => {})));
  // A kept tab has no owner now: unless the user shares it, no session may use it, so the debugger
  // leaves it, also while a dialog holds it.
  for (const tabId of kept) if (!(await anyoneMayAccess(tabId))) await detach(tabId);
  const live = new Set(Object.entries(state.tabs).filter(([, entry]) => entry.sessionId).map(([tabId]) => Number(tabId)));
  for (const windowId of Object.keys(state.windowGroups)) {
    const groupId = await agentGroup(Number(windowId), state);
    if (groupId === undefined) continue;
    const members = (await chrome.tabs.query({ groupId })).map((tab) => tab.id);
    if (members.some((id) => live.has(id))) continue;
    const strays = members.filter((id) => !toClose.includes(id));
    if (strays.length) await chrome.tabs.ungroup(strays).catch(() => {});
  }
  return { closed: toClose.length };
}

// Sessions the connected hub reports as live (its own and its clients'), or null while no authenticated
// hub reports. A session that owns tabs and stays absent from the reports for ABSENT_SESSION_GRACE_MS
// ended without saying so, for example because its server was killed while it was the hub: it ends as
// in endSession, so its marked tabs stay. The grace period leaves the other servers time to elect a new
// hub and reconnect. Without a hub, or when the hub changes, nothing is closed and the period starts over.
const ABSENT_SESSION_GRACE_MS = 45_000;
let live = null; // { ids: Set of session ids, absentSince: Map session id -> time first found absent }
let absenceTimer = null;
// Sessions ended for their absence, which may come back; a session that ended itself does not.
const reaped = new Set();

export function setLiveSessions(sessionIds) {
  clearTimeout(absenceTimer);
  if (!sessionIds) {
    live = null;
    return;
  }
  live = { ids: new Set(sessionIds), absentSince: live?.absentSince ?? new Map() };
  // A session that reconnected after it was ended for its absence may open tabs again.
  for (const id of live.ids) {
    if (reaped.delete(id)) endedSessions.delete(id);
  }
  serialized(endAbsentSessions);
}

async function endAbsentSessions() {
  const current = live;
  if (!current) return;
  const owners = new Set(Object.values((await load()).tabs).map((entry) => entry.sessionId).filter(Boolean));
  const now = Date.now();
  for (const id of current.absentSince.keys()) if (!owners.has(id) || current.ids.has(id)) current.absentSince.delete(id);
  for (const id of owners) {
    if (current.ids.has(id)) continue;
    if (!current.absentSince.has(id)) current.absentSince.set(id, now);
    if (now - current.absentSince.get(id) < ABSENT_SESSION_GRACE_MS) continue;
    current.absentSince.delete(id);
    reaped.add(id);
    await endSessionNow(id);
  }
  if (live !== current || !current.absentSince.size) return;
  const due = Math.min(...current.absentSince.values()) + ABSENT_SESSION_GRACE_MS - Date.now();
  clearTimeout(absenceTimer);
  absenceTimer = setTimeout(() => serialized(endAbsentSessions), Math.max(due, 0) + 50);
}
