# Privacy policy

Bruse is a browser extension and a local program (an MCP server) that let AI agents you run on your own
computer read and operate your browser tabs. This policy covers the Bruse extension and the Bruse MCP
server. Last updated: October 28, 2026.

## What Bruse collects

Nothing. Bruse has no servers, accounts, analytics or telemetry, and its developer receives no data
from it.

## What the extension accesses, and where it goes

When an agent you run asks for it, the extension reads and operates tabs: the pages' content and
accessibility tree, screenshots, console messages and network requests of tabs the agent works in,
and, only when the agent asks for them, the files a tab downloads and your browsing history and
bookmarks (these two only after you turn them on in the extension's popup). By default those are only
the tabs the agent opened and the tabs you share with it in the popup; of your other tabs, an agent
learns only how many there are. If you let agents use all tabs (under Access in the popup), they also
see the list of your tabs and can work in any of them.

That information goes to one place: the Bruse MCP server on the same computer, over a connection to
`127.0.0.1` that only that server can answer (the two authenticate each other). The server passes it to
the agent that asked for it. The agent is a program you chose, such as Claude Code or Codex, and sends
what it reads to the AI model provider you use with it, under that provider's terms. Bruse itself sends
nothing anywhere else; code the agent chooses to run in Bruse's JavaScript tool runs on your computer with
your permissions and can reach the network.

## What is stored

- In the extension's storage: a pairing secret, which agent session owns which tab, and whether you
  paused agents.
- On your computer, in `~/.local/share/bruse`: the installed program, the pairing secret and the
  token that local agent sessions use.
- Exports an agent makes (for example a YouTube transcript): in a private temporary folder
  (`browser-control-exports-…` in the system's temporary directory), which the operating system may clear.

None of it is sent anywhere by Bruse. Removing the extension and running `bruse uninstall` deletes the
first two; delete exports you no longer need yourself.

## Your control

Click the Bruse icon in the toolbar and choose **Pause agents** (or **Cancel** on the browser's
"started debugging" bar) to stop all agent access at once until you resume.

## Limited Use

The use of information received from the browser's extension APIs adheres to the Chrome Web Store User
Data Policy, including the Limited Use requirements: the data is used only to provide Bruse's single
purpose, letting your own agents operate your browser, and is never sold, used for advertising or
creditworthiness, or read by people.

## Contact

Questions about this policy: open an issue at <https://github.com/padmk/bruse/issues>. Security
reports: see [SECURITY.md](SECURITY.md).
