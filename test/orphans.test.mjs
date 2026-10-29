// A session whose server is killed, even the hub's, never sends session.end. Once a hub reports the
// live sessions and the dead one stays absent for the grace period (shortened here), the extension ends
// it like any other session; without a hub it leaves the tabs alone.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startEnvironment, startSite, until } from "./harness.mjs";

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
