// Agents open web pages and about:blank, never the browser's internal pages, and a tab they may not use
// reveals nothing about its page.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hubClient, startEnvironment, until } from "./harness.mjs";

let env, client;
before(async () => {
  env = await startEnvironment();
  // A session's first call starts the hub, which the client below joins.
  const session = await env.session();
  await session.js("await cua.getState();");
  client = await hubClient(env.port, env.stateDir);
  await until(() => client.call("browser.info").catch(() => null), { message: "the extension to connect" });
});
after(async () => {
  client?.close();
  await env?.close();
});

test("about: addresses other than about:blank and about:srcdoc are refused", async () => {
  const refused = /only about:blank and about:srcdoc/;
  await assert.rejects(client.call("tabs.create", { url: "about:settings" }), refused);
  const { id: tabId } = await client.call("tabs.create", { url: "about:blank" });
  await assert.rejects(client.call("tabs.navigate", { tabId, url: "about:settings" }), refused);
  await assert.rejects(client.call("cdp", { tabId, method: "Page.navigate", params: { url: "about:version" } }), refused);
  await client.call("tabs.navigate", { tabId, url: "about:blank" });
  assert.equal((await client.call("cdp", { tabId, method: "Runtime.evaluate", params: { expression: "location.href", returnByValue: true } })).result.value, "about:blank");
});

test("a method the extension does not take is refused, also one every object inherits", async () => {
  for (const method of ["notAMethod", "constructor", "toString", "hasOwnProperty", "__proto__"]) {
    await assert.rejects(client.call(method, {}), { message: `Unknown method ${method}` }, method);
  }
  for (const namespace of ["constructor", "__proto__"]) {
    await assert.rejects(client.call("browser.manage", { namespace, method: "toString" }), { message: `${namespace}.toString is not available` }, namespace);
  }
});

test("a tab the session may not use gives the same error whatever its page", async () => {
  await env.browser.cdp.send("Target.createTarget", { url: "chrome://version/" });
  const tab = await until(() => env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url.startsWith("chrome://version")) ?? null)`), { message: "the user's tab" });
  for (const method of ["page.state", "tabs.get", "cdp"]) {
    await assert.rejects(client.call(method, { tabId: tab.id, method: "Runtime.evaluate", params: { expression: "1" } }), (error) => {
      assert.match(error.message, /not one of this session's tabs/);
      assert.doesNotMatch(error.message, /chrome:/);
      return true;
    });
  }
});

test("raw Network and Page commands pass only by name", async () => {
  const { id: tabId } = await client.call("tabs.create", { url: "about:blank" });
  const refused = /does not let agents send/;
  // Cookie store, cache, next-page scripts, download folder, focus, isolated worlds, loads outside the page,
  // and a command the list does not name.
  for (const method of ["Network.getCookies", "Network.getAllCookies", "Network.setCookie", "Network.clearBrowserCache", "Network.loadNetworkResource", "Page.addScriptToEvaluateOnNewDocument", "Page.setDownloadBehavior", "Page.bringToFront", "Page.createIsolatedWorld", "Page.notAMethod"]) {
    await assert.rejects(client.call("cdp", { tabId, method, params: {} }), refused, method);
  }
  // Commands the browser API sends through the same path keep working.
  for (const method of ["Network.enable", "Page.enable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.captureScreenshot", "Page.setInterceptFileChooserDialog"]) {
    await client.call("cdp", { tabId, method, params: method === "Page.setInterceptFileChooserDialog" ? { enabled: false } : {} });
  }
  // A domain that is listed whole still passes, a domain that is not stays refused.
  assert.equal((await client.call("cdp", { tabId, method: "Runtime.evaluate", params: { expression: "1 + 1", returnByValue: true } })).result.value, 2);
  await assert.rejects(client.call("cdp", { tabId, method: "Storage.getCookies", params: {} }), refused);
  await client.call("tabs.close", { tabId }).catch(() => {});
});
