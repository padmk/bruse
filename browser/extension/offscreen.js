// Holds the WebSocket to the local MCP hub. An offscreen document is not suspended like the service
// worker, so it can retry twice a second and connect as soon as an agent session starts. Messages are
// passed to the service worker, which authenticates the hub and executes its requests. Each socket has
// a generation number so that a reply never reaches a newer hub than the one that asked.

import { fromExtensionPage, isRecord } from "./sender.js";
import { HUB_PORT, ignore, logFailure } from "./shared.js";

const HUB_URL = `ws://127.0.0.1:${HUB_PORT}/extension`;
const RETRY_MS = 500;

/** @type {WebSocket | null} */
let socket = null;
let generation = 0;

// Resolves with the worker's reply; rejects when no worker took the message.
/** @param {Record<string, unknown>} message @returns {Promise<unknown>} */
function toWorker(message) {
  return chrome.runtime.sendMessage({ target: "worker", ...message });
}

function connect() {
  const current = new WebSocket(HUB_URL);
  const gen = ++generation;
  socket = current;
  current.addEventListener("open", () => {
    toWorker({ type: "hub-open", gen }).catch(ignore("the worker starts over when the first message of a newer generation reaches it"));
  });
  /** @param {unknown} data */
  const relay = async (data) => {
    // Every hub message, keepalives included, wakes the worker or extends its lifetime.
    const reply = await toWorker({ type: "hub-message", gen, data }).catch(() => null);
    if (typeof reply === "string" && current === socket && current.readyState === WebSocket.OPEN) current.send(reply);
  };
  current.addEventListener("message", ({ data }) => {
    relay(data).catch(logFailure("Relaying a hub message"));
  });
  current.addEventListener("close", () => {
    if (current !== socket) return;
    socket = null;
    toWorker({ type: "hub-closed", gen }).catch(ignore("the worker drops what it sends for an older generation, and the next connection starts over"));
    setTimeout(connect, RETRY_MS);
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!isRecord(message) || message.target !== "offscreen" || !fromExtensionPage(sender)) return;
  if (message.type === "send" && message.gen === generation && socket?.readyState === WebSocket.OPEN && typeof message.data === "string") socket.send(message.data);
  // The service worker lost this connection's authentication (it restarted); a new connection redoes it.
  if (message.type === "reconnect" && message.gen === generation) socket?.close();
});

connect();
