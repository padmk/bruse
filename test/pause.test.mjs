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

test("a session ended for its absence while paused that reconnects before the resume keeps its tabs", async (t) => {
  const url = `${site.origin}/?absent-then-back`;
  const first = await hubClient(env.port, env.stateDir);
  await first.call("tabs.create", { url });
  await setPaused(true);
  t.after(() => setPaused(false));
  first.close();
  // The end for its absence lands in the moment the pause starts (the extension read the pause state
  // just before); this records it the way that end does.
  await env.inPopup(`chrome.storage.local.get("agentState").then(({ agentState }) => chrome.storage.local.set({
    agentState: { ...agentState, pausedEnds: [...(agentState.pausedEnds ?? []), ${JSON.stringify(first.sessionId)}], absentEnds: [${JSON.stringify(first.sessionId)}] },
  }))`);
  const back = await hubClient(env.port, env.stateDir, { sessionId: first.sessionId });
  t.after(() => back.close());
  await sleep(1_000);
  await setPaused(false);
  await sleep(1_500);
  assert.equal(await present(url), true, "the reconnected session's tab stays open after resume");
});

// Holds the extension's first read of its agent state for ending a session (endSessionNow) until
// `release()`, so that the user and the hub can act while the extension ends a session.
async function holdSessionEnd() {
  const { cdp, extensionId } = env.browser;
  const { targetInfos } = await cdp.send("Target.getTargets");
  const worker = targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const evaluate = async (expression) => (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  await evaluate(`(() => {
    const original = chrome.storage.local.get;
    const held = (globalThis.heldEnd = { original, calls: 0, release: null });
    chrome.storage.local.get = async function (keys) {
      if (held.calls || keys !== "agentState" || !new Error().stack.includes("endSessionNow")) return original.call(this, keys);
      held.calls++;
      await new Promise((resolve) => (held.release = resolve));
      return original.call(this, keys);
    };
  })()`);
  return {
    held: () => until(() => evaluate("globalThis.heldEnd.calls > 0"), { timeoutMs: GRACE_MS + 15_000, message: "a session end to start" }),
    async release() {
      await evaluate("chrome.storage.local.get = globalThis.heldEnd.original; globalThis.heldEnd.release()");
      await cdp.send("Target.detachFromTarget", { sessionId });
    },
  };
}

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

// Kills the hub's session; the session it starts is the hub afterwards.
let nextHub;
test("a session that vanishes from the live report while paused keeps its tabs until the user resumes", async (t) => {
  const url = `${site.origin}/?vanished-while-paused`;
  await session.js(`await cua.createBrowserTab("1", ${JSON.stringify(url)});`);
  const other = (nextHub = await env.session());
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

// Runs last: it kills the hub.
test("a session that reconnects while its end for its absence is under way and the user pauses keeps its tabs", async (t) => {
  const url = `${site.origin}/?absent-pause-back`;
  const first = await hubClient(env.port, env.stateDir);
  await first.call("tabs.create", { url });
  const next = await env.session();
  await next.js("await cua.getState();");
  const hold = await holdSessionEnd();
  t.after(() => hold.release().catch(() => {}));
  // The next session becomes the hub and reports only itself, so the first one is absent.
  nextHub.kill();
  // The grace period passes while agents run, so the extension starts ending the session.
  await hold.held();
  await setPaused(true);
  t.after(() => setPaused(false));
  const back = await hubClient(env.port, env.stateDir, { sessionId: first.sessionId });
  t.after(() => back.close());
  await sleep(1_000);
  await hold.release();
  await sleep(1_000);
  await setPaused(false);
  await sleep(1_500);
  assert.equal(await present(url), true, "the reconnected session's tab stays open after resume");
});
