// The agent requests the extension is running, by session. When the MCP server stops a REPL whose call
// timed out or was cancelled, it sends session.cancel, which aborts the session's requests still in
// flight: each is refused at its next check before an effect (requireAgentEffect in access.js, the
// debugger gate in cdp.js), so nothing the stopped code asked for takes effect afterwards. A request
// registers as it arrives, before its first await, so a request that arrives after the cancel (from the
// REPL that replaced the stopped one) is not affected.

/**
 * One agent request: the session the hub says it comes from, and whether it was cancelled.
 * @typedef {{ readonly session: string | null, readonly signal: AbortSignal }} AgentRequest
 */

export const CANCELLED_ERROR = "This request was cancelled: the agent's call that sent it timed out or was cancelled, so it does not take effect.";

/** @type {Map<string | null, Set<AbortController>>} */
const inFlight = new Map();

// Registers a request of `session`; `end` must be called once it settles.
/** @param {string | null} session @returns {{ request: AgentRequest, end: () => void }} */
export function beginRequest(session) {
  const controller = new AbortController();
  let requests = inFlight.get(session);
  if (!requests) inFlight.set(session, (requests = new Set()));
  requests.add(controller);
  const end = () => {
    requests.delete(controller);
    if (!requests.size && inFlight.get(session) === requests) inFlight.delete(session);
  };
  return { request: { session, signal: controller.signal }, end };
}

// Aborts the requests of the session of `canceller` that are in flight, other than `canceller` itself.
// Returns how many it aborted.
/** @param {AgentRequest} canceller @returns {number} */
export function cancelSessionRequests(canceller) {
  let cancelled = 0;
  for (const controller of inFlight.get(canceller.session) ?? []) {
    if (controller.signal === canceller.signal || controller.signal.aborted) continue;
    controller.abort();
    cancelled++;
  }
  return cancelled;
}

/** @param {AgentRequest} request */
export function requireNotCancelled(request) {
  if (request.signal.aborted) throw new Error(CANCELLED_ERROR);
}
