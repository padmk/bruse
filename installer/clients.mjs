// Agent clients beyond Claude Code and Codex. A client with a CLI that adds and removes MCP servers is
// registered through it; the others through their user configuration file. A file is changed only when
// it parses as JSON (a file with comments is reported, not rewritten), keeps every other key, is backed
// up first and is replaced atomically. Each client has the shape agentClients() in lib.mjs describes.
//
// Formats, as documented on 2026-10-28:
// - Cursor: ~/.cursor/mcp.json, "mcpServers" with "type": "stdio" (https://cursor.com/docs/context/mcp)
// - Claude Desktop: claude_desktop_config.json, "mcpServers" (https://modelcontextprotocol.io/quickstart/user)
// - Devin Desktop, formerly Windsurf: ~/.config/devin/mcp_config.json, "mcpServers"
//   (https://docs.devin.ai/desktop/cascade/mcp); Windsurf installs keep ~/.codeium/windsurf/mcp_config.json
// - VS Code: mcp.json in the user profile, "servers" with "type": "stdio"
//   (https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
// - GitHub Copilot CLI: `copilot mcp add|remove`, or ~/.copilot/mcp-config.json with "type": "local"
//   (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
// - Gemini CLI: `gemini mcp add|remove --scope user`, or ~/.gemini/settings.json
//   (https://geminicli.com/docs/tools/mcp-server/)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../browser/mcp/config.mjs";

const UNREADABLE = { status: 1, stdout: "", stderr: "could not read its MCP configuration" };

export function moreClients(onPath, name) {
  const home = homedir();
  const appData = platform() === "darwin" ? join(home, "Library", "Application Support") : process.env.XDG_CONFIG_HOME || join(home, ".config");
  const stdio = (command) => ({ command: command[0], args: command.slice(1) });
  const files = [
    { label: "Cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers", entry: (command) => ({ type: "stdio", ...stdio(command) }) },
    { label: "Claude Desktop", path: join(appData, "Claude", "claude_desktop_config.json"), key: "mcpServers", entry: stdio },
    { label: "Devin Desktop", path: join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "devin", "mcp_config.json"), key: "mcpServers", entry: stdio },
    { label: "Windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: stdio },
    { label: "VS Code", path: join(appData, "Code", "User", "mcp.json"), key: "servers", entry: (command) => ({ type: "stdio", ...stdio(command) }) },
    {
      label: "VS Code Insiders",
      path: join(appData, "Code - Insiders", "User", "mcp.json"),
      key: "servers",
      entry: (command) => ({ type: "stdio", ...stdio(command) }),
    },
    {
      label: "GitHub Copilot CLI",
      path: join(process.env.COPILOT_HOME || join(home, ".copilot"), "mcp-config.json"),
      key: "mcpServers",
      entry: (command) => ({ type: "local", ...stdio(command), tools: ["*"] }),
      cli: onPath("copilot") && { path: onPath("copilot"), add: ["mcp", "add", "--tools", "*", name, "--"], remove: ["mcp", "remove", name] },
    },
    {
      label: "Gemini CLI",
      path: join(home, ".gemini", "settings.json"),
      key: "mcpServers",
      entry: stdio,
      cli: onPath("gemini") && { path: onPath("gemini"), add: ["mcp", "add", "--scope", "user", name], remove: ["mcp", "remove", "--scope", "user", name] },
    },
  ];
  // A client counts as installed when its CLI is on PATH or its configuration folder exists.
  return files.filter((file) => file.cli || existsSync(dirname(file.path))).map((file) => configClient(file, name));
}

function configClient({ label, path, key, entry, cli }, name) {
  // The configuration, or null when it cannot be read as a JSON object with an object at `key`.
  const read = () => {
    try {
      const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
      return isObject(config) && (config[key] === undefined || isObject(config[key])) ? config : null;
    } catch {
      return null;
    }
  };

  const write = (change) => {
    const config = read();
    if (!config) return UNREADABLE;
    try {
      if (existsSync(path)) {
        const backups = join(DATA_DIR, "backups");
        mkdirSync(backups, { recursive: true });
        copyFileSync(path, join(backups, `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${Date.now()}.json`));
      }
      change(config);
      const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
      const temp = join(dirname(path), `.${name}-${process.pid}-${Date.now()}.tmp`);
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: "wx" });
      renameSync(temp, path);
      return { status: 0, stdout: "", stderr: "" };
    } catch (error) {
      return { status: 1, stdout: "", stderr: error.message };
    }
  };

  const run = (args) => (read() ? spawnSync(cli.path, args, { encoding: "utf8" }) : UNREADABLE);

  const registration = () => {
    const config = read();
    if (!config) return null;
    const existing = config[key]?.[name];
    return { path: existing ? (existing.args?.at(-1) ?? "unknown") : null };
  };

  const remove = () => {
    if (cli) return registration()?.path === null ? { status: 0, stdout: "", stderr: "" } : run(cli.remove);
    return registration()?.path === null ? { status: 0, stdout: "", stderr: "" } : write((config) => delete config[key][name]);
  };

  // Adding replaces an earlier registration.
  const add = (command) => {
    if (cli) {
      remove();
      return run([...cli.add, ...command]);
    }
    return write((config) => {
      config[key] = { ...config[key], [name]: entry(command) };
    });
  };

  return { name: label, add, remove, registration };
}
