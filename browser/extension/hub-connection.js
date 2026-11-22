// Holds the WebSocket to the local MCP hub in the service worker. It retries twice a second while no
// hub listens, so it connects as soon as an agent session starts. Each socket has a generation number,
// so that a reply never reaches a newer hub than the one that asked.
//
// The connection lives in the service worker rather than in an offscreen document: when the
// extension's renderer process dies, the browser restarts a service worker on its next event (the
// alarm below), but marks an extension whose offscreen document died as crashed and runs none of its
// code again until the user reloads it.
//
// Observed in Chrome for Testing 159 (test/crash-recovery.test.mjs keeps the first point): after its
// process was killed, an extension with an offscreen document stayed "TERMINATED" with no contexts,
// while one with only a service worker ran again at its next alarm. A worker that only retried a
// WebSocket was stopped as idle within a minute; with the extension API call below every 20 s it was
// still running after six minutes without a hub, and reconnected at once when one started. Messages on an open WebSocket, such as the hub's keepalives,
// keep it running too. After a few minutes of refused connections the browser starts each new
// WebSocket of the extension 1 to 5 s late, which bounds the rate of the retries below.

import { HUB_PORT, logFailure } from "./shared.js";

const HUB_URL = `ws://127.0.0.1:${HUB_PORT}/extension`;
// The retries have no limit: the extension waits for a hub as long as the browser runs, and a session
// expects it within moments. The browser's own spacing (see above) is their backoff.
const RETRY_MS = 500;
// A connection that neither opens nor fails by then (something holds the port without answering) is
// dropped for a new one. The browser's start delay and the hub's handshake fit well within it.
const CONNECT_TIMEOUT_MS = 15_000;
// An extension API call this often keeps the browser from stopping the worker as idle (after 30 s).
const KEEP_RUNNING_MS = 20_000;
// Wakes a service worker the browser stopped anyway, which reconnects as its module loads.
const WAKE_ALARM = "hub-connection";

/**
 * What the service worker does with the connection of generation `gen`. `message` resolves with the
 * reply to send, if any.
 * @typedef {object} HubHandlers
 * @property {(gen: number) => void} opened
 * @property {(gen: number, text: unknown) => Promise<string | null>} message
 * @property {(gen: number) => void} closed
 */

/**
 * Where the connection is: a socket of generation `gen` (connecting or open, as its readyState says),
 * or the wait before the next attempt.
 * @typedef {{ phase: "socket", gen: number, socket: WebSocket, deadline: ReturnType<typeof setTimeout> } | { phase: "waiting", gen: number, timer: ReturnType<typeof setTimeout> }} Connection
 */

/** @type {Connection | null} */
let connection = null;

// The one place the connection changes phase; it ends what the previous phase held.
/** @param {Connection} next */
function enter(next) {
  if (connection?.phase === "socket") clearTimeout(connection.deadline);
  if (connection?.phase === "waiting") clearTimeout(connection.timer);
  connection = next;
}

/** @param {HubHandlers} handlers */
function connect(handlers) {
  const gen = (connection?.gen ?? 0) + 1;
  /** @type {WebSocket} */
  let socket;
  try {
    socket = new WebSocket(HUB_URL);
  } catch (error) {
    logFailure("Opening the hub connection")(error);
    wait(handlers, gen);
    return;
  }
  const current = () => connection?.phase === "socket" && connection.socket === socket;
  enter({ phase: "socket", gen, socket, deadline: setTimeout(() => socket.readyState === WebSocket.CONNECTING && socket.close(), CONNECT_TIMEOUT_MS) });
  socket.addEventListener("open", () => {
    if (current()) handlers.opened(gen);
  });
  socket.addEventListener("message", ({ data }) => {
    handlers
      .message(gen, data)
      .then((reply) => {
        if (reply !== null && current() && socket.readyState === WebSocket.OPEN) socket.send(reply);
      })
      .catch(logFailure("Handling a hub message"));
  });
  socket.addEventListener("close", () => {
    if (!current()) return;
    handlers.closed(gen);
    wait(handlers, gen);
  });
}

/** @param {HubHandlers} handlers @param {number} gen */
function wait(handlers, gen) {
  enter({ phase: "waiting", gen, timer: setTimeout(() => connect(handlers), RETRY_MS) });
}

function keepRunning() {
  chrome.runtime.getPlatformInfo().catch(logFailure("Keeping the service worker running"));
}

// Starts connecting, and keeps a connection to the hub from then on. Called once, as the worker's
// module loads, so that the wake-up listeners are registered before the events they wake it for.
/** @param {HubHandlers} handlers */
export function startHubConnection(handlers) {
  chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 }).catch(logFailure("Scheduling the service worker wake-up"));
  // Each of these events only starts a stopped worker, which connects as its module loads.
  chrome.alarms.onAlarm.addListener(keepRunning);
  chrome.runtime.onStartup.addListener(keepRunning);
  setInterval(keepRunning, KEEP_RUNNING_MS);
  connect(handlers);
}

// Sends `text` on the connection of generation `gen`, if it is still the open one.
/** @param {number} gen @param {string} text */
export function sendToHub(gen, text) {
  if (connection?.phase === "socket" && connection.gen === gen && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(text);
}

// Drops the connection of generation `gen`, if it is still the current one; a new one follows.
/** @param {number} gen */
export function reconnectHub(gen) {
  if (connection?.phase === "socket" && connection.gen === gen) connection.socket.close();
}
