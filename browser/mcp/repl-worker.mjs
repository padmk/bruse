// Runs the REPL in a worker thread so that the server can stop code that outlives its call (an endless
// loop, or a timer the code scheduled) by terminating the worker. Messages: run, reset.

import { parentPort } from "node:worker_threads";
import { Repl } from "./repl.mjs";

// Agent code can leave promises unhandled (an un-awaited call that later fails); that must not end the worker.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[browser-control] Unhandled rejection: ${reason?.stack ?? reason}\n`);
});

// Dynamic import support in the vm is flagged experimental; keep that notice out of the client's log.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") process.stderr.write(`${warning.stack ?? warning}\n`);
});

const repl = new Repl();

parentPort.on("message", async (message) => {
  if (message.type === "run") {
    parentPort.postMessage({ id: message.id, result: await repl.run(message.code, message.timeoutMs) });
  } else if (message.type === "reset") {
    repl.reset();
    parentPort.postMessage({ id: message.id, result: null });
  }
});
