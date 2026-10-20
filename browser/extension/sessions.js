// Agent sessions: tabs an agent session opened, the tab group that marks them, and cleanup when the
// session ends. State lives in chrome.storage.session so it survives service worker restarts.

import { sinceAgentInput } from "./cdp.js";

const DEFAULT_GROUP_TITLE = "Claude";
const GROUP_COLOR = "orange";
// Marked tabs survive session cleanup: deliverables are results for the user, handoffs wait for later work.
const KEPT_MARKS = new Set(["deliverable", "handoff"]);

async function load() {
  const { agentState } = await chrome.storage.session.get("agentState");
  return agentState ?? { tabs: {}, groups: {}, names: {} };
}

async function save(state) {
  await chrome.storage.session.set({ agentState: state });
}

// Read-modify-write operations on the state run one at a time so concurrent requests do not
// overwrite each other's changes.
let queue = Promise.resolve();
function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

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
const ancestorsOf = new Map(); // tab id -> tabs that opened it, nearest first; kept when those close

// A page opened a tab from an agent action when the agent gave the opening tab input just before.
// Tabs the user opens from such a page (its context menu, a middle click) are not the session's.
const AGENT_OPEN_WINDOW_MS = 3_000;

export function onTabOpened(listener) {
  openedListeners.add(listener);
}

// The tabs that opened this tab, nearest first.
export function openerChain(tabId) {
  return ancestorsOf.get(tabId) ?? [];
}

chrome.tabs.onRemoved.addListener((tabId) => ancestorsOf.delete(tabId));

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
  ancestorsOf.set(tabId, [sourceTabId, ...openerChain(sourceTabId)].slice(0, 8));
  const byAgent = sinceAgentInput(sourceTabId) < AGENT_OPEN_WINDOW_MS;
  for (const listener of openedListeners) listener(sourceTabId, tabId, url, byAgent);
  if (!byAgent) return;
  serialized(async () => {
    const state = await load();
    const opener = state.tabs[sourceTabId];
    if (!opener?.sessionId || state.tabs[tabId]) return;
    state.tabs[tabId] = { sessionId: opener.sessionId, mark: null };
    await save(state);
    await keepInBackground(tabId, sourceTabId, opener.sessionId, state);
  });
});

// A popup window or foreground tab opened by an agent page would cover the user's work: it becomes a
// background tab in the session's group, next to the opener, and the tab the user had active stays so.
async function keepInBackground(tabId, sourceTabId, sessionId, state) {
  const [tab, source] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.get(sourceTabId)]).catch(() => []);
  if (!tab || !source) return;
  if (tab.windowId !== source.windowId) await chrome.tabs.move(tabId, { windowId: source.windowId, index: -1 }).catch(() => {});
  const groupId = state.groups[sessionId];
  if (await groupExists(groupId)) await chrome.tabs.group({ tabIds: [tabId], groupId }).catch(() => {});
  if (currentActive.get(source.windowId) !== tabId) return;
  const previous = lastActive.get(source.windowId);
  if (previous !== undefined) await chrome.tabs.update(previous, { active: true }).catch(() => {});
}

// The active tab of each window before the latest switch, so that a tab activated by a page can be undone.
const lastActive = new Map(); // window id -> tab id
const currentActive = new Map();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (currentActive.has(windowId)) lastActive.set(windowId, currentActive.get(windowId));
  currentActive.set(windowId, tabId);
});

async function groupExists(groupId) {
  if (groupId === undefined) return false;
  return chrome.tabGroups.get(groupId).then(() => true, () => false);
}

export function groupAgentTab(tabId, sessionId, sessionName) {
  return serialized(() => groupAgentTabNow(tabId, sessionId, sessionName));
}

async function groupAgentTabNow(tabId, sessionId, sessionName) {
  const state = await load();
  if (sessionName) state.names[sessionId] = sessionName;
  let groupId = state.groups[sessionId];
  const tab = await chrome.tabs.get(tabId);
  const sameWindow = (await groupExists(groupId)) && (await chrome.tabGroups.get(groupId)).windowId === tab.windowId;
  if (sameWindow) {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: state.names[sessionId] ?? DEFAULT_GROUP_TITLE, color: GROUP_COLOR, collapsed: false });
    state.groups[sessionId] = groupId;
  }
  state.tabs[tabId] = { sessionId, mark: null };
  await save(state);
}

export function nameSession(sessionId, name) {
  return serialized(() => nameSessionNow(sessionId, name));
}

async function nameSessionNow(sessionId, name) {
  const state = await load();
  state.names[sessionId] = name;
  await save(state);
  if (await groupExists(state.groups[sessionId])) await chrome.tabGroups.update(state.groups[sessionId], { title: name });
  return null;
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
// session. Other tabs in the agent group stay open.
export function endSession(sessionId) {
  return serialized(() => endSessionNow(sessionId));
}

async function endSessionNow(sessionId) {
  const state = await load();
  const toClose = [];
  for (const [tabId, entry] of Object.entries(state.tabs)) {
    if (entry.sessionId !== sessionId) continue;
    if (!KEPT_MARKS.has(entry.mark)) toClose.push(Number(tabId));
    delete state.tabs[tabId];
  }
  delete state.groups[sessionId];
  delete state.names[sessionId];
  await save(state);
  // One by one, so a tab that is already gone does not keep the others open.
  await Promise.all(toClose.map((tabId) => chrome.tabs.remove(tabId).catch(() => {})));
  return { closed: toClose.length };
}
