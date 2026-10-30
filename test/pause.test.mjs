// The user's pause switch in the toolbar popup: agents are refused and detached until the user resumes.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hubClient, startEnvironment, startSite, until } from "./harness.mjs";

const GRACE_MS = 2_000;
let env;
let site;
let session;

before(async () => {
  env = await startEnvironment({ absentSessionGraceMs: GRACE_MS });
  site = await startSite({ "/": "<title>Page</title><button>Press</button>" });
  session = await env.session();
  // The session makes a call so that it runs the hub.
  await session.js("await cua.getState();");
});

after(async () => {
  await env?.close();
  await site?.close();
});

// Opens the extension's popup page as a tab and clicks its button, the way the user does.
async function clickPopupButton() {
  const { cdp } = env.browser;
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${env.browser.extensionId}/popup.html` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const read = async (expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  const before = await until(() => read("document.getElementById('status')?.textContent"), { message: "popup to render" });
  await read("document.getElementById('toggle').click()");
  const status = await until(
    async () => {
      const text = await read("document.getElementById('status').textContent");
      return text !== before && text;
    },
    { message: "popup status to change" },
  );
  await cdp.send("Target.closeTarget", { targetId });
  return status;
}

async function agentTabAttached(url) {
  const { targetInfos } = await env.browser.cdp.send("Target.getTargets");
  return targetInfos.find((target) => target.url === url)?.attached;
}

test("pausing refuses agent requests and detaches from tabs until resumed", async () => {
  const url = `${site.origin}/`;
  await session.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(url)});`);
  assert.equal(await agentTabAttached(url), true, "the agent's tab is attached while in use");

  assert.equal(await clickPopupButton(), "Agents are paused");
  await until(async () => (await agentTabAttached(url)) === false, { message: "the extension to detach from the agent's tab" });
  await assert.rejects(session.js("await tab.getAXState();"), /paused/);
  await assert.rejects(session.js(`await cua.createBrowserTab("1", ${JSON.stringify(`${url}?while-paused`)});`), /paused/);
  assert.ok(!(await env.browser.pages()).some((page) => page.url.includes("while-paused")), "no tab opens while paused");

  assert.equal(await clickPopupButton(), "Agents can use this browser");
  assert.match(await session.js("await tab.getAXState({ disableDiffing: true });"), /button Press/);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const present = async (url) => (await env.browser.pages()).some((page) => page.url === url);
const setPaused = (paused) => env.inPopup(`import("./pause.js").then((pause) => pause.setPaused(${paused}))`);

test("a session that ends while paused keeps its tabs until the user resumes", async (t) => {
  const client = await hubClient(env.port, env.stateDir);
  t.after(() => client.close());
  const url = `${site.origin}/?ended-while-paused`;
  await client.call("tabs.create", { url });
  await setPaused(true);
  t.after(() => setPaused(false));
  await client.call("session.end");
  await sleep(1_000);
  assert.equal(await present(url), true, "the tab stays open while paused");
  await setPaused(false);
  await until(async () => !(await present(url)), { message: "the ended session's tab to close after resume" });
});

test("pausing ends a download wait in progress", async (t) => {
  const client = await hubClient(env.port, env.stateDir);
  t.after(() => client.close());
  const tab = await client.call("tabs.create", { url: `${site.origin}/?download-wait` });
  // The outcome is caught at once, since the wait fails while the test is still pausing.
  const waiting = client.call("downloads.wait", { tabId: tab.id, timeoutMs: 10_000 }).then(
    () => null,
    (error) => error,
  );
  await sleep(500);
  await setPaused(true);
  t.after(() => setPaused(false));
  assert.match(String((await waiting)?.message), /paused/);
});

test("extension.reload is refused while paused", async (t) => {
  const client = await hubClient(env.port, env.stateDir);
  t.after(() => client.close());
  await setPaused(true);
  t.after(() => setPaused(false));
  await assert.rejects(client.call("extension.reload"), /paused/);
});

// Runs last: it kills the hub's session.
test("a session that vanishes from the live report while paused keeps its tabs until the user resumes", async (t) => {
  const url = `${site.origin}/?vanished-while-paused`;
  await session.js(`await cua.createBrowserTab("1", ${JSON.stringify(url)});`);
  const other = await env.session();
  await other.js("await cua.getState();");
  await setPaused(true);
  t.after(() => setPaused(false));
  // The other session becomes the hub and reports only itself.
  session.kill();
  await sleep(GRACE_MS + 5_000);
  assert.equal(await present(url), true, "the tab stays open while paused");
  await setPaused(false);
  await until(async () => !(await present(url)), { timeoutMs: GRACE_MS + 30_000, message: "the vanished session's tab to close after resume" });
});
