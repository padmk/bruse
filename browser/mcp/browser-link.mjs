// Connection from this MCP server to the browser extension. The first MCP server to bind the local
// port becomes the hub: the extension connects to it, and every other MCP server (one per agent
// session) connects to the hub as a client. When the hub exits, the remaining servers elect a new one.
// Browser events are broadcast to every session; each session filters them by tab.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { EXTENSION_ORIGIN, PORT, STATE_DIR, TOKEN_PATH } from "./config.mjs";
import { acceptUpgrade, rejectUpgrade } from "./websocket.mjs";

const REQUEST_TIMEOUT_MS = 90_000;
// The extension retries on a 30-second alarm, so allow one full period for it to connect.
const EXTENSION_WAIT_MS = 35_000;
const KEEPALIVE_MS = 20_000;
const NOT_CONNECTED =
  "The browser extension did not connect. Make sure the browser is running and the Browser Control Bridge extension is enabled.";

// Identifies this agent session to the extension, which groups and cleans up its tabs.
export const sessionId = randomUUID();

const eventListeners = new Set();
let role = null; // Promise<{ send(method, params): Promise<unknown> }>

export function onBrowserEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function emitEvent(event) {
  for (const listener of eventListeners) listener(event);
}

export function callBrowser(method, params = {}) {
  role ??= becomeHub().catch((error) => {
    if (error.code !== "EADDRINUSE") throw error;
    return becomeClient();
  });
  return role.then(
    (link) => link.send(method, params),
    (error) => {
      role = null;
      throw error;
    },
  );
}

// Closes this session's unmarked agent tabs; called when the MCP client goes away.
export async function endSession() {
  if (!role) return;
  await Promise.race([callBrowser("session.end", { sessionId }).catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
}

function becomeHub() {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString("hex");
    let extension = null;
    const extensionWaiters = new Set();
    const clients = new Set();
    const pending = new Map(); // hub request id -> settle(reply)
    let nextId = 1;

    function forward(method, params, settle) {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        settle({ error: `${method} timed out` });
      }, REQUEST_TIMEOUT_MS);
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
      try {
        await whenExtensionConnected();
        forward(method, params, settle);
      } catch (error) {
        settle({ error: error.message });
      }
    }

    function acceptExtension(req, socket) {
      extension?.close();
      const peer = acceptUpgrade(req, socket);
      extension = peer;
      peer.on("message", (text) => {
        const message = JSON.parse(text);
        if (message.type === "event") {
          emitEvent(message);
          for (const client of clients) client.send(text);
          return;
        }
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      peer.on("close", () => {
        if (extension !== peer) return;
        extension = null;
        for (const settle of pending.values()) settle({ error: "The browser extension disconnected" });
        pending.clear();
      });
      for (const waiter of [...extensionWaiters]) waiter();
    }

    function acceptClient(req, socket) {
      const peer = acceptUpgrade(req, socket);
      let clientSession = null;
      clients.add(peer);
      peer.on("message", (text) => {
        const message = JSON.parse(text);
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
      const url = new URL(req.url, "http://localhost");
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

function becomeClient() {
  return new Promise((resolve, reject) => {
    const token = readFileSync(TOKEN_PATH, "utf8").trim();
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
            }, REQUEST_TIMEOUT_MS + 5_000);
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
      const message = JSON.parse(data);
      if (message.type === "event") return emitEvent(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    socket.addEventListener("error", () => reject(new Error("Could not reach the browser hub")));
    socket.addEventListener("close", () => {
      // The hub exited; the next call elects a new one.
      role = null;
      for (const settle of pending.values()) settle({ error: "The browser hub went away; retry the call" });
      pending.clear();
    });
  });
}
