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
- tabs the user did not give the agent (not opened by its session and not bound with `getTab`) being closed or changed by session cleanup;
- the release artifacts, the installer and the Homebrew formula.

Pairing trusts the first connection by design: an extension without a pairing secret gives its new secret to whatever listens on the port, and a hub without `extension-secret` accepts the first extension that pairs. See [Security in the README](README.md#security-and-privacy).
