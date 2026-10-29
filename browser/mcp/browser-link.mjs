// Connection from this MCP server to the browser extension. The first MCP server to bind the local
// port becomes the hub: the extension connects to it, and every other MCP server (one per agent
// session) connects to the hub as a client. When the hub exits, the remaining servers elect a new one.
// Browser events are broadcast to every session; each session filters them by tab.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { EXTENSION_ORIGINS, EXTENSION_SECRET_PATH, HUB_VERSION_MISMATCH, PORT, PRODUCT_NAME, STATE_DIR, TOKEN_PATH, VERSION } from "./config.mjs";
import { acceptUpgrade, rejectUpgrade } from "./websocket.mjs";

const REQUEST_TIMEOUT_MS = 90_000;
// The extension's offscreen document retries every 0.5 s; this also covers pairing and a slow worker start.
const EXTENSION_WAIT_MS = 8_000;
const AUTH_TIMEOUT_MS = 5_000;
// Connections that have not authenticated yet, at most; more are refused until some finish.
const MAX_UNAUTHENTICATED = 32;
const KEEPALIVE_MS = 20_000;
const NOT_CONNECTED = `The browser extension did not connect. Make sure the browser is running and the ${PRODUCT_NAME} extension is enabled. If the extension was reinstalled, remove ${EXTENSION_SECRET_PATH} so that it can pair again.`;

// How MCP servers authenticate to the hub and the hub to them (see connectClient). The hub announces it
// in its challenge and on plain HTTP requests, so that servers of different versions can tell why they
// cannot connect.
const CLIENT_PROTOCOL = 2;
const PROTOCOL_HEADER = "x-hub-protocol";
const OTHER_HUB = `The process listening on 127.0.0.1:${PORT} is not a browser hub of ${PRODUCT_NAME} ${VERSION}. Most likely an agent session started before an update still runs an older ${PRODUCT_NAME} MCP server, which this version cannot talk to. Restart (or end) the agent sessions that use ${PRODUCT_NAME}, then retry.`;
const IMPOSTOR_HUB = `The process listening on 127.0.0.1:${PORT} did not prove that it is the browser hub (it does not know the hub token), so no request was sent to it.`;
const HEX_NONCE = /^[0-9a-f]{64}$/;

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

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const hmac = (secret, message) => createHmac("sha256", secret).update(message).digest("hex");

const HEX_MAC = /^[0-9a-f]{64}$/;

