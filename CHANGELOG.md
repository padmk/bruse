# Changelog

## Unreleased

- **Smaller page state:** image source URLs are left out of the accessibility tree, and tooltips are cut to 80 characters and left out when they only repeat the page a link leads to. The first state of Wikipedia's main page is about 10 % shorter, a GitHub folder about 27 %.
- **Replaced elements:** an action on an element number whose element a page script has replaced since the snapshot (Wikipedia's search field becomes a combo box after load) acts on the element that took its place, when the page has not navigated and exactly one element in the same frame has the same name and role. Agents had got a stale-element error and spent extra calls on a new state; a Wikipedia search took 7 to 8 turns instead of 4.
- **Clicks wait for the page they open:** a click or key press that starts a navigation (a link, a form submission) returns once the new page has loaded, as in Playwright, and a state read right after an action no longer shows the new page half parsed. Agents had read a page with only its banner after submitting a filter and then spent a separate call on every read.
- **Date fields:** `setValue()` on the day, month or year of a date input sets the whole field, and a value the field rejects fails with the format it takes (such as `2026-11-03`) instead of leaving the field empty.
- **Fewer calls:** the tool description makes `createBrowserTab("1", url)` the first call when the agent opens a page, which also returns the documentation; agents had spent a call on `getState()` first. The documentation shows how to check many elements in a loop within one call.
- **Install docs:** the README leads with `brew install padmk/tap/bruse`, and `bruse help` and the Homebrew notes name all the agent clients setup registers with.

## 0.17.0

- **New look:** a new icon, and the toolbar popup shows the extension's state with a status dot and one clear button.
- **Chrome Web Store:** the MCP server accepts the extension from the Chrome Web Store as well as an unpacked copy; setup and doctor let the store update its copy instead of asking to reload it. `node scripts/store-package.mjs` builds the store package.
- **Privacy policy:** `PRIVACY.md` describes what the extension accesses, where it goes and what is stored.
- **`bruse` command:** `bruse setup` installs or updates the extension files and the MCP server, registers the server with Claude Code and Codex and waits for the extension; `bruse doctor` checks the installation, the registrations, pairing and the browser connection and says what to run for each problem; `bruse uninstall` removes what setup added; `bruse version` prints the version.
- **Setup reports failures:** setup exits with an error when an agent CLI rejects the registration, and after reloading a connected extension it waits until the extension reconnects with the new version, so an extension loaded from another folder or turned off is reported instead of a false success.
- **More agent clients:** setup registers the MCP server with Cursor, VS Code (and Insiders), GitHub Copilot CLI, Gemini CLI, Claude Desktop, Devin Desktop and Windsurf, besides Claude Code and Codex; `bruse doctor` checks those registrations and `bruse uninstall` removes them. JSON configurations keep every other setting, are backed up first, and are left alone when they contain comments.
- **Pause switch:** the Bruse icon in the toolbar opens a switch that pauses agents: the extension detaches from every tab and refuses agent requests until the user resumes. Cancelling the browser's debugging bar pauses too, and `bruse doctor` reports a paused browser.
- **Hub checks the host name:** WebSocket upgrades must address `127.0.0.1` or `localhost`, so a page using DNS rebinding cannot reach the hub even before the token and origin checks.
- **Tests:** `npm test` runs unit tests and end-to-end tests that load the extension into headless Chromium and check pairing and authentication, session cleanup, page actions, locators, frames, dialogs, downloads and the `bruse` command cycle; CI runs them on every push.
- **One folder:** the installed copy and the pairing state live in `~/.local/share/bruse` (or `$XDG_DATA_HOME/bruse`) on macOS and Linux alike, instead of `~/Library/Application Support/Bruse` and `~/.local/state/browser-control`.
- **Versions:** the MCP server reports the release version, the extension reports its version, and an agent is told once when the two differ (for example after an update before `bruse setup`).
- **Fixed, pairing:** after reinstalling the extension, removing `extension-secret` lets it pair again. Before, the new extension kept a secret the hub had refused and could not pair until it was reinstalled once more.
- **Fixed, hub:** a malformed authentication message (a MAC with non-ASCII characters) no longer ends the hub process; the connection is refused.
- **Fixed, exports:** YouTube transcripts and Google Workspace exports go to a directory only the user can read, and a second export with the same name no longer replaces the first.
- **Fixed, REPL:** a declaration on the line after `count++` or `count--` persists to later cells.
- **Fixed, keys:** `ControlOrMeta` in locator `press` and `click` is Control outside macOS, and `tab.pressKey` accepts it too.
- **Fixed, downloads:** a `target=_blank` link to an attachment that the server answers at once counts for the waiting tab again (the new tab closed before its opener was looked up), and a tab the agent creates right after a page opened one no longer holds back its downloads.
- **Fixed, selected tab:** `browser.tabs.selected()` returns the active tab of the window the user used last, not the active tab of whichever window comes first.
- **Release zip:** it includes SECURITY.md and CHANGELOG.md, and README links to files it leaves out point to the repository.
- **Fixed, MCP:** a JSON line that is not an object (such as `null`) is ignored instead of ending the server.
