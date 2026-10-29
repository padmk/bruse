# Bruse

<img src="browser/extension/icons/icon-128.png" width="96" alt="Bruse icon" align="right">

**Bruse** (browser use) gives local AI agents fast, background control of your
real browser, independent of any vendor's runtime.

An MCP server gives the agent (Claude Code, Codex or another MCP client) a persistent JavaScript REPL
with a `cua` object that reads and operates your Chromium browser's tabs in the background, without
taking focus or moving the cursor. The API follows the shape of Codex's browser computer use: numbered
accessibility trees with diffs, input by element number, Playwright-style locators, dialogs, uploads
and downloads. Its tabs open in your browser profile, where you are already signed in; by default an
agent uses only the tabs it opens and the tabs you share with it. Nothing is written into the browser's
or the system's configuration.

Bruse is one browser tool for every MCP client you use, including ones without a browser tool of their
own, and it works in background tabs of your everyday browser profile. An agent can batch many steps
into one call, which saves turns. If your client's own browser tool already does what you need, a
second tool may not add much.

On six read and interaction tasks on public websites (Wikipedia, GitHub, the Python documentation, a
paginated shop and a single-page app), measured on 2026-10-29 with the same model and prompts, Bruse's
median run took 48 to 68 % less time and 38 to 74 % less money than Claude in Chrome, with all 96 runs
of both tools passing. That is one computer, one browser (Brave), one model and eight runs per task,
on the code before the last fixes to replaced elements and tab shares, which were not measured again;
see [the benchmark](bench/README.md) for the method, every run and what the numbers do not cover.

## Requirements

