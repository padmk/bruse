// Repository checks that need no browser: every module parses, the release version agrees across
// files, the bruse command runs, and the MCP server answers initialize and tools/list over stdio.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failures++;
};

const files = spawnSync("git", ["ls-files", "*.js", "*.mjs"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  check(result.status === 0, `parses: ${file}${result.status === 0 ? "" : `\n${result.stderr}`}`);
}

const version = JSON.parse(readFileSync(join(root, "browser/extension/manifest.json"), "utf8")).version;
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
check(packageVersion === version, `package.json version ${packageVersion} matches the manifest's ${version}`);

const cli = spawnSync(process.execPath, [join(root, "bin/bruse.mjs"), "version"], { encoding: "utf8" });
check(cli.status === 0 && cli.stdout.trim() === `bruse ${version}`, `bruse version prints ${version}`);

// The server must survive a line that is not a request and answer the ones that follow.
const server = spawn(process.execPath, [join(root, "browser/mcp/server.mjs")], {
  env: { ...process.env, BROWSER_CONTROL_STATE_DIR: mkdtempSync(join(tmpdir(), "bruse-check-")) },
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(message.id)?.(message);
});
const request = (id, method, params = {}) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} got no reply`)), 10_000);
    replies.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
try {
  const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } });
  check(init.result?.serverInfo?.version === version, `MCP initialize reports version ${version}`);
  server.stdin.write("null\n");
  const tools = await request(2, "tools/list");
  const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
  check(names.includes("js") && names.includes("js_reset"), `MCP tools/list has js and js_reset (${names.join(", ")})`);
} catch (error) {
  check(false, `MCP server: ${error.message}`);
}
server.stdin.end();

console.log(failures ? `\n${failures} check${failures === 1 ? "" : "s"} failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
