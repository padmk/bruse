# Installing Bruse (instructions for an AI agent)

You are in an unpacked Bruse package. Bruse gives AI agents background control of the user's own
Chromium browser (Brave, Chrome, Edge). Install it for the user by following these steps.

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
2. **Run the installer** from this directory:

   ```sh
   node installer/install.mjs
   ```

   It copies `browser/` to `~/Library/Application Support/Bruse/browser` on macOS
   (`~/.local/share/bruse/browser` on Linux), replacing an earlier version. It registers the MCP server
   as `bruse` with Claude Code (user scope) and Codex, if their CLIs are installed. Then it waits up to
   10 minutes for the extension to connect. Run it in the background or with a long timeout, and read
   its output.
3. **Ask the user to load the extension.** This is needed once. The browser installs extensions from
   outside its store only by hand, and you cannot do it for the user. On macOS the installer has
   already opened the extensions page and shown the folder in Finder. Tell the user:
   - turn on **Developer mode** (top right of the extensions page);
   - drag the `extension` folder onto the page, or choose **Load unpacked** and select the path the
     installer printed, ending in `browser/extension`.

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
  again, it has a new secret, while the old one is still stored. Ask the user, then move
  `~/.local/state/browser-control/extension-secret` to the Trash and run the installer again.
- **"Load unpacked" fails.** Check that the selected folder contains `manifest.json`.
- **Developer mode warning.** Chromium shows a notice about developer-mode extensions. It is expected
  for extensions loaded this way.

## Uninstalling

Remove the extension on the browser's extensions page, then:

```sh
claude mcp remove -s user bruse
codex mcp remove bruse
```

Then move `~/Library/Application Support/Bruse` (macOS) or `~/.local/share/bruse` (Linux) and
`~/.local/state/browser-control` to the Trash.

## Rules

- Do not change browser profiles, policies or system settings; the installer needs none of that.
- Do not read, print or copy files in `~/.local/state/browser-control`; they hold the pairing secrets.
