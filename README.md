# Bruse

<img src="browser/extension/icons/icon-128.png" width="96" alt="Bruse icon" align="right">

**Bruse** (browser use, with a nod to Bruce Lee) gives local AI agents fast, background control of your
real browser, independent of any vendor's runtime.

An MCP server gives the agent (Claude Code, Codex or another MCP client) a persistent JavaScript REPL
with a `cua` object that reads and operates your Chromium browser's tabs in the background, without
taking focus or moving the cursor. The API follows the shape of Codex's browser computer use: numbered
accessibility trees with diffs, input by element number, Playwright-style locators, dialogs, uploads
and downloads. It works in the tabs where you are already signed in, and nothing is written into the
browser's or the system's configuration.

In [the benchmark against Claude in Chrome](bench/README.md), the same model finished each task 56 to
87 % faster and 26 to 88 % cheaper with Bruse.

## Requirements

- macOS (Linux works too, but is tested less), with Node.js 22 or newer
- A Chromium browser: Brave, Chrome, Edge, Chromium or Vivaldi
- An MCP client; setup registers the server with Claude Code and Codex when their CLIs are installed

## Install

From a checkout of this repository:

```sh
node bin/bruse.mjs setup
```

Or download a release zip, unpack it and double-click **Install Bruse.command**. You can also open an
agent in the unpacked folder and ask it to install Bruse; the package's `AGENTS.md` tells it how.

Setup:

- copies the extension and the MCP server to `~/Library/Application Support/Bruse/browser`
  (`~/.local/share/bruse/browser` on Linux), replacing a previous version;
- registers the MCP server as `bruse` with Claude Code (user scope) and Codex, whichever is installed;
- when the extension is not connected yet, shows its folder in Finder and opens the browser's
  extensions page (the first time, macOS asks to let the terminal control the browser);
- waits until the extension connects, which also pairs it (see [Security and privacy](#security-and-privacy)),
  or reloads an extension that is already connected and waits until it runs the new version.

The one manual step, on first install only: on the extensions page turn on **Developer mode** and drag
the `extension` folder onto the page (or choose **Load unpacked**). Chromium browsers install other
extensions only from the Chrome Web Store, so this step remains until the extension is published there.

A zip downloaded from the internet is quarantined: macOS refuses to open the unsigned
`Install Bruse.command` until you allow it in System Settings › Privacy & Security (**Open Anyway**).

Start a new agent session afterwards: MCP servers load when a session starts.

## Commands

| Command | What it does |
| --- | --- |
| `bruse setup` | Install or update, register the MCP server and wait for the extension |
| `bruse doctor` | Check Node.js, the installed copy, the registrations, pairing and the browser connection |
| `bruse uninstall` | Remove the registrations, the installed copy and the pairing state |
| `bruse version` | Print the version |

From a checkout, run them as `node bin/bruse.mjs <command>`. To update, run `bruse setup` again with
the new version; it reloads the extension in the browser. To uninstall, run `bruse uninstall` and
remove the extension on the browser's extensions page.

## Usage

Ask the agent to do something in your browser. Its first call to the `js` tool returns the API
documentation; a session then looks like this:

```js
await cua.getState();                                             // browsers and tabs
const tab = await cua.createBrowserTab("1", "https://example.org"); // background tab, shows its tree
await tab.click(7); await tab.typeText(12, "query"); await tab.pressKey(null, "Return");
await tab.getAXState();                                            // only what changed
await tab.playwright.getByRole("button", { name: "Save" }).click();
await tab.getScreenshot();
```

The full API is in [browser/mcp/cua/docs.mjs](browser/mcp/cua/docs.mjs).

## Security and privacy

- **The agent gets your browser.** Code sent to the `js` tool runs as your user with Node.js
  privileges and acts in your signed-in tabs. The agent is told to confirm irreversible or
  outward-facing steps with you, but that is an instruction to the model, not a guarantee.
- **Page content goes to your model provider.** What the agent reads from a tab (accessibility trees,
  screenshots, page text) is returned to the agent and so reaches the provider of the model it runs on.
  Bruse itself sends nothing anywhere: the server and the extension talk only over `127.0.0.1`.
- **One browser.** The hub talks to one paired extension, in one browser profile, at a time.
- **Who can drive it.** The hub accepts peer MCP servers only with the token in
  `~/.local/state/browser-control/hub-token` (mode 0600), so web pages and other users cannot drive it.
  Hub and extension authenticate each other: on first connection the extension pairs by sending a
  random secret, which the hub stores in `~/.local/state/browser-control/extension-secret` (0600);
  every later connection proves that secret in both directions with HMAC over fresh nonces. The
  extension executes requests only on an authenticated connection, so a process posing as the hub on
  the port gets nothing, and one posing as the extension cannot replace it.
- **Pairing trusts the first connection.** While the extension has no secret (on first install or
  after a reinstall) it offers its new secret to whatever listens on the port, and while the hub has
  no `extension-secret` it accepts the first extension that pairs. Pair while the hub is your own
  session. After reinstalling the extension, move `extension-secret` to the Trash so that the new
  extension can pair; it connects again within a second.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Behavior

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

## Development

The code layout, working on the code and the benchmarks are in [docs/development.md](docs/development.md).
Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
