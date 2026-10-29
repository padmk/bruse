// Installs the browser extension files and the MCP server to a stable per-user location, registers the
// server with the agent clients the user picks, opens the browser's extensions page for the one manual
// step (Load unpacked), and waits until the extension connects and pairs. An extension that is already
// connected is reloaded and must come back with this version.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_VERSION_MISMATCH, PORT, STORE_EXTENSION_ID } from "../browser/mcp/config.mjs";
import { agentClients, clientId, extensionDir, fail, installRoot, installed, manifest, note, onPath, product, requireNode, serverPath, source, step, moveToTrash } from "./lib.mjs";

const PAIR_WAIT_MS = 10 * 60_000;
const PAIR_HINT_MS = 45_000;
const RELOAD_WAIT_MS = 30_000;
// Homebrew installs leave SECURITY.md out, so the notice links to this version's copy in the repository.
const SECURITY_URL = `${manifest.homepage_url}/blob/v${manifest.version}/SECURITY.md`;

// Chromium browsers in the order they are offered; the first installed one gets its extensions page opened.
const BROWSERS = [
  { name: "Brave", app: "Brave Browser", page: "brave://extensions" },
  { name: "Chrome", app: "Google Chrome", page: "chrome://extensions" },
  { name: "Edge", app: "Microsoft Edge", page: "edge://extensions" },
  { name: "Chromium", app: "Chromium", page: "chrome://extensions" },
  { name: "Vivaldi", app: "Vivaldi", page: "vivaldi://extensions" },
];

// Copies next to the target first, so a failed copy leaves the previous installation working. The
// previous copy is set aside and put back when the new one cannot take its place; a process killed
// between the two renames still leaves no copy at the installed path. `rename` lets tests make a rename fail.
export function installFiles({ rename = renameSync } = {}) {
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
    rename(installed, previous);
    try {
      rename(staged, installed);
    } catch (error) {
      discard(staged);
      try {
        rename(previous, installed);
      } catch (restoreError) {
        fail(
          `Could not install the new copy (${error.message}) or put the previous one back (${restoreError.message}). ` +
            `The previous installation is kept in ${previous}; to restore it, run:\n  mv ${shellQuote(previous)} ${shellQuote(installed)}`,
        );
      }
      fail(`Could not install the new copy (${error.message}); the previous installation in ${installed} is unchanged.`);
    }
    moveToTrash(previous);
  } else {
    rename(staged, installed);
  }
  note(installed);
}

// Single quotes keep the shell from expanding `$` and backquotes in a path.
const shellQuote = (path) => `'${path.replace(/'/g, "'\\''")}'`;

// Moves a leftover staged copy to the Trash; a failure here must not hide the error that left it.
function discard(path) {
  try {
    moveToTrash(path);
  } catch {
    note(`(Could not move ${path} to the Trash; remove it by hand.)`);
  }
}

// Shown once, on the first install, before any agent client gets the server.
function trustNotice() {
  step(`${product} is meant for agents you trust`);
  note("Code an agent runs in the `js` tool runs with your user account's permissions: your files, programs and network.");
  note("Agents act in your browser profile and can use the accounts you are signed in to there.");
  note("A separate browser profile keeps those sign-ins out of reach, but it is not a sandbox for this computer.");
  note(`More in SECURITY.md: ${SECURITY_URL}`);
}

// A stable path such as /opt/homebrew/bin/node keeps working after Node upgrades; process.execPath is versioned.
const nodePath = () => process.env.INSTALL_NODE || onPath("node") || process.execPath;

// The clients to register with: --clients names them; in a terminal the user picks from the list.
// Without a terminal (an agent or a script runs setup), an update keeps the clients that already have the
// server, and a first install stops with the list, because registering with every client unasked is the
// user's decision.
async function chooseClients(clients, requested) {
  if (requested !== undefined) {
    const ids = requested.split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.length) fail(`--clients needs client names, such as ${clients.map(clientId).join(",") || "claude-code,codex"}.`);
    const unknown = ids.filter((id) => !clients.some((client) => clientId(client) === id));
    if (unknown.length) fail(`Unknown or not installed client: ${unknown.join(", ")}. Found: ${clients.map(clientId).join(", ") || "none"}.`);
    return clients.filter((client) => ids.includes(clientId(client)));
  }
  if (!process.stdin.isTTY) {
    if (!clients.length) return clients;
    const registered = clients.filter((client) => client.registration()?.path);
    if (registered.length) return registered;
    fail(`Choose the agent clients to register with: bruse setup --clients ${clients.map(clientId).join(",")} (any subset of these).`);
  }
  if (clients.length < 2) return clients;
  step("Agent clients found");
  clients.forEach((client, i) => note(`${i + 1}. ${client.name}`));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await prompt.question("  Register with which? Enter for all, numbers such as 1,3, or 0 for none: ")).trim();
  prompt.close();
  if (!answer) return clients;
  const picked = answer.split(/[\s,]+/).map(Number);
  if (picked.some((n) => !Number.isInteger(n) || n < 0 || n > clients.length)) fail(`Expected numbers from 1 to ${clients.length}.`);
  return clients.filter((_, i) => picked.includes(i + 1));
}

