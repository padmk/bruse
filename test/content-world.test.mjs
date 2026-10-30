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
    "/frame": `<!doctype html><title>Frames</title><iframe srcdoc="<title>Inner</title>"></iframe>`,
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
// Each test gives its tab its own address, by which contextsOf finds it.
async function tabWithExtensionWorld(hash) {
  const { id: tabId } = await client.call("tabs.create", { url: `${site.origin}/#${hash}` });
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
  const tabId = await tabWithExtensionWorld("plain");
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

  // Only commands that also take a unique ID take the numeric ID of a page context, as they are sent by that.
  await assert.rejects(send("DOM.resolveNode", { nodeId: root.nodeId, executionContextId: page.id }), refused);
  await assert.rejects(send("Runtime.compileScript", { expression: "1", sourceURL: "", persistScript: false, executionContextId: page.id }), refused);
  await assert.rejects(send("Runtime.globalLexicalScopeNames", { executionContextId: page.id }), refused);
  const title = await send("Runtime.callFunctionOn", { executionContextId: page.id, functionDeclaration: "function () { return document.title; }", returnByValue: true });
  assert.equal(title.result.value, "Login");

  // The page's own context stays usable, by name and by default.
  assert.equal((await send("Runtime.evaluate", { contextId: page.id, expression: "document.title", returnByValue: true })).result.value, "Login");
  assert.equal((await send("Runtime.evaluate", { uniqueContextId: page.uniqueId, expression: "document.title", returnByValue: true })).result.value, "Login");
  assert.equal((await send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value, "Login");
});

test("raw commands use only objects of the page's own contexts", async () => {
  const tabId = await tabWithExtensionWorld("objects");
  // An object the extension's world logs gets a handle in that world.
  await inExtensionWorld(tabId, "() => { console.log(document); return true; }");
  const world = (await contextsOf(`${site.origin}/#objects`)).find((context) => context.origin === `chrome-extension://${extensionId}`);
  const send = (method, params) => client.call("cdp", { tabId, method, params });
  const refused = /only in the page's own contexts/;
  const { result: page } = await send("Runtime.evaluate", { expression: "document" });

  // Handles are "<isolate>.<context>.<object>", so ones for the extension's world can be made up.
  const [isolate] = page.objectId.split(".");
  const functionDeclaration = "function () { return globalThis.chrome?.runtime?.id ?? null; }";
  for (let id = 1; id <= 20; id++) {
    const objectId = `${isolate}.${world.id}.${id}`;
    await assert.rejects(send("Runtime.callFunctionOn", { objectId, functionDeclaration, returnByValue: true }), refused);
    await assert.rejects(send("Runtime.getProperties", { objectId, ownProperties: true }), refused);
    await assert.rejects(send("Runtime.callFunctionOn", { objectId: page.objectId, functionDeclaration: "function (x) { return x; }", arguments: [{ objectId }] }), refused);
  }
  await assert.rejects(send("Runtime.getProperties", { objectId: "document" }), refused);

  // The page's own objects stay usable.
  const title = await send("Runtime.callFunctionOn", { objectId: page.objectId, functionDeclaration: "function () { return this.title; }", returnByValue: true });
  assert.equal(title.result.value, "Login");
  const { result: properties } = await send("Runtime.getProperties", { objectId: page.objectId, ownProperties: true });
  assert.ok(properties.some((property) => property.name === "location"));
  // Values passed to a function are page data, even when they look like a handle.
  const data = await send("Runtime.callFunctionOn", { objectId: page.objectId, functionDeclaration: "function (x) { return x.objectId; }", arguments: [{ value: { objectId: "x" } }], returnByValue: true });
  assert.equal(data.result.value, "x");
});

test("raw commands cannot keep using a context that is gone", async () => {
  const { id: tabId } = await client.call("tabs.create", { url: `${site.origin}/frame` });
  await client.call("page.state", { tabId });
  const send = (method, params) => client.call("cdp", { tabId, method, params });
  // Without Runtime events the extension would not learn of contexts that end.
  await assert.rejects(send("Runtime.disable", {}), /may not send Runtime.disable/);

  const titleIn = (contextId) => send("Runtime.evaluate", { contextId, expression: "document.title", returnByValue: true }).then(({ result }) => result.value);
  const contexts = (await contextsOf(`${site.origin}/frame`)).filter((context) => context.auxData?.isDefault);
  let inner;
  for (const context of contexts) if ((await titleIn(context.id)) === "Inner") inner = context;
  assert.ok(inner, "the inner frame has a context");
  await send("Runtime.evaluate", { expression: "document.querySelector('iframe').remove()" });
  await assert.rejects(titleIn(inner.id), /only in the page's own contexts/);
});

test("agents cannot add raw bindings", async () => {
  const tabId = await tabWithExtensionWorld("bindings");
  const page = (await contextsOf(`${site.origin}/#bindings`)).find((context) => context.auxData?.isDefault && context.origin === site.origin);
  const send = (method, params) => client.call("cdp", { tabId, method, params });
  const refused = /may not send Runtime.addBinding/;
  await assert.rejects(send("Runtime.addBinding", { name: "probeBinding" }), refused);
  await assert.rejects(send("Runtime.addBinding", { name: "probeBinding", executionContextId: page.id }), refused);
  await assert.rejects(send("Runtime.addBinding", { name: "probeBinding", executionContextName: "anything" }), refused);
  assert.equal((await send("Runtime.evaluate", { expression: "typeof probeBinding", returnByValue: true })).result.value, "undefined");
});

test("the extension's script world in a page gets no storage and no hub requests executed", async () => {
  const tabId = await tabWithExtensionWorld("storage");
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
