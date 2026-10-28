import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { browserCopy, freePort, launchBrowser, until } from "./harness.mjs";

let copy, browser, home, installed, cli, environment;
const children = new Set();
function run(command) {
  const child = spawn(process.execPath, [cli, command], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => { children.delete(child); resolve({ code, output }); });
  });
  return { child, done, output: () => output };
}
before(async () => {
  copy = browserCopy(await freePort());
  for (const name of ["bin", "installer", "package.json"]) cpSync(new URL(`../${name}`, import.meta.url), join(copy.dir, name), { recursive: true });
  home = join(copy.dir, "home"); installed = join(home, ".local", "share", "bruse"); cli = join(copy.dir, "bin", "bruse.mjs");
  environment = { ...process.env, HOME: home, BRUSE_NO_OPEN: "1", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  delete environment.XDG_DATA_HOME; delete environment.BROWSER_CONTROL_STATE_DIR;
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
  assert.match(setup.output(), /No Claude Code or Codex CLI found/);
  assert.ok(setup.output().includes(join(installed, "browser", "mcp", "server.mjs")));
  browser = await launchBrowser(join(installed, "browser", "extension"));
  const first = await setup.done;
  assert.equal(first.code, 0, first.output); assert.match(first.output, /is ready/);
  const secretPath = join(installed, "state", "extension-secret");
  const secret = readFileSync(secretPath, "utf8");
  const second = await run("setup").done;
  assert.equal(second.code, 0, second.output); assert.match(second.output, /Reloaded in/); assert.match(second.output, /is ready/);
  assert.equal(readFileSync(secretPath, "utf8"), secret);
  const doctor = await run("doctor").done;
  assert.equal(doctor.code, 0, doctor.output);
  assert.match(doctor.output, /Installed in/); assert.match(doctor.output, /Paired with an extension/); assert.match(doctor.output, /Connected to/);
  assert.match(doctor.output, /No Claude Code or Codex CLI found/); assert.match(doctor.output, /Everything looks right/);
  const uninstall = await run("uninstall").done;
  assert.equal(uninstall.code, 0, uninstall.output); assert.equal(existsSync(installed), false);
});
test("unknown command prints usage and exits 2", async () => {
  const result = await run("unknown").done;
  assert.equal(result.code, 2); assert.match(result.output, /Usage: bruse/);
});