// Constant-time comparison of two SHA-256 hex digests; anything else never matches.
function sameHex(a, b) {
  return typeof a === "string" && typeof b === "string" && HEX_MAC.test(a) && HEX_MAC.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Whether `secret` is the stored extension secret, compared in constant time.
function sameSecret(secret) {
  let stored;
  try {
    stored = readFileSync(EXTENSION_SECRET_PATH, "utf8").trim();
  } catch {
    return false;
  }
  return sameHex(hmac(stored, "pairing"), hmac(secret, "pairing"));
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
// Set when the session ends: it no longer counts as live and stops reconnecting.
let sessionEnding = false;

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
  sessionEnding = true;
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
    const clients = new Map(); // authenticated client connection -> its session id, once it said hello
    const pending = new Map(); // hub request id -> settle(reply)
    hubPending = pending;
    let nextId = 1;

    // `session` is the agent session the request comes from: the hub's own, or the one a client named in
    // its hello. The extension decides tab access by it, so it travels outside the request's parameters,
    // which the session's code controls.
    function forward(method, params, settle, session) {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        settle({ error: `${method} timed out` });
      }, deadlineFor(params));
      pending.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      extension.send(JSON.stringify({ id, method, params, session: session ?? null }));
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

    // The extension closes the tabs of a session that stays absent from this list for a while (its
    // server was killed, also when it was the hub), so it is sent whenever it changes.
    function reportSessions() {
      const sessionIds = new Set([...clients.values()].filter(Boolean));
      if (!sessionEnding) sessionIds.add(sessionId);
      extension?.send(JSON.stringify({ type: "live-sessions", sessionIds: [...sessionIds] }));
    }

    async function request(method, params, settle, session) {
      if (draining) return settle({ error: HUB_CLOSING });
      try {
        await whenExtensionConnected();
        forward(method, params, settle, session);
      } catch (error) {
        settle({ error: error.message });
      }
    }

    // A connection that has not authenticated yet takes only small messages, is closed after
    // AUTH_TIMEOUT_MS, and counts against MAX_UNAUTHENTICATED until `authenticated()` is called.
    let unauthenticated = 0;
    function admit(req, socket) {
      if (unauthenticated >= MAX_UNAUTHENTICATED) {
        rejectUpgrade(socket, "503 Service Unavailable");
        return null;
      }
      const peer = acceptUpgrade(req, socket);
      if (!peer) return null;
      unauthenticated++;
      let counted = true;
      const timer = setTimeout(() => peer.close(), AUTH_TIMEOUT_MS);
      const release = () => {
        clearTimeout(timer);
        if (counted) unauthenticated--;
        counted = false;
      };
      peer.on("close", release);
      return {
        peer,
        authenticated() {
          release();
          peer.authenticated();
        },
      };
    }

    // The extension must prove the secret it paired with, and the hub proves it back; see the extension's
    // service worker. Only an authenticated connection receives requests.
    function acceptExtension(req, socket) {
      const admitted = admit(req, socket);
      if (!admitted) return;
      const { peer } = admitted;
      const nonce = randomBytes(32).toString("hex");
      let authenticated = false;
      peer.send(JSON.stringify({ type: "challenge", nonce }));

      const activate = (secret, extensionNonce) => {
        authenticated = true;
        admitted.authenticated();
        peer.send(JSON.stringify({ type: "auth-ok", mac: hmac(secret, `hub:${extensionNonce}`) }));
        const previous = extension;
        extension = peer;
        previous?.close();
        reportSessions();
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
          } else if (message.type === "pair" && typeof message.secret === "string" && sameSecret(message.secret)) {
            // The hub stored this secret, but its auth-ok did not arrive; the extension still offers it.
            activate(message.secret, String(message.nonce));
          } else if (message.type === "auth" && existsSync(EXTENSION_SECRET_PATH)) {
            let secret = null;
            try {
              secret = readFileSync(EXTENSION_SECRET_PATH, "utf8").trim();
            } catch {}
            if (secret && sameHex(message.mac, hmac(secret, `extension:${nonce}`))) activate(secret, String(message.nonce));
            else peer.close();
          } else {
            if (message.type === "pair") process.stderr.write(`[browser-control] Refused to pair a new extension instance: ${EXTENSION_SECRET_PATH} already exists.\n`);
            peer.close();
          }
          return;
        }
        // An event names the sessions that may see it (`audience`), or none to reach every session.
        if (message.type === "event") {
          const reaches = (session) => !Array.isArray(message.audience) || message.audience.includes(session);
          if (reaches(sessionId)) emitEvent(message);
          for (const [client, clientSession] of clients) if (reaches(clientSession)) client.send(text);
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
    }

    // A client proves that it read the hub token, and the hub proves it back, with HMAC over fresh
    // nonces (see connectClient); the token itself never crosses the connection. MCP servers of versions
    // before that handshake present the token in the URL instead (`legacy`), which the upgrade handler
    // has checked, so agent sessions started before an update keep working with the new hub. Only an
    // authenticated client's requests are run.
    function acceptClient(req, socket, { legacy }) {
      const admitted = admit(req, socket);
      if (!admitted) return;
      const { peer } = admitted;
      const nonce = randomBytes(32).toString("hex");
      let authenticated = false;
      let clientSession = null;
      const authenticate = () => {
        authenticated = true;
        admitted.authenticated();
        clients.set(peer, null);
      };
      if (legacy) authenticate();
      else peer.send(JSON.stringify({ type: "challenge", protocol: CLIENT_PROTOCOL, nonce }));
      peer.on("message", (text) => {
        const message = parse(text);
        if (!message) return authenticated || peer.close();
        if (!authenticated) {
          const clientNonce = message.nonce;
          if (message.type === "auth" && typeof clientNonce === "string" && HEX_NONCE.test(clientNonce) && sameHex(message.mac, hmac(token, `client:${nonce}:${clientNonce}`))) {
            authenticate();
            peer.send(JSON.stringify({ type: "auth-ok", mac: hmac(token, `hub:${clientNonce}:${nonce}`) }));
          } else {
            peer.close();
          }
          return;
        }
        if (message.type === "hello") {
          if (typeof message.sessionId !== "string") return;
          clientSession = message.sessionId;
          clients.set(peer, clientSession);
          reportSessions();
          return;
        }
        request(message.method, message.params, (reply) => peer.send(JSON.stringify({ ...reply, id: message.id })), clientSession);
      });
      peer.on("close", () => {
        if (!clients.delete(peer)) return;
        if (clientSession) request("session.end", { sessionId: clientSession }, () => {}, clientSession);
        reportSessions();
      });
    }

    const server = http.createServer((_, response) => response.writeHead(426, { [PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) }).end());
    server.on("upgrade", (req, socket) => {
      socket.on("error", () => {});
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        return rejectUpgrade(socket, "400 Bad Request");
      }
      // A web page that points its own host name at 127.0.0.1 (DNS rebinding) still sends that name.
      if (!LOCAL_HOSTS.has(req.headers.host)) return rejectUpgrade(socket);
      if (url.pathname === "/extension" && EXTENSION_ORIGINS.has(req.headers.origin)) acceptExtension(req, socket);
      else if (url.pathname === "/client" && !req.headers.origin) {
        const legacyToken = url.searchParams.get("token");
        if (legacyToken === null) acceptClient(req, socket, { legacy: false });
        else if (sameHex(legacyToken, token)) acceptClient(req, socket, { legacy: true });
        else rejectUpgrade(socket);
      } else rejectUpgrade(socket);
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
            request(method, params, (reply) => (reply.error ? rejectCall(new Error(reply.error)) : resolveCall(reply.result)), sessionId),
          ),
      });
    });
  });
}

