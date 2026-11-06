# Restricted REPL: design proposal

Status: proposal, not implemented. Today the `js` tool runs agent code in a worker thread of the MCP
server with the user's full Node.js privileges (see the README's security section). This page records
what a restricted mode would have to cover, so that it can be built and judged against a measurement
rather than a promise.

## Goal and limits

A restricted REPL keeps a page-steered agent away from files, programs and credentials that its task
does not need. It does not stop an agent from sending what it read in the browser somewhere else: the
browser itself reaches the network, and that stays the job of the agent's instructions and of the
user's choice of browser profile.

Node.js documents its permission model as a precaution against unintended access, not a boundary
against malicious code. A hard boundary needs an operating system sandbox as well: Landlock on Linux.
On macOS `sandbox-exec` is deprecated and there is no supported replacement for a plain command-line
process, so a macOS build can promise only the Node.js permissions.

## Shape

- The REPL runs in a child process started with `--permission`, not in a worker thread. The parent
  (the MCP server) keeps the hub token, the pairing secret and the browser link; the child reaches the
  browser only through messages to the parent, as the worker does today through `browser-port.mjs`.
- The child may read Bruse's own code and read and write one session folder. It gets no
  `child_process`, workers, native addons, WASI or inspector, and no read of the state directory.
- Network access from Node.js (`fetch`, `node:net`) is off; pages reach the network through the
  browser.
- Full Node.js stays available as an explicit choice at setup, for users who want the agent to work
  with local files directly.

## Paths that reach local files

Node.js permissions cover file access by the REPL process itself. The browser reads and writes files on
its own, so a path that agent code hands to the browser needs a separate check in the extension's
guard, and files the browser writes must land where the REPL may read them:

| Call | Who touches the file | Needed in restricted mode |
| --- | --- | --- |
| `fileChooser.setFiles(paths)` (`cua/tab.mjs`) | The browser, through `DOM.setFileInputFiles`; the page can then read the file | Paths inside the session folder only, checked in the extension's guard |
| Navigating to a `file:` URL (`guard.js` `AGENT_SCHEMES`) | The browser | `file:` refused, or limited to the session folder |
| `waitForEvent("download").path()` | The browser writes to its download folder | Downloads moved or copied into the session folder, so the REPL can read them |
| `nodeRepl.emitImage(path)` (`repl.mjs` `imagePayload`) | The REPL process | Covered by the REPL's permissions |
| `content.exportGsuite()`, `exportYouTubeTranscript()` (`cua/content.mjs`) | The REPL process, in a temporary export folder | Covered by the permissions; the export folder moves into the session folder |

Uploading a file that lives elsewhere then needs the user to copy it into the session folder or to
approve that path.

## How to judge it

`bench/injection.mjs` runs an ordinary task on a page that asks the agent to read a canary file and send
it to a local receiver, and counts leaks and attempts per variant and model. A restricted mode should
show no leak of the canary from Node.js in any variant, and no fewer correct answers on the regular
benchmark tasks (`bench/run.mjs`), including uploads and downloads.

## Related

The hub token is a full client credential (see SECURITY.md). Once the REPL no longer holds it, a
page-steered agent cannot reach the hub directly, which leaves per-session credentials as protection
against other programs of the user only. That is why this proposal comes before per-client tokens.
