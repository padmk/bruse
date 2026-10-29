// Runs each benchmark task with an agent on two browser tools and records time, tokens, cost, correctness
// and whether the run took over the user's active tab or brought the browser to the front.
//
//   node bench/run.mjs [--reps 5] [--tasks table,form] [--tools bruse,chrome] [--model claude-opus-5-5] [--effort medium]
//   node bench/run.mjs --agent codex [--tools bruse,openai] [--model gpt-6.1-terra] [--effort medium]
//
// With Claude Code the tools are Bruse and Claude in Chrome. With Codex they are Bruse and OpenAI's own
// browser runtime (cua_repl from the ChatGPT app), which `codex exec` reaches only through the
// brave-cua-mcp bridge (--openai-bridge, default ~/dev/brave-cua-mcp/src/server.mjs). Both are offered to
// Codex as the same MCP server name, so the model sees the same tool either way.
//
// Results go to bench/results/<timestamp>/runs.jsonl; bench/report.mjs summarizes them.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN_A } from "./server.mjs";
import { tasks } from "./tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const reps = Number(args.reps ?? 5);
const capabilityReps = Number(args["capability-reps"] ?? 2);
const taskIds = args.tasks ? args.tasks.split(",") : tasks.map((t) => t.id);
const agent = args.agent ?? "claude";
const tools = (args.tools ?? (agent === "codex" ? "bruse,openai" : "bruse,chrome")).split(",");
const model = args.model ?? (agent === "codex" ? "gpt-6.1-terra" : "claude-opus-5-5");
const effort = args.effort ?? "medium";
const browserApp = "Brave Browser";

// The code under test: a run of a dirty tree is marked as such.
const revision = (() => {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    return execFileSync("git", ["status", "--porcelain"], { cwd: here, encoding: "utf8" }).trim() ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
})();

const outDir = path.join(here, "results", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(outDir, { recursive: true });
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bruse-bench-"));
const node = process.execPath;
fs.writeFileSync(path.join(workDir, "bruse.json"), JSON.stringify({ mcpServers: { bruse: { type: "stdio", command: node, args: [path.join(here, "..", "browser", "mcp", "server.mjs")] } } }));
fs.writeFileSync(path.join(workDir, "none.json"), JSON.stringify({ mcpServers: {} }));

// The same tools are denied to both runs so that the browser is the only way to the answer.
const denied = "Bash,WebFetch,WebSearch,Read,Glob,Grep,Edit,Write,NotebookEdit,Task,Agent";
const toolFlags = {
  bruse: ["--no-chrome", "--mcp-config", path.join(workDir, "bruse.json")],
  chrome: ["--chrome", "--mcp-config", path.join(workDir, "none.json")],
};

const osa = (script) => {
  try { return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 5000 }).trim(); } catch { return ""; }
};
const activeTabUrl = () => osa(`tell application "${browserApp}" to get URL of active tab of front window`);
const frontApp = () => {
  try { return execFileSync("lsappinfo", ["info", "-only", "name", execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).match(/"([^"]+)"/)?.[1] ?? ""; } catch { return ""; }
};
const closeBenchTabs = () => osa(`tell application "${browserApp}"
  repeat with w in windows
    close (every tab of w whose URL contains "47901" or URL contains "47902")
  end repeat
end tell`);
const openUserTab = (url) => osa(`tell application "${browserApp}" to tell front window to make new tab at end of tabs with properties {URL:"${url}"}`);
const reselectTab = (url) => osa(`tell application "${browserApp}"
  set i to 0
  repeat with t in tabs of front window
    set i to i + 1
    if URL of t is "${url}" then set active tab index of front window to i
  end repeat
end tell`);

// Downloads from the download task go to the Trash so that each run starts without an earlier copy.
const trashDownloads = () => {
  const dir = path.join(os.homedir(), "Downloads");
  for (const f of fs.readdirSync(dir).filter((f) => /^raport-q3.*\.csv$/.test(f))) {
    fs.renameSync(path.join(dir, f), path.join(os.homedir(), ".Trash", `${Date.now()}-${f}`));
  }
};

const api = async (p, init) => (await fetch(`${ORIGIN_A}${p}`, init)).json();

function runClaude(tool, task) {
  return new Promise((resolve) => {
    const deny = task.allowFileTools ? denied.replace("Read,Glob,", "") : denied;
    const argv = ["-p", task.prompt, "--model", model, "--effort", effort, "--output-format", "json", "--strict-mcp-config", "--dangerously-skip-permissions", "--disallowedTools", deny, ...toolFlags[tool]];
    const started = Date.now();
    const child = spawn("claude", argv, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = {};
      try { result = JSON.parse(out); } catch { result = { result: out.slice(-500) }; }
      resolve({ code, wallMs: Date.now() - started, result, stderr: err.slice(-500) });
    });
  });
}

// Codex has no per-tool deny list: the shell runs in a read-only sandbox without network, web search and
// the app's own browser connectors are off, and the browser MCP server is the only way to the pages.
const cuaNode = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
const openaiBridge = args["openai-bridge"] ?? path.join(os.homedir(), "dev", "brave-cua-mcp", "src", "server.mjs");
const codexServers = {
  bruse: [node, path.join(here, "..", "browser", "mcp", "server.mjs")],
  openai: [cuaNode, openaiBridge],
};
const codexHint = "Do this in the user's Brave browser with the js browser tool. ";

