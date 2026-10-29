import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { hubClient, startEnvironment, until } from "./harness.mjs";

let env;
let hub;
const call = (session) => session.js("await cua.getState();");
const secretPath = () => join(env.stateDir, "extension-secret");

before(async () => {
  env = await startEnvironment();
});
after(async () => {
  await env?.close();
});

function upgrade(path, origin, host) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") };
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    const req = http.request({ host: "127.0.0.1", port: env.port, path, headers });
    req.on("upgrade", (_response, socket, head) => resolve({ socket, head }));
    req.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode });
    });
    req.on("error", reject);
    req.end();
  });
}

function sendFrame(socket, value) {
  const payload = Buffer.from(JSON.stringify(value));
  assert.ok(payload.length < 65536);
  const mask = randomBytes(4);
  const offset = payload.length < 126 ? 2 : 4;
  const frame = Buffer.alloc(offset + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | (offset === 2 ? payload.length : 126);
  if (offset === 4) frame.writeUInt16BE(payload.length, 2);
  mask.copy(frame, offset);
  for (let i = 0; i < payload.length; i++) frame[offset + 4 + i] = payload[i] ^ mask[i % 4];
  socket.write(frame);
}

// A WebSocket connection that speaks frames directly: `messages` holds the hub's messages parsed,
// `next(matches)` waits for the next (matching) one.
async function rawPeer(path, origin) {
  const result = await upgrade(path, origin);
  assert.ok(result.socket, `upgrade of ${path} rejected: ${result.status}`);
  const { socket } = result;
  const peer = { socket, messages: [], closed: false, send: (value) => sendFrame(socket, value), destroy: () => socket.destroy() };
  let data = result.head;
  let taken = 0;
  const parseFrames = () => {
    while (data.length >= 2) {
      let length = data[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (data.length < 4) return;
        length = data.readUInt16BE(2);
        offset = 4;
      }
      if (data.length < offset + length) return;
      if ((data[0] & 0x0f) === 0x1) peer.messages.push(JSON.parse(data.subarray(offset, offset + length).toString()));
      data = data.subarray(offset + length);
    }
  };
  socket.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
    parseFrames();
  });
  socket.on("close", () => (peer.closed = true));
  socket.on("error", () => {});
  parseFrames();
  peer.next = async (matches = () => true) => {
    const message = await until(() => peer.messages.slice(taken).find(matches), { message: `a message on ${path}` });
    taken = peer.messages.indexOf(message) + 1;
    return message;
  };
  return peer;
}

async function rejectedExtension(message) {
  const result = await upgrade("/extension", `chrome-extension://${env.browser.extensionId}`);
  assert.ok(result.socket, `extension upgrade rejected: ${result.status}`);
  const { socket, head } = result;
  let data = head;
  let closed = false;
  socket.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  socket.on("close", () => {
    closed = true;
  });
  try {
    await until(() => data.length >= 2 && data.length >= 2 + (data[1] & 127), { message: "authentication challenge" });
    const challenge = JSON.parse(data.subarray(2, 2 + (data[1] & 127)).toString());
    assert.equal(challenge.type, "challenge");
    sendFrame(socket, message);
    await until(() => closed, { message: "unauthenticated extension to close" });
    const remaining = data.subarray(2 + (data[1] & 127));
    assert.ok(!remaining.includes(Buffer.from("auth-ok")), "unauthenticated peer received auth-ok");
  } finally {
    socket.destroy();
  }
}

test("first connection pairs and protects credentials", { timeout: 120_000 }, async () => {
  hub = await env.session();
  await call(hub);
  assert.equal(statSync(secretPath()).mode & 0o777, 0o600);
  assert.equal(statSync(join(env.stateDir, "hub-token")).mode & 0o777, 0o600);
});

test("hub rejects web origins", { timeout: 60_000 }, async () => {
  for (const [path, origin] of [
    ["/client", "https://example.com"],
    ["/extension", "https://example.com"],
    ["/extension", "chrome-extension://abcdefghijklmnopabcdefghijklmnop"],
  ]) {
    const result = await upgrade(path, origin);
    if (result.socket) result.socket.destroy();
    assert.equal(result.status, 403);
  }
});

test("hub accepts the Chrome Web Store copy of the extension", { timeout: 60_000 }, async () => {
  const { STORE_EXTENSION_ID } = await import(join(env.copy.browserDir, "mcp", "config.mjs"));
  const result = await upgrade("/extension", `chrome-extension://${STORE_EXTENSION_ID}`);
  assert.ok(result.socket, `store extension upgrade rejected: ${result.status}`);
  result.socket.destroy();
});

test("hub rejects requests addressed to another host name", { timeout: 60_000 }, async () => {
  const accepted = await upgrade("/client");
  accepted.socket?.destroy();
  assert.ok(accepted.socket, "a client on 127.0.0.1 connects");
  // A page on a domain that resolves to 127.0.0.1 sends its own name as Host.
  for (const [path, origin] of [
    ["/client", undefined],
    ["/extension", `chrome-extension://${env.browser.extensionId}`],
  ]) {
    const result = await upgrade(path, origin, `rebind.example:${env.port}`);
    result.socket?.destroy();
    assert.equal(result.status, 403);
  }
});

