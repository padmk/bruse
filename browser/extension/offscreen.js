// Holds the WebSocket to the local MCP hub. An offscreen document is not suspended like the service
// worker, so it can retry twice a second and connect as soon as an agent session starts. Messages are
// passed to the service worker, which authenticates the hub and executes its requests. Each socket has
// a generation number so that a reply never reaches a newer hub than the one that asked.

// Must match PORT in mcp/config.mjs.
const HUB_URL = "ws://127.0.0.1:47615/extension";
const RETRY_MS = 500;

let socket = null;
let generation = 0;

function toWorker(message) {
  return chrome.runtime.sendMessage({ target: "worker", ...message }).catch(() => null);
}

function connect() {
  const current = new WebSocket(HUB_URL);
  const gen = ++generation;
  socket = current;
  current.addEventListener("open", () => toWorker({ type: "hub-open", gen }));
  current.addEventListener("message", async ({ data }) => {
    // Every hub message, keepalives included, wakes the worker or extends its lifetime.
    const reply = await toWorker({ type: "hub-message", gen, data });
    if (reply && current === socket && current.readyState === WebSocket.OPEN) current.send(reply);
  });
  current.addEventListener("close", () => {
    if (current !== socket) return;
    socket = null;
    toWorker({ type: "hub-closed", gen });
    setTimeout(connect, RETRY_MS);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;
  if (message.type === "send" && message.gen === generation && socket?.readyState === WebSocket.OPEN) socket.send(message.data);
});

connect();
