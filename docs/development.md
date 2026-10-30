# Development

## Layout

```text
native host ──private pipes──▶ extension (pairing secret)
MCP server (hub) ◀──WebSocket 127.0.0.1:47615──▶ extension ──chrome.debugger / chrome.tabs──▶ tabs
   ▲
   └── other MCP servers (one per agent session) connect to the hub as clients
```

- `browser/extension/`: MV3 extension, a thin executor. `offscreen.js` holds the WebSocket to the hub
  (an offscreen document is never suspended, so it reconnects within 0.5 s of a session starting) and
  passes requests to `service-worker.js`, which checks each request with `guard.js` (web pages only,
  no raw DevTools commands beyond the tab) and handles tab lifecycle, browser management, history and
  downloads. `cdp.js` relays DevTools Protocol commands through `chrome.debugger`, including the
  sessions of cross-origin frames, and tracks dialogs and console output. `sessions.js` keeps the tabs
  of all agent sessions in one tab group per window, tracks which session owns each tab and closes a
  session's unmarked tabs when it ends, or when the hub has not listed it among the live sessions for
  a while. `downloads.js` pairs downloads with the tabs that started
  them. `shared.js` is the one owner of what the extension and the MCP server must agree on (hub
  port, management method allow-list, which input counts as the agent's press and for how long,
  password manager element names, the unresponsive-page error, the extension code fingerprint that
  setup, doctor and the benchmark compare); it uses no browser or Node APIs beyond Web Crypto, so
  the MCP server imports it from the extension directory. `browser/package.json` marks the `.js`
  files as ES modules for Node; installed copies of `browser/` include it.
- `bench/`: benchmark against Claude in Chrome on local task pages (`tasks.mjs`) and public websites
  (`tasks-real.mjs`), with one grading rule (`grading.mjs`) and the conversation checks that decide
  whether the browser produced an answer (`transcript.mjs`); see `bench/README.md`.
- `installer/`: `install.mjs` (the installer), `Install.command` (its double-click entry point on macOS,
  which finds Node.js), `agent-instructions.md` (installation steps for an agent, shipped as the
  package's `AGENTS.md` with a `CLAUDE.md` that imports it), `clients.mjs` (the agent clients beyond
  Claude Code and Codex) and `package.mjs` (builds the zip package, with every other installer module).
- `browser/native-host/pairing.mjs`: one framed native request, retrieving or creating the private
  pairing secret through `secret.mjs`, which setup also calls. `installer/native-host.mjs` writes browser manifests and a launcher in the stable
  installed copy, using the same stable Node path as MCP registration. The extension manifest key
  pins `dcebpfjehgpkddgcdaipjemnndbdpmpc`, the ID used in `allowed_origins`. Native host manifests live outside versioned Homebrew paths.
- `browser/mcp/`: MCP stdio server, no dependencies.
  - `server.mjs`: the `js` and `js_reset` tools. It runs the REPL in a worker thread (`repl-worker.mjs`)
    and replaces the worker whenever a call times out or the worker crashes, so nothing the call left running (an endless
    loop, a timer, a pending request) can act on a page later; a command the call had already sent to
    the browser still completes. The browser connection stays in the main
    thread and survives the replacement; the worker reaches it through `browser-port.mjs`.
  - `repl.mjs`: the persistent REPL; `hoist.mjs`: turns top-level declarations of a cell into globals so
    they persist and can be redeclared.
  - `focus-guard.mjs`: gives the front back to the user's app when an agent action makes a page
    open a tab and the browser takes the front (see Behavior); a switch the user makes stands.
  - `browser-link.mjs`, `websocket.mjs`, `config.mjs`: hub election, authentication and transport. The
    first server to bind the port becomes the hub; the others connect to it. A hub that exits first lets
    in-flight requests finish, read-only requests interrupted by a handover are resent, and a new hub
    is elected right away by the servers whose sessions used the browser (by the others on their next
    call). The hub tells the extension which sessions are live.
  - `cua/`: the browser API. `index.mjs` (`cua` object, browser and management capability), `tab.mjs`
    (tab methods), `ax-tree.mjs` (accessibility snapshots across frames with stable element numbers and
    diffs), `aria-snapshot.mjs` (Playwright-style ARIA snapshot for `domSnapshot()`), `locator.mjs` and `page-scripts.mjs` (locators and in-page helpers), `elements.mjs` (pointer
    input), `keys.mjs` (xdotool-style key chords), `content.mjs` (YouTube transcript and Google
    Workspace exports), `docs.mjs` (documentation shown to the agent), `output.mjs`.
