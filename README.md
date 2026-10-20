# cua

Local computer-use tools for agents, independent of any vendor's runtime.

## Browser

Gives an MCP client (Claude Code) a persistent JavaScript REPL with a `cua` object for reading and
operating the user's browser tabs in the background, without taking focus or moving the cursor. The API
follows the shape of Codex's browser computer use: numbered accessibility trees with diffs, input by
element number, Playwright-style locators, dialogs, uploads and downloads. Installing the extension is
the only setup; nothing is written into the browser's or the system's configuration.

```text
MCP server (hub) ◀──WebSocket 127.0.0.1:47615──▶ extension ──chrome.debugger / chrome.tabs──▶ tabs
   ▲
   └── other MCP servers (one per agent session) connect to the hub as clients
```

### Layout

- `browser/extension/`: MV3 extension, a thin executor. `offscreen.js` holds the WebSocket to the hub
  (an offscreen document is never suspended, so it reconnects within 0.5 s of a session starting) and
  passes requests to `service-worker.js`, which handles tab lifecycle, browser management, history and
  downloads. `cdp.js` relays DevTools Protocol commands through `chrome.debugger`, including the
  sessions of cross-origin frames, and tracks dialogs and console output. `sessions.js` keeps each agent
  session's tabs in its own tab group and closes the unmarked ones when the session ends.
- `browser/mcp/`: MCP stdio server, no dependencies.
  - `server.mjs`: the `js` and `js_reset` tools; `repl.mjs`: the persistent REPL.
  - `browser-link.mjs`, `websocket.mjs`, `config.mjs`: hub election and transport. The first server to
    bind the port becomes the hub; the others connect to it and a new hub is elected when it exits.
  - `cua/`: the browser API. `index.mjs` (`cua` object, browser and management capability), `tab.mjs`
    (tab methods), `ax-tree.mjs` (accessibility snapshots across frames with stable element numbers and
    diffs), `locator.mjs` and `page-scripts.mjs` (locators and in-page helpers), `elements.mjs` (pointer
    input), `keys.mjs` (xdotool-style key chords), `content.mjs` (YouTube transcript and Google
    Workspace exports), `docs.mjs` (documentation shown to the agent), `output.mjs`.

The hub accepts the extension only from its own origin (`chrome-extension://dcebpfjehgpkddgcdaipjemnndbdpmpc`,
fixed by the manifest `key`) and peer servers only with the token in
`~/.local/state/browser-control/hub-token`, so web pages cannot drive it.

### Install

1. In `brave://extensions` (or `chrome://extensions`), enable Developer mode, choose **Load unpacked** and
   select `browser/extension`.
2. Register the MCP server (Node 22 or newer):

   ```sh
   claude mcp add -s user browser -- /opt/homebrew/opt/node@24/bin/node ~/dev/cua/browser/mcp/server.mjs
   ```

After editing extension files, reload the extension in `brave://extensions`, or let it reload itself:

```sh
node --input-type=module -e 'import { callBrowser } from "./browser/mcp/browser-link.mjs"; await callBrowser("extension.reload"); process.exit(0)'
```

MCP server changes take effect in new agent sessions.

### Usage

```js
await cua.getState();                                             // browsers and tabs
const tab = await cua.createBrowserTab("1", "https://example.org"); // background tab, shows its tree
await tab.click(7); await tab.typeText(12, "query"); await tab.pressKey(null, "Return");
await tab.getAXState();                                            // only what changed
await tab.playwright.getByRole("button", { name: "Save" }).click();
await tab.getScreenshot();
```

The full API is in `browser/mcp/cua/docs.mjs`, which the agent receives on its first browser call.

### Behavior

- Agent tabs open without focus in a tab group named after the session (`sessionName` or
  `browser.nameSession`). When the session ends, its unmarked tabs close, including tabs its pages
  opened; `markDeliverable()` and `markHandoff()` keep a tab. Tabs bound with `getTab` stay untouched.
- Password manager menus are frames of another extension, which make the browser cut off debugger
  access. Fields the agent focuses get the opt-out attributes password managers honor, and any such
  frame that still appears is removed before the command is retried.
- Input that opens a JavaScript dialog returns immediately; the dialog is reported and handled with
  `getJsDialog()`.
- Console logs include only the page's own contexts, not other extensions' content scripts.
- All frames, including cross-origin ones in other processes, are part of the accessibility tree and
  accept input by element number. Playwright locators reach the main document and same-origin frames.
- The first call of a new session connects within about 0.5 s. While no session runs, the offscreen
  document retries twice a second; the browser logs the refused connections on the extension's card
  under **Errors**, which is expected.
- `tab.setViewport()` overrides the viewport for responsive testing; `browser.capabilities.get("management")`
  organizes windows, tabs, tab groups and bookmarks; `tab.content` exports YouTube transcripts and
  Google Docs, Sheets and Slides to local files.
- Browsers block extensions from loading `data:` and internal (`brave://`, `chrome://`) URLs.
