import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startEnvironment, until } from "./harness.mjs";

let env;
let hub;
const call = (session) => session.js("await cua.getState();");
const secretPath = () => join(env.stateDir, "extension-secret");

before(async () => { env = await startEnvironment(); });
after(async () => { await env?.close(); });

function upgrade(path, origin) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64") };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: "127.0.0.1", port: env.port, path, headers });
    req.on("upgrade", (_response, socket, head) => resolve({ socket, head }));
    req.on("response", (response) => { response.resume(); resolve({ status: response.statusCode }); });
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

async function rejectedExtension(message) {
  const result = await upgrade("/extension", `chrome-extension://${env.browser.extensionId}`);
  assert.ok(result.socket, `extension upgrade rejected: ${result.status}`);
  const { socket, head } = result;
  let data = head;
  let closed = false;
  socket.on("data", (chunk) => { data = Buffer.concat([data, chunk]); });
  socket.on("close", () => { closed = true; });
  try {
    await until(() => data.length >= 2 && data.length >= 2 + (data[1] & 127), { message: "authentication challenge" });
    const challenge = JSON.parse(data.subarray(2, 2 + (data[1] & 127)).toString());
    assert.equal(challenge.type, "challenge");
    sendFrame(socket, message);
    await until(() => closed, { message: "unauthenticated extension to close" });
    const remaining = data.subarray(2 + (data[1] & 127));
    assert.ok(!remaining.includes(Buffer.from("auth-ok")), "unauthenticated peer received auth-ok");
  } finally { socket.destroy(); }
}

test("first connection pairs and protects credentials", { timeout: 120_000 }, async () => {
  hub = await env.session();
  await call(hub);
  assert.equal(statSync(secretPath()).mode & 0o777, 0o600);
  assert.equal(statSync(join(env.stateDir, "hub-token")).mode & 0o777, 0o600);
});

test("hub rejects incorrect tokens and web origins", { timeout: 60_000 }, async () => {
  const token = readFileSync(join(env.stateDir, "hub-token"), "utf8").trim();
  for (const [path, origin] of [["/client?token=wrong", undefined], [`/client?token=${token}`, "https://example.com"], ["/extension", "https://example.com"]]) {
    const result = await upgrade(path, origin);
    if (result.socket) result.socket.destroy();
    assert.equal(result.status, 403);
  }
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
  await until(async () => { try { await call(client); return true; } catch { return false; } }, { timeoutMs: 40_000, message: "client to take over hub" });
  assert.equal(readFileSync(secretPath(), "utf8"), original);
});
