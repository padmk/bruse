import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { hubClient, lastJson, startEnvironment, startSite, until } from "./harness.mjs";

let env, site;
before(async () => {
  env = await startEnvironment();
  site = await startSite({
    "/": '<title>Opener</title><a href="/link" target="_blank">Open link</a><button onclick="window.open(\'/popup\')">Open popup</button>',
    "/link": "<title>Link child</title>",
    "/popup": "<title>Popup child</title>",
    "/page": "<title>Page</title>",
  });
});
after(async () => {
  await env?.close();
  await site?.close();
});
const url = (path) => site.origin + path;
const pages = async () => (await env.browser.pages()).map((p) => p.url);
const present = async (u) => (await pages()).includes(u);
const waitPage = (u, exists) => until(async () => (await present(u)) === exists, { timeoutMs: 30000, message: `${u} ${exists ? "open" : "closed"}` });
const json = async (s, code) => lastJson(await s.js(`nodeRepl.write(JSON.stringify(${code}));`));

test("session closes its agent tabs and retains marked tabs", async () => {
  const s = await env.session();
  const a = url("/page?a"),
    b = url("/page?b"),
    c = url("/page?c");
  await s.js(
    `const a = await cua.createBrowserTab('1', ${JSON.stringify(a)}); const b = await cua.createBrowserTab('1', ${JSON.stringify(b)}); const c = await cua.createBrowserTab('1', ${JSON.stringify(c)}); await b.markDeliverable(); await c.markHandoff();`,
  );
  for (const u of [a, b, c]) await waitPage(u, true);
  await s.close();
  await waitPage(a, false);
  assert.equal(await present(b), true);
  assert.equal(await present(c), true);
});

test("a user tab stays hidden until shared, and binding a shared tab does not transfer ownership", async () => {
  const u = url("/page?user");
  await env.browser.cdp.send("Target.createTarget", { url: u });
  await waitPage(u, true);
  const userTabId = await env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(u)}).id)`);
  const s = await env.session();
  assert.ok(!(await json(s, "await cua.listTabs({emit:false})")).some((t) => t.url === u), "an unshared tab is not listed");
  assert.match(await s.js("await cua.getState();"), /not shared with agents/);
  await assert.rejects(s.js(`await cua.getTab(${JSON.stringify(String(userTabId))});`), /not shared it/);
  await env.share(userTabId);
  const tabs = await json(s, "await cua.listTabs({emit:false})");
  assert.ok(tabs.some((t) => t.url === u), "a shared tab is listed");
  await s.js(`const user = await cua.getTab(${JSON.stringify(String(userTabId))});`);
  await env.share(userTabId, false);
  await assert.rejects(s.js("await user.getAXState();"), /not shared it/);
  await s.close();
  assert.equal(await present(u), true);
});

test("shares stopped at the same time, also by a closing tab, all end", async () => {
  const urls = [1, 2, 3].map((n) => url(`/page?share=${n}`));
  for (const u of urls) await env.browser.cdp.send("Target.createTarget", { url: u });
  for (const u of urls) await waitPage(u, true);
  const ids = await env.inPopup(`chrome.tabs.query({}).then((tabs) => ${JSON.stringify(urls)}.map((u) => tabs.find((tab) => tab.url === u).id))`);
  for (const id of ids) await env.share(id);
  const shared = () => env.inPopup(`chrome.storage.session.get("sharedTabs").then(({ sharedTabs }) => sharedTabs ?? [])`);
  assert.deepEqual((await shared()).toSorted(), ids.toSorted());
  // Two Stop clicks in the popup, while the third tab closes and the service worker ends its share.
  await env.inPopup(`import("./access.js").then((access) => Promise.all([access.setShared(${ids[0]}, false), access.setShared(${ids[1]}, false), chrome.tabs.remove(${ids[2]})]))`);
  await waitPage(urls[2], false);
  await until(async () => (await shared()).length === 0, { timeoutMs: 5000, message: "every share to end" });
  const s = await env.session();
  for (const id of ids.slice(0, 2)) await assert.rejects(s.js(`await cua.getTab(${JSON.stringify(String(id))});`), /not shared it/);
  await s.close();
});

test("input-created link and popup tabs are reported and closed", async () => {
  const s = await env.session();
  await s.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(url("/"))});`);
  for (const [name, path] of [
    ["Open link", "/link"],
    ["Open popup", "/popup"],
  ]) {
    const output = await s.js(`await tab.playwright.getByText(${JSON.stringify(name)}).click();`);
    await waitPage(url(path), true);
    assert.match(output, /new tab/i);
    const match = output.match(/opened a new tab (\d+) \(([^)]+)\)/i);
    assert.ok(match, output);
    assert.equal(match[2], url(path));
    const tabs = await json(s, "await cua.listTabs({emit:false})");
    assert.ok(tabs.some((t) => String(t.id) === match[1] && t.url === url(path)));
  }
  await s.close();
  for (const path of ["/", "/link", "/popup"]) await waitPage(url(path), false);
});

