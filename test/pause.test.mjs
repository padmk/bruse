// The user's pause switch in the toolbar popup: agents are refused and detached until the user resumes.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startEnvironment, startSite, until } from "./harness.mjs";

let env;
let site;
let session;

before(async () => {
  env = await startEnvironment();
  site = await startSite({ "/": "<title>Page</title><button>Press</button>" });
  session = await env.session();
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
