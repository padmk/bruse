// A session whose server is killed, even the hub's, never sends session.end. Once a hub reports the
// live sessions and the dead one stays absent for the grace period (shortened here), the extension ends
// it like any other session; without a hub it leaves the tabs alone.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hubClient, startEnvironment, startSite, until } from "./harness.mjs";
import { ignore } from "../browser/extension/shared.js";

const GRACE_MS = 3_000;
let env, site;
before(async () => {
  env = await startEnvironment({ absentSessionGraceMs: GRACE_MS });
  site = await startSite({ "/page": "<title>Page</title>" });
});
after(async () => {
  await env?.close();
  await site?.close();
});
const url = (path) => site.origin + path;
const present = async (u) => (await env.browser.pages()).some((page) => page.url === u);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An extension reload in the middle of a session's end stops it before it closed the tabs; they go back
// to the session, which is absent now, so they close after the grace period.
test("tabs a session's end was closing when the extension reloaded close afterwards", async (t) => {
  const hub = await env.session();
  t.after(() => hub.close());
  await hub.js("await cua.getState();");
  const client = await hubClient(env.port, env.stateDir);
  const u = url("/page?closing-at-reload");
  const tab = await client.call("tabs.create", { url: u });
  // Holds the answer to the end's write that takes the tab from the session, once it is stored.
  const hold = await env.holdCall("chrome.storage.local.set", `args[0].agentState && !args[0].agentState.tabs[${tab.id}] && stack.includes("endSessionNow")`, { answered: true });
  // After the reload the worker that held the call is gone, and so is the hold.
  let reloaded = false;
  t.after(() => reloaded || hold.release().catch(ignore("cleanup: a release the test made already fails")));
  client.call("session.end").catch(ignore("the reload ends the request"));
  await hold.held();
  client.close();
  const reloader = await hubClient(env.port, env.stateDir);
  reloader.call("extension.reload").catch(ignore("the extension may reload before it answers"));
  reloader.close();
  reloaded = true;
  await until(async () => !(await present(u)), { timeoutMs: GRACE_MS + 30_000, message: "the tab of the interrupted end to close" });
});

// The same for a tab that the browser opened after its session ended, which the extension closes at once.
test("a tab of an ended session that was closing when the extension reloaded closes afterwards", async (t) => {
  const hub = await env.session();
  t.after(() => hub.close());
  await hub.js("await cua.getState();");
  const client = await hubClient(env.port, env.stateDir);
  const u = url("/page?late-closing-at-reload");
  // Holds the browser's answer to the tab's creation until the session has ended.
  const create = await env.holdCall("chrome.tabs.create", "true", { answered: true });
  t.after(() => create.release().catch(ignore("cleanup: a release the test made already fails")));
  client.call("tabs.create", { url: u }).catch(ignore("the session ends while the tab opens"));
  await create.held();
  await client.call("session.end");
  client.close();
  // Holds the close of the tab, which the extension starts once it hears of the tab.
  const remove = await env.holdCall("chrome.tabs.remove", "true");
  let reloaded = false;
  t.after(() => reloaded || remove.release().catch(ignore("cleanup: a release the test made already fails")));
  await create.release();
  await remove.held();
  const reloader = await hubClient(env.port, env.stateDir);
  reloader.call("extension.reload").catch(ignore("the extension may reload before it answers"));
  reloader.close();
  reloaded = true;
  await until(async () => !(await present(u)), { timeoutMs: GRACE_MS + 30_000, message: "the tab of the ended session to close" });
});

let client;
const clientPage = () => url("/page?client");

test("tabs of a killed hub's session close once the next hub reports it gone", async () => {
  const hub = await env.session();
  const dropped = url("/page?dropped"),
    kept = url("/page?kept");
  await hub.js(`const a = await cua.createBrowserTab('1', ${JSON.stringify(dropped)}); const b = await cua.createBrowserTab('1', ${JSON.stringify(kept)}); await b.markDeliverable();`);
  client = await env.session();
  await client.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(clientPage())});`);
  hub.kill();
  // The client makes no call: it becomes the hub on its own and reports only itself.
  await until(async () => !(await present(dropped)), { timeoutMs: GRACE_MS + 30_000, message: "the killed session's tab to close" });
  assert.equal(await present(kept), true, "a marked tab stays");
  // A live session's tab outlasts the grace period.
  await sleep(GRACE_MS + 1_000);
  assert.equal(await present(clientPage()), true);
  assert.equal(await present(kept), true);
});

test("without a hub, the tabs of killed sessions stay", async () => {
  client.kill();
  await sleep(GRACE_MS * 2 + 1_000);
  assert.equal(await present(clientPage()), true);
});
