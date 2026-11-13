#!/usr/bin/env node
// MCP stdio server with a persistent JavaScript REPL (`js`) whose `cua` global controls the user's
// browser through the extension (see cua/ and browser-link.mjs).

import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { ignore, isPressInput, logFailure } from "../extension/shared.js";
import { callBrowser, endSession, onBrowserEvent, sessionId } from "./browser-link.mjs";
import { VERSION } from "./config.mjs";
import { beforeInput, isOpeningInput, onEvent as guardFocus } from "./focus-guard.mjs";
import { updateNotice } from "./update-notice.mjs";

const SERVER_INFO = { name: "browser-control", version: VERSION };

const DEFAULT_TIMEOUT_MS = 30_000;

const JS_DESCRIPTION = `Control the user's browser by running JavaScript in a persistent REPL with the global \`cua\`.
The code runs as Node.js on the user's computer with the user's permissions (files, processes, network).

On the first call, or after js_reset, run exactly one entry call; it also returns the documentation:
- \`const tab = await cua.createBrowserTab("1", url)\` to open a page in a background tab (browser "1" is the connected browser),
- \`await cua.getState()\` only to find tabs the user already has open, then \`const tab = await cua.getTab(tabId)\` to bind one.

Then act by element number from the accessibility state and check the result in the same call, e.g.
\`await tab.click(12); await tab.getAXState();\`. Later getAXState() calls return only changes.
Top-level declarations persist between calls. Use nodeRepl.write(value) to output other values.
If a call says the browser extension did not connect, stop and tell the user; do not do the task another way, such as fetching pages from the REPL.`;

const TOOLS = [
  {
    name: "js",
    description: JS_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript to run; top-level await is supported." },
        timeout_ms: { type: "integer", minimum: 1, description: `Execution timeout in milliseconds, default ${DEFAULT_TIMEOUT_MS}.` },
        title: { type: "string", maxLength: 80, description: "Short user-facing description of what the code does." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
    // Claude Code otherwise defers MCP tools behind tool search, which costs a model turn before the
    // first browser call.
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "js_reset",
    description: "Reset the persistent REPL: all bindings are discarded and the next js call starts fresh. Browser tabs stay open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// Time the worker gets beyond a call's timeout to report on its own before it is terminated.
const TERMINATE_GRACE_MS = 500;
// A reset the worker does not confirm in time (it is busy or stuck) replaces the worker instead.
const RESET_WAIT_MS = 2_000;
// Timers take at most 2^31 - 1 ms and run a longer delay at once, which would end the call as timed out.
const MAX_TIMEOUT_MS = 2 ** 31 - 1 - TERMINATE_GRACE_MS;

// The timeout of a js call from its `timeout_ms` argument; clients may send null for an argument left out.
function callTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error("timeout_ms must be a whole number of milliseconds, 1 or more"), { code: -32602 });
  return Math.min(value, MAX_TIMEOUT_MS);
}

const TIMED_OUT_NOTE = "The REPL was reset because the call timed out: code still running from it was stopped. Bind tabs again with cua.getTab(id).";
const CANCELLED_NOTE = "The REPL was reset because the previous call was cancelled: its code was stopped. Bind tabs again with cua.getTab(id).";
// What a call the client cancelled resolves with; such a call gets no reply.
const CANCELLED = Symbol("cancelled");

// Mouse buttons and keys the REPL's code holds pressed. A worker replaced in the middle of a long press
// would leave them down in the page; the host releases them.
class PressedInput {
  constructor() {
    this.pressed = new Map(); // "tab:mouse:button" or "tab:key:code" -> the press's cdp call
  }

  note(method, params) {
    if (method !== "cdp") return;
    const mouse = params?.method === "Input.dispatchMouseEvent";
    if (!mouse && params?.method !== "Input.dispatchKeyEvent") return;
    const { type, button, code, key } = params.params ?? {};
    const id = mouse ? `${params.tabId}:mouse:${button}` : `${params.tabId}:key:${code ?? key}`;
    if (isPressInput(params.method, params.params)) this.pressed.set(id, params);
    else if (type === (mouse ? "mouseReleased" : "keyUp")) this.pressed.delete(id);
  }

  releaseAll() {
    // Newest first, so a chord's key goes up before its modifiers.
    for (const { tabId, sessionId, method, params } of [...this.pressed.values()].reverse()) {
      const { key, code, windowsVirtualKeyCode, modifiers } = params;
      const release = method === "Input.dispatchMouseEvent" ? { ...params, type: "mouseReleased", clickCount: 1 } : { type: "keyUp", key, code, windowsVirtualKeyCode, modifiers };
      callBrowser("cdp", { tabId, sessionId, method, params: release }).catch(ignore("a tab that is gone holds no input"));
    }
    this.pressed.clear();
  }
}

// Hosts the REPL worker and relays its browser calls and events through this thread's browser link.
// A call that times out ends with the worker replaced, which stops everything the call left running.
class ReplHost {
  // Set by start(), which the constructor and every replacement run.
  /** @type {Worker} */
  worker;

  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.runId = null; // request id of the js call the worker is running
    this.pressed = new PressedInput();
    onBrowserEvent((event) => {
      guardFocus(event);
      this.worker.postMessage({ type: "browser-event", event });
    });
    this.start();
  }

  start() {
    // The server's standard output carries the MCP protocol, so what REPL code or a module it loads prints
    // there (process.stdout) goes to the server's log instead.
    const worker = (this.worker = new Worker(new URL("./repl-worker.mjs", import.meta.url), { workerData: { sessionId }, stderr: false, stdout: true }));
    worker.stdout.pipe(process.stderr, { end: false });
    let failure = null;
    worker.on("message", (message) => {
      if (message.type === "browser-call") {
        this.relay(worker, message).catch(logFailure("Relaying a browser call"));
        return;
      }
      this.pending.get(message.id)?.(message.result);
      this.pending.delete(message.id);
    });
    worker.on("error", (error) => {
      failure = error;
      process.stderr.write(`[browser-control] REPL worker failed: ${error instanceof Error ? error.stack : error}\n`);
    });
    // A worker that dies on its own (not replaced) fails its pending calls and is started again.
    worker.on("exit", () => {
      if (worker !== this.worker) return;
      const reason = failure?.message ?? "it exited";
      const settle = [...this.pending.values()];
      this.pending.clear();
      this.pressed.releaseAll();
      this.start();
      for (const resolve of settle) {
        resolve({ content: [{ type: "text", text: `The REPL crashed (${reason}) and was started again; its state is gone. Bind tabs again with cua.getTab(id).` }], isError: true });
      }
    });
  }

  async relay(worker, { callId, method, params }) {
    // A replaced worker may still be running until it is terminated; it reaches nothing anymore.
    if (worker !== this.worker) return;
    let reply;
    try {
      if (isOpeningInput(method, params)) {
        await beforeInput(params.tabId);
        // The worker may have been replaced meanwhile; its input must not arrive after the reset.
        if (worker !== this.worker) return;
      }
      this.pressed.note(method, params);
      reply = { type: "browser-reply", callId, result: await callBrowser(method, params) };
    } catch (error) {
      reply = { type: "browser-reply", callId, error: error?.message ?? String(error) };
    }
    if (worker === this.worker) worker.postMessage(reply);
  }

  async restart() {
    const old = this.worker;
    this.pending.clear();
    this.pressed.releaseAll();
    this.start();
    await old.terminate();
  }

  // Waits for the worker's answer, or `waitMs` (undefined when it does not answer in time).
  request(message, waitMs) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = waitMs ? setTimeout(() => (this.pending.delete(id), resolve(undefined)), waitMs) : undefined;
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      if (message.type === "run") this.runId = id;
      this.worker.postMessage({ ...message, id });
    });
  }

  // Resolves with the call's result, or with CANCELLED when cancelRun() ended it. A call that timed out
  // or was cancelled ends with the worker replaced, so nothing of it runs on.
  async run(code, timeoutMs) {
    const result = await this.request({ type: "run", code, timeoutMs }, timeoutMs + TERMINATE_GRACE_MS);
    this.runId = null;
    if (result === CANCELLED) {
      await this.restart();
      return CANCELLED;
    }
    if (result !== undefined && !result.timedOut) return result;
    await this.restart();
    const content = result?.content ?? [{ type: "text", text: `Execution timed out after ${timeoutMs} ms` }];
    return { content: [...content, { type: "text", text: TIMED_OUT_NOTE }], isError: true };
  }

  // Ends the js call that is running, if any, without waiting for its code.
  cancelRun() {
    const settle = this.pending.get(this.runId);
    this.pending.delete(this.runId);
    settle?.(CANCELLED);
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
  queue = result.catch(ignore("the task's caller gets its failure; the queue only keeps the order"));
  return result;
}

