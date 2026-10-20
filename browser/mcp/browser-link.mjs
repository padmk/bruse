// Connection from this MCP server to the browser extension. The first MCP server to bind the local
// port becomes the hub: the extension connects to it, and every other MCP server (one per agent
// session) connects to the hub as a client. When the hub exits, the remaining servers elect a new one.
// Browser events are broadcast to every session; each session filters them by tab.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { EXTENSION_ORIGIN, EXTENSION_SECRET_PATH, PORT, PRODUCT_NAME, STATE_DIR, TOKEN_PATH } from "./config.mjs";
import { acceptUpgrade, rejectUpgrade } from "./websocket.mjs";

const REQUEST_TIMEOUT_MS = 90_000;
// The extension's offscreen document retries every 0.5 s; this also covers pairing and a slow worker start.
const EXTENSION_WAIT_MS = 8_000;
const AUTH_TIMEOUT_MS = 5_000;
const KEEPALIVE_MS = 20_000;
const NOT_CONNECTED = `The browser extension did not connect. Make sure the browser is running and the ${PRODUCT_NAME} extension is enabled. If the extension was reinstalled, remove ${EXTENSION_SECRET_PATH} so that it can pair again.`;

// Requests may carry their own deadline (timeoutMs, e.g. waiting for a download); the transport allows a margin beyond it.
function deadlineFor(params) {
  return Math.max(REQUEST_TIMEOUT_MS, (Number(params?.timeoutMs) || 0) + 10_000);
}

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const hmac = (secret, message) => createHmac("sha256", secret).update(message).digest("hex");

