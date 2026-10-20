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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await load();
  if (!state.tabs[tabId]) return;
  delete state.tabs[tabId];
  await save(state);
});

async function groupExists(groupId) {
  if (groupId === undefined) return false;
  return chrome.tabGroups.get(groupId).then(() => true, () => false);
}

export async function groupAgentTab(tabId, sessionId, sessionName) {
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

export async function nameSession(sessionId, name) {
  const state = await load();
  state.names[sessionId] = name;
  await save(state);
  if (await groupExists(state.groups[sessionId])) await chrome.tabGroups.update(state.groups[sessionId], { title: name });
  return null;
}

export async function markTab(tabId, mark) {
  const state = await load();
  state.tabs[tabId] ??= { sessionId: null, mark: null };
  state.tabs[tabId].mark = mark;
  await save(state);
  return null;
}

export async function agentTabs() {
  return (await load()).tabs;
}

// Closes the session's unmarked agent tabs, including tabs its pages opened into the agent group,
// and forgets the session.
export async function endSession(sessionId) {
  const state = await load();
  const toClose = new Set();
  const groupId = state.groups[sessionId];
  if (await groupExists(groupId)) {
    for (const tab of await chrome.tabs.query({ groupId })) {
      if (!KEPT_MARKS.has(state.tabs[tab.id]?.mark)) toClose.add(tab.id);
    }
  }
  for (const [tabId, entry] of Object.entries(state.tabs)) {
    if (entry.sessionId !== sessionId) continue;
    if (!KEPT_MARKS.has(entry.mark)) toClose.add(Number(tabId));
    delete state.tabs[tabId];
  }
  delete state.groups[sessionId];
  delete state.names[sessionId];
  await save(state);
  if (toClose.size) await chrome.tabs.remove([...toClose]).catch(() => {});
  return { closed: toClose.size };
}
