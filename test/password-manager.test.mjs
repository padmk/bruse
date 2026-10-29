// Another extension's frame in a page (a password manager menu) makes the browser refuse debugger access
// to the tab. fixtures/password-manager shows such a menu the way 1Password does; the extension removes
// it and attaches again, for state reads and frame commands alike.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hubClient, lastJson, startEnvironment, startSite } from "./harness.mjs";

const fixture = fileURLToPath(new URL("./fixtures/password-manager", import.meta.url));
let env, site, frameSite, session;
const json = async (code) => lastJson(await session.js(`nodeRepl.write(JSON.stringify(await (${code})));`));
const menuCount = "tab.playwright.evaluate(() => document.querySelector('#shadow-host').shadowRoot.querySelectorAll('com-1password-menu').length)";

before(async () => {
  frameSite = await startSite({ "/": "<title>Frame</title><button>Frame button</button>" }, "localhost");
  site = await startSite({
    "/": `<!doctype html><title>Login</title><button>Page button</button>
    <div id="shadow-host"><template shadowrootmode="open"><label>Password <input type="password"></label></template></div>
    <iframe src="${frameSite.origin}/"></iframe>`,
  });
  env = await startEnvironment();
  await env.browser.cdp.send("Extensions.loadUnpacked", { path: fixture });
  session = await env.session();
});
after(async () => {
  await env?.close();
  await site?.close();
  await frameSite?.close();
});

test("a password manager menu present at load does not block reading the page", async () => {
  // The first state read attaches the debugger, which the menu's frame blocks.
  const tree = await session.js(`var tab = await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/#menu`)});`);
  assert.match(tree, /button Page button/);
  assert.match(tree, /Frame button/, "the page's own cross-origin frame stays");
  assert.equal(await json(menuCount), 0);
  assert.equal(await json("tab.playwright.evaluate(() => document.querySelectorAll('iframe').length)"), 1);
});

test("a menu that keeps coming back fails with what removal did", async () => {
  // Only the frame of an unknown wrapper may go, and this wrapper puts it back each time.
  await assert.rejects(
    session.js(`await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/#unknown-menu`)});`),
    /blocks debugger access to this tab, and removing such frames did not restore it after 3 attempts \(\d+ elements removed; [1-9]\d* of another extension's frames back in the page afterwards\)/,
  );
});

test("a frame command after the debugger attached anew goes to the frame's new session", async () => {
  const client = await hubClient(env.port, env.stateDir);
  try {
    // The client works in a tab of its own session.
    const { id: tabId } = await client.call("tabs.create", { url: `${site.origin}/` });
    const before = await client.call("page.state", { tabId });
    const frame = before.frames.find((f) => f.url.startsWith(frameSite.origin));
    assert.ok(frame, JSON.stringify(before.frames));
    // The menu appears while the debugger is attached; the next command meets it.
    await client.call("cdp", { tabId, method: "Runtime.evaluate", params: { expression: "postMessage('show-menu', '*')" } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { result } = await client.call("cdp", { tabId, sessionId: frame.sessionId, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
    assert.equal(result.value, "Frame");
    const after = await client.call("page.state", { tabId });
    assert.notEqual(after.frames.find((f) => f.frameId === frame.frameId)?.sessionId, frame.sessionId, "the debugger attached anew");
    const menus = await client.call("cdp", { tabId, method: "Runtime.evaluate", params: { expression: "document.querySelector('#shadow-host').shadowRoot.querySelectorAll('com-1password-menu').length", returnByValue: true } });
    assert.equal(menus.result.value, 0);
  } finally {
    client.close();
  }
});
