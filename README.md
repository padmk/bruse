# Bruse

<img src="browser/extension/icons/icon-128.png" width="96" alt="Bruse icon" align="right">

**Bruse** (browser use, with a nod to Bruce Lee) gives local AI agents fast, background control of the
user's real browser, independent of any vendor's runtime.

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
  sessions of cross-origin frames, and tracks dialogs and console output. `sessions.js` keeps the tabs
  of all agent sessions in one tab group per window, tracks which session owns each tab and closes a
  session's unmarked tabs when it ends. `downloads.js` pairs downloads with the tabs that started
  them. `shared.js` is the one owner of what the extension and the MCP server must agree on (hub
  port, management method allow-list, which input counts as the agent's press and for how long,
  password manager element names, the unresponsive-page error); it uses no browser or Node APIs, so
  the MCP server imports it from the extension directory. `browser/package.json` marks the `.js`
  files as ES modules for Node; installed copies of `browser/` include it.
- `installer/`: `install.mjs` (the installer), `Install.command` (its double-click entry point on macOS,
  which finds Node.js), `agent-instructions.md` (installation steps for an agent, shipped as the
  package's `AGENTS.md` with a `CLAUDE.md` that imports it) and `package.mjs` (builds the zip package).
- `browser/mcp/`: MCP stdio server, no dependencies.
  - `server.mjs`: the `js` and `js_reset` tools. It runs the REPL in a worker thread (`repl-worker.mjs`)
    and replaces the worker whenever a call times out or the worker crashes, so nothing the call left running (an endless
    loop, a timer, a pending request) can act on a page later. The browser connection stays in the main
    thread and survives the replacement; the worker reaches it through `browser-port.mjs`.
  - `repl.mjs`: the persistent REPL; `hoist.mjs`: turns top-level declarations of a cell into globals so
    they persist and can be redeclared.
  - `focus-guard.mjs`: gives the front back to the user's app when an agent action makes a page
    open a tab and the browser takes the front (see Behavior); a switch the user makes stands.
  - `browser-link.mjs`, `websocket.mjs`, `config.mjs`: hub election, authentication and transport. The
    first server to bind the port becomes the hub; the others connect to it. A hub that exits first lets
    in-flight requests finish, read-only requests interrupted by a handover are resent, and a new hub
    is elected on the next call.
  - `cua/`: the browser API. `index.mjs` (`cua` object, browser and management capability), `tab.mjs`
    (tab methods), `ax-tree.mjs` (accessibility snapshots across frames with stable element numbers and
    diffs), `aria-snapshot.mjs` (Playwright-style ARIA snapshot for `domSnapshot()`), `locator.mjs` and `page-scripts.mjs` (locators and in-page helpers), `elements.mjs` (pointer
    input), `keys.mjs` (xdotool-style key chords), `content.mjs` (YouTube transcript and Google
    Workspace exports), `docs.mjs` (documentation shown to the agent), `output.mjs`.

Security: the hub accepts peer MCP servers only with the token in `~/.local/state/browser-control/hub-token`
(mode 0600), so web pages and other users cannot drive it. Hub and extension authenticate each other: on
first connection the extension pairs by sending a random secret, which the hub stores in
`~/.local/state/browser-control/extension-secret` (0600); every later connection proves that secret in
both directions with HMAC over fresh nonces. The extension executes requests only on an authenticated
connection, so a process posing as the hub on the port gets nothing, and one posing as the extension
cannot replace it. Pairing itself trusts the first connection: while the extension has no secret
(on first install or after a reinstall) it gives its new secret to whatever listens on the port, and
while the hub has no `extension-secret` it accepts the first extension that pairs. Pair while the hub
is your own session. After reinstalling the extension (it then has a new secret), remove
`extension-secret` so that it can pair again.

### Install

Requires Node.js 22 or newer and a Chromium browser (Brave, Chrome, Edge).

1. Build the package with `node installer/package.mjs`; it writes `dist/Bruse-<version>.zip` (about 100 KB).
2. Unzip it and double-click **Install Bruse.command** (or run `node installer/install.mjs` from a checkout),
   or open an agent (Claude Code, Codex) in the unpacked folder and ask it to install Bruse: the package's
   `AGENTS.md` tells it how.
   The installer:
   - copies the extension and the MCP server to `~/Library/Application Support/Bruse/browser`
     (`~/.local/share/bruse/browser` on Linux), replacing a previous version;
   - registers the MCP server as `bruse` with Claude Code (user scope) and Codex, whichever is installed;
   - when the extension is not connected yet, shows its folder in Finder and opens the browser's extensions
     page (the first time, macOS asks to let the terminal control the browser);
   - waits until the extension connects, which also pairs it (see Security), or reloads an extension that
     is already connected so that it runs the new files.
3. The one manual step, on first install only: on the extensions page turn on Developer mode and drag the
   `extension` folder onto the page (or choose **Load unpacked**). Chromium browsers on macOS install other
   extensions only from the Chrome Web Store, so this step remains until the extension is published there.

A package downloaded from the internet is quarantined: macOS refuses to open the unsigned
`Install Bruse.command` until it is allowed in System Settings › Privacy & Security (**Open Anyway**).

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

- Agent tabs open without focus in the window's "Claude" tab group, which all agent sessions share;
  the extension remembers which session owns each tab, also across extension reloads. When a session
  ends, its unmarked tabs close, including tabs its pages opened in response to the agent's input: the
  page reported the opening (`Page.windowOpen`) right after the agent's input, and the browser
  reported the new tab with its opener (`webNavigation.onCreatedNavigationTarget`), so tool results
  name the exact new tab. Tabs the user opens from an agent page, for example from its context menu,
  stay the user's. `markDeliverable()` and `markHandoff()` keep a tab, which then leaves the group.
  Tabs bound with `getTab` stay untouched, and other tabs in the group, such as ones the user moves
  there, leave it once no live session has a tab in it.
- Agent work keeps the user's app in front. Brave brings its window forward when a page opens a tab
  or window (`target=_blank`, `window.open`); tabs opened by agent pages become background tabs in
  the agent group, popup windows included, and on macOS `focus-guard.mjs` returns the front to the
  app that had it before the agent's input (Brave may show for a fraction of a second).
- Password manager menus are frames of another extension, which make the browser cut off debugger
  access. Fields the agent clicks or focuses get the opt-out attributes password managers honor, any
  such frame that still appears is removed (only the frame, or a known password manager's wrapper)
  before the command is retried, and password manager buttons
  and live regions are left out of the accessibility tree.
- The `js` tool is loaded up front (`_meta["anthropic/alwaysLoad"]`), so Claude Code does not spend a
  turn on tool search before the first browser call. A call returns at most 30,000 characters of text,
  cut at a line end with a note on reading the rest from the REPL; Claude Code would otherwise move a
  result over 25,000 tokens (a busy page's first tree) to a file outside the agent's view.
- State reads after an action wait until the DOM has had no mutations for 60 ms (at most 1 s from the
  action) instead of a fixed delay.
- Screenshots are captured in CSS pixels, so points in the image are the points `click([x, y])` takes.
- `tab.hover()` and `locator.hover()` open hover menus; `tab.drag()` takes element numbers or points and
  `locator.dragTo()` drags onto another element; `tab.dev.requests()` lists recent network requests,
  for example to confirm a submission made with `fetch`.
- Input that opens a JavaScript dialog returns immediately; the dialog is reported and handled with
  `getJsDialog()`.
- Console logs include only the page's own contexts, not other extensions' content scripts.
- All frames, including cross-origin ones in other processes, are part of the accessibility tree and
  accept input by element number. Playwright locators reach them too, through `frameLocator()`.
- Clicks aim at the center of the element's visible part and check that the element receives them: a
  click by element number waits up to 1 s and a locator click up to its timeout for a covering element
  (an overlay, a toast) to go away, then fails naming what would receive the click instead (also when
  the element has `pointer-events: none`). `{ force: true }` clicks the point anyway. Actions on an element that was removed or replaced
  fail with a pointer to `getAXState()` instead of changing the detached node.
- `waitForLoadState({ state: "networkidle" })` waits until the tab has had no request in flight for
  500 ms. `waitForEvent("download")` takes the next download the tab starts, or a tab it opened (such
  as a `target=_blank` link to an attachment): a download counts only when that tab reported it, either
  through the debugger (`Page.downloadWillBegin`) or because the extension held the tab's first
  document response (CDP `Fetch`) and saw a file. Two tabs downloading the same URL each get their own
  file, a download nothing ties to the tab is never handed out, and when another download of the same
  URL starts at the same moment the wait fails rather than guess.
- CSS locators reach into open shadow roots, as in Playwright.
- A page that stops responding (an endless script) makes the tool's own commands fail after 8 s with
  a message saying so, instead of hanging; reading whole pages, screenshots and the agent's own code
  in the page may take up to 30 s.
- The `management` capability organizes tabs but cannot navigate them; pages are opened and driven
  through tab objects.
- The first call of a new session connects within about 0.5 s. While no session runs, the offscreen
  document retries twice a second; the browser logs the refused connections on the extension's card
  under **Errors**, which is expected.
- `tab.setViewport()` overrides the viewport for responsive testing; `browser.capabilities.get("management")`
  organizes windows, tabs, tab groups and bookmarks; `tab.content` exports YouTube transcripts and
  Google Docs, Sheets and Slides to local files.
- Browsers block extensions from loading `data:` and internal (`brave://`, `chrome://`) URLs.
