#!/usr/bin/env node
// MCP stdio server with a persistent JavaScript REPL (`js`) whose `cua` global controls the user's
// browser through the extension (see cua/ and browser-link.mjs).

import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { callBrowser, endSession, onBrowserEvent, sessionId } from "./browser-link.mjs";
import { beforeInput, isOpeningInput, onEvent as guardFocus } from "./focus-guard.mjs";

const SERVER_INFO = { name: "browser-control", version: "0.3.0" };

// The REPL's dynamic import support is flagged experimental; keep that notice out of the client's log.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") process.stderr.write(`${warning.stack ?? warning}\n`);
});

const JS_DESCRIPTION = `Control the user's browser by running JavaScript in a persistent REPL with the global \`cua\`.

On the first call, or after js_reset, run exactly one entry call and read the documentation it returns:
- \`await cua.getState()\` for an inventory of browsers and open tabs,
- \`const tab = await cua.createBrowserTab("1", url)\` to open a background tab,
- \`const tab = await cua.getTab(tabId)\` to bind an existing tab.

Then act by element number from the accessibility state and check the result in the same call, e.g.
\`await tab.click(12); await tab.getAXState();\`. Later getAXState() calls return only changes.
Top-level declarations persist between calls. Use nodeRepl.write(value) to output other values.`;

const TOOLS = [
  {
    name: "js",
    description: JS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to run; top-level await is supported." },
        timeout_ms: { type: "integer", minimum: 1, description: "Execution timeout in milliseconds, default 30000." },
        title: { type: "string", maxLength: 80, description: "Short user-facing description of what the code does." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "js_reset",
    description: "Reset the persistent REPL: all bindings are discarded and the next js call starts fresh. Browser tabs stay open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const DEFAULT_TIMEOUT_MS = 30_000;
// Time the worker gets beyond a call's timeout to report on its own before it is terminated.
const TERMINATE_GRACE_MS = 500;
// A reset the worker does not confirm in time (it is busy or stuck) replaces the worker instead.
const RESET_WAIT_MS = 2_000;
const TIMED_OUT_NOTE = "The REPL was reset because the call timed out: code still running from it was stopped. Bind tabs again with cua.getTab(id).";

// Mouse buttons the REPL's code holds pressed. A worker replaced in the middle of a long press would
// leave the button down in the page; the host releases it.
class PressedButtons {
  constructor() {
    this.pressed = new Map(); // "tab:button" -> mousePressed params with the tab
  }

  note(method, params) {
    if (method !== "cdp" || params?.method !== "Input.dispatchMouseEvent") return;
    const { type, button } = params.params ?? {};
    const key = `${params.tabId}:${button}`;
    if (type === "mousePressed") this.pressed.set(key, params);
    else if (type === "mouseReleased") this.pressed.delete(key);
  }

  releaseAll() {
    for (const { tabId, sessionId, params } of this.pressed.values()) {
      callBrowser("cdp", { tabId, sessionId, method: "Input.dispatchMouseEvent", params: { ...params, type: "mouseReleased", clickCount: 1 } }).catch(() => {});
    }
    this.pressed.clear();
  }
}

// Hosts the REPL worker and relays its browser calls and events through this thread's browser link.
// A call that times out ends with the worker replaced, which stops everything the call left running.
class ReplHost {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buttons = new PressedButtons();
    onBrowserEvent((event) => {
      guardFocus(event);
      this.worker.postMessage({ type: "browser-event", event });
    });
    this.start();
  }

  start() {
    const worker = (this.worker = new Worker(new URL("./repl-worker.mjs", import.meta.url), { workerData: { sessionId }, stderr: false }));
    let failure = null;
    worker.on("message", (message) => {
      if (message.type === "browser-call") return this.relay(worker, message);
      this.pending.get(message.id)?.(message.result);
      this.pending.delete(message.id);
    });
    worker.on("error", (error) => {
      failure = error;
      process.stderr.write(`[browser-control] REPL worker failed: ${error?.stack ?? error}\n`);
    });
    // A worker that dies on its own (not replaced) fails its pending calls and is started again.
    worker.on("exit", () => {
      if (worker !== this.worker) return;
      const reason = failure?.message ?? "it exited";
      const settle = [...this.pending.values()];
      this.pending.clear();
      this.buttons.releaseAll();
      this.start();
      for (const resolve of settle) {
        resolve({ content: [{ type: "text", text: `The REPL crashed (${reason}) and was started again; its state is gone. Bind tabs again with cua.getTab(id).` }], isError: true });
      }
    });
  }

  async relay(worker, { callId, method, params }) {
    // A replaced worker may still be running until it is terminated; it reaches nothing anymore.
    if (worker !== this.worker) return;
    this.buttons.note(method, params);
    if (isOpeningInput(method, params)) await beforeInput(params.tabId);
    let reply;
    try {
      reply = { type: "browser-reply", callId, result: await callBrowser(method, params) };
    } catch (error) {
      reply = { type: "browser-reply", callId, error: error?.message ?? String(error) };
    }
    if (worker === this.worker) worker.postMessage(reply);
  }

  async restart() {
    const old = this.worker;
    this.pending.clear();
    this.buttons.releaseAll();
    this.start();
    await old.terminate();
  }

  // Waits for the worker's answer, or `waitMs` (undefined when it does not answer in time).
  request(message, waitMs) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = waitMs ? setTimeout(() => (this.pending.delete(id), resolve(undefined)), waitMs) : null;
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.worker.postMessage({ ...message, id });
    });
  }

  async run(code, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = await this.request({ type: "run", code, timeoutMs }, timeoutMs + TERMINATE_GRACE_MS);
    if (result !== undefined && !result.timedOut) return result;
    await this.restart();
    const content = result?.content ?? [{ type: "text", text: `Execution timed out after ${timeoutMs} ms` }];
    return { content: [...content, { type: "text", text: TIMED_OUT_NOTE }], isError: true };
  }

  async reset() {
    if ((await this.request({ type: "reset" }, RESET_WAIT_MS)) === undefined) await this.restart();
  }
}

const repl = new ReplHost();
// Calls share one REPL and one output sink, so they run one at a time.
let queue = Promise.resolve();

function serialized(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

async function handle(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: "Browser automation through the js tool's cua API. Start with cua.getState(), cua.createBrowserTab or cua.getTab.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = message.params ?? {};
      if (name === "js") return serialized(() => repl.run(String(args.code ?? ""), args.timeout_ms));
      if (name === "js_reset") {
        return serialized(async () => {
          await repl.reset();
          return { content: [{ type: "text", text: "The REPL was reset." }] };
        });
      }
      throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return; // notifications need no reply
    try {
      const result = await handle(message);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`);
    }
  })
  // The client closed the session: close this session's unmarked agent tabs, then exit.
  .on("close", shutDown);

// Clients may also stop the server with a signal; the session's tabs are cleaned up the same way.
let shuttingDown = false;
async function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await endSession();
  process.exit(0);
}
process.on("SIGTERM", shutDown);
process.on("SIGHUP", shutDown);
