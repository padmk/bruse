// What the hub allows a connection before it authenticates, and how it stores its token. No browser is
// needed: the session becomes the hub when its first call links up.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { browserCopy, freePort, startSession, until } from "./harness.mjs";

let port, copy, stateDir, session, pending;
const tokenPath = () => join(stateDir, "hub-token");

before(async () => {
  port = await freePort();
  copy = browserCopy(port);
  stateDir = join(copy.dir, "state");
  mkdirSync(stateDir, { mode: 0o755 });
  // A token file left readable by others, as an older install or a manual copy could leave it.
  writeFileSync(tokenPath(), "0".repeat(64), { mode: 0o644 });
  session = await startSession(copy.serverPath, { stateDir });
  // Without a browser the call fails once the extension wait ends; it only makes the session the hub.
  pending = session.js("await cua.getState();", 60_000).catch(() => {});
  await until(() => readFileSync(tokenPath(), "utf8").trim() !== "0".repeat(64), { message: "the hub to write its token" });
});
after(async () => {
  await pending;
  await session?.close();
  copy?.remove();
});

test("the hub makes an existing token file and state directory private", () => {
  assert.equal(statSync(tokenPath()).mode & 0o777, 0o600);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});

// An unauthenticated client connection that collects the opcodes of the hub's frames.
function connect() {
  return new Promise((resolve, reject) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") };
    const req = http.request({ host: "127.0.0.1", port, path: "/client", headers });
    req.on("upgrade", (_response, socket, head) => {
      const peer = { socket, opcodes: [], closed: false };
      let data = head;
      const parse = () => {
        while (data.length >= 2) {
          let length = data[1] & 127;
          let offset = 2;
          if (length === 126) {
            if (data.length < 4) return;
            length = data.readUInt16BE(2);
            offset = 4;
          }
          if (data.length < offset + length) return;
          peer.opcodes.push(data[0] & 0x0f);
          data = data.subarray(offset + length);
        }
      };
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        parse();
      });
      socket.on("close", () => (peer.closed = true));
      socket.on("error", () => {});
      parse();
      resolve(peer);
    });
    req.on("response", (response) => reject(new Error(`upgrade rejected: ${response.statusCode}`)));
    req.on("error", reject);
    req.end();
  });
}

function ping(socket, size) {
  const payload = randomBytes(size);
  const mask = randomBytes(4);
  const offset = size < 126 ? 2 : 4;
  const frame = Buffer.alloc(offset + 4 + size);
  frame[0] = 0x89;
  frame[1] = 0x80 | (offset === 2 ? size : 126);
  if (offset === 4) frame.writeUInt16BE(size, 2);
  mask.copy(frame, offset);
  for (let i = 0; i < size; i++) frame[offset + 4 + i] = payload[i] ^ mask[i % 4];
  socket.write(frame);
}

test("the hub answers a small ping before authentication", async () => {
  const peer = await connect();
  try {
    ping(peer.socket, 125);
    await until(() => peer.opcodes.includes(0xa), { message: "a pong" });
    assert.equal(peer.closed, false);
  } finally {
    peer.socket.destroy();
  }
});

test("the hub closes a connection that sends a ping over 125 bytes, without a pong", async () => {
  const peer = await connect();
  try {
    ping(peer.socket, 200);
    await until(() => peer.closed, { message: "the hub to close the connection" });
    assert.ok(!peer.opcodes.includes(0xa), "the hub answered the oversized ping");
  } finally {
    peer.socket.destroy();
  }
});
