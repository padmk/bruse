// The debugger sessions of cross-origin frames: which frame and tab each belongs to, kept after the sessions
// end, since the next attach gives the frames new sessions and a command for an earlier one goes to the
// frame's new session. Only ended sessions are forgotten to keep the record bounded: a live one stays until
// it detaches or its tab closes, or commands to its frame would be refused.

export const MAX_REMEMBERED_FRAME_SESSIONS = 1_000;

export class FrameSessions {
  /** @type {Map<string, { frameId: string, tabId: number }>} session id -> its frame and tab, oldest first */
  #remembered = new Map();

  /**
   * @param {string} sessionId
   * @param {string} frameId
   * @param {number} tabId
   * @param {(sessionId: string) => boolean} isLive whether a session is still attached
   */
  remember(sessionId, frameId, tabId, isLive) {
    this.#remembered.delete(sessionId);
    this.#remembered.set(sessionId, { frameId, tabId });
    if (this.#remembered.size <= MAX_REMEMBERED_FRAME_SESSIONS) return;
    for (const id of this.#remembered.keys()) {
      if (id === sessionId || isLive(id)) continue;
      this.#remembered.delete(id);
      return;
    }
  }

  /** @param {string} sessionId */
  frameOf(sessionId) {
    return this.#remembered.get(sessionId)?.frameId;
  }

  /** @param {string} sessionId */
  tabOf(sessionId) {
    return this.#remembered.get(sessionId)?.tabId;
  }

  /** @param {number} tabId */
  forgetTab(tabId) {
    for (const [id, { tabId: owner }] of this.#remembered) if (owner === tabId) this.#remembered.delete(id);
  }
}
