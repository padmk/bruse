// Removing another extension's frame runs the extension's own script in the page, in an isolated world
// that has chrome.storage and chrome.runtime. Agents' raw DevTools commands must not reach that world or
// other extensions' content script worlds, and the world itself must not reach the extension's storage
// or get hub requests executed.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { hubClient, startEnvironment, startSite, until } from "./harness.mjs";

const fixture = fileURLToPath(new URL("./fixtures/password-manager", import.meta.url));
let env, site, frameSite, session, client, extensionId;

before(async () => {
  frameSite = await startSite({ "/": "<title>Frame</title>" }, "localhost");
  site = await startSite({
    "/": `<!doctype html><title>Login</title>
    <div id="shadow-host"><template shadowrootmode="open"><label>Password <input type="password"></label></template></div>
    <iframe src="${frameSite.origin}/"></iframe>`,
  });
  env = await startEnvironment();
  await env.browser.cdp.send("Extensions.loadUnpacked", { path: fixture });
  // A session's first call starts the hub, which the client below joins.
  session = await env.session();
  await session.js("await cua.getState();");
  client = await hubClient(env.port, env.stateDir);
  ({ id: extensionId } = await client.call("browser.info"));
});
after(async () => {
  client?.close();
  await env?.close();
  await site?.close();
  await frameSite?.close();
});

// An agent tab with the extension's own script world in it, as removing another extension's frame makes.
async function tabWithExtensionWorld() {
  const { id: tabId } = await client.call("tabs.create", { url: `${site.origin}/#plain` });
  await client.call("page.state", { tabId });
  await env.inPopup(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => true })`);
  return tabId;
}

// Runs `func` (a function's source) as this extension's content script in the tab and returns its result.
function inExtensionWorld(tabId, func) {
  return env.inPopup(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: ${func} }).then(([injection]) => injection.result)`);
}

// The execution contexts of the tab's main frame as the browser reports them to a client of its own.
async function contextsOf(url) {
  const { targetInfos } = await env.browser.cdp.send("Target.getTargets");
  const { targetId } = targetInfos.find((target) => target.type === "page" && target.url === url);
  const { sessionId } = await env.browser.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const contexts = [];
  env.browser.cdp.on((message) => {
    if (message.sessionId === sessionId && message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
  });
  await env.browser.cdp.send("Runtime.enable", {}, sessionId);
  await env.browser.cdp.send("Target.detachFromTarget", { sessionId });
  return contexts;
}

test("raw commands do not reach the extension's script world in a page", async () => {
  // The menu at load makes the extension remove it with its own script in the page.
  const { id: tabId } = await client.call("tabs.create", { url: `${site.origin}/#menu` });
  await client.call("page.state", { tabId });
  const reached = [];
  for (let contextId = 1; contextId <= 60; contextId++) {
    const reply = await client
      .call("cdp", { tabId, method: "Runtime.evaluate", params: { contextId, expression: "globalThis.chrome?.runtime?.id ?? null", returnByValue: true } })
      .catch(() => null);
    if (reply?.result?.value) reached.push(`${contextId}:${reply.result.value === extensionId ? "this extension" : reply.result.value}`);
  }
  assert.deepEqual(reached, [], "no context of an extension answered");
});

test("raw commands that name a context run only in the page's own contexts", async () => {
  const tabId = await tabWithExtensionWorld();
  const contexts = await contextsOf(`${site.origin}/#plain`);
  const world = contexts.find((context) => context.origin === `chrome-extension://${extensionId}`);
  const page = contexts.find((context) => context.auxData?.isDefault && context.auxData?.frameId && context.origin === site.origin);
  assert.ok(world && page, "the tab has the extension's world and the page's context");
  const send = (method, params) => client.call("cdp", { tabId, method, params });
  const refused = /only in the page's own contexts/;
  const expression = "globalThis.chrome?.runtime?.id ?? null";

  await assert.rejects(send("Runtime.evaluate", { contextId: world.id, expression, returnByValue: true }), refused);
  await assert.rejects(send("Runtime.evaluate", { uniqueContextId: world.uniqueId, expression, returnByValue: true }), refused);
  const functionDeclaration = "function () { return globalThis.chrome?.runtime?.id ?? null; }";
  await assert.rejects(send("Runtime.callFunctionOn", { executionContextId: world.id, functionDeclaration, returnByValue: true }), refused);
  const { root } = await send("DOM.getDocument", {});
  await assert.rejects(send("DOM.resolveNode", { nodeId: root.nodeId, executionContextId: world.id }), refused);
  await assert.rejects(send("Runtime.addBinding", { name: "probe", executionContextName: "anything" }), refused);

  // The page's own context stays usable, by name and by default.
  assert.equal((await send("Runtime.evaluate", { contextId: page.id, expression: "document.title", returnByValue: true })).result.value, "Login");
  assert.equal((await send("Runtime.evaluate", { uniqueContextId: page.uniqueId, expression: "document.title", returnByValue: true })).result.value, "Login");
  assert.equal((await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value, "Login");
});

test("the extension's script world in a page gets no storage and no hub requests executed", async () => {
  const tabId = await tabWithExtensionWorld();
  const storage = await inExtensionWorld(
    tabId,
    `async () => {
      const outcome = async (promise) => promise.then(() => "allowed", (error) => "refused: " + error.message);
      return { read: await outcome(chrome.storage.local.get("hubSecret")), write: await outcome(chrome.storage.local.set({ accessMode: "all-tabs" })) };
    }`,
  );
  assert.match(storage.read, /^refused/);
  assert.match(storage.write, /^refused/);
  assert.notEqual(await env.inPopup(`chrome.storage.local.get("accessMode").then(({ accessMode }) => accessMode ?? null)`), "all-tabs");

  const reply = await inExtensionWorld(
    tabId,
    `async () => {
      const data = JSON.stringify({ id: 1, method: "browser.info", session: "content-script" });
      return chrome.runtime.sendMessage({ target: "worker", type: "hub-message", gen: Number.MAX_SAFE_INTEGER, data }).then((reply) => reply ?? null, () => null);
    }`,
  );
  assert.equal(reply, null, "the service worker did not answer the content script");
  // The message did not disturb the hub's authenticated connection.
  await until(async () => (await client.call("browser.info").catch(() => null))?.id === extensionId, { message: "the hub to answer" });
});
