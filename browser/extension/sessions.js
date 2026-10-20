// Agent sessions: tabs an agent session opened, the tab group that marks them, and cleanup when the
// session ends. State lives in chrome.storage.session so it survives service worker restarts.

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

// Tabs that pages open (target=_blank links, window.open) are paired with the page that opened them:
// the debugger reports the opening page and URL, the tabs API the new tab, in either order. A tab that
// a session's page opened belongs to that session. Other new tabs, including ones the user moves into
// the agent group, belong to no session.
const PAIRING_WINDOW_MS = 5_000;
const unpairedOpens = []; // { openerTabId, url, at }
const unpairedTabs = []; // { tabId, url, at }
const openedListeners = new Set();

export function onTabOpened(listener) {
  openedListeners.add(listener);
}

function normalizedUrl(url) {
  if (!url || url === "about:blank") return "";
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function takeFirst(list, url) {
  const now = Date.now();
  for (let i = list.length - 1; i >= 0; i--) if (now - list[i].at > PAIRING_WINDOW_MS) list.splice(i, 1);
  const index = list.findIndex((entry) => entry.url === url);
  return index < 0 ? null : list.splice(index, 1)[0];
}

function paired(openerTabId, tabId, url) {
  for (const listener of openedListeners) listener(openerTabId, tabId, url);
  return serialized(async () => {
    const state = await load();
    const opener = state.tabs[openerTabId];
    if (!opener?.sessionId || state.tabs[tabId]) return;
    state.tabs[tabId] = { sessionId: opener.sessionId, mark: null };
    await save(state);
  });
}

export function noteWindowOpen(openerTabId, url) {
  const key = normalizedUrl(url);
  const tab = takeFirst(unpairedTabs, key);
  if (tab) paired(openerTabId, tab.tabId, url);
  else unpairedOpens.push({ openerTabId, url: key, at: Date.now() });
}

function noteTabUrl(tabId, url, at) {
  const open = takeFirst(unpairedOpens, normalizedUrl(url));
  if (open) paired(open.openerTabId, tabId, url);
  else unpairedTabs.push({ tabId, url: normalizedUrl(url), at });
}

chrome.tabs.onCreated.addListener((tab) => noteTabUrl(tab.id, tab.pendingUrl || tab.url, Date.now()));

// A tab opened by window.open() may get its URL only after it was created.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const url = tab.pendingUrl || change.url;
  if (!url) return;
  const index = unpairedTabs.findIndex((entry) => entry.tabId === tabId && entry.url === "");
  if (index >= 0) noteTabUrl(tabId, url, unpairedTabs.splice(index, 1)[0].at);
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
