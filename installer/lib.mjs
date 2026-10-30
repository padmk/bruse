// What setup, doctor and uninstall share: the product, where it is installed, the agent CLIs it
// registers with, and console output.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { moreClients } from "./clients.mjs";
import { DATA_DIR } from "../browser/mcp/config.mjs";

export const MIN_NODE_MAJOR = 22;
const MCP_NAME = "bruse";

// The browser files this command ships with.
export const source = join(dirname(fileURLToPath(import.meta.url)), "..", "browser");
export const manifest = JSON.parse(readFileSync(join(source, "extension", "manifest.json"), "utf8"));
export const product = manifest.name;

// A stable per-user copy: the browser loads the extension from it, and agents start its server. The
// pairing state lives next to it.
export const installRoot = DATA_DIR;
export const installed = join(installRoot, "browser");
export const extensionDir = join(installed, "extension");
export const serverPath = join(installed, "mcp", "server.mjs");

export function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8")).version;
  } catch {
    return null;
  }
}

export const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
export const note = (text) => console.log(`  ${text}`);

export function fail(text) {
  console.error(`\n\x1b[31m${text}\x1b[0m`);
  process.exit(1);
}

// The problem a connected extension reports in its browser.info, which keeps it from running agent
// requests, and what to do about it.
export const problemMessage = (info) => `${info.name} refuses agent requests: ${info.problem} Update ${info.name}, then run \`bruse setup\` to reload the extension.`;

export function requireNode() {
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) fail(`${product} needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${process.version}).`);
}

export function onPath(command) {
  return spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).stdout.trim() || null;
}

// Short name of a client for `bruse setup --clients`, such as claude-code or vs-code.
export const clientId = (client) => client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

// A CLI's answer for a server it does not know; any other failure leaves the registration unknown.
const NOT_REGISTERED = /No MCP server named/i;

// The agent clients found on this machine, each with how to read, add and remove the registration.
// add() replaces an earlier registration. registration() returns { path } for a registered server,
// { path: null } when the client says there is none, and null when it could not tell.
export function agentClients() {
  const clients = [];
  const claude = onPath("claude") ?? [join(homedir(), ".local", "bin", "claude"), join(homedir(), ".claude", "local", "claude")].find(existsSync);
  if (claude) {
    clients.push({
      name: "Claude Code",
      add: (command) => {
        spawnSync(claude, ["mcp", "remove", "-s", "user", MCP_NAME], { encoding: "utf8" });
        return spawnSync(claude, ["mcp", "add", "-s", "user", MCP_NAME, "--", ...command], { encoding: "utf8" });
      },
      remove: () => spawnSync(claude, ["mcp", "remove", "-s", "user", MCP_NAME], { encoding: "utf8" }),
      // `claude mcp get` prints the arguments joined by spaces on an "Args:" line, so a path with spaces
      // can only be recognized, not split out.
      registration: () => {
        const result = spawnSync(claude, ["mcp", "get", MCP_NAME], { encoding: "utf8", timeout: 30_000 });
        if (result.status !== 0) return NOT_REGISTERED.test(`${result.stdout}${result.stderr}`) ? { path: null } : null;
        const args = result.stdout.match(/^\s*Args:\s*(.+)$/m)?.[1].trim();
        return args ? { path: args.endsWith(serverPath) ? serverPath : args } : null;
      },
    });
  }
  const codex = onPath("codex");
  if (codex) {
    clients.push({
      name: "Codex",
      add: (command) => {
        spawnSync(codex, ["mcp", "remove", MCP_NAME], { encoding: "utf8" });
        return spawnSync(codex, ["mcp", "add", MCP_NAME, "--", ...command], { encoding: "utf8" });
      },
      remove: () => spawnSync(codex, ["mcp", "remove", MCP_NAME], { encoding: "utf8" }),
      registration: () => {
        const result = spawnSync(codex, ["mcp", "get", MCP_NAME, "--json"], { encoding: "utf8" });
        if (result.status !== 0) return NOT_REGISTERED.test(`${result.stdout}${result.stderr}`) ? { path: null } : null;
        try {
          const config = JSON.parse(result.stdout);
          return { path: (config.transport?.args ?? config.args ?? []).at(-1) ?? null };
        } catch {
          return null;
        }
      },
    });
  }
  return [...clients, ...moreClients(onPath, MCP_NAME)];
}

export function moveToTrash(path) {
  if (platform() === "darwin") {
    execFileSync("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(path)} as alias)`], { stdio: "ignore" });
  } else {
    const trash = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Trash", "files");
    mkdirSync(trash, { recursive: true });
    renameSync(path, join(trash, `${product.toLowerCase()}-${Date.now()}`));
  }
}
