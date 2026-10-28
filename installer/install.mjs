// Installs the browser extension files and the MCP server to a stable per-user location, registers the
// server with the agent CLIs found on this machine, opens the browser's extensions page for the one
// manual step (Load unpacked), and waits until the extension connects and pairs. An extension that is
// already connected is reloaded and must come back with this version.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_EXTENSION_ID } from "../browser/mcp/config.mjs";
import { agentClients, extensionDir, fail, installRoot, installed, manifest, note, onPath, product, requireNode, serverPath, source, step, moveToTrash } from "./lib.mjs";

const PAIR_WAIT_MS = 10 * 60_000;
const PAIR_HINT_MS = 45_000;
const RELOAD_WAIT_MS = 30_000;

// Chromium browsers in the order they are offered; the first installed one gets its extensions page opened.
const BROWSERS = [
  { name: "Brave", app: "Brave Browser", page: "brave://extensions" },
  { name: "Chrome", app: "Google Chrome", page: "chrome://extensions" },
  { name: "Edge", app: "Microsoft Edge", page: "edge://extensions" },
  { name: "Chromium", app: "Chromium", page: "chrome://extensions" },
  { name: "Vivaldi", app: "Vivaldi", page: "vivaldi://extensions" },
];

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

// Returns whether every agent CLI found took the registration.
function registerServer() {
  step("Registering the MCP server");
  // A stable path such as /opt/homebrew/bin/node keeps working after Node upgrades; process.execPath is versioned.
  const node = process.env.INSTALL_NODE || onPath("node") || process.execPath;
  const command = [node, serverPath];
  const clients = agentClients();
  let failed = 0;
  for (const client of clients) {
    const result = client.add(command);
    if (result.status === 0) note(`${client.name}: added`);
    else {
      failed++;
      note(`${client.name}: failed (${(result.stderr || result.stdout).trim()})`);
    }
  }
  if (!clients.length) {
    note("No supported agent client found. Add this stdio server to your MCP client:");
    note(`  ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  }
  return failed === 0;
}

function openExtensionsPage() {
  step("Load the extension (once)");
  const browser = platform() === "darwin" ? BROWSERS.find((b) => existsSync(`/Applications/${b.app}.app`) || existsSync(join(homedir(), "Applications", `${b.app}.app`))) : null;
  const page = browser?.page ?? "chrome://extensions";
  note(`1. In ${page}, turn on Developer mode (top right).`);
  note(`2. Drag the "extension" folder from the Finder window onto the page,`);
  note(`   or choose Load unpacked and select:`);
  note(`   ${extensionDir}`);
  if (platform() !== "darwin" || process.env.BRUSE_NO_OPEN) return;
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
async function waitForExtension(callBrowser) {
  step("Waiting for the extension to connect");
  const started = Date.now();
  let hinted = false;
  for (;;) {
    try {
      const info = await callBrowser("browser.info");
      note(`Connected to ${info.name}.`);
      return info;
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

// The reloaded extension reconnects within moments; it reports its version from then on.
async function reloadExtension(callBrowser, connected) {
  step("Updating the extension");
  await callBrowser("extension.reload").catch(() => {});
  const deadline = Date.now() + RELOAD_WAIT_MS;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  let info = null;
  while (Date.now() < deadline) {
    info = await callBrowser("browser.info").catch(() => null);
    if (info?.version === manifest.version) {
      note(`Reloaded in ${info.name}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!info) fail(`The extension did not reconnect after the reload. On the extensions page of ${connected.name}, check that Developer mode and the ${product} extension are turned on.`);
  fail(
    `The connected extension is version ${info.version ?? "unknown"}, not ${manifest.version}. It is probably loaded from another folder: remove it on the extensions page and load ${extensionDir}.`,
  );
}

// The Chrome Web Store's copy updates itself; reloading it would not change its version.
function checkStoreExtension(info) {
  if (info.version === manifest.version) note(`Connected to ${info.name}, extension from the Chrome Web Store.`);
  else note(`The extension from the Chrome Web Store is version ${info.version}; the browser updates it to ${manifest.version} on its own.`);
}

const fromStore = (info) => info?.id === STORE_EXTENSION_ID;

export async function setup() {
  requireNode();
  installFiles();
  const registered = registerServer();
  const { callBrowser } = await import(join(installed, "mcp", "browser-link.mjs"));
  const connected = await callBrowser("browser.info").catch(() => null);
  if (fromStore(connected)) checkStoreExtension(connected);
  else if (connected) await reloadExtension(callBrowser, connected);
  else {
    openExtensionsPage();
    const info = await waitForExtension(callBrowser);
    // An extension enabled from another folder, or an older copy, connects too; it must run this version.
    if (fromStore(info)) checkStoreExtension(info);
    else if (info.version !== manifest.version) await reloadExtension(callBrowser, info);
  }
  if (!registered) fail(`${product} is installed, but registering the MCP server failed for an agent CLI (see above).`);
  step(`${product} is ready. Start a new agent session to use it.`);
}

// Run directly (node installer/install.mjs, Install Bruse.command); `bruse setup` imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await setup();
  process.exit(0);
}
