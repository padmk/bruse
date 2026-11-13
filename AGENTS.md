# Working on Bruse

Bruse is an MCP stdio server (`browser/mcp/`) and a Manifest V3 extension (`browser/extension/`) that let agents drive the user's Chromium browser in background tabs, plus an installer (`installer/`, `bin/bruse.mjs`). Plain Node.js modules and browser APIs: no npm dependencies, no build step. The layout, the hub and pairing design and how to run a checkout are in [docs/development.md](docs/development.md); read it before changing the server, the extension or the installer.

This file is for agents changing the code. To install Bruse for a user, follow [installer/agent-instructions.md](installer/agent-instructions.md) instead; the zip package ships that file as its own `AGENTS.md`.

## Commands

```sh
npm ci                        # the development tools: TypeScript, ESLint and type packages (nothing the product loads)
node scripts/check.mjs        # what the CI checks job runs: every module parses, versions agree, the server lists its tools, types check, lint passes
npx tsc -p browser/extension  # one TypeScript project; each tsconfig.json is one, check.mjs runs them all
npx eslint browser/mcp        # lint part of the tree
git config core.hooksPath .githooks   # run check.mjs before each commit in this checkout
npm test                      # unit and end-to-end tests in headless Chrome for Testing, four files at a time
npx playwright install chromium   # the browser the tests find in Playwright's cache; or set BRUSE_TEST_CHROME
node --test test/<file>.test.mjs  # one test file
node installer/package.mjs    # the zip package in dist/
```

CI (`.github/workflows/ci.yml`, Linux, Node.js 26) runs `node scripts/check.mjs` and `npm test` on pushes to main and pull requests. The release workflow builds and smoke-tests the zip on macOS from a `v*` tag; the steps are in [docs/development.md](docs/development.md#releasing).

## Constraints

- Never test against the user's browser or installed Bruse: the tests start their own Chrome for Testing, hub port, state directory and native host manifest. Do not run `bruse setup` or `bruse uninstall` on the owner's machine to try a change; a checkout's server is registered by hand, as described in [Working on the code](docs/development.md#working-on-the-code).
- Keep the server and the extension free of npm dependencies and code loaded at run time; [SECURITY.md](SECURITY.md) and the README promise it. `devDependencies` hold only the type checker, the linter and type packages, installed at exact versions at least a day old (`.npmrc`), and nothing of them may be imported at run time or copied into the package.
- Types are JSDoc in the `.js` and `.mjs` files, checked by `tsc` (`checkJs`); there is no build step. `browser/extension` is checked with `strict`, the rest of the tree with `strictNullChecks` for now (see [Type checking and lint](docs/development.md#type-checking-and-lint)). Do not silence the checker with `any`, casts or `@ts-` comments, or the linter with disable comments; fix the type or the code.
- A promise nobody awaits ends in `.catch(ignore("why it does not matter"))` or `.catch(logFailure("what failed"))` from `browser/extension/shared.js`; ESLint refuses empty rejection and error handlers and empty `catch` blocks (a comment inside that gives the reason is enough).
- The requests the extension takes are listed once, in `PROTOCOL` in `browser/extension/shared.js`, with what each acts on and how it is checked, and their parameter and result types in `Protocol`. The service worker's handlers, the guard and the server's resend rule read it; a request without an entry or a handler is a type error.
- `browser/extension/shared.js` is the one owner of what the server and the extension must agree on (hub port, the request protocol table, management allow-list, password manager names, the code fingerprint). It may use no browser or Node APIs beyond Web Crypto, since the server imports it from the extension directory.
- The extension enforces tab isolation and the raw DevTools limits in `guard.js` and `access.js`, using the session the hub names. A change to what agents can reach must keep [SECURITY.md](SECURITY.md) and the README's security section true.
- The manifest `key` pins the extension ID `dcebpfjehgpkddgcdaipjemnndbdpmpc`, which the native host manifests allow; do not change it. Old paired extensions and hubs must keep working; see [Pairing compatibility](docs/development.md#pairing-compatibility).
- The release version is the `version` in `browser/extension/manifest.json`, and `package.json` carries the same value; `scripts/check.mjs` fails when they differ.
- `browser/mcp/cua/docs.mjs` is the API documentation agents get on their first call; keep it in step with the API. Agent-facing rules (safety, workflow) live there and in the tool description in `browser/mcp/server.mjs`.
- Changes to the extension reach a loaded copy only after a reload, and server changes only new agent sessions.
- User-visible changes get an entry in `CHANGELOG.md`; update the README, SECURITY.md, PRIVACY.md, `installer/agent-instructions.md` and `docs/development.md` where a change affects what they say.
