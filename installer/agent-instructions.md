# Installing Bruse (instructions for an AI agent)

Bruse gives AI agents background control of the user's own Chromium browser (Brave, Chrome, Edge,
Chromium, Vivaldi). Install it for the user by following these steps. Tell the user first that code run
through Bruse has their user account's permissions and can use the accounts signed in to the browser
profile ([SECURITY.md](https://github.com/padmk/bruse/blob/main/SECURITY.md)), and ask whether to go on.

The commands below use `bruse`, as after a Homebrew install. If you were not given an unpacked package,
ask the user, then run `brew install padmk/tap/bruse`. In an unpacked package run
`node installer/install.mjs` in place of `bruse setup`, and `node bin/bruse.mjs` in place of `bruse`.

## What is in this package

- `browser/extension/`: the browser extension (Manifest V3). It runs in the user's browser and executes
  commands in tabs.
- `browser/mcp/`: the MCP stdio server, plain Node.js modules with no dependencies (nothing to
  `npm install`). Agents talk to it; it relays their commands to the extension over a WebSocket on
  `127.0.0.1:47615`.
- `installer/install.mjs`: the installer. `Install Bruse.command` is the same installer as a double-click
  file for the user.

Both parts are needed: the server cannot reach tabs, and the extension cannot accept connections.

## Steps

1. **Check Node.js.** Run `node --version`; it must be 22 or newer. If it is missing or older, ask the user
   before installing Node (for example `brew install node` on macOS).
2. **Run the installer:**

   ```sh
   bruse setup --clients <names the user chose, such as claude-code,codex>
   ```

   It copies `browser/` to `~/.local/share/bruse/browser`, replacing an earlier version. It registers the
   MCP server as `bruse` with the agent clients the user picks (Claude Code, Codex, Cursor, VS Code and
   Insiders, GitHub Copilot CLI, Gemini CLI, Claude Desktop, Devin Desktop, Windsurf). Without a terminal
   it cannot ask, so ask the user which clients they want and pass them, for example
   `bruse setup --clients claude-code,codex`; without `--clients` a first install stops
   and lists the clients it found. Then it waits up to 10 minutes for the extension to connect. Run it
   in the background or with a long timeout, and read its output.
3. **Get the extension loaded.** This is needed once, and no command can do it: browsers load an
   extension from a folder only through their extensions page. On macOS the installer has already opened
   that page and shown the folder in Finder. The steps are:
   - turn on **Developer mode** (top right of the extensions page);
   - click **Load unpacked**;
   - select the path the installer printed, ending in `browser/extension`. In the macOS file dialog,
     `Cmd+Shift+G` opens a field for the path. Dragging the folder onto the page works too.

   If you have a tool that controls desktop apps, offer to do these steps, and do them only after the user
   agrees. Otherwise, give the user the steps and the path. Either way the installer continues by itself
   when the extension connects.

   Limits when you click for the user: on the extensions page change only Developer mode and Load
   unpacked, and leave other extensions alone. Select only the path the installer printed. Stop and ask at
   any window you did not expect. Tell the user that Developer mode stays on.

   The first time, macOS may ask whether the terminal may control the browser; the user can allow it,
   or open the extensions page by hand (`brave://extensions`, `chrome://extensions`, `edge://extensions`).
4. **Confirm.** The installer prints `Connected to <browser>` and `Bruse is ready`. That connection also
   pairs the extension with this machine. If the extension was already connected (an update), the
   installer reloads it instead and opens nothing.
5. **Tell the user to start a new agent session.** MCP servers load at session start. In the new session,
   the `js` tool of the `bruse` server works; its first call returns the API documentation.

## Other MCP clients

If neither `claude` nor `codex` is installed, the installer prints the command to register. Add it to
the client as a stdio server: `<absolute path to node> <install path>/browser/mcp/server.mjs`.
Use a stable Node path such as `/opt/homebrew/bin/node`, not a versioned one.

## Troubleshooting

- **The extension does not connect after a reinstall.** If the user removed the extension and loaded it
  again, it has a new secret, while the old one is still stored. `bruse setup` then asks in a terminal
  whether to reset the pairing, and without a terminal it stops and says so. The user runs it and answers;
  you never answer that question for the user, and you do not touch `extension-secret` yourself.
- **Setup says the extension holds a pairing from an earlier installation.** An uninstall left the
  extension in the browser. The user removes it on the extensions page and loads it again; then run the
  installer again.
- **"Load unpacked" fails.** Check that the selected folder contains `manifest.json`.
- **Developer mode warning.** Chromium shows a notice about developer-mode extensions. It is expected
  for extensions loaded this way.

## Checking and uninstalling

`bruse doctor` checks the installation, the registrations and the browser connection and
says what to do about each problem. `bruse uninstall` removes the registrations, moves the installed copy and the
pairing state to the Trash and opens the extensions page. The user removes the extension there, before
installing again.

## Rules

- Do not edit browser profile files or policies, and do not change system settings; the installer needs
  none of that. Developer mode is changed only on the extensions page, with the user's permission.
- Do not read, print or copy files in `~/.local/share/bruse/state`; they hold the pairing secrets.
