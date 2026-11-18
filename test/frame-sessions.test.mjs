import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameSessions, MAX_REMEMBERED_FRAME_SESSIONS } from "../browser/extension/frame-sessions.js";

test("a live frame session outlasts many later attachments, and ended ones are forgotten first", () => {
  const sessions = new FrameSessions();
  const live = new Set(["live"]);
  sessions.remember("live", "frame-live", 7, (id) => live.has(id));
  for (let i = 0; i < MAX_REMEMBERED_FRAME_SESSIONS + 50; i++) sessions.remember(`ended-${i}`, `frame-${i}`, 8, (id) => live.has(id));
  assert.equal(sessions.tabOf("live"), 7);
  assert.equal(sessions.frameOf("live"), "frame-live");
  assert.equal(sessions.tabOf("ended-0"), undefined);
  assert.equal(sessions.tabOf(`ended-${MAX_REMEMBERED_FRAME_SESSIONS + 49}`), 8);
});

test("closing a tab forgets its frame sessions only", () => {
  const sessions = new FrameSessions();
  sessions.remember("a", "frame-a", 1, () => true);
  sessions.remember("b", "frame-b", 2, () => true);
  sessions.forgetTab(1);
  assert.equal(sessions.tabOf("a"), undefined);
  assert.equal(sessions.tabOf("b"), 2);
});
