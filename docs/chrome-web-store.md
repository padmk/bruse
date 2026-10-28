# Chrome Web Store listing

What to enter in the Chrome Web Store Developer Dashboard for Bruse. The package is built with
`node scripts/store-package.mjs` (it leaves out the manifest `key`, which the store rejects).

## Store listing

- **Name:** Bruse (from the manifest)
- **Summary** (from the manifest description, at most 132 characters): Browser use for local AI agents:
  reads and operates your tabs in the background.
- **Category:** Developer Tools
- **Language:** English
- **Description:**

  > Bruse lets the AI agents you run on your own computer (Claude Code, Codex, Cursor, VS Code, Gemini
  > CLI and other MCP clients) use your real browser: the tabs where you are already signed in.
  >
  > Agents work in background tabs, in their own tab group, without taking focus or moving your cursor.
  > They read pages through numbered accessibility trees and screenshots, click and type by element
  > number or with Playwright-style locators, handle dialogs, uploads and downloads, and reach into
  > cross-origin frames. When an agent session ends, its tabs close, except the ones it marked for you.
  >
  > Bruse itself sends nothing anywhere. The extension talks only to the Bruse program on 127.0.0.1,
  > and the two authenticate each other, so web pages and other programs cannot drive your browser.
  > There are no servers, accounts or analytics. What your agent reads from a page goes to the agent,
  > and from there to the AI model provider you use with it. Click the Bruse icon and choose Pause
  > agents to stop all agent access at once.
  >
  > Bruse needs its free companion program: install it with Homebrew (`brew install padmk/tap/bruse`)
  > and run `bruse setup`, which registers it with your agents. Source code and documentation:
  > https://github.com/padmk/bruse

- **Icon:** `browser/extension/icons/icon-128.png`
- **Screenshots:** `docs/store/screenshot-1.png` to `screenshot-3.png` (1280x800).
- **Small promo tile:** `docs/store/promo-tile-440x280.png`.
- **Homepage URL:** https://github.com/padmk/bruse
- **Support URL:** https://github.com/padmk/bruse/issues

## Privacy practices

- **Single purpose:** Let the user's own AI agents, running on the same computer, read and operate the
  user's browser tabs in the background.
- **Permission justifications:**
  - `debugger`: Reads pages (accessibility tree, screenshots) and sends the agent's clicks and key
    presses to them through the Chrome DevTools Protocol, which is how the agent operates tabs.
  - Host permission `<all_urls>`: The agent works on whatever site the user asks it to; also needed to
    remove password manager frames that block debugger access to a page.
  - `scripting`: Removes another extension's injected frames (password manager menus) that make the
    browser refuse debugger access to a page.
  - `tabs`, `tabGroups`: Lists tabs, opens the agent's tabs in the background and keeps them in their
    own tab group.
  - `webNavigation`: Tells which tab a page opened, so new tabs and downloads go to the right agent
    session.
  - `downloads`: Reports the file a tab downloaded to the agent that started the download.
  - `history`: Lets the agent find a page the user visited, when the user asks for it.
  - `bookmarks`: Lets the agent organize bookmarks, when the user asks for it.
  - `storage`: Stores the pairing secret, which session owns which tab, and whether the user paused
    agents.
  - `offscreen`: Keeps the connection to the local Bruse program open (a service worker would be
    suspended).
  - `alarms`: Recreates that connection document if the browser closed it, and detaches the debugger
    from idle tabs.
- **Remote code:** No, I am not using remote code. All of the extension's logic is in the package. It
  carries out Chrome DevTools Protocol commands that the local Bruse program sends, through the
  `chrome.debugger` API.
- **Data usage:** Website content, Web history and User activity are handled, only to provide the
  single purpose, and are passed only to the Bruse program on the same computer. Certify: not sold to
  third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness
  or lending.
- **Privacy policy URL:** https://github.com/padmk/bruse/blob/main/PRIVACY.md (the repository must be
  public by then).

## Distribution

- Free, all regions, public visibility.