- `bin/bruse.mjs`: the `bruse` command; `installer/doctor.mjs` and `installer/uninstall.mjs` hold its
  `doctor` and `uninstall` commands, and `installer/lib.mjs` the paths and agent CLI handling they
  share with the installer.

## Working on the code

Run the MCP server from a checkout by registering `browser/mcp/server.mjs` with your agent instead of
the installed copy, and load `browser/extension` unpacked. After editing extension files, reload the
extension on the extensions page, or let it reload itself:

```sh
node --input-type=module -e 'import { callBrowser } from "./browser/mcp/browser-link.mjs"; await callBrowser("extension.reload"); process.exit(0)'
```

MCP server changes take effect in new agent sessions. `node scripts/check.mjs` runs the checks CI
runs: every module parses, the versions agree, and the MCP server starts and lists its tools. `node installer/package.mjs` builds the zip
package in `dist/`.

The release version is the `version` of `browser/extension/manifest.json`; `package.json` carries the
same value.

## Tests

`npm test` runs the unit tests and the end-to-end tests, with at most four files at once so browser startup does not saturate the host. The end-to-end tests load a copy of the
extension into headless Chrome for Testing and drive it through MCP sessions, the way an agent does.
Each test file uses its own hub port, state directory, native host manifest and browser profile, so the tests never reach an
installed Bruse or the browser it is connected to. They look for Chromium in Playwright's cache
(`npx playwright install chromium`) or take its executable from `BRUSE_TEST_CHROME`. `test/harness.mjs`
starts the browser, sessions and local test sites, and `hubClient()` connects to the hub as a peer MCP
server does, to send requests to the extension directly. `test/fixtures/password-manager` is an
extension that shows a menu frame the way password managers do.

Brave ignores `--user-data-dir` when it looks for native hosts (on macOS it reads
`Google/Chrome/NativeMessagingHosts`), so tests that pair through the host fail under `BRUSE_TEST_CHROME`
set to Brave. Run them in Chrome for Testing.

## Benchmarks

`bench/` compares Bruse with Claude in Chrome on local task pages; see [bench/README.md](../bench/README.md).

## Releasing

1. Move the `Unreleased` entries of `CHANGELOG.md` under a `## X.Y.Z` heading, set `X.Y.Z` as the
   `version` in `browser/extension/manifest.json` and `package.json`, and commit.
2. Once `ci` passed for that commit on `main`, tag it `vX.Y.Z` and push the tag.

`.github/workflows/release.yml` then checks the commit, builds and smoke-tests the zip package on
macOS, creates the GitHub release with the changelog section as notes, and renders
`packaging/homebrew/bruse.rb.tmpl` into `Formula/bruse.rb` of the owner's `homebrew-tap`. The tap
step needs a `HOMEBREW_TAP_TOKEN` secret, with write access to the tap, in the repository's
`release` environment; without it the step is skipped. Running the workflow by hand
(`workflow_dispatch`) builds and checks everything without publishing.

## Pairing compatibility

Only HMAC proofs travel on the extension WebSocket. The native host reuses `extension-secret`, so
paired older extensions and older hubs retain their handshake. Unpaired older extensions cannot pair
with a newer hub and must be updated. A saved extension secret remains a fallback when setup has not
yet installed the native host. Reinstalls obtain the host's secret without reset approval. The legacy
`pair` message, reset approval command and pairing-offer error codes are removed. Setup creates the
secret before it reloads the extension, because a still-running 0.18 hub stores a `pair` secret from any
local process while no secret file exists.

Setup registers hosts for the five supported browsers and Chrome for Testing, including ones installed
later. A directory that cannot be written gets a line in the output; setup fails when none could be
written or the written hosts would not start. On macOS these
live under `~/Library/Application Support/<browser>/NativeMessagingHosts`; on Linux under the browser's
XDG config directory. Uninstall moves manifests belonging to this installation to the Trash once the
installation itself has moved. Doctor
checks manifests, allowed origins, the launcher, Node executable and host module; repair with `bruse setup`.

Adding `nativeMessaging` and reloading an existing unpacked extension stayed enabled in Chrome for
Testing 153.0.8010.12 and in Brave 156 on macOS. The pairing tests cover this update path. Other browser builds may
require enabling the extension again. Chrome's general permission-update warning rules are documented
[here](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings).
The [Chromium security FAQ](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md)
explains why an unpacked extension's key is not proof of publisher identity.

## Inspector compatibility

