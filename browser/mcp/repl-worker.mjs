// Runs the REPL in a worker thread so that the server can stop code that outlives its call (an endless
// loop, or a timer the code scheduled) by terminating the worker. Messages: run, reset.

import { parentPort as threadPort } from "node:worker_threads";
import { Repl } from "./repl.mjs";

if (!threadPort) throw new Error("repl-worker.mjs runs in a worker thread that server.mjs starts");
const parentPort = threadPort;

// Agent code can leave promises unhandled (an un-awaited call that later fails) or throw from a timer
// callback; neither may end the worker.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[browser-control] Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`[browser-control] Uncaught exception in REPL code: ${error?.stack ?? error}\n`);
});

// Dynamic import support in the vm is flagged experimental; keep that notice out of the client's log.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") process.stderr.write(`${warning.stack ?? warning}\n`);
});

const repl = new Repl();

parentPort.on("message", (message) => {
  if (message.type === "run") {
    // A failure of the REPL itself still answers the call, which would otherwise wait for its timeout.
    repl.run(message.code, message.timeoutMs).then(
      (result) => parentPort.postMessage({ id: message.id, result }),
      (error) => parentPort.postMessage({ id: message.id, result: { content: [{ type: "text", text: `The REPL failed: ${error instanceof Error ? error.stack : error}` }], isError: true, timedOut: false } }),
    );
  } else if (message.type === "reset") {
    repl.reset();
    parentPort.postMessage({ id: message.id, result: null });
  }
});
