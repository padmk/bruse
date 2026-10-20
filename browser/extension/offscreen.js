// Holds the WebSocket to the local MCP hub. An offscreen document is not suspended like the service
// worker, so it can retry twice a second and connect as soon as an agent session starts. Requests are
// passed to the service worker, which executes them; its replies and events come back here.

// Must match PORT in mcp/config.mjs.
const HUB_URL = "ws://127.0.0.1:47615/extension";
const RETRY_MS = 500;

let socket = null;

function connect() {
  socket = new WebSocket(HUB_URL);
  socket.addEventListener("message", async ({ data }) => {
    // Every hub message, keepalives included, wakes the worker or extends its lifetime.
    const reply = await chrome.runtime.sendMessage({ target: "worker", type: "hub-message", data }).catch(() => null);
    if (reply && socket?.readyState === WebSocket.OPEN) socket.send(reply);
  });
  socket.addEventListener("close", () => {
    socket = null;
    setTimeout(connect, RETRY_MS);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;
  if (message.type === "send" && socket?.readyState === WebSocket.OPEN) socket.send(message.data);
});

connect();
