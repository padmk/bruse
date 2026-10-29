// An MCP server that finds the hub port taken connects as a client; these fakes on the port show that it
// sends neither the hub token nor any request to a process that cannot prove the token, and that it
// names a version mismatch when the hub refuses its handshake. No browser is needed.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { browserCopy, freePort, startSession } from "./harness.mjs";

let port, copy, stateDir, token, acceptUpgrade;

before(async () => {
  port = await freePort();
  copy = browserCopy(port);
  stateDir = join(copy.dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  token = randomBytes(32).toString("hex");
  writeFileSync(join(stateDir, "hub-token"), token, { mode: 0o600 });
  ({ acceptUpgrade } = await import(join(copy.browserDir, "mcp", "websocket.mjs")));
});
after(() => copy?.remove());

// A listener on the hub port; `onUpgrade(req, socket)` handles WebSocket upgrades, `onRequest` plain ones.
async function fakeHub({ onUpgrade, onRequest = (_req, res) => res.writeHead(426).end() }) {
  const server = http.createServer(onRequest);
  const seen = { urls: [], bytes: Buffer.alloc(0), messages: [] };
  server.on("upgrade", (req, socket) => {
    seen.urls.push(req.url);
    socket.on("data", (chunk) => (seen.bytes = Buffer.concat([seen.bytes, chunk])));
    onUpgrade(req, socket, seen);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { seen, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

test("a client sends no token or request to a listener that cannot prove the token", { timeout: 60_000 }, async () => {
  const fake = await fakeHub({
    onUpgrade(req, socket, seen) {
      const peer = acceptUpgrade(req, socket);
      peer.on("message", (text) => {
        seen.messages.push(JSON.parse(text));
        // Accepts any answer and claims to be the hub.
        peer.send(JSON.stringify({ type: "auth-ok", mac: "0".repeat(64) }));
      });
      peer.send(JSON.stringify({ type: "challenge", protocol: 2, nonce: randomBytes(32).toString("hex") }));
    },
  });
  const session = await startSession(copy.serverPath, { stateDir });
  try {
    await assert.rejects(session.js("await cua.getState();", 60_000), /did not prove that it is the browser hub/);
    assert.ok(fake.seen.urls.length > 0, "the client connected");
    assert.ok(fake.seen.urls.every((url) => !url.includes(token)), `token in URL: ${fake.seen.urls}`);
    // Client frames are masked, so the raw bytes cannot show the token; the parsed messages can.
    assert.ok(!JSON.stringify(fake.seen.messages).includes(token), "token in a message");
    assert.deepEqual([...new Set(fake.seen.messages.map((message) => message.type))], ["auth"]);
    assert.ok(fake.seen.messages.every((message) => message.method === undefined), "a request reached the fake hub");
  } finally {
    await session.close();
    await fake.close();
  }
});

test("a client names the version mismatch when the hub refuses its handshake", { timeout: 60_000 }, async () => {
  // What a hub of an older version does: it refuses the upgrade without the token in the URL.
  const fake = await fakeHub({ onUpgrade: (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n") });
  const session = await startSession(copy.serverPath, { stateDir });
  try {
    await assert.rejects(session.js("await cua.getState();", 30_000), /is not a browser hub of .* cannot talk to/);
  } finally {
    await session.close();
    await fake.close();
  }
});