- macOS (Linux works too, but is tested less), with Node.js 22 or newer
- A Chromium browser: Brave, Chrome, Edge, Chromium or Vivaldi
- An MCP client; setup registers the server with the supported ones you pick (see [Install](#install))
- A browser that allows extensions loaded in Developer mode and their `debugger` permission. A browser
  your organization manages may block either by policy; then an administrator has to allow the
  extension.

## Install

With Homebrew (macOS or Linux):

```sh
brew install padmk/tap/bruse
bruse setup
```

Or download a release zip, unpack it and double-click **Install Bruse.command**. You can also open an
agent in the unpacked folder and ask it to install Bruse; the package's `AGENTS.md` tells it how. From
a checkout of this repository, run `node bin/bruse.mjs setup`.

Setup:

- copies the extension and the MCP server to `~/.local/share/bruse/browser`, replacing a previous
  version (`~/.local/share/bruse` holds everything Bruse keeps, the pairing state included). When the
  new copy cannot take the place of the previous one, setup puts the previous one back and stops; if
  that fails too, it keeps it next to the installed path and prints the command that restores it;
- on a first install, says what agents can reach through Bruse (your user account's permissions and
  the accounts signed in to your browser profile) and links to [SECURITY.md](SECURITY.md);
- lists the agent clients it finds (Claude Code, Codex, Cursor, VS Code and Insiders, GitHub Copilot CLI,
  Gemini CLI, Claude Desktop, Devin Desktop, Windsurf) and registers the MCP server as `bruse` with the
  ones you pick; Enter picks all of them. `bruse setup --clients claude-code,codex` picks without
  asking. Run without a terminal (by an agent or a script) and without `--clients`, setup updates the
  clients that already have the server and, on a first install, stops and lists the clients to choose
  from. It uses the client's own `mcp add` command where there is one; otherwise it edits the client's
  JSON configuration, keeping everything else, after a backup to `~/.local/share/bruse/backups`, and
  leaves a file with comments untouched and reports it;
- when the extension is not connected yet, shows its folder in Finder and opens the browser's
  extensions page (the first time, macOS asks to let the terminal control the browser);
- waits until the extension connects, which also pairs it (see [Security and privacy](#security-and-privacy)),
  or reloads an extension that is already connected and waits until it runs the new version.

The one manual step, on first install only: on the extensions page turn on **Developer mode** and drag
the `extension` folder onto the page (or choose **Load unpacked**). Chromium browsers let no installer
add an extension that is not from the Chrome Web Store, so this step stays manual. Later updates need
no manual step: `bruse setup` reloads the extension.

A zip downloaded from the internet is quarantined: macOS refuses to open the unsigned
`Install Bruse.command` until you allow it in System Settings › Privacy & Security (**Open Anyway**).

Start a new agent session afterwards: MCP servers load when a session starts.

Bruse does not update itself. To update, get the new version (`brew upgrade bruse`, or a newer zip or
checkout) and run `bruse setup`, which replaces the installed copy and reloads the extension; `bruse
doctor` tells you when the browser still runs older extension code.

## Commands

| Command | What it does |
| --- | --- |
| `bruse setup` | Install or update, register the MCP server with the clients you pick and wait for the extension |
| `bruse setup --clients claude-code,codex` | The same, with the named clients and without asking (names as `bruse doctor` shows them) |
| `bruse doctor` | Check Node.js, the installed copy, the registrations, pairing and the browser connection |
| `bruse uninstall` | Remove the registrations, the installed copy and the pairing state |
| `bruse version` | Print the version |

From a checkout or the unpacked zip, run them as `node bin/bruse.mjs <command>`. To update, run `bruse setup` again with
the new version; it reloads the extension in the browser. Agent sessions started before the update
keep working; while one of them holds the hub, setup and newer sessions say that the versions differ,
and restarting the older sessions fixes it. To uninstall, run `bruse uninstall`, remove the extension on the
browser's extensions page and, after a Homebrew install, run `brew uninstall bruse`. Agent sessions
started before the uninstall keep the removed server until they end.

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

- **The agent gets your browser and runs code on your computer.** Code sent to the `js` tool runs as
  your user with Node.js privileges: it can read and write your files, use the network and start
  programs, also when the agent client has its own shell turned off. It acts in your signed-in tabs,
  and page content may try to steer the agent. The agent is told to confirm irreversible or
  outward-facing steps with you, but that is an instruction to the model, not a guarantee. Tabs the
  agent opens are in your browser profile, where you are signed in, so a page can still steer the agent
  within the sites it visits. To keep agents away from your accounts altogether, install the extension
  in a separate browser profile without important sign-ins.
- **You can stop it at any moment.** Click the Bruse icon in the toolbar and **Pause agents** (or
  **Cancel** on the browser's "started debugging" bar): the extension detaches from every tab at once
  and refuses agent requests until you resume. Agent tabs stay open, so you can look at what was done.
- **Page content goes to your model provider.** What the agent reads from a tab (accessibility trees,
  screenshots, page text) is returned to the agent and so reaches the provider of the model it runs on.
  The server and the extension themselves talk only over `127.0.0.1`; code the agent runs in the `js`
  tool can still reach the network.
- **One browser.** The hub talks to one paired extension, in one browser profile, at a time.
- **Agents use their own tabs and the tabs you share.** By default an agent session sees and uses
  only the tabs it opened (and tabs their pages opened from its input), plus the tabs you share: click
  the Bruse icon on a tab and **Share this tab**; **Stop** ends the share and detaches the debugger at
  once, and an agent waiting for a download from the tab does not get the file. The extension checks
  every request against this, using the session the hub says the request comes from, not one the
  request names:
  - Your other tabs, and the tabs of other agent sessions, are hidden: agents do not see their titles
    or addresses (only how many there are), and cannot read, drive, close or move them.
  - Agent tabs open in the background in your window, in the collapsed grey "Bruse" tab group. A window
    counts as the agent's only when every tab in it is the agent's or shared. Agents do not see
    windows and tab groups without a tab of theirs or a shared tab. They cannot resize, focus or close
    your windows, move tabs into them or into groups holding tabs they cannot use, or make a tab the
    active one in them, so they do not switch the tab you are looking at.
  - Tabs an agent opens through the browser's management functions (a new window, a duplicated tab)
    are its own, like the tabs it opens directly, and close when its session ends.

  Under **Access** in the popup you can let agents use all tabs instead. Shares end when the browser
  restarts. A shared tab is shared with every agent session, not with one, and nothing locks it to one
  agent: actions of several agents on the same shared tab can interleave.
- **Tab isolation is not account isolation, and not a sandbox.** An agent can still open any site in a
  tab of its own, in your profile, where you are signed in; only a separate browser profile keeps your
  accounts out of reach. Isolation limits what an agent does through Bruse's browser API; code in the
  `js` tool runs as your user and could read the hub token like any program of yours, so it does not
  stop an agent that sets out to get around it.
- **Why there is no list of allowed sites.** Such a list would keep an agent that a page steered, or
  that simply erred, out of signed-in sites the task never needed. A first version, with a confirmation
  the agent could click itself, was dropped. Enforced on every navigation of agent tabs, a list would
  hold better now that agents cannot open the extension's pages and raw DevTools commands are limited,
  but it would still not stop an agent from sending what it read elsewhere, and every task would need
  its sign-in redirects, payment pages and other domains allowed, a list users would widen until it
  limits little. A browser profile without important sign-ins protects those accounts fully and needs no
  list, so that is the recommendation; a list stays an option if users ask for one.
- **Why `fetch` stays in the REPL, and confirmations stay instructions.** Turning off `fetch` would not
  stop the network, since Node.js modules and processes reach it too; a real limit means running the
  REPL as a separate process with restricted permissions, which would also cut off the files that
  uploads, downloads and exports use. Technical confirmations cannot tell an irreversible click from any
  other at the input level and would interrupt every step, so the agent is instructed to confirm such
  steps with you instead.
- **Pages, not the browser.** The extension lets agents open and drive web pages (and data and file
  pages, `about:blank` and `about:srcdoc`), not the browser's internal pages or the extension's own
  pages, where the pause switch and the access settings are; other `about:` addresses, which the browser
  turns into its internal pages, are refused. The extension's storage is open only to its own pages
  and service worker, not to scripts it runs in web pages. Raw DevTools commands are limited to the
  domains that act on the page in the tab (`Accessibility`, `Animation`, `CSS`, `DOM`, `DOMSnapshot`,
  `Emulation`, `Input`, `Log`, `Network`, `Overlay`, `Page`, `Performance`, `Runtime`), without the
  cookie and cache commands and `Page.addScriptToEvaluateOnNewDocument`, and run JavaScript only in the
  page's own contexts, never in the isolated worlds where extensions' content scripts run. A frame's
  session works only with the tab it belongs to.
- **Who can drive it.** The hub accepts peer MCP servers only when they prove that they read the token
  in `~/.local/share/bruse/state/hub-token` (mode 0600), so web pages and other users cannot drive it.
  The proof works in both directions, with HMAC keyed with the token over fresh nonces, and the token
  itself is never sent: a server sends no request until the hub has proved the token too, so a process
  of another user that takes the port after the hub exits gets neither the token nor any request.
  Until a connection has authenticated, the hub takes only small messages from it, closes it when it
  leaves the hub's replies unread, and keeps only a few such connections at a time. Hub and extension authenticate each other: on first connection the extension pairs by sending a
  random secret, which the hub stores in `~/.local/share/bruse/state/extension-secret` (0600);
  every later connection proves that secret in both directions with HMAC over fresh nonces. The
  extension executes requests only on an authenticated connection, so a process posing as the hub on
  the port gets nothing, and one posing as the extension cannot replace it.
- **Pairing trusts the first connection.** While the extension has no secret (on first install or after
  a reinstall) it offers its new secret to whatever listens on the port, and while the hub has no
  `extension-secret` it accepts the first extension that pairs. A program already running on the
  computer, also of another user, could take either side in that moment: as the hub it would drive agent
  tabs in your profile, as the extension it would receive agent requests and could answer them with
  made-up pages. `bruse setup` checks that a hub that knows the token holds the port before you load the
  extension, and stops otherwise; the remaining window is a program that pairs as the extension while
  setup waits, or an extension loaded without setup while no hub runs. Pairing through the browser's
  native messaging would close it; it is the intended fix and not built into a release yet. After
  reinstalling the extension, move `extension-secret` to the Trash so that the new extension can pair;
  it connects again within a second.

- **No independent audit yet.** No external security audit of Bruse has been published. The changes
  are reviewed by models and covered by end-to-end tests, which do not replace one.
- **Nothing third-party.** The server and the extension use only Node.js built-ins and browser APIs:
  no npm dependencies, no code downloaded at run time, no telemetry. The extension's only network connection is the
  WebSocket to `127.0.0.1`; requests to websites are made by the pages themselves, for example when
  exporting a Google Doc the agent was asked to export.

The extension asks for these permissions:

| Permission | Used for |
| --- | --- |
| `debugger` | Reading pages and sending input to them (Chrome DevTools Protocol); the browser shows its "started debugging" bar while attached |
| `<all_urls>` (host) | Debugging and reading tabs on any site, and removing password manager menus that block debugging |
| `scripting` | Removing those password manager menus from a page's frames |
| `tabs`, `tabGroups` | Listing tabs, opening agent tabs in the background and grouping them |
| `webNavigation` | Telling which tab a page opened, so new tabs and downloads go to the right session |
| `downloads` | Reporting the files a tab downloaded |
| `history`, `bookmarks` (optional) | `browser.history()` and bookmarks in the `management` capability; off until you turn them on under **Access** in the popup, and the browser asks you to confirm |
| `storage` | The pairing secret and which session owns which tab |
| `offscreen`, `alarms` | Keeping the connection to the local hub open |

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Behavior

- Agent tabs open without focus in the window's grey "Bruse" tab group, which all agent sessions share and
  which starts collapsed, so that many sessions' tabs take one chip in the tab strip;
  the extension remembers which session owns each tab, also across extension reloads. When a session
  ends, its unmarked tabs close, including tabs its pages opened in response to the agent's input: the
  page reported the opening (`Page.windowOpen`) right after the agent's input, and the browser
  reported the new tab with its opener (`webNavigation.onCreatedNavigationTarget`), so tool results
  name the exact new tab. Tabs the user opens from an agent page, for example from its context menu,
  stay the user's. `markDeliverable()` and `markHandoff()` keep a tab, which then leaves the group.
  Tabs bound with `getTab` stay untouched, and other tabs in the group, such as ones the user moves
  there, leave it once no live session has a tab in it.
- A session also ends when its MCP server is gone without ending it (killed, also while it was the
  hub). The hub tells the extension which sessions are live, its own and those of the servers connected
  to it, and the other servers reconnect at once when their hub goes away; a session that owns tabs and
  stays off that list for 45 s ends as above, so its marked tabs stay. While no hub runs, no tab is
  closed.
- Agent work keeps the user's app in front. Brave brings its window forward when a page opens a tab
  or window (`target=_blank`, `window.open`); tabs opened by agent pages become background tabs in
  the agent group, popup windows included, and on macOS `focus-guard.mjs` returns the front to the
  app that had it before the agent's input (Brave may show for a fraction of a second).
- Password manager menus are frames of another extension, which make the browser cut off debugger
  access. Fields the agent clicks or focuses get the opt-out attributes password managers honor, and
  password manager buttons and live regions are left out of the accessibility tree. When such a frame
  still blocks a command or a state read, it is removed (only the frame, or a known password manager's
  wrapper, also inside shadow roots), the debugger attaches again and the call is retried, up to three
  times; a call that still fails says what was removed and what came back. A command for a cross-origin
  frame goes to the frame's new debugger session after such a reattach.
- The `js` tool is loaded up front (`_meta["anthropic/alwaysLoad"]`), so Claude Code does not spend a
  turn on tool search before the first browser call. A call returns at most 30,000 characters of text,
  cut at a line end with a note on reading the rest from the REPL; Claude Code would otherwise move a
  result over 25,000 tokens (a busy page's first tree) to a file outside the agent's view.
- A click or key press that starts a navigation returns once the new page has loaded. State reads
  after an action wait until the DOM has had no mutations for 60 ms (at most 1 s from the action)
  instead of a fixed delay.
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
  the element has `pointer-events: none`). `{ force: true }` clicks the point anyway. An action on an element that a page script replaced
  since the read (Wikipedia's search field becomes a combo box) goes to the element that took its
  place only when that one is new to the page and the only one of its name and role in that document,
  and the old one was the only one in its read. Otherwise an action on a removed element fails with a
  pointer to `getAXState()` instead of changing the detached node or another element of the same name.
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
- Agent tabs are kept from being discarded when the browser frees memory, since a discarded tab loses
  its page and what the agent typed. A tab that is discarded anyway (one the user shares, or by hand)
  fails page calls with a message to reload it.
- Without a connected extension, every browser call waits 8 s and fails, and agents are told to stop
  and tell the user rather than reach the pages another way; `bruse doctor` shows what is missing.
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