test("a client must prove the hub token", { timeout: 60_000 }, async () => {
  const impostor = await rawPeer("/client");
  try {
    const challenge = await impostor.next();
    assert.equal(challenge.type, "challenge");
    assert.equal(challenge.protocol, 2);
    impostor.send({ type: "auth", nonce: "1".repeat(64), mac: createHmac("sha256", "wrong").update(`client:${challenge.nonce}:${"1".repeat(64)}`).digest("hex") });
    await until(() => impostor.closed, { message: "client with a wrong MAC to be closed" });
    assert.ok(!impostor.messages.some((message) => message.type === "auth-ok"), "unauthenticated client received auth-ok");
  } finally {
    impostor.destroy();
  }
  // hubClient proves the token and checks the hub's proof.
  const client = await hubClient(env.port, env.stateDir);
  try {
    assert.ok((await client.call("browser.info")).version);
  } finally {
    client.close();
  }
});

test("an older client that presents the token in the URL is served", { timeout: 60_000 }, async () => {
  const token = readFileSync(join(env.stateDir, "hub-token"), "utf8").trim();
  assert.equal((await upgrade(`/client?token=${"0".repeat(64)}`)).socket, undefined, "a wrong token in the URL is refused");
  const older = await rawPeer(`/client?token=${token}`);
  try {
    older.send({ type: "hello", sessionId: "older" });
    older.send({ id: 1, method: "browser.info", params: {} });
    const reply = await older.next((message) => message.id === 1);
    assert.equal(reply.error, undefined);
    assert.ok(reply.result.version);
    assert.ok(!older.messages.some((message) => message.type === "challenge"), "an older client got the new handshake");
  } finally {
    older.destroy();
  }
});

test("unauthenticated connections get small messages only", { timeout: 60_000 }, async () => {
  for (const [path, origin] of [
    ["/client", undefined],
    ["/extension", `chrome-extension://${env.browser.extensionId}`],
  ]) {
    const peer = await rawPeer(path, origin);
    try {
      await peer.next();
      // The start of a 1 MiB message: the hub refuses it before it arrives in full.
      const header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4]);
      peer.socket.write(Buffer.concat([header, Buffer.alloc(1024, 0x20)]));
      await until(() => peer.closed, { timeoutMs: 2_000, message: `${path} connection with an oversized message to be closed` });
    } finally {
      peer.destroy();
    }
  }
  await call(hub);
});

test("hub bounds the connections that have not authenticated", { timeout: 60_000 }, async () => {
  const peers = [];
  try {
    for (let i = 0; i < 32; i++) {
      const peer = await rawPeer("/client");
      peers.push(peer);
      await peer.next();
    }
    const refused = await upgrade("/client");
    refused.socket?.destroy();
    assert.equal(refused.status, 503);
  } finally {
    for (const peer of peers) peer.destroy();
  }
  await until(
    async () => {
      const client = await hubClient(env.port, env.stateDir).catch(() => null);
      client?.close();
      return client;
    },
    { message: "hub to take clients again" },
  );
  await call(hub);
});

test("impostors cannot authenticate or replace the pairing", { timeout: 120_000 }, async () => {
  const original = readFileSync(secretPath(), "utf8");
  for (const message of [
    { type: "auth", mac: "0".repeat(64), nonce: "x" },
    { type: "auth", mac: "é".repeat(64), nonce: "x" },
    { type: "pair", secret: "a".repeat(64), nonce: "x" },
  ]) {
    await rejectedExtension(message);
    assert.equal(readFileSync(secretPath(), "utf8"), original);
    await call(hub);
  }
});

test("reinstalled extension requires pairing reset", { timeout: 120_000 }, async () => {
  const oldSecret = readFileSync(secretPath(), "utf8");
  await env.browser.cdp.send("Extensions.uninstall", { id: env.browser.extensionId });
  await env.browser.cdp.send("Extensions.loadUnpacked", { path: env.copy.extensionDir });
  await assert.rejects(call(hub), /did not connect/i);
  assert.equal(readFileSync(secretPath(), "utf8"), oldSecret);
  renameSync(secretPath(), join(env.stateDir, "old-extension-secret"));
  await call(hub);
  assert.notEqual(readFileSync(secretPath(), "utf8"), oldSecret);
});

test("another session takes over the hub without re-pairing", { timeout: 120_000 }, async () => {
  const original = readFileSync(secretPath(), "utf8");
  const client = await env.session();
  await call(client);
  await call(hub);
  await hub.close();
  await until(
    async () => {
      try {
        await call(client);
        return true;
      } catch {
        return false;
      }
    },
    { timeoutMs: 40_000, message: "client to take over hub" },
  );
  assert.equal(readFileSync(secretPath(), "utf8"), original);
});