// Returns whether every chosen client took the registration.
async function registerServer(requested) {
  const command = [nodePath(), serverPath];
  const found = agentClients();
  const clients = await chooseClients(found, requested);
  step("Registering the MCP server");
  for (const client of found.filter((client) => !clients.includes(client))) note(`${client.name}: skipped (add it later with \`bruse setup --clients ${clientId(client)}\`)`);
  let failed = 0;
  for (const client of clients) {
    const result = client.add(command);
    if (result.status === 0) note(`${client.name}: added`);
    else {
      failed++;
      note(`${client.name}: failed (${(result.stderr || result.stdout).trim()})`);
    }
  }
  if (!found.length) {
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
      if (error.code === HUB_VERSION_MISMATCH) fail(error.message);
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
async function reloadExtension(callBrowser, connected, build) {
  step("Updating the extension");
  await callBrowser("extension.reload").catch(() => {});
  const deadline = Date.now() + RELOAD_WAIT_MS;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  let info = null;
  while (Date.now() < deadline) {
    info = await callBrowser("browser.info").catch(() => null);
    if (runsThisCode(info, build)) {
      note(`Reloaded in ${info.name}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!info) fail(`The extension did not reconnect after the reload. On the extensions page of ${connected.name}, check that Developer mode and the ${product} extension are turned on.`);
  fail(
    info.version === manifest.version
      ? `The connected extension runs other code than ${extensionDir}, though its version is ${manifest.version}. It is probably loaded from another folder: remove it on the extensions page and load ${extensionDir}.`
      : `The connected extension is version ${info.version ?? "unknown"}, not ${manifest.version}. It is probably loaded from another folder: remove it on the extensions page and load ${extensionDir}.`,
  );
}

// The Chrome Web Store's copy updates itself; reloading it would not change its version or its code.
function checkStoreExtension(info, build) {
  if (info.version !== manifest.version) note(`The extension from the Chrome Web Store is version ${info.version}; the browser updates it to ${manifest.version} on its own.`);
  else if (build && info.build !== build) note(`The extension from the Chrome Web Store runs other code than ${extensionDir}, though its version is ${manifest.version}; \`bruse doctor\` says how to match them.`);
  else note(`Connected to ${info.name}, extension from the Chrome Web Store.`);
}

const fromStore = (info) => info?.id === STORE_EXTENSION_ID;

const portTaken = (error) =>
  `No ${product} hub that knows the hub token answers on 127.0.0.1:${PORT} (${error.message}). A new extension pairs with whatever answers there, so do not load it now: find the program with \`lsof -nP -iTCP:${PORT} -sTCP:LISTEN\`, stop it and run setup again.`;
// The version stays the same between releases, so the extension must also report this copy's code
// fingerprint (`build`, see shared.js) to count as updated.
const runsThisCode = (info, build) => info?.version === manifest.version && (!build || info.build === build);

export async function setup({ clients } = {}) {
  requireNode();
  const firstInstall = !existsSync(installed);
  installFiles();
  if (firstInstall) trustNotice();
  const { extensionBuild } = await import(join(installed, "extension", "shared.js"));
  const build = await extensionBuild((file) => readFile(join(extensionDir, file), "utf8")).then(({ hash }) => hash, () => null);
  const registered = await registerServer(clients);
  const { callBrowser, isNotConnected } = await import(join(installed, "mcp", "browser-link.mjs"));
  // A hub of an older version, run by an agent session started before the update, cannot be reached.
  // Before the extension is loaded, a hub that proved the hub token must hold the port (this process
  // or an agent session): an extension without a pairing secret gives it to whatever answers there.
  const connected = await callBrowser("browser.info").catch((error) => {
    if (error.code === HUB_VERSION_MISMATCH) fail(error.message);
    if (!isNotConnected(error)) fail(portTaken(error));
    return null;
  });
  if (fromStore(connected)) checkStoreExtension(connected, build);
  else if (connected) await reloadExtension(callBrowser, connected, build);
  else {
    openExtensionsPage();
    const info = await waitForExtension(callBrowser);
    // An extension enabled from another folder, or an older copy, connects too; it must run this version.
    if (fromStore(info)) checkStoreExtension(info, build);
    else if (!runsThisCode(info, build)) await reloadExtension(callBrowser, info, build);
  }
  if (!registered) fail(`${product} is installed, but registering the MCP server failed for an agent CLI (see above).`);
  step(`${product} is ready. Start a new agent session to use it.`);
}

// Run directly (node installer/install.mjs, Install Bruse.command); `bruse setup` imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const flag = process.argv.indexOf("--clients");
  await setup({ clients: flag > 0 ? (process.argv[flag + 1] ?? "") : undefined });
  process.exit(0);
}
