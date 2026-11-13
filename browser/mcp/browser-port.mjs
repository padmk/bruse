// Browser access for code running in the REPL worker. The connection to the browser lives in the
// server's main thread (browser-link.mjs), so replacing the worker never drops it; calls and events
// cross the thread boundary as messages.

import { parentPort as threadPort, workerData } from "node:worker_threads";

if (!threadPort) throw new Error("browser-port.mjs runs in the REPL worker thread");
const parentPort = threadPort;

export const sessionId = workerData.sessionId;

const pending = new Map(); // call id -> { resolve, reject }
const eventListeners = new Set();
let nextId = 1;

parentPort.on("message", (message) => {
  if (message.type === "browser-reply") {
    const call = pending.get(message.callId);
    pending.delete(message.callId);
    if (message.error !== undefined) call?.reject(new Error(message.error));
    else call?.resolve(message.result);
  } else if (message.type === "browser-event") {
    for (const listener of eventListeners) listener(message.event);
  }
});

/** @type {import("../extension/shared.js").BrowserCall} */
export function callBrowser(method, ...[params = {}]) {
  return new Promise((resolve, reject) => {
    const callId = nextId++;
    pending.set(callId, { resolve, reject });
    parentPort.postMessage({ type: "browser-call", callId, method, params });
  });
}

export function onBrowserEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}