function sameHex(a, b) {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Identifies this agent session to the extension, which groups and cleans up its tabs. It lives in the
// server's main thread, so it stays the same when the REPL worker is replaced.
export const sessionId = randomUUID();

const DRAIN_MS = 5_000;
const eventListeners = new Set();
let hubPending = null; // requests in flight while this process is the hub
let role = null; // Promise<{ send(method, params): Promise<unknown> }>
// Whether this session ever reached the browser, and so may own tabs to clean up.
let sessionUsed = false;

export function onBrowserEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function emitEvent(event) {
  for (const listener of eventListeners) listener(event);
}

// A hub that is shutting down takes no new requests; they were not run, so every one is resent.
const HUB_CLOSING = "The browser hub is shutting down";
let draining = false;
const HUB_GONE = "The browser hub went away while the request was in flight, so it may or may not have taken effect; check the page before repeating an action";
// Requests that only read state; they are resent through a new hub when the old one exits mid-call.
const READ_ONLY_METHODS = new Set(["browser.info", "tabs.list", "tabs.get", "tabs.agent", "tabs.waitForLoad", "page.state", "page.console", "page.network", "history.search"]);
const READ_ONLY_CDP = /^(DOM\.(getDocument|describeNode|getContentQuads|getBoxModel|getFrameOwner|resolveNode)|Accessibility\.|Page\.(getFrameTree|getLayoutMetrics|captureScreenshot)|Runtime\.(getProperties|releaseObject|releaseObjectGroup))$/;

function isReadOnly(method, params) {
  return READ_ONLY_METHODS.has(method) || (method === "cdp" && READ_ONLY_CDP.test(params?.method ?? ""));
}

function link() {
  role ??= becomeHub().catch((error) => {
    if (error.code !== "EADDRINUSE") throw error;
    return becomeClient();
  });
  return role.catch((error) => {
    role = null;
    throw error;
  });
}

export async function callBrowser(method, params = {}) {
  const closingDeadline = Date.now() + DRAIN_MS + 1_000;
  for (let attempt = 0; ; ) {
    const current = await link();
    sessionUsed = true;
    try {
      return await current.send(method, params);
    } catch (error) {
      // Until the closing hub is gone and a new one is elected.
      if (error.message === HUB_CLOSING && Date.now() < closingDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (attempt++ > 0 || error.message !== HUB_GONE || !isReadOnly(method, params)) throw error;
    }
  }
}

// Closes this session's unmarked agent tabs; called when the MCP client goes away. A hub also lets
// requests of other sessions finish before the process exits.
export async function endSession() {
  if (sessionUsed) await Promise.race([callBrowser("session.end", { sessionId }).catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
  draining = true;
  const deadline = Date.now() + DRAIN_MS;
  while (hubPending && hubPending.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

function becomeHub() {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString("hex");
    let extension = null;
    const extensionWaiters = new Set();
    const clients = new Set();
    const pending = new Map(); // hub request id -> settle(reply)
    hubPending = pending;
    let nextId = 1;

    function forward(method, params, settle) {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        settle({ error: `${method} timed out` });
      }, deadlineFor(params));
      pending.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      extension.send(JSON.stringify({ id, method, params }));
    }

    function whenExtensionConnected() {
      if (extension) return Promise.resolve();
      return new Promise((resolveWait, rejectWait) => {
        const waiter = () => {
          clearTimeout(timer);
          extensionWaiters.delete(waiter);
          resolveWait();
        };
        const timer = setTimeout(() => {
          extensionWaiters.delete(waiter);
          rejectWait(new Error(NOT_CONNECTED));
        }, EXTENSION_WAIT_MS);
        extensionWaiters.add(waiter);
      });
    }

    async function request(method, params, settle) {
      if (draining) return settle({ error: HUB_CLOSING });
      try {
        await whenExtensionConnected();
        forward(method, params, settle);
      } catch (error) {
        settle({ error: error.message });
      }
    }

    // The extension must prove the secret it paired with, and the hub proves it back; see the extension's
    // service worker. Only an authenticated connection receives requests.
    function acceptExtension(req, socket) {
      const peer = acceptUpgrade(req, socket);
      if (!peer) return;
      const nonce = randomBytes(32).toString("hex");
      let authenticated = false;
      const authTimer = setTimeout(() => authenticated || peer.close(), AUTH_TIMEOUT_MS);
      peer.send(JSON.stringify({ type: "challenge", nonce }));

      const activate = (secret, extensionNonce) => {
        authenticated = true;
        clearTimeout(authTimer);
        peer.send(JSON.stringify({ type: "auth-ok", mac: hmac(secret, `hub:${extensionNonce}`) }));
        const previous = extension;
        extension = peer;
        previous?.close();
        for (const waiter of [...extensionWaiters]) waiter();
      };

      peer.on("message", (text) => {
        const message = parse(text);
        if (!message) return;
        if (!authenticated) {
          if (message.type === "pair" && typeof message.secret === "string" && message.secret.length >= 32 && !existsSync(EXTENSION_SECRET_PATH)) {
            try {
              mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
              writeFileSync(EXTENSION_SECRET_PATH, message.secret, { mode: 0o600, flag: "wx" });
              activate(message.secret, String(message.nonce));
            } catch {
              peer.close();
            }
          } else if (message.type === "auth" && existsSync(EXTENSION_SECRET_PATH)) {
            const secret = readFileSync(EXTENSION_SECRET_PATH, "utf8").trim();
            if (sameHex(message.mac, hmac(secret, `extension:${nonce}`))) activate(secret, String(message.nonce));
            else peer.close();
          } else {
            if (message.type === "pair") process.stderr.write(`[browser-control] Refused to pair a new extension instance: ${EXTENSION_SECRET_PATH} already exists.\n`);
            peer.close();
          }
          return;
        }
        if (message.type === "event") {
          emitEvent(message);
          for (const client of clients) client.send(text);
          return;
        }
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      peer.on("close", () => {
        clearTimeout(authTimer);
        if (extension !== peer) return;
        extension = null;
        for (const settle of pending.values()) settle({ error: "The browser extension disconnected" });
        pending.clear();
      });
    }

    function acceptClient(req, socket) {
      const peer = acceptUpgrade(req, socket);
      if (!peer) return;
      let clientSession = null;
      clients.add(peer);
      peer.on("message", (text) => {
        const message = parse(text);
        if (!message) return;
        if (message.type === "hello") {
          clientSession = message.sessionId;
          return;
        }
        request(message.method, message.params, (reply) => peer.send(JSON.stringify({ ...reply, id: message.id })));
      });
      peer.on("close", () => {
        clients.delete(peer);
        if (clientSession) request("session.end", { sessionId: clientSession }, () => {});
      });
    }

    const server = http.createServer((_, response) => response.writeHead(426).end());
    server.on("upgrade", (req, socket) => {
      socket.on("error", () => {});
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        return rejectUpgrade(socket, "400 Bad Request");
      }
      if (url.pathname === "/extension" && req.headers.origin === EXTENSION_ORIGIN) acceptExtension(req, socket);
      else if (url.pathname === "/client" && !req.headers.origin && url.searchParams.get("token") === token) acceptClient(req, socket);
      else rejectUpgrade(socket);
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
      // Messages keep the extension's service worker alive while the hub exists.
      setInterval(() => extension?.send(JSON.stringify({ type: "keepalive" })), KEEPALIVE_MS).unref();
      resolve({
        send: (method, params) =>
          new Promise((resolveCall, rejectCall) =>
            request(method, params, (reply) => (reply.error ? rejectCall(new Error(reply.error)) : resolveCall(reply.result))),
          ),
      });
    });
  });
}

// A new hub writes its token right after binding the port, so a client that races it retries briefly.
async function becomeClient() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connectClient();
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function connectClient() {
  return new Promise((resolve, reject) => {
    let token;
    try {
      token = readFileSync(TOKEN_PATH, "utf8").trim();
    } catch {
      return reject(new Error("The browser hub token is not available yet"));
    }
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/client?token=${token}`);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", sessionId }));
      resolve({
        send: (method, params) =>
          new Promise((resolveCall, rejectCall) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`${method} timed out`));
            }, deadlineFor(params) + 5_000);
            pending.set(id, (reply) => {
              clearTimeout(timer);
              if (reply.error) rejectCall(new Error(reply.error));
              else resolveCall(reply.result);
            });
            socket.send(JSON.stringify({ id, method, params }));
          }),
      });
    });
    socket.addEventListener("message", ({ data }) => {
      const message = parse(data);
      if (!message) return;
      if (message.type === "event") return emitEvent(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    socket.addEventListener("error", () => reject(new Error("Could not reach the browser hub")));
    socket.addEventListener("close", () => {
      // The hub exited; the next call elects a new one.
      role = null;
      for (const settle of pending.values()) settle({ error: HUB_GONE });
      pending.clear();
    });
  });
}
