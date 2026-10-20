// Runs the REPL in a worker thread so that the server can stop code that never yields (for example an
// endless loop after an await) by terminating the worker. Messages: run, reset, end.

import { parentPort } from "node:worker_threads";
import { endSession } from "./browser-link.mjs";
import { Repl } from "./repl.mjs";

// Agent code can leave promises unhandled (an un-awaited call that later fails); that must not end the
// worker, or the hub it may be serving for other sessions.
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
  } else if (message.type === "end") {
    await endSession();
    parentPort.postMessage({ id: message.id, result: null });
  }
});
