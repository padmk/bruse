// Connection from this MCP server to the browser extension. The first MCP server to bind the local
// port becomes the hub: the extension connects to it, and every other MCP server (one per agent
// session) connects to the hub as a client. When the hub exits, the remaining servers elect a new one.
// Browser events are broadcast to every session; each session filters them by tab.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { EXTENSION_ORIGINS, EXTENSION_SECRET_PATH, HUB_VERSION_MISMATCH, PORT, PRODUCT_NAME, STATE_DIR, TOKEN_PATH, VERSION } from "./config.mjs";
import { acceptUpgrade, rejectUpgrade } from "./websocket.mjs";
import { PAIRING_FAILURES, ignore, isReadOnly, logFailure } from "../extension/shared.js";

const REQUEST_TIMEOUT_MS = 90_000;
// The extension's offscreen document retries every 0.5 s; this also covers pairing and a slow worker start.
const EXTENSION_WAIT_MS = 8_000;
const AUTH_TIMEOUT_MS = 5_000;
// Connections that have not authenticated yet, at most; more are refused until some finish.
const MAX_UNAUTHENTICATED = 32;
const KEEPALIVE_MS = 20_000;
const NOT_CONNECTED_START = "The browser extension did not connect.";
const NOT_CONNECTED = `${NOT_CONNECTED_START} Make sure the browser is running (on macOS, Chrome with no window open stops its extensions: open a window) and the ${PRODUCT_NAME} extension is enabled, and run \`bruse doctor\`. If it is enabled but stays disconnected, its process may have crashed, which it cannot recover from alone: the user clicks Reload on it on the extensions page. If the extension was reinstalled, the user runs \`bruse setup\` in a terminal.`;
// An extension reached the hub but did not authenticate. The hub words every cause itself: the
// connection is not authenticated, so whatever it says may come from a process posing as the extension.
const PAIRING_FAILED = (cause) =>
  `${NOT_CONNECTED_START} The ${PRODUCT_NAME} extension reached the browser hub but could not pair with it: ${cause}. The user runs \`bruse setup\` in a terminal, which registers the native pairing host for each installed browser; \`bruse doctor\` checks the pairing.`;
const UNKNOWN_PAIRING_FAILURE = "the extension could not get the pairing secret";
const NO_HUB_SECRET = "this computer has no pairing secret yet";
const OTHER_SECRET = "the extension proved a pairing secret other than this computer's";
// How MCP servers authenticate to the hub and the hub to them (see connectClient). The hub announces it
// in its challenge and on plain HTTP requests, so that servers of different versions can tell why they
// cannot connect.
const CLIENT_PROTOCOL = 2;
const PROTOCOL_HEADER = "x-hub-protocol";
// Whether a call failed only because no extension is connected to a hub that proved the hub token.
// Hubs of other versions word the rest of the message differently.
export const isNotConnected = (error) => Boolean(error?.message?.startsWith(NOT_CONNECTED_START));
const OTHER_HUB = `The process listening on 127.0.0.1:${PORT} is not a browser hub of ${PRODUCT_NAME} ${VERSION}. Most likely an agent session started before an update still runs an older ${PRODUCT_NAME} MCP server, which this version cannot talk to. Restart (or end) the agent sessions that use ${PRODUCT_NAME}, then retry.`;
const IMPOSTOR_HUB = `The process listening on 127.0.0.1:${PORT} did not prove that it is the browser hub (it does not know the hub token), so no request was sent to it.`;
const HEX_NONCE = /^[0-9a-f]{64}$/;

// Requests may carry their own deadline (timeoutMs, e.g. waiting for a download); the transport allows a margin beyond it.
function deadlineFor(params) {
  return Math.max(REQUEST_TIMEOUT_MS, (Number(params?.timeoutMs) || 0) + 10_000);
}

// An error reply from the hub, with its code when it has one.
const replyError = ({ error, code }) => Object.assign(new Error(error), { code });

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

// Identifies this agent session to the extension, which groups and cleans up its tabs. It lives in the
// server's main thread, so it stays the same when the REPL worker is replaced.
export const sessionId = randomUUID();

const DRAIN_MS = 5_000;
const eventListeners = new Set();
let hubPending = null; // requests in flight while this process is the hub
let role = null; // Promise<{ send(method, params, generation): Promise<unknown> }>
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

