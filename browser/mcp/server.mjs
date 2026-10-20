#!/usr/bin/env node
// MCP stdio server with a persistent JavaScript REPL (`js`) whose `cua` global controls the user's
// browser through the extension (see cua/ and browser-link.mjs).

import { createInterface } from "node:readline";
import { endSession } from "./browser-link.mjs";
import { Repl } from "./repl.mjs";

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

const repl = new Repl();
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
          repl.reset();
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
  .on("close", async () => {
    await endSession();
    process.exit(0);
  });