// The js calls that wait for their turn or run, by request id, so that the client can cancel them
// (notifications/cancelled, sent when the user interrupts the agent): a waiting call is skipped, and a
// running one is stopped at once instead of acting on pages until its code or timeout ends.
const jsCalls = new Map(); // request id -> { cancelled, running }
// Set when a cancelled call took the REPL's state with it, until the next call has told the agent.
let cancelledNotePending = false;

function cancelCall(requestId) {
  const call = jsCalls.get(requestId);
  if (!call || call.cancelled) return;
  call.cancelled = true;
  if (call.running) repl.cancelRun();
}

async function runJs(call, code, timeoutMs) {
  if (call.cancelled) return CANCELLED;
  call.running = true;
  const result = await repl.run(code, timeoutMs);
  if (result === CANCELLED || call.cancelled) {
    cancelledNotePending = true;
    return CANCELLED;
  }
  const notes = [cancelledNotePending ? CANCELLED_NOTE : null, updateNotice()].filter(Boolean);
  cancelledNotePending = false;
  return notes.length ? { ...result, content: [...result.content, ...notes.map((text) => ({ type: "text", text }))] } : result;
}

/** @returns {Promise<unknown>} */
async function handle(message) {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: "Browser automation through the js tool's cua API. To open a page, start with cua.createBrowserTab(\"1\", url); cua.getState() lists the tabs the user already has open.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const { name, arguments: args = {} } = message.params ?? {};
      if (name === "js") {
        const timeoutMs = callTimeout(args.timeout_ms);
        const call = { cancelled: false, running: false };
        jsCalls.set(message.id, call);
        return serialized(() => runJs(call, String(args.code ?? ""), timeoutMs)).finally(() => jsCalls.delete(message.id));
      }
      if (name === "js_reset") {
        return serialized(async () => {
          await repl.reset();
          cancelledNotePending = false;
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
  .on("line", (line) => {
    answer(line).catch(logFailure("Answering an MCP message"));
  })
  // The client closed the session: close this session's unmarked agent tabs, then exit.
  .on("close", shutDown);

// Answers one line of the MCP stream; a request gets its reply, a notification none.
async function answer(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  // Notifications need no reply.
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") cancelCall(message.params?.requestId);
    return;
  }
  try {
    const result = await handle(message);
    if (result === CANCELLED) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`);
  }
}

// Clients may also stop the server with a signal; the session's tabs are cleaned up the same way.
let shuttingDown = false;
function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  endSession()
    .catch(logFailure("Ending the session"))
    .finally(() => process.exit(0));
}
process.on("SIGTERM", shutDown);
process.on("SIGHUP", shutDown);
