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
