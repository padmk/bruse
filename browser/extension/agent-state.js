// The stored record of agent sessions' tabs, { tabs: { [tabId]: { sessionId, mark } }, windowGroups,
// pausedEnds: [session ids that ended while agents were paused, whose tabs close on resume] }.
// sessions.js keeps it; this module only reads and writes it, without listeners, so the popup can use it.

export async function loadAgentState() {
  const { agentState } = await chrome.storage.local.get("agentState");
  return { tabs: agentState?.tabs ?? {}, windowGroups: agentState?.windowGroups ?? {}, pausedEnds: agentState?.pausedEnds ?? [] };
}

export function saveAgentState(state) {
  return chrome.storage.local.set({ agentState: state });
}

// The session that owns the tab (opened it, or its page opened it from the agent's input), or null.
export async function tabOwner(tabId) {
  return (await loadAgentState()).tabs[tabId]?.sessionId ?? null;
}