function runCodex(tool, task) {
  return new Promise((resolve) => {
    const [command, script] = codexServers[tool];
    const argv = [
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--disable", "apps",
      "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-c", 'web_search="disabled"',
      "-c", "mcp_servers.node_repl.enabled=false", "-c", "mcp_servers.portside.enabled=false",
      "-c", `mcp_servers.cua_repl.command=${JSON.stringify(command)}`, "-c", `mcp_servers.cua_repl.args=[${JSON.stringify(script)}]`,
      "-c", "mcp_servers.cua_repl.startup_timeout_sec=120",
      // exec cannot ask, and Codex wants approval for tools that do not declare themselves read-only.
      "-c", 'mcp_servers.cua_repl.tools.js.approval_mode="approve"',
      codexHint + task.prompt,
    ];
    const started = Date.now();
    const child = spawn("codex", argv, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let answer = "", turns = 0, failed = false;
      const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
      for (const line of out.split("\n")) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const item = event.item ?? {};
        if (event.type === "item.completed" && item.type === "agent_message") answer = item.text ?? answer;
        if (event.type === "item.completed" && (item.type === "mcp_tool_call" || item.type === "command_execution")) turns++;
        if (event.type === "turn.completed") for (const key of Object.keys(usage)) usage[key] += event.usage?.[key] ?? 0;
        if (event.type === "turn.failed" || event.type === "error") failed = true;
      }
      resolve({
        code, wallMs: Date.now() - started, stderr: err.slice(-500),
        result: {
          result: answer || err.slice(-300), num_turns: turns, is_error: failed || code !== 0, total_cost_usd: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens + usage.reasoning_output_tokens, cached_input_tokens: usage.cached_input_tokens },
        },
      });
    });
  });
}

async function runOne(task, tool, rep) {
  closeBenchTabs();
  await api("/api/reset");
  const baseline = activeTabUrl();
  if (task.setup === "open-user-tab") {
    openUserTab(`${ORIGIN_A}/notatki`);
    await new Promise((r) => setTimeout(r, 1500));
    reselectTab(baseline); // the user keeps working in their own tab
  }
  const startTab = activeTabUrl();
  const startFront = frontApp();
  const seenTabs = new Set();
  let browserCameForward = false;
  const probe = setInterval(() => {
    const url = activeTabUrl();
    // Only benchmark pages are recorded; the user's own tab switches stay out of the results.
    if (url && url !== startTab && /:4790[12]\//.test(url)) seenTabs.add(url.replace(/[?#].*$/, ""));
    if (startFront !== browserApp && frontApp() === browserApp) browserCameForward = true;
  }, 700);
  const run = agent === "codex" ? await runCodex(tool, task) : await runClaude(tool, task);
  if (/hit your (session|usage) limit|usage limit reached|usage limit/i.test(`${run.result.result ?? ""} ${run.stderr ?? ""}`)) {
    console.log(`usage limit reached during ${task.id}/${tool} #${rep}; stopping without recording this run`);
    throw new Error("usage-limit");
  }
  clearInterval(probe);
  const log = await api("/api/log");
  const answer = run.result.result ?? "";
  const ok = (() => { try { return task.check({ answer, log }); } catch { return false; } })();
  const usage = run.result.usage ?? {};
  const record = {
    task: task.id, kind: task.kind, tool, rep, ok, model, effort, revision, answer: String(answer).slice(0, 400),
    wallMs: run.wallMs, durationMs: run.result.duration_ms, apiMs: run.result.duration_api_ms, turns: run.result.num_turns,
    agent, costUsd: run.result.total_cost_usd,
    // Claude reports cached input apart from input_tokens; Codex counts it inside input_tokens.
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cachedInputTokens: usage.cached_input_tokens ?? usage.cache_read_input_tokens, outputTokens: usage.output_tokens, isError: run.result.is_error ?? run.code !== 0,
    activeTabChanged: seenTabs.size > 0, activeTabs: [...seenTabs], browserCameForward, startFront,
  };
  fs.appendFileSync(path.join(outDir, "runs.jsonl"), JSON.stringify(record) + "\n");
  trashDownloads();
  console.log(`${task.id.padEnd(13)} ${tool.padEnd(7)} #${rep} ${ok ? "ok  " : "FAIL"} ${(run.wallMs / 1000).toFixed(1)}s turns=${record.turns} in=${record.inputTokens} out=${record.outputTokens} $${(record.costUsd ?? 0).toFixed(3)} tab=${record.activeTabChanged ? "taken" : "kept"}`);
  closeBenchTabs();
}

const server = spawn(node, [path.join(here, "server.mjs")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
try {
  for (const id of taskIds) {
    const task = tasks.find((t) => t.id === id);
    const n = task.kind === "timed" ? reps : capabilityReps;
    for (let rep = 1; rep <= n; rep++) {
      // Alternate which tool goes first so that warm-up and drift do not favor one of them.
      const order = rep % 2 ? tools : [...tools].reverse();
      for (const tool of order) await runOne(task, tool, rep);
    }
  }
} finally {
  server.kill();
}
console.log(`results: ${outDir}`);
