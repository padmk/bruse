# Changelog

## Unreleased

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