test("concurrent sessions retain independent ownership", async () => {
  const a = await env.session(),
    b = await env.session();
  const ua = url("/page?session=a"),
    ub = url("/page?session=b");
  await a.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(ua)});`);
  await b.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(ub)});`);
  await a.close();
  await waitPage(ua, false);
  assert.equal(await present(ub), true);
  assert.equal(await json(b, "await tab.title()"), "Page");
  await b.close();
  await waitPage(ub, false);
});

test("a session that ends while its tab is being created leaves no tab behind", async () => {
  const hub = await env.session();
  await hub.js("await cua.getState();");
  const client = await hubClient(env.port, env.stateDir);
  try {
    const sessionId = randomUUID();
    const u = url("/page?race");
    const created = client.call("tabs.create", { url: u, sessionId }).then(
      (tab) => tab,
      (error) => error,
    );
    await client.call("session.end", { sessionId });
    const result = await created;
    const tabs = await client.call("tabs.list");
    assert.ok(!tabs.some((t) => t.url === u || t.pendingUrl === u), JSON.stringify(tabs));
    await waitPage(u, false);
    // Either creation wins and session cleanup closes it, or the ended session rejects creation.
    if (result instanceof Error) assert.match(result.message, /ended while its tab was being created|No tab with id/);
    else assert.ok(Number.isInteger(result.id), JSON.stringify(result));
  } finally {
    client.close();
    await hub.close();
  }
});

test("agent tabs open in the background", async (t) => {
  // The user's active tabs are visible to agents in "all tabs" mode only.
  await env.setAccessMode("all-tabs");
  t.after(() => env.setAccessMode("agent-tabs"));
  const s = await env.session();
  const before = await json(s, 'await (await (await cua.getBrowser()).capabilities.get("management")).tabs.query({active:true})');
  await s.js(`await cua.createBrowserTab('1', ${JSON.stringify(url("/page?background"))});`);
  const after = await json(s, 'await (await (await cua.getBrowser()).capabilities.get("management")).tabs.query({active:true})');
  assert.ok(before.some((t) => t.active));
  assert.deepEqual(
    after.filter((t) => t.active).map((t) => t.id),
    before.filter((t) => t.active).map((t) => t.id),
  );
  await s.close();
});

// Headless Chromium cannot move focus between windows, but it reports the newest window as the last
// focused one, while the first window still has an active tab of its own.
test("selected tab is the active tab of the last focused window", async (t) => {
  await env.setAccessMode("all-tabs");
  t.after(() => env.setAccessMode("agent-tabs"));
  const s = await env.session();
  const u1 = url("/page?window=1"),
    u2 = url("/page?window=2");
  await env.browser.cdp.send("Target.createTarget", { url: u1, newWindow: true });
  await env.browser.cdp.send("Target.createTarget", { url: u2, newWindow: true });
  await waitPage(u1, true);
  await waitPage(u2, true);
  const state = await json(
    s,
    `await (async () => {
    const management = await (await cua.getBrowser()).capabilities.get('management');
    const focused = await management.windows.getLastFocused({windowTypes:['normal']});
    const active = (await management.tabs.query({active:true})).map(tab => ({id:String(tab.id), windowId:tab.windowId}));
    const selected = await (await cua.getBrowser()).tabs.selected();
    return {focused:focused.id, active, selected:selected?.id};
  })()`,
  );
  if (state.active[0]?.windowId === state.focused) return t.skip("the first window listed is the focused one, so this browser cannot tell the cases apart");
  assert.ok(state.active.length >= 2, JSON.stringify(state));
  assert.equal(state.selected, state.active.find((tab) => tab.windowId === state.focused)?.id, JSON.stringify(state));
  await s.close();
});