V8 commit [205922abe6](https://chromium.googlesource.com/v8/v8/+/205922abe6)
uses isolate ID zero for untrusted inspector sessions. It is present in
[V8 15.8](https://chromium.googlesource.com/v8/v8/+/refs/branch-heads/15.8/src/inspector/injected-script.cc)
but absent from the inspected
[15.7 branch head](https://chromium.googlesource.com/v8/v8/+/refs/branch-heads/15.7/src/inspector/injected-script.cc).
Chrome's [8127 branch DEPS](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/8127/DEPS)
pins V8 b17064889ef49a632dd09bead566cf50887886bf, whose session implementation includes this change;
[chrome/VERSION](https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/8127/chrome/VERSION)
identifies it as milestone 158.
[Chromiumdash's milestone 158 schedule](https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=158)
queried on 2026-10-30 gives early stable 2026-11-04 and stable 2026-11-17. These are scheduled dates,
not confirmation of a completed rollout; backports to other milestones were not established.

Chrome for Testing 158.0.8127.2 on macOS reports zero-isolate handles through `chrome.debugger`.
The content-world test holds a receiver command after validation, navigates across processes, then
releases it and checks that its old unique context fails. See SECURITY.md for the raw handle API limits.

### Verification on 2026-10-30

- macOS: two runs of actions, isolation, native pairing, sessions and downloads passed 42/42 each.
  One full suite passed 103/103 after bounding file concurrency; a later loaded repeat passed 91/103,
  with initial extension-connection failures and subsequent dependent assertions. The gate script passed.
- Chrome for Testing 158.0.8127.2: actions, content-world and smoke passed 18/18; the final content-world
  regressions passed 7/7, including zero-isolate handles and the queued cross-process receiver command.
- Linux arm64, disposable Playwright v1.64.1 container, Chrome for Testing 156.0.8078.4: the six affected
  files passed 49/49 once. Repeated runs exposed the creation/end test ordering assumption and a
  cross-origin click that sometimes had no effect. Waiting for the effect did not repair the click;
  the cause remains unresolved. Popup ownership and blank-attachment checks passed in these runs.
- A shared tab was closed by an agent's evaluated `window.close()`; the API ownership guards and
  Browser/Target refusals passed. This script-closure limitation is documented in SECURITY.md.
- Installed Chrome 156.0.8078.74 loaded the extension in a temporary profile, but isolated native-host
  probes did not establish an end-to-end connection. Edge and Vivaldi were absent from both Applications
  folders. Their native discovery and connection remain unverified; the user's Brave was not used.
- The saved-pairing test checks the reloaded build rather than accepting a pre-reload connection.
  Window tests wait for chrome.tabs, and creation/end tests accept either ordering while checking cleanup.
  The original saved-pairing failure and the intermittent popup/download reports were not reproduced
  independently. File-concurrency limits do not guarantee passing tests on an overloaded host.

### Cross-origin input investigation on 2026-10-30

The actions file was repeated ten times in the Linux arm64 Playwright v1.64.1 container with Chrome
for Testing 156.0.8078.4, two files at a time alongside four bounded CPU workers. Three repetitions
failed only the cross-origin click assertion. Temporary capture listeners recorded pointerdown,
pointerup and click on the parent document's iframe element at (65.64, 253.5), with no pointer events
in the child. The child button's center mapped to that point: its rectangle was (8, 29, 95.28, 21),
inside an iframe whose content started at (10, 214). This establishes incorrect input routing despite
successful DOM hit tests, rather than a delayed button effect. Stale compositor routing is the inferred
browser mechanism; compositor internals were not instrumented.

Element-targeted cross-origin clicks probe delivery with trusted mouse movement before pressing.
Only moves are retried, with fresh geometry and hit tests each time; failure to reach the document
throws without pressing. The same path serves locator and numbered clicks, including forced clicks.
Ten repetitions with the fix passed all 100 tests under the same container load. The existing
cross-origin test also checks that both click styles increment a counter exactly once.

Ten macOS cold-start probes with sixteen bounded CPU workers all authenticated successfully, taking
435 to 981 ms from the first MCP browser call. The locally selected Chrome for Testing was
153.0.8010.12. A separate ten-file actions repetition had six failing files: five initial 30-second
cell timeouts and one later Runtime timeout, followed by dependent assertions. Its sixteen CPU
workers expired after four minutes, so later repetitions did not retain the same artificial load.
These are not reproductions of the reported initial extension-connection error. Reconnect backoff,
challenge handling and native-host startup remain unproven causes; no authentication changes were made.
The post-fix loaded macOS full suite passed 94/103 with no skipped tests. Its nine failures were in
orphan cleanup, password-manager handling, debugger reattachment, pause, replacement and sessions;
the reported errors were cell or Runtime timeouts and dependent assertions, with no initial
extension-connection error. The gate script passed. Those timeouts remain unresolved, so this is
not a clean full-suite verification.
