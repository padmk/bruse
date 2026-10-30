import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { browserCopy, freePort, launchBrowser, offerPairing, until } from "./harness.mjs";

let copy, port, browser, home, installed, cli, environment;
const children = new Map();
function run(command, ...args) {
  const child = spawn(process.execPath, [cli, command, ...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
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
  children.set(child, done);
  return { child, done, output: () => output };
}
before(async () => {
  port = await freePort();
  copy = browserCopy(port);
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
  delete environment.GEMINI_CLI_HOME;
  delete environment.BROWSER_CONTROL_STATE_DIR;
});
after(async () => {
  const pending = [...children];
  for (const [child] of pending) child.kill("SIGKILL");
  await Promise.allSettled(pending.map(([, done]) => done));
  await browser?.close();
  copy?.remove();
});
// Evaluates `expression` (awaiting a promise) in a new tab at `url` of the test browser.
async function inPage(url, expression) {
  const { cdp } = browser;
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await until(async () => (await cdp.send("Runtime.evaluate", { expression: "document.readyState === 'complete' && typeof chrome.management", returnByValue: true }, sessionId)).result.value === "object", { message: `${url} to load` });
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}
// Runs setup as at a terminal, where setup tells by stdin's isTTY, and gives `answer` to its question;
// returns the output.
async function inTerminal(answer) {
  const child = spawn(process.execPath, ["--import", "data:text/javascript,process.stdin.isTTY=true", cli, "setup"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const done = new Promise((resolve) => child.on("close", resolve));
  children.set(child, done);
  await until(() => output.includes("Reset the pairing?"), { timeoutMs: 60_000, message: "setup to ask" });
  child.stdin.write(`${answer}\n`);
  const code = await done;
  output += `\nexit code ${code}`;
  children.delete(child);
  return output;
}
const setPaused = (paused) => inPage(`chrome-extension://${browser.extensionId}/popup.html`, `chrome.storage.local.set({ paused: ${paused} })`);
const setEnabled = (enabled) => inPage("chrome://extensions", `chrome.management.setEnabled(${JSON.stringify(browser.extensionId)}, ${enabled})`);

test("version prints the manifest version", async () => {
  const result = await run("version").done;
  assert.equal(result.code, 0);
  assert.match(result.output, new RegExp(JSON.parse(readFileSync(join(copy.extensionDir, "manifest.json"))).version.replaceAll(".", "\\.")));
});
test("setup, reload, doctor and uninstall", { timeout: 180_000 }, async () => {
  const setup = run("setup");
  await until(() => setup.output().includes("Waiting for the extension to connect"), { timeoutMs: 60_000, message: "setup to wait" });
  assert.match(setup.output(), /No supported agent client found/);
  // A first install says what agents can reach before any client gets the server.
  assert.match(setup.output(), /meant for agents you trust/);
  assert.ok(setup.output().indexOf("meant for agents you trust") < setup.output().indexOf("Registering the MCP server"), setup.output());
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
  assert.doesNotMatch(second.output, /meant for agents you trust/);
  assert.match(second.output, /is ready/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  // An extension that connects only while setup waits, already running this build, while paused.
  await setPaused(true);
  await setEnabled(false);
  const paused = run("setup");
  await until(() => paused.output().includes("Waiting for the extension to connect"), { timeoutMs: 60_000, message: "setup to wait" });
  await setEnabled(true);
  const stopped = await paused.done;
  assert.notEqual(stopped.code, 0, stopped.output);
  assert.match(stopped.output, /Agents are paused in .*Resume agents from the .* icon in the browser toolbar and run setup again/);
  assert.doesNotMatch(stopped.output, /is ready/);
  await setPaused(false);
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
  assert.match(uninstall.output, /Remove the .* extension on the extensions page of the browser you loaded it in.* before you install again/);
});
test("setup reports a leftover extension and asks before it resets a pairing", { timeout: 300_000 }, async () => {
  const secretPath = join(installed, "state", "extension-secret");
  // The extension the uninstall left in the browser still holds the old secret.
  const leftover = await run("setup").done;
  assert.notEqual(leftover.code, 0, leftover.output);
  assert.match(leftover.output, /holds a pairing from an earlier installation.*Remove it on the browser's extensions page, load it again/);
  assert.equal(existsSync(secretPath), false);
  const reinstall = async () => {
    await browser.cdp.send("Extensions.uninstall", { id: browser.extensionId });
    await browser.cdp.send("Extensions.loadUnpacked", { path: join(installed, "browser", "extension") });
  };
  // Doing what the message says pairs again.
  await reinstall();
  const paired = await run("setup").done;
  assert.equal(paired.code, 0, paired.output);
  const secret = readFileSync(secretPath, "utf8");
  // Removed and loaded again by hand: without a terminal nobody can agree to a reset.
  await reinstall();
  const refused = await run("setup").done;
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /A new extension wants to pair.*The user must decide.*bruse setup. in a terminal/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  // At a terminal, only yes resets it, and the extension then pairs by itself.
  const declined = await inTerminal("n");
  assert.match(declined, /Reset the pairing\? \[y\/N\]/);
  assert.match(declined, /The pairing was not reset/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  const accepted = await inTerminal("y");
  assert.match(accepted, /is ready/);
  assert.notEqual(readFileSync(secretPath, "utf8"), secret);
  // A second program offering another secret while the question is open stops the reset.
  const kept = readFileSync(secretPath, "utf8");
  await reinstall();
  let forging = true;
  const forger = (async () => {
    while (forging) {
      await offerPairing(port, browser.extensionId, "f".repeat(64)).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  })();
  const contested = await inTerminal("y").finally(() => (forging = false));
  await forger;
  assert.match(contested, /Two programs are trying to pair.*The pairing was kept.*Find out what the other one is/);
  assert.match(contested, /exit code 1/);
  assert.equal(readFileSync(secretPath, "utf8"), kept);
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
  // Without a terminal, setup registers only with the clients it is given.
  const clients = "cursor,claude-desktop,devin-desktop,windsurf,vs-code,vs-code-insiders,github-copilot-cli,gemini-cli";
  const setup = run("setup", "--clients", clients);
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
  const retry = run("setup", "--clients", clients);
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
test("doctor reports a damaged installation", { timeout: 60_000 }, async () => {
  cpSync(copy.browserDir, join(installed, "browser"), { recursive: true });
  const removed = async (path) => {
    renameSync(path, `${path}.away`);
    const result = await run("doctor").done;
    renameSync(`${path}.away`, path);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /installation is damaged/);
    assert.doesNotMatch(result.output, /Connected to|ERR_MODULE_NOT_FOUND|at async/);
  };
  await removed(join(installed, "browser", "extension", "popup.js"));
  await removed(join(installed, "browser", "extension", "shared.js"));
  await removed(join(installed, "browser", "mcp", "websocket.mjs"));
  await removed(join(installed, "browser", "mcp", "server.mjs"));
  await removed(join(installed, "browser", "extension", "manifest.json"));
  // The command's own copy, which it needs before it can look at anything.
  const own = join(copy.extensionDir, "shared.js");
  renameSync(own, `${own}.away`);
  const result = await run("doctor").done;
  renameSync(`${own}.away`, own);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /files of this bruse command are damaged/);
  assert.doesNotMatch(result.output, /at async/);
});
test("an uninstall that cannot move the installation keeps the pairing state", { timeout: 60_000, skip: process.platform !== "darwin" }, async () => {
  // Moves paths to a folder as the Finder would, except for the installation.
  const bin = join(home, "fake-bin");
  const trash = join(home, "fake-trash");
  mkdirSync(bin, { recursive: true });
  mkdirSync(trash, { recursive: true });
  writeFileSync(join(bin, "osascript"), `#!/bin/sh
case "$2" in *'${installed}"'*) exit 1 ;; esac
path=$(printf '%s' "$2" | sed -E 's/.*POSIX file "(.*)" as alias.*/\\1/')
exec /bin/mv "$path" '${trash}/'
`);
  chmodSync(join(bin, "osascript"), 0o755);
  const plain = environment;
  environment = { ...plain, PATH: `${bin}:${plain.PATH}` };
  const state = join(installed, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "extension-secret"), "s".repeat(64));
  const inside = await run("uninstall").done;
  assert.equal(inside.code, 1, inside.output);
  assert.equal(readFileSync(join(state, "extension-secret"), "utf8"), "s".repeat(64));
  assert.match(inside.output, /Kept .*state with the installation/);
  assert.match(inside.output, /left in place.*bruse/);
  // A state directory elsewhere still gets its own attempt.
  const elsewhere = join(home, "custom-state");
  mkdirSync(elsewhere);
  environment = { ...environment, BROWSER_CONTROL_STATE_DIR: elsewhere };
  const outside = await run("uninstall").done;
  environment = plain;
  assert.equal(outside.code, 1, outside.output);
  assert.equal(existsSync(elsewhere), false);
  assert.ok(existsSync(join(trash, "custom-state")));
  assert.ok(existsSync(state));
});
test("unknown command prints usage and exits 2", async () => {
  const result = await run("unknown").done;
  assert.equal(result.code, 2);
  assert.match(result.output, /Usage: bruse/);
});
