// Installs the browser extension files and the MCP server to a stable per-user location, registers the
// server with the agent CLIs found on this machine, opens the browser's extensions page for the one
// manual step (Load unpacked), and waits until the extension connects and pairs.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MCP_NAME = "bruse";
const PAIR_WAIT_MS = 10 * 60_000;
const PAIR_HINT_MS = 45_000;

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "browser");
const manifest = JSON.parse(readFileSync(join(source, "extension", "manifest.json"), "utf8"));
const product = manifest.name;

const installRoot =
  platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", product)
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), product.toLowerCase());
const installed = join(installRoot, "browser");
const extensionDir = join(installed, "extension");
const serverPath = join(installed, "mcp", "server.mjs");

// Chromium browsers in the order they are offered; the first installed one gets its extensions page opened.
const BROWSERS = [
  { name: "Brave", app: "Brave Browser", page: "brave://extensions" },
  { name: "Chrome", app: "Google Chrome", page: "chrome://extensions" },
  { name: "Edge", app: "Microsoft Edge", page: "edge://extensions" },
  { name: "Chromium", app: "Chromium", page: "chrome://extensions" },
  { name: "Vivaldi", app: "Vivaldi", page: "vivaldi://extensions" },
];

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const note = (text) => console.log(`  ${text}`);

function fail(text) {
  console.error(`\n\x1b[31m${text}\x1b[0m`);
  process.exit(1);
}

function onPath(command) {
  return spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim() || null;
}

function moveToTrash(path) {
  if (platform() === "darwin") {
    execFileSync("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(path)} as alias)`], { stdio: "ignore" });
  } else {
    const trash = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, `${product.toLowerCase()}-${Date.now()}`));
  }
}

// Copies next to the target first, so a failed copy leaves the previous installation working.
function installFiles() {
  step(`Installing ${product} ${manifest.version}`);
  if (source === installed) {
    note(`Already running from ${installRoot}`);
    return;
  }
  mkdirSync(installRoot, { recursive: true });
  const staged = join(installRoot, `browser.new-${process.pid}`);
  cpSync(source, staged, { recursive: true, filter: (path) => !path.endsWith(".DS_Store") });
  if (existsSync(installed)) {
    const previous = join(installRoot, `browser.previous-${Date.now()}`);
    renameSync(installed, previous);
    renameSync(staged, installed);
    moveToTrash(previous);
  } else {
    renameSync(staged, installed);
  }
  note(installed);
}

function registerServer() {
  step("Registering the MCP server");
  // A stable path such as /opt/homebrew/bin/node keeps working after Node upgrades; process.execPath is versioned.
  const node = process.env.INSTALL_NODE || onPath("node") || process.execPath;
  const command = [node, serverPath];
  let registered = 0;

  const claude = onPath("claude") ?? [join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude")].find(existsSync);
  if (claude) {
    spawnSync(claude, ["mcp", "remove", "-s", "user", MCP_NAME], { stdio: "ignore" });
    const result = spawnSync(claude, ["mcp", "add", "-s", "user", MCP_NAME, "--", ...command], { encoding: "utf8" });
    if (result.status === 0) {
      note("Claude Code: added for all projects");
      registered++;
    } else note(`Claude Code: failed (${(result.stderr || result.stdout).trim()})`);
  }

  const codex = onPath("codex");
  if (codex) {
    spawnSync(codex, ["mcp", "remove", MCP_NAME], { stdio: "ignore" });
    const result = spawnSync(codex, ["mcp", "add", MCP_NAME, "--", ...command], { encoding: "utf8" });
    if (result.status === 0) {
      note("Codex: added");
      registered++;
    } else note(`Codex: failed (${(result.stderr || result.stdout).trim()})`);
  }

  if (!registered) {
    note("No Claude Code or Codex CLI found. Add this stdio server to your MCP client:");
    note(`  ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  }
}

function openExtensionsPage() {
  step("Load the extension (once)");
  const browser = platform() === "darwin" ? BROWSERS.find((b) => existsSync(`/Applications/${b.app}.app`) || existsSync(join(homedir(), "Applications", `${b.app}.app`))) : null;
  const page = browser?.page ?? "chrome://extensions";
  note(`1. In ${page}, turn on Developer mode (top right).`);
  note(`2. Drag the "extension" folder from the Finder window onto the page,`);
  note(`   or choose Load unpacked and select:`);
  note(`   ${extensionDir}`);
  if (platform() !== "darwin") return;
  spawnSync("open", ["-R", extensionDir]);
  if (browser) showPage(browser.app, page);
}

// Browsers ignore internal pages passed by `open`, but accept them from AppleScript. The first run asks
// the user to let the terminal control the browser.
function showPage(app, page) {
  const script = `tell application ${JSON.stringify(app)}
    activate
    if (count of windows) = 0 then make new window
    make new tab at end of tabs of front window with properties {URL:${JSON.stringify(page)}}
  end tell`;
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) note(`(Could not open ${page} automatically; open it in ${app}.)`);
}

// The first connection pairs the extension with this machine's hub; see "Security" in the README.
async function waitForExtension() {
  step("Waiting for the extension to connect");
  const started = Date.now();
  let hinted = false;
  for (;;) {
    try {
      const info = await callBrowser("browser.info");
      note(`Connected to ${info.name}.`);
      return;
    } catch (error) {
      const waited = Date.now() - started;
      if (waited > PAIR_WAIT_MS) fail(`The extension did not connect within ${PAIR_WAIT_MS / 60_000} minutes. ${error.message}`);
      if (waited > PAIR_HINT_MS && !hinted) {
        hinted = true;
        note(`Still waiting. ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) fail(`${product} needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${process.version}).`);
installFiles();
registerServer();
const { callBrowser } = await import(join(installed, "mcp", "browser-link.mjs"));
const connected = await callBrowser("browser.info").catch(() => null);
if (connected) {
  step("Updating the extension");
  await callBrowser("extension.reload").catch(() => {});
  note(`Reloaded in ${connected.name}.`);
} else {
  openExtensionsPage();
  await waitForExtension();
}
step(`${product} is ready. Start a new agent session to use it.`);
process.exit(0);
