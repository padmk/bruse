// The agent requests the extension is running, by session. The MCP server numbers its REPLs and sends
// each request it relays from one with that REPL's generation. When it replaces a REPL whose call timed
// out or was cancelled, it sends session.cancel with the new REPL's generation, which aborts the
// session's requests of earlier generations still in flight: each is refused at its next check before
// an effect (requireAgentEffect in access.js, the debugger gate in cdp.js), so nothing the stopped code
// asked for takes effect afterwards. Requests the server sends on its own, such as the release of keys a
// stopped REPL held, carry no generation, and no cancel aborts them.

/**
 * One agent request: the session the hub says it comes from, and whether it was cancelled.
 * @typedef {{ readonly session: string | null, readonly signal: AbortSignal }} AgentRequest
 */

export const CANCELLED_ERROR = "This request was cancelled: the agent's call that sent it timed out or was cancelled, so it does not take effect.";

/** @type {Map<string | null, Map<AbortController, number>>} the requests that carry a generation, with it */
const inFlight = new Map();

// Registers a request of `session` and the REPL generation it carries, if any; `end` must be called once
// it settles. A request without a generation is not registered, as nothing cancels it.
/** @param {string | null} session @param {unknown} generation @returns {{ request: AgentRequest, end: () => void }} */
export function beginRequest(session, generation) {
  const controller = new AbortController();
  const request = { session, signal: controller.signal };
  if (!Number.isSafeInteger(generation)) return { request, end: () => {} };
  let requests = inFlight.get(session);
  if (!requests) inFlight.set(session, (requests = new Map()));
  requests.set(controller, /** @type {number} */ (generation));
  const end = () => {
    requests.delete(controller);
    if (!requests.size && inFlight.get(session) === requests) inFlight.delete(session);
  };
  return { request, end };
}

// Aborts the requests of `session` in flight whose generation is before `before`. Returns how many it
// aborted.
/** @param {string | null} session @param {unknown} before @returns {number} */
export function cancelSessionRequests(session, before) {
  if (!Number.isSafeInteger(before)) throw new Error(`session.cancel takes the generation of the current REPL as before, not ${JSON.stringify(before)}`);
  let cancelled = 0;
  for (const [controller, generation] of inFlight.get(session) ?? []) {
    if (generation >= /** @type {number} */ (before) || controller.signal.aborted) continue;
    controller.abort();
    cancelled++;
  }
  return cancelled;
}

/** @param {AgentRequest} request */
export function requireNotCancelled(request) {
  if (request.signal.aborted) throw new Error(CANCELLED_ERROR);
}