// A session that may own tabs links up again as soon as its hub goes away, also while it is idle, so
// that the next hub lists it as live before the extension's grace period for absent sessions ends. The
// random delay spreads the sessions' elections.
function reconnectSoon(delayMs = 100 + Math.random() * 400) {
  if (!sessionUsed || sessionEnding || draining) return;
  setTimeout(() => {
    if (role || sessionEnding || draining) return;
    link().catch(() => reconnectSoon(Math.min(delayMs * 2, 5_000)));
  }, delayMs).unref();
}

// A new hub writes its token right after binding the port, so a client that races it retries briefly.
// A hub of another version will not let it in, so that is reported at once.
async function becomeClient() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connectClient();
    } catch (error) {
      if (attempt >= 10 || error.code === HUB_VERSION_MISMATCH) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const versionMismatch = () => Object.assign(new Error(OTHER_HUB), { code: HUB_VERSION_MISMATCH });

// Why the hub refused the connection: hubs of this version name their protocol on plain HTTP requests.
function refusalReason() {
  return new Promise((resolve) => {
    const unreachable = () => resolve(new Error("Could not reach the browser hub"));
    const probe = http.get({ host: "127.0.0.1", port: PORT, path: "/client", timeout: 1_000 }, (response) => {
      response.resume();
      resolve(response.headers[PROTOCOL_HEADER] === String(CLIENT_PROTOCOL) ? new Error("Could not reach the browser hub") : versionMismatch());
    });
    probe.on("error", unreachable);
    probe.on("timeout", () => probe.destroy());
  });
}

// Mutual authentication with the hub: the hub sends a nonce, this server answers with an HMAC keyed
// with the hub token (which only this user can read) over both nonces, and the hub proves the token back
// over them in the other order. Requests go out only after that proof, so a process posing as the hub on
// the port learns neither the token nor any request.
function connectClient() {
  return new Promise((resolve, reject) => {
    let token;
    try {
      token = readFileSync(TOKEN_PATH, "utf8").trim();
    } catch {
      return reject(new Error("The browser hub token is not available yet"));
    }
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/client`);
    const nonce = randomBytes(32).toString("hex");
    let hubNonce = null;
    let opened = false;
    let verified = false;
    const fail = (error) => {
      reject(error);
      socket.close();
    };
    const authTimer = setTimeout(() => fail(new Error("The browser hub did not authenticate in time")), AUTH_TIMEOUT_MS);
    const pending = new Map();
    let nextId = 1;
    const send = (method, params) =>
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
      });
    socket.addEventListener("open", () => {
      opened = true;
    });
    socket.addEventListener("message", ({ data }) => {
      const message = parse(data);
      if (!message) return;
      if (!verified) {
        if (message.type === "challenge" && hubNonce === null) {
          if (message.protocol !== CLIENT_PROTOCOL) return fail(versionMismatch());
          if (typeof message.nonce !== "string" || !HEX_NONCE.test(message.nonce)) return fail(new Error(IMPOSTOR_HUB));
          hubNonce = message.nonce;
          socket.send(JSON.stringify({ type: "auth", nonce, mac: hmac(token, `client:${hubNonce}:${nonce}`) }));
        } else if (message.type === "auth-ok" && hubNonce !== null && sameHex(message.mac, hmac(token, `hub:${nonce}:${hubNonce}`))) {
          verified = true;
          clearTimeout(authTimer);
          socket.send(JSON.stringify({ type: "hello", sessionId }));
          resolve({ send });
        } else {
          fail(new Error(IMPOSTOR_HUB));
        }
        return;
      }
      if (message.type === "event") return emitEvent(message);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    socket.addEventListener("close", async () => {
      clearTimeout(authTimer);
      if (!verified) {
        // A refused upgrade may come from a hub of another version, which the probe tells. A hub that
        // closes during authentication may have written a new token since it was read; becomeClient retries.
        reject(opened ? new Error("The browser hub closed the connection during authentication") : await refusalReason());
        return;
      }
      // The hub exited; the next call elects a new one, or the reconnect below does.
      role = null;
      for (const settle of pending.values()) settle({ error: HUB_GONE });
      pending.clear();
      reconnectSoon();
    });
  });
}
