import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { browserCopy, freePort, launchBrowser, until } from "./harness.mjs";

let copy, browser, home, installed, cli, environment;
const children = new Set();
function run(command) {
  const child = spawn(process.execPath, [cli, command], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      children.delete(child);
      resolve({ code, output });
    });
  });
  return { child, done, output: () => output };
}
before(async () => {
  copy = browserCopy(await freePort());
  for (const name of ["bin", "installer", "package.json"]) cpSync(new URL(`../${name}`, import.meta.url), join(copy.dir, name), { recursive: true });
  home = join(copy.dir, "home");
  installed = join(home, ".local", "share", "bruse");
  cli = join(copy.dir, "bin", "bruse.mjs");
  environment = {
    ...process.env,
    HOME: home,
    BRUSE_NO_OPEN: "1",
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    PATH: "/usr/bin:/bin",
    INSTALL_NODE: process.execPath,
  };
  delete environment.XDG_DATA_HOME;
  delete environment.XDG_CONFIG_HOME;
  delete environment.COPILOT_HOME;
  delete environment.BROWSER_CONTROL_STATE_DIR;
});
after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await browser?.close();
  copy?.remove();
});
test("version prints the manifest version", async () => {
  const result = await run("version").done;
  assert.equal(result.code, 0);
  assert.match(result.output, new RegExp(JSON.parse(readFileSync(join(copy.extensionDir, "manifest.json"))).version.replaceAll(".", "\\.")));
});
test("setup, reload, doctor and uninstall", { timeout: 180_000 }, async () => {
  const setup = run("setup");
  await until(() => setup.output().includes("Waiting for the extension to connect"), { timeoutMs: 60_000, message: "setup to wait" });
  assert.match(setup.output(), /No supported agent client found/);
  assert.ok(setup.output().includes(join(installed, "browser", "mcp", "server.mjs")));
  browser = await launchBrowser(join(installed, "browser", "extension"));
  const first = await setup.done;
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /is ready/);
  const secretPath = join(installed, "state", "extension-secret");
  const secret = readFileSync(secretPath, "utf8");
  const second = await run("setup").done;
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /Reloaded in/);
  assert.match(second.output, /is ready/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  const doctor = await run("doctor").done;
  assert.equal(doctor.code, 0, doctor.output);
  assert.match(doctor.output, /Installed in/);
  assert.match(doctor.output, /Paired with an extension/);
  assert.match(doctor.output, /Connected to/);
  assert.match(doctor.output, /No supported agent client found/);
  assert.match(doctor.output, /Everything looks right/);
  const uninstall = await run("uninstall").done;
  assert.equal(uninstall.code, 0, uninstall.output);
  assert.equal(existsSync(installed), false);
});
test("file clients preserve configuration and reject comments", { timeout: 180_000 }, async () => {
  const app = process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  const files = [
    ["Cursor", join(home, ".cursor", "mcp.json"), "mcpServers"],
    ["Claude Desktop", join(app, "Claude", "claude_desktop_config.json"), "mcpServers"],
    ["Devin Desktop", join(home, ".config", "devin", "mcp_config.json"), "mcpServers"],
    ["Windsurf", join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers"],
    ["VS Code", join(app, "Code", "User", "mcp.json"), "servers"],
    ["VS Code Insiders", join(app, "Code - Insiders", "User", "mcp.json"), "servers"],
    ["GitHub Copilot CLI", join(home, ".copilot", "mcp-config.json"), "mcpServers"],
    ["Gemini CLI", join(home, ".gemini", "settings.json"), "mcpServers"],
  ];
  for (const [, path, key] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ other: 42, [key]: { existing: { command: "other" } } }));
  }
  const malformed = files[0][1];
  writeFileSync(malformed, "{ // comment\n}\n");
  const setup = run("setup");
  await until(() => setup.output().includes("Gemini CLI: added"), { timeoutMs: 60_000 });
  setup.child.kill("SIGTERM");
  const result = await setup.done;
  assert.match(result.output, /Cursor: failed \(could not read its MCP configuration\)/);
  assert.equal(readFileSync(malformed, "utf8"), "{ // comment\n}\n");
  for (const [, path, key] of files.slice(1)) {
    const value = JSON.parse(readFileSync(path));
    assert.equal(value.other, 42);
    assert.equal(value[key].existing.command, "other");
    assert.equal(value[key].bruse.args[0], join(installed, "browser", "mcp", "server.mjs"));
  }
  // The clients that document a type field get it.
  const entry = (label) => JSON.parse(readFileSync(files.find(([name]) => name === label)[1]))[files.find(([name]) => name === label)[2]].bruse;
  assert.equal(entry("VS Code").type, "stdio");
  assert.equal(entry("GitHub Copilot CLI").type, "local");
  assert.deepEqual(entry("GitHub Copilot CLI").tools, ["*"]);
  assert.ok(readdirSync(join(installed, "backups")).length >= files.length - 1);
  writeFileSync(malformed, JSON.stringify({ other: 42, mcpServers: { existing: { command: "other" } } }));
  const retry = run("setup");
  await until(() => retry.output().includes("Gemini CLI: added"), { timeoutMs: 60_000 });
  retry.child.kill("SIGTERM");
  await retry.done;
  assert.equal(JSON.parse(readFileSync(malformed)).mcpServers.bruse.args[0], join(installed, "browser", "mcp", "server.mjs"));
  const doctor = await run("doctor").done;
  for (const [name] of files) assert.ok(doctor.output.includes(`${name}: registered`), doctor.output);
  writeFileSync(malformed, "{ // comment\n}\n");
  const blocked = await run("uninstall").done;
  assert.notEqual(blocked.code, 0);
  assert.ok(existsSync(installed));
  assert.equal(readFileSync(malformed, "utf8"), "{ // comment\n}\n");
  writeFileSync(malformed, JSON.stringify({ other: 42, mcpServers: { existing: { command: "other" } } }));
  const uninstall = await run("uninstall").done;
  assert.equal(uninstall.code, 0, uninstall.output);
  for (const [, path, key] of files) {
    const value = JSON.parse(readFileSync(path));
    assert.equal(value.other, 42);
    assert.equal(value[key].existing.command, "other");
    assert.equal(value[key].bruse, undefined);
  }
});
test("unknown command prints usage and exits 2", async () => {
  const result = await run("unknown").done;
  assert.equal(result.code, 2);
  assert.match(result.output, /Usage: bruse/);
});
