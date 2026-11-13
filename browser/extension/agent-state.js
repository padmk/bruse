// The stored record of agent sessions' tabs (see AgentState). sessions.js keeps it; this module only
// reads and writes it, without listeners, so the popup can use it.

/** @typedef {import("./shared.js").AgentTabEntry} AgentTabEntry */

/**
 * @typedef {object} AgentState
 * @property {Record<string, AgentTabEntry>} tabs tab id -> the session that owns the tab and its mark
 * @property {Record<string, number>} windowGroups window id -> the id of its agent tab group
 * @property {(string | null)[]} pausedEnds sessions that ended while agents were paused, whose tabs close on resume
 * @property {(string | null)[]} absentEnds those of pausedEnds that ended for their absence from the hub's reports
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

/**
 * @param {unknown} value
 * @returns {(string | null)[]}
 */
function sessionList(value) {
  return Array.isArray(value) ? value.filter((id) => id === null || typeof id === "string") : [];
}

/**
 * What storage holds, as an AgentState: a missing or malformed field is empty.
 * @param {unknown} stored
 * @returns {AgentState}
 */
function parseAgentState(stored) {
  const record = isRecord(stored) ? stored : {};
  /** @type {AgentState} */
  const state = { tabs: {}, windowGroups: {}, pausedEnds: sessionList(record.pausedEnds), absentEnds: sessionList(record.absentEnds) };
  if (isRecord(record.tabs)) {
    for (const [tabId, entry] of Object.entries(record.tabs)) {
      if (isRecord(entry)) state.tabs[tabId] = { sessionId: stringOrNull(entry.sessionId), mark: stringOrNull(entry.mark) };
    }
  }
  if (isRecord(record.windowGroups)) {
    for (const [windowId, groupId] of Object.entries(record.windowGroups)) {
      if (typeof groupId === "number") state.windowGroups[windowId] = groupId;
    }
  }
  return state;
}

/** @returns {Promise<AgentState>} */
export async function loadAgentState() {
  const { agentState } = await chrome.storage.local.get("agentState");
  return parseAgentState(agentState);
}

/**
 * @param {AgentState} state
 * @returns {Promise<void>}
 */
export function saveAgentState(state) {
  return chrome.storage.local.set({ agentState: state });
}

/**
 * The session that owns the tab (opened it, or its page opened it from the agent's input), or null.
 * @param {number} tabId
 * @returns {Promise<string | null>}
 */
export async function tabOwner(tabId) {
  return (await loadAgentState()).tabs[tabId]?.sessionId ?? null;
}