const DROPPED = "The request was not sent: the REPL that made it was replaced";
// A hub that is shutting down takes no new requests; they were not run, so every one is resent.
const HUB_CLOSING = "The browser hub is shutting down";
let draining = false;
const HUB_GONE = "The browser hub went away while the request was in flight, so it may or may not have taken effect; check the page before repeating an action";
// The extension reconnects within half a second after a restart of its service worker or a reload.
const EXTENSION_GONE = "The browser extension disconnected while the request was in flight (it restarted or was reloaded), so the request may or may not have taken effect. It reconnects within moments: check the page, then repeat the call if needed";
// The state directory and the secrets in it are the user's only, also when they existed with wider
// permissions before.
function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
}

// Replaces `path` with a new file that only the user can read, so that no reader sees it half written.
function writePrivate(path, value) {
  ensureStateDir();
  const temp = `${path}.${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The write failed before it created the file; the write's error is the one to report.
    }
    throw error;
  }
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

// `wanted` is asked before the request is sent, also before each resend: a request of a REPL that was
// replaced meanwhile is dropped instead of reaching the browser after the replacement cancelled the
// session's requests in flight.
/**
 * @template {import("../extension/shared.js").Method} M
 * @param {M} method
 * @param {import("../extension/shared.js").Params<M>} [params]
 * @param {{ wanted?: () => boolean, generation?: number }} [options] `generation`: that of the REPL whose
 *   request this relays; requests the host sends on its own have none, and no session.cancel aborts them.
 * @returns {Promise<import("../extension/shared.js").Result<M>>}
 */
export async function callBrowser(method, params = {}, { wanted = () => true, generation } = {}) {
  const closingDeadline = Date.now() + DRAIN_MS + 1_000;
  for (let attempt = 0; ; ) {
    const current = await link();
    if (!wanted()) throw new Error(DROPPED);
    sessionUsed = true;
    try {
      return await current.send(method, params, generation);
    } catch (error) {
      // Until the closing hub is gone and a new one is elected.
      if (error.message === HUB_CLOSING && Date.now() < closingDeadline) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (attempt++ > 0 || ![HUB_GONE, EXTENSION_GONE].includes(error.message) || !isReadOnly(method, params)) throw error;
    }
  }
}

// Closes this session's unmarked agent tabs; called when the MCP client goes away. A hub also lets
// requests of other sessions finish before the process exits.
export async function endSession() {
  sessionEnding = true;
  if (sessionUsed) await Promise.race([callBrowser("session.end", { sessionId }).catch(ignore("the extension also ends a session the hub stops reporting")), new Promise((r) => setTimeout(r, 2_000))]);
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
    // Why an extension last failed to authenticate, and when: { cause, at }. A failing extension tries
    // again at least once every AUTH_TIMEOUT_MS plus its retry delay, which is within EXTENSION_WAIT_MS,
    // so an older report no longer describes a browser that is running.
    let pairingFailure = null;

    // `session` is the agent session the request comes from: the hub's own, or the one a client named in
    // its hello. The extension decides tab access by it, so it travels outside the request's parameters,
    // which the session's code controls, like `generation`, the relaying REPL's (see requests.js).
    function forward(method, params, settle, session, generation) {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        settle({ error: `${method} timed out` });
      }, deadlineFor(params));
      pending.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      extension.send(JSON.stringify({ id, method, params, session: session ?? null, ...(Number.isSafeInteger(generation) ? { generation } : {}) }));
    }

    function whenExtensionConnected() {
      if (extension) return Promise.resolve();
      return new Promise((resolveWait, rejectWait) => {
        const waiter = () => {
          clearTimeout(timer);
          extensionWaiters.delete(waiter);
          resolveWait(undefined);
        };
        const timer = setTimeout(() => {
          extensionWaiters.delete(waiter);
          const failed = pairingFailure && Date.now() - pairingFailure.at <= EXTENSION_WAIT_MS;
          rejectWait(new Error(failed ? PAIRING_FAILED(pairingFailure.cause) : NOT_CONNECTED));
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

    // Settles with the reply, or with the error that kept the request from the extension.
    function request(method, params, settle, session, generation) {
      if (draining) return settle({ error: HUB_CLOSING });
      whenExtensionConnected()
        .then(() => forward(method, params, settle, session, generation))
        .catch((error) => settle({ error: error.message, code: error.code }))
        .catch(logFailure("Answering a browser request"));
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
        pairingFailure = null;
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
          // The extension says why it has no answer. The connection stays open until its authentication
          // deadline, so that the extension starts the native host again only at that pace.
          if (message.type === "pairing-failed") {
            const known = typeof message.reason === "string" && Object.hasOwn(PAIRING_FAILURES, message.reason);
            pairingFailure = { cause: known ? PAIRING_FAILURES[message.reason] : UNKNOWN_PAIRING_FAILURE, at: Date.now() };
            return;
          }
          let secret = null;
          try {
            secret = readFileSync(EXTENSION_SECRET_PATH, "utf8").trim();
          } catch {
            // No pairing secret yet: the proof below cannot match, and the cause is reported.
          }
          if (message.type === "auth" && secret && HEX_NONCE.test(message.nonce) && sameHex(message.mac, hmac(secret, `extension:${nonce}`))) activate(secret, message.nonce);
          else {
            if (message.type === "auth") pairingFailure = { cause: secret ? OTHER_SECRET : NO_HUB_SECRET, at: Date.now() };
            peer.close();
          }
          return;
        }
        // An event names the sessions that may see it (`audience`), or none to reach every session.
        if (message.type === "event") {
          const reaches = (session) => !Array.isArray(message.audience) || message.audience.includes(session);
          if (reaches(sessionId)) emitEvent(message);
          // A client that has not named its session yet acts for none, and the extension refuses it the tabs.
          for (const [client, clientSession] of clients) if (clientSession !== null && reaches(clientSession)) client.send(text);
          return;
        }
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      });
      peer.on("close", () => {
        if (extension !== peer) return;
        extension = null;
        for (const settle of pending.values()) settle({ error: EXTENSION_GONE });
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
        request(message.method, message.params, (reply) => peer.send(JSON.stringify({ ...reply, id: message.id })), clientSession, message.generation);
      });
      peer.on("close", () => {
        if (!clients.delete(peer)) return;
        if (clientSession) request("session.end", { sessionId: clientSession }, ignore("nobody waits for the reply of a client that is gone"), clientSession);
        reportSessions();
      });
    }

    const server = http.createServer((_, response) => response.writeHead(426, { [PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) }).end());
    server.on("upgrade", (req, socket) => {
      socket.on("error", ignore("a socket that fails is closed, which ends its connection"));
      let url;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        return rejectUpgrade(socket, "400 Bad Request");
      }
      // A web page that points its own host name at 127.0.0.1 (DNS rebinding) still sends that name.
      if (!LOCAL_HOSTS.has(req.headers.host ?? "")) return rejectUpgrade(socket);
      if (url.pathname === "/extension" && EXTENSION_ORIGINS.has(req.headers.origin ?? "")) acceptExtension(req, socket);
      else if (url.pathname === "/client" && !req.headers.origin) {
        const legacyToken = url.searchParams.get("token");
        if (legacyToken === null) acceptClient(req, socket, { legacy: false });
        else if (sameHex(legacyToken, token)) acceptClient(req, socket, { legacy: true });
        else rejectUpgrade(socket);
      } else rejectUpgrade(socket);
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      writePrivate(TOKEN_PATH, token);
      // Messages keep the extension's service worker alive while the hub exists.
      setInterval(() => extension?.send(JSON.stringify({ type: "keepalive" })), KEEPALIVE_MS).unref();
      resolve({
        send: (method, params, generation) =>
          new Promise((resolveCall, rejectCall) =>
            request(method, params, (reply) => (reply.error ? rejectCall(replyError(reply)) : resolveCall(reply.result)), sessionId, generation),
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
    const exchange = (name, fields, timeoutMs) =>
      new Promise((resolveCall, rejectCall) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error(`${name} timed out`));
        }, timeoutMs);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          if (reply.error) rejectCall(replyError(reply));
          else resolveCall(reply.result);
        });
        socket.send(JSON.stringify({ id, ...fields }));
      });
    const send = (method, params, generation) => exchange(method, { method, params, ...(generation === undefined ? {} : { generation }) }, deadlineFor(params) + 5_000);
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
    socket.addEventListener("close", () => {
      clearTimeout(authTimer);
      if (!verified) {
        // A refused upgrade may come from a hub of another version, which the probe tells. A hub that
        // closes during authentication may have written a new token since it was read; becomeClient retries.
        if (opened) reject(new Error("The browser hub closed the connection during authentication"));
        else refusalReason().then(reject, reject);
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
