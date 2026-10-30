import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { browserCopy, freePort, launchBrowser, offerPairing, startSession, until } from "./harness.mjs";
import { hostManifestPath, installPairingHost, pairingHostProblems } from "../installer/native-host.mjs";

function nativeSecret(copy, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(copy.browserDir, "native-host", "pairing.mjs")], { env: { ...process.env, BROWSER_CONTROL_STATE_DIR: stateDir } });
    const body = Buffer.from(JSON.stringify({ type: "secret" }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    let output = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => { output = Buffer.concat([output, chunk]); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Native host exited ${code}`));
      try { resolve(JSON.parse(output.subarray(4).toString()).secret); } catch (error) { reject(error); }
    });
    child.stdin.end(Buffer.concat([header, body]));
  });
}

test("native host preserves existing pairings and registers only the pinned extension", async () => {
  const copy = browserCopy(await freePort());
  try {
    const stateDir = join(copy.dir, "state");
    const secret = await nativeSecret(copy, stateDir);
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(await nativeSecret(copy, stateDir), secret);
    assert.equal(statSync(join(stateDir, "extension-secret")).mode & 0o777, 0o600);
    const dataDirs = [join(copy.dir, "browser-profile")];
    const { written } = await installPairingHost({ browserDir: copy.browserDir, stateDir, node: process.execPath, dataDirs });
    assert.deepEqual(written, dataDirs);
    assert.equal(await nativeSecret(copy, stateDir), secret);
    const manifest = JSON.parse(readFileSync(hostManifestPath(dataDirs[0]), "utf8"));
    const { EXTENSION_ORIGINS } = await import(join(copy.browserDir, "mcp", "config.mjs"));
    assert.deepEqual(manifest.allowed_origins, [...EXTENSION_ORIGINS].map((origin) => `${origin}/`));
    assert.deepEqual(pairingHostProblems(copy.browserDir, dataDirs), []);
    assert.match(pairingHostProblems(copy.browserDir, [join(copy.dir, "missing")])[0], /Run bruse setup/);
  } finally { copy.remove(); }
});

test("a port squatter never receives the native secret or authenticates to a fresh extension", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const copy = browserCopy(port);
  const stateDir = join(copy.dir, "state");
  const { acceptUpgrade } = await import(join(copy.browserDir, "mcp", "websocket.mjs"));
  const server = http.createServer();
  const peers = [];
  const messages = [];
  server.on("upgrade", (req, socket) => {
    const peer = acceptUpgrade(req, socket);
    peers.push(peer);
    peer.on("message", (text) => {
      messages.push(JSON.parse(text));
      peer.send(JSON.stringify({ id: 99, method: "browser.info", params: {} }));
    });
    peer.send(JSON.stringify({ type: "challenge", nonce: "a".repeat(64) }));

  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await launchBrowser(copy.extensionDir, { pairing: { browserDir: copy.browserDir, stateDir } });
    await until(() => messages.some((message) => message.type === "auth"));
    const secret = readFileSync(join(stateDir, "extension-secret"), "utf8").trim();
    assert.ok(!JSON.stringify(messages).includes(secret));
    assert.ok(messages.every((message) => message.type === "auth" && !('secret' in message)));
    assert.ok(!messages.some((message) => message.id === 99));
  } finally {
    await browser?.close();
    for (const peer of peers) peer.close();
    await new Promise((resolve) => server.close(resolve));
    copy.remove();
  }
});


test("a flood of challenges on one connection gets one answer", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const copy = browserCopy(port);
  const stateDir = join(copy.dir, "state");
  const { acceptUpgrade } = await import(join(copy.browserDir, "mcp", "websocket.mjs"));
  const server = http.createServer();
  const peers = [];
  const answers = new Map();
  server.on("upgrade", (req, socket) => {
    const peer = acceptUpgrade(req, socket);
    peers.push(peer);
    answers.set(peer, 0);
    peer.on("message", () => answers.set(peer, answers.get(peer) + 1));
    for (let i = 0; i < 20; i++) peer.send(JSON.stringify({ type: "challenge", nonce: "a".repeat(64) }));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await launchBrowser(copy.extensionDir, { pairing: { browserDir: copy.browserDir, stateDir } });
    await until(() => [...answers.values()].some((count) => count > 0));
    // Time for the native hosts of further answers to start and reply.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.ok([...answers.values()].every((count) => count <= 1), JSON.stringify([...answers.values()]));
  } finally {
    await browser?.close();
    for (const peer of peers) peer.close();
    await new Promise((resolve) => server.close(resolve));
    copy.remove();
  }
});

test("an older unpaired extension cannot plant a secret in a new hub", { timeout: 30_000 }, async () => {
  const port = await freePort();
  const copy = browserCopy(port);
  const stateDir = join(copy.dir, "state");
  const session = await startSession(copy.serverPath, { stateDir });
  try {
    const call = session.js("await cua.getState()").catch(() => {});
    await until(() => existsSync(join(stateDir, "hub-token")));
    const { EXTENSION_ORIGINS } = await import(join(copy.browserDir, "mcp", "config.mjs"));
    const id = [...EXTENSION_ORIGINS][0].split("//")[1];
    assert.equal(await offerPairing(port, id, "f".repeat(64)), false);
    assert.equal(existsSync(join(stateDir, "extension-secret")), false);
    await call;
  } finally { await session.close(); copy.remove(); }
});

test("a saved pairing works without a host and an unpacked permission update stays enabled", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const copy = browserCopy(port);
  const stateDir = join(copy.dir, "state");
  const secret = await nativeSecret(copy, stateDir);
  const manifestPath = join(copy.extensionDir, "manifest.json");
  const current = readFileSync(manifestPath, "utf8");
  const legacy = JSON.parse(current);
  legacy.permissions = legacy.permissions.filter((permission) => permission !== "nativeMessaging");
  writeFileSync(manifestPath, JSON.stringify(legacy));
  let browser, session;
  try {
    browser = await launchBrowser(copy.extensionDir);
    const { targetId } = await browser.cdp.send("Target.createTarget", { url: `chrome-extension://${browser.extensionId}/popup.html` });
    const { sessionId } = await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = (expression) => browser.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    await until(async () => (await evaluate('location.protocol === "chrome-extension:" && document.readyState === "complete"')).result.value);
    await evaluate(`chrome.storage.local.set({ hubSecret: ${JSON.stringify(secret)} })`);
    session = await startSession(copy.serverPath, { stateDir });
    await session.js("await cua.getState()");
    writeFileSync(manifestPath, current);
    await evaluate("chrome.runtime.reload()").catch(() => {});
    await until(async () => {
      try { await session.js("await cua.getState()"); return true; } catch { return false; }
    });
    assert.equal(readFileSync(join(stateDir, "extension-secret"), "utf8").trim(), secret);
  } finally { await session?.close(); await browser?.close(); copy.remove(); }
});
