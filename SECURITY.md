# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/padmk/bruse/security) of `padmk/bruse` and choose **Report a vulnerability** ([GitHub's guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)). Please do not open a public issue, pull request or discussion for a vulnerability.

Include the version (`bruse version`, or the version on the extension's card), the browser and operating system, what an attacker can do and the steps to reproduce it. Fixes are released as a new version with a GitHub security advisory, which credits the reporter unless they ask otherwise.

## Supported versions

Only the latest release receives security fixes. After updating, run `bruse setup` so that the installed copy, the registered MCP server and the extension in the browser all run the new version.

## Scope

Bruse gives the agents you run full control of your browser: the code an agent sends to the `js` tool runs as your user, with Node.js privileges, and drives your signed-in tabs. An agent or program that already runs as your user is therefore outside the threat model. In scope, for example:

- driving the browser, reading tabs or receiving browser events without the hub token, from web pages (cross-origin or DNS-rebinding requests to `127.0.0.1:47615`) or from other accounts on the same computer;
- a process posing as the hub or as the extension getting requests executed, or taking over an authenticated connection, once the extension has paired;
- a process of another account that listens on the hub port (for example after the hub exited) receiving the hub token or an MCP server's requests, or answering them;
- the hub crashing or misbehaving on input from an unauthenticated connection;
- pairing state, hub token or exported files readable by other accounts;
- an agent session seeing the title or address of, reading, driving, closing or moving a tab that it did not open and the user did not share (in the default "agent tabs" mode), including through the management capability, frame sessions or events, or by naming another session;
- in that mode, an agent session seeing a window or tab group that holds none of its tabs and no shared tab; changing, focusing or closing a window that holds a tab it did not open (shared tabs included), moving tabs into such a window or into a group it cannot fully reach, or making a tab active in such a window;
- a debugger staying attached to a tab after the user stopped sharing it;
- an agent opening the browser's internal pages or the extension's own pages (agents get web, data, file and blob pages, `about:blank` and `about:srcdoc`), or running JavaScript through raw DevTools commands anywhere but in the page's own contexts, such as in the isolated world of this or another extension's content script;
- web pages or content scripts reading or changing the extension's storage (its access setting, shares and pairing secret), which only the extension's pages and service worker may use, or getting the extension to execute hub requests through its runtime messages;
- tabs the user did not give the agent (not opened by its session and not shared or bound with `getTab`) being closed or changed by session cleanup;
- the release artifacts, the installer and the Homebrew formula.

Tab isolation limits what an agent does through Bruse's browser API. It is not a sandbox: code in the `js` tool runs as your user, so an agent that sets out to get around it (for example by reading the hub token) is outside the threat model, like any program of yours.

No independent security audit of Bruse has been published.

Pairing uses native messaging. Setup registers a host whose `allowed_origins` contains only the ID
pinned by the extension's manifest key. The browser starts the host over pipes; it reads or creates the
user's private `extension-secret`, which the extension uses for mutual HMAC authentication. Setup
creates the file too, so a hub of an older version that is still running does not accept a secret
offered on its port. No secret
is accepted or sent over the hub port. A process of another account that takes the port first cannot
obtain the secret or have browser requests executed. Existing secrets remain valid across upgrades.

The host allow-list is not proof of publisher identity: another unpacked extension can copy a public
manifest key, and programs running as the user can invoke the host directly or read the secret. These
are outside the threat model above. Native messaging does not protect a compromised user account.
Older extensions without an existing pairing must be updated; port-based first pairing and reset
approval are removed. See [Security in the README](README.md#security-and-privacy).

## Shared tabs and page scripts

The tab and management APIs refuse to close or discard a shared tab, and raw `Page.close` and
`Page.crash` require ownership. Browser and Target domain commands are refused altogether.
Reloading and navigating shared tabs are allowed. Page JavaScript can call `window.close()` when
Chromium permits it, including code evaluated by an agent or triggered through page input. Sharing
allows that JavaScript, so it does not guarantee that the tab stays open. Replacing `window.close`
in the page would not enforce such a guarantee across frames and navigations.

## Inspector object handles

Runtime receiver calls are sent with the tracked unique page context, with the receiver passed as an
argument. A command queued across a renderer change therefore cannot resolve its receiver in a new
extension world whose numeric context ID happens to match. For zero-isolate handles, Runtime commands
without a unique context selector are refused. An explicit command contract table converts node
handles for DOM, Accessibility and Overlay commands that accept backend node IDs through a pinned
Runtime call. `DOM.requestNode` uses the same conversion followed by a frontend node lookup. Other
zero-isolate handle consumers are refused, including `DOM.getFileInfo`: it requires a File object,
which cannot be converted to a backend node ID. Bruse's upload and download features do not use it.
Conversion checks for open dialogs before running JavaScript and reports dialogs opened during the
pinned call through the same race as other commands. Locators enumerate nodes through pinned deep
serialization rather than `Runtime.getProperties`.

Receiver calls preserve implicit object-group inheritance by remembering groups of handles in protocol
replies, scoped to their session and unique context. This uses local metadata rather than an extra
protocol round trip; entries end with their object, group, context or session. The receiver wrapper
uses `Reflect.apply` without a named receiver binding or the callable's own `apply` property. An arrow
function declaration can still see the wrapper's `arguments`; removing that limit would require eval
or an additional protocol call.
