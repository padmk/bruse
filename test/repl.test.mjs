import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { onLines } from "../browser/mcp/lines.mjs";
import { once } from "node:events";

async function server(t) {
  const child = spawn(process.execPath, ["browser/mcp/server.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  let id = 0;
  onLines(child.stdout, (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    clearTimeout(timer);
  });
  return {
    child,
    async request(method, params = {}) {
      const requestId = ++id;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No reply to ${method}: ${stderr}`)), 10000);
        pending.set(requestId, (reply) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(reply);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
  };
}

async function cell(client, code) {
  const reply = await client.request("tools/call", { name: "js", arguments: { code } });
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  return reply.result.content.map((item) => item.text).join("\n");
}

test("MCP ignores non-object JSON and answers subsequent requests", async (t) => {
  const client = await server(t);
  client.child.stdin.write('null\n42\nfalse\n"hello"\ninvalid json\n');
  const reply = await client.request("ping");
  assert.deepEqual(reply.result, {});
});

test("REPL persists and redeclares declarations across cells", async (t) => {
  const client = await server(t);
  await cell(client, 'let x = 1; const label = "first";');
  assert.match(await cell(client, "nodeRepl.write([x, label])"), /1.*first/s);
  await cell(client, "let x = 4;");
  assert.match(await cell(client, "nodeRepl.write(x)"), /4/);
});

for (const [name, source, expected] of [
  ["postfix", "x++\nlet after = 11", 11],
  ["prefix", "++x\nlet after = 12", 12],
  ["typeof before prefix", "typeof ++x\nlet after = 13", 13],
  ["await before prefix", "await ++x\nlet after = 14", 14],
  ["keyword property", "obj.return++\nlet after = 15", 15],
  ["block comment that spans lines", "let before = 1 /* one\n two */ let after = 16", 16],
  ["block comment between function and its name", "let { a } = { a: 1 }, b = function /* one\n two */ named() { return 17 }\nlet after = b()", 17],
  ["block comment before !==", "let { a } = { a: 1 }, after = 18 /* one\n two */ !== 0", true],
  ["line break before !=", "let { a } = { a: 1 }, after = 19\n != 0", true],
  ["carriage return", "let before = 1\rlet after = 20", 20],
  ["line separator", "let before = 1\u2028let after = 21", 21],
  ["block comment with a paragraph separator", "let before = 1 /* one\u2029two */ let after = 22", 22],
  ["object pattern before a name without initializer", "const { a } = { a: 23 }, b;\nlet after = [a, b]", "[ 23, undefined ]"],
  ["array pattern before a name without initializer", "let [a] = [24], b;\nlet after = [a, b]", "[ 24, undefined ]"],
  ["patterns between plain declarators", "var n, { a } = { a: 25 }, [c] = [1], m = 2;\nlet after = [n, a, c, m]", "[ undefined, 25, 1, 2 ]"],
  ["pattern initialized by a function whose body starts on the next line", "let n = 26, { name } = function named()\n{};\nlet after = [n, name]", "[ 26, 'named' ]"],
  ["pattern initialized by a template whose substitution ends on the next line", "let n = 27, [ch] = `${\"x\"\n}`, m = 2;\nlet after = [n, ch, m]", "[ 27, 'x', 2 ]"],
  ["pattern initialized with a regular expression after a division", "let [ch] = 8 / /,x/.source.length + \"\", b = 28;\nlet after = [ch, b]", "[ '4', 28 ]"],]) {
  test(`REPL preserves declaration after ${name}`, async (t) => {
    const client = await server(t);
    await cell(client, "let x = 1; let obj = { return: 1 };");
    await cell(client, source);
    assert.equal((await cell(client, "nodeRepl.write(after)")).trim(), String(expected));
  });
}

// A soft reset keeps the worker, and the server passes on no answer to a browser call from before the
// reset, so the worker ends such calls itself.
test("a reset ends the browser call a running cell waits for", async (t) => {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(new URL("../browser/mcp/repl-worker.mjs", import.meta.url), { workerData: { sessionId: "test-session" } });
  t.after(() => worker.terminate());
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  const next = (matches, timeoutMs) =>
    new Promise((resolve, reject) => {
      const found = messages.find(matches);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`No matching worker message within ${timeoutMs} ms: ${JSON.stringify(messages)}`)), timeoutMs);
      worker.on("message", function listener(message) {
        if (!matches(message)) return;
        clearTimeout(timer);
        worker.off("message", listener);
        resolve(message);
      });
    });
  worker.postMessage({ type: "run", id: 1, code: "await cua.listTabs({ emit: false });", timeoutMs: 30_000 });
  const call = await next((message) => message.type === "browser-call", 5_000);
  worker.postMessage({ type: "reset", id: 2 });
  await next((message) => message.id === 2, 2_000);
  const run = await next((message) => message.id === 1, 2_000);
  const text = run.result.content.map((item) => item.text).join("\n");
  assert.equal(run.result.isError, true, text);
  assert.match(text, /The REPL was reset/);
  // A late answer to the call changes nothing: no second result, and the worker still runs cells.
  worker.postMessage({ type: "browser-reply", callId: call.callId, result: [] });
  worker.postMessage({ type: "run", id: 3, code: "nodeRepl.write('after');", timeoutMs: 5_000 });
  const after = await next((message) => message.id === 3, 5_000);
  assert.equal(after.result.content.map((item) => item.text).join("\n"), "after");
  assert.equal(messages.filter((message) => message.id === 1).length, 1, "the cell has one result");
});
