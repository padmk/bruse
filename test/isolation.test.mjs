import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hubClient, lastJson, startEnvironment, startSite, until } from "./harness.mjs";

// In the default access mode a window is the session's only when every tab in it is: agent tabs open in
// the user's windows, which the session must not change, move tabs into, switch tabs in or see.

let env, site;
before(async () => {
  env = await startEnvironment();
  site = await startSite({ "/page": "<title>Page</title>" });
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
const tabOf = (u) => env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(u)}))`);

// A tab the user opens, in a window of its own when `newWindow`.
async function userTab(u, newWindow = false) {
  await env.browser.cdp.send("Target.createTarget", { url: u, newWindow });
  await waitPage(u, true);
  return tabOf(u);
}

// A session with `m` (management) and `own`, its tab in the user's window, bound in its REPL.
async function sessionWithTab(u) {
  const s = await env.session();
  await s.js(`const m = await (await cua.getBrowser()).capabilities.get('management'); const own = await cua.createBrowserTab('1', ${JSON.stringify(u)}, { emit: false });`);
  const ownTab = await tabOf(u);
  return { s, ownTab };
}

// The session's own window: a window made for the tab it opens with `u`. Returns { id, tabId }.
async function ownWindow(s, u) {
  await s.js(`await cua.createBrowserTab('1', ${JSON.stringify(u)}, { emit: false });`);
  const { id: tabId } = await tabOf(u);
  const { id } = await json(s, `await m.windows.create({ tabId: ${tabId} })`);
  return { id, tabId };
}

test("windows with a user tab cannot be changed or removed; the session's own window can", async () => {
  const user = await userTab(url("/page?update-user"));
  const { s, ownTab } = await sessionWithTab(url("/page?update-own"));
  assert.equal(ownTab.windowId, user.windowId, "agent tabs open in the user's window");
  await assert.rejects(s.js(`await m.windows.update(${user.windowId}, { width: 700 });`), /holds tabs that are not this session's/);
  await assert.rejects(s.js(`await m.windows.remove(${user.windowId});`), /holds tabs that are not this session's/);
  const own = await ownWindow(s, url("/page?update-window"));
  await s.js(`await m.windows.update(${own.id}, { width: 700 });`);
  await s.close();
});

test("tabs move within their window and into the session's windows only", async () => {
  const user = await userTab(url("/page?move-user"));
  const { s, ownTab } = await sessionWithTab(url("/page?move-own"));
  const own = await ownWindow(s, url("/page?move-window"));
  const inOwnWindow = own.tabId;
  await assert.rejects(s.js(`await m.tabs.move(${inOwnWindow}, { windowId: ${user.windowId}, index: -1 });`), /holds tabs that are not this session's/);
  await s.js(`await m.tabs.move(${ownTab.id}, { index: -1 });`);
  await s.js(`await m.tabs.move(${ownTab.id}, { windowId: ${user.windowId}, index: 0 });`);
  await s.js(`await m.tabs.move(${ownTab.id}, { windowId: ${own.id}, index: -1 });`);
  assert.equal((await tabOf(url("/page?move-own"))).windowId, own.id);
  await s.close();
});

test("own tabs cannot join a user group or a group in a user window", async () => {
  const user = await userTab(url("/page?group-user"));
  const userGroup = await env.inPopup(`chrome.tabs.group({ tabIds: [${user.id}] })`);
  const { s } = await sessionWithTab(url("/page?group-own"));
  const own = await ownWindow(s, url("/page?group-window"));
  const inOwnWindow = own.tabId;
  await assert.rejects(s.js(`await m.tabs.group({ tabIds: [${inOwnWindow}], groupId: ${userGroup} });`), /not shared it/);
  await assert.rejects(s.js(`await m.tabs.group({ tabIds: [${inOwnWindow}], createProperties: { windowId: ${user.windowId} } });`), /holds tabs that are not this session's/);
  await s.close();
});

test("a group cannot be moved into a user window", async () => {
  const user = await userTab(url("/page?groupmove-user"));
  const { s } = await sessionWithTab(url("/page?groupmove-own"));
  const own = await ownWindow(s, url("/page?groupmove-window"));
  const groupId = await json(s, `await m.tabs.group({ tabIds: [${own.tabId}], createProperties: { windowId: ${own.id} } })`);
  await assert.rejects(s.js(`await m.tabGroups.move(${groupId}, { windowId: ${user.windowId}, index: -1 });`), /holds tabs that are not this session's/);
  await s.js(`await m.tabGroups.move(${groupId}, { windowId: ${own.id}, index: 0 });`);
  await s.close();
});

test("an own tab in a user window cannot become the active tab", async () => {
  await userTab(url("/page?active-user"));
  const { s, ownTab } = await sessionWithTab(url("/page?active-own"));
  await assert.rejects(s.js(`await m.tabs.update(${ownTab.id}, { active: true });`), /holds tabs that are not this session's/);
  await assert.rejects(s.js(`await m.tabs.update(${ownTab.id}, { highlighted: true });`), /holds tabs that are not this session's/);
  // Unhighlighting the active tab activates another highlighted tab of the window.
  await assert.rejects(s.js(`await m.tabs.update(${ownTab.id}, { highlighted: false });`), /holds tabs that are not this session's/);
  await s.js(`await m.tabs.update(${ownTab.id}, { muted: true });`);
  const own = await ownWindow(s, url("/page?active-window"));
  await s.js(`await m.tabs.update(${own.tabId}, { active: true });`);
  await s.close();
});

test("windows without a tab of the session are hidden", async () => {
  const user = await userTab(url("/page?hidden-user"), true);
  const s = await env.session();
  await s.js(`const m = await (await cua.getBrowser()).capabilities.get('management');`);
  const windows = await json(s, "await m.windows.getAll({ populate: true })");
  assert.ok(!windows.some((window) => window.id === user.windowId), JSON.stringify(windows));
  await assert.rejects(s.js(`await m.windows.get(${user.windowId});`), /holds no tab of this session/);
  await env.share(user.id);
  assert.ok((await json(s, "await m.windows.getAll()")).some((window) => window.id === user.windowId));
  await env.share(user.id, false);
  await s.close();
});

test("a duplicate is the session's, of its own tab and of a shared tab", async () => {
  const shared = await userTab(url("/page?dup-shared"));
  await env.share(shared.id);
  const { s, ownTab } = await sessionWithTab(url("/page?dup-own"));
  const fromOwn = await json(s, `await m.tabs.duplicate(${ownTab.id})`);
  const fromShared = await json(s, `await m.tabs.duplicate(${shared.id})`);
  assert.equal(fromOwn.active, false, "a duplicate opens in the background");
  assert.equal(fromShared.active, false, "a duplicate opens in the background");
  const agent = await json(s, "await (await cua.getBrowser()).tabs.list()");
  for (const id of [fromOwn.id, fromShared.id]) assert.ok(agent.some((tab) => tab.id === String(id)), JSON.stringify(agent));
  const other = await env.session();
  const seen = await json(other, "await cua.listTabs({ emit: false })");
  assert.ok(!seen.some((tab) => tab.id === String(fromOwn.id) || tab.id === String(fromShared.id)), "another session does not see the duplicates");
  assert.ok(seen.some((tab) => tab.id === String(shared.id)), "the original stays shared");
  await s.close();
  await until(async () => (await env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => [${fromOwn.id}, ${fromShared.id}].includes(tab.id)).length)`)) === 0, {
    message: "the duplicates to close with the session",
  });
  assert.equal(await present(url("/page?dup-shared")), true);
  assert.ok((await json(other, "await cua.listTabs({ emit: false })")).some((tab) => tab.id === String(shared.id)));
  await env.share(shared.id, false);
  await other.close();
});

test("tabs of a new window are the session's and close with it", async () => {
  const urls = [1, 2, 3].map((n) => url(`/page?window-tab=${n}`));
  const s = await env.session();
  await s.js(`const m = await (await cua.getBrowser()).capabilities.get('management');`);
  const window = await json(s, `await m.windows.create({ url: ${JSON.stringify(urls)} })`);
  assert.equal(window.tabs.length, 3, JSON.stringify(window));
  assert.equal(window.focused, false);
  const other = await env.session();
  const seen = await json(other, "await cua.listTabs({ emit: false })");
  assert.ok(!seen.some((tab) => urls.includes(tab.url)), "another session does not see them");
  await s.close();
  for (const u of urls) await waitPage(u, false);
  await other.close();
});

test("a tab moved into a new window keeps its owner or share", async () => {
  const shared = await userTab(url("/page?moved-shared"));
  await env.share(shared.id);
  const s = await env.session();
  await s.js(`const m = await (await cua.getBrowser()).capabilities.get('management');`);
  const sharedWindow = await json(s, `await m.windows.create({ tabId: ${shared.id} })`);
  assert.deepEqual(
    sharedWindow.tabs.map((tab) => tab.id),
    [shared.id],
  );
  const { s: owner, ownTab } = await sessionWithTab(url("/page?moved-own"));
  const added = url("/page?moved-added");
  await owner.js(`await m.windows.create({ tabId: ${ownTab.id}, url: ${JSON.stringify(added)} });`);
  await waitPage(added, true);
  const other = await env.session();
  assert.ok(!(await json(other, "await cua.listTabs({ emit: false })")).some((tab) => tab.url === added), "the new tab is not another session's");
  await assert.rejects(other.js(`await cua.getTab(${JSON.stringify(String(ownTab.id))});`), /not shared it/);
  await owner.close();
  await waitPage(url("/page?moved-own"), false);
  await waitPage(added, false);
  await s.close();
  assert.equal(await present(url("/page?moved-shared")), true, "the shared tab stays open");
  assert.ok((await json(other, "await cua.listTabs({ emit: false })")).some((tab) => tab.id === String(shared.id)), "and shared");
  await env.share(shared.id, false);
  await other.close();
});

test("a session that ends while its window is being created leaves no tab behind", async () => {
  const hub = await env.session();
  await hub.js("await cua.getState();");
  const client = await hubClient(env.port, env.stateDir);
  try {
    const urls = [1, 2].map((n) => url(`/page?window-race=${n}`));
    const created = client.call("browser.manage", { namespace: "windows", method: "create", args: [{ url: urls }] }).then(
      (window) => window,
      (error) => error,
    );
    await client.call("session.end");
    const result = await created;
    await until(async () => !(await pages()).some((u) => urls.includes(u)), { message: "no tab of the ended session" });
    assert.match(String(result?.message), /ended while its tabs were being created/);
  } finally {
    client.close();
    await hub.close();
  }
});

// Headless Chromium reports the newest window as the last focused one.
test("the selected tab is undefined in a user window and found once shared", async () => {
  const focused = await userTab(url("/page?selected"), true);
  const s = await env.session();
  await s.js(`await cua.getState({ emit: false });`);
  assert.equal(await json(s, "(await (await cua.getBrowser()).tabs.selected())?.id ?? null"), null);
  await env.share(focused.id);
  assert.equal(await json(s, "(await (await cua.getBrowser()).tabs.selected())?.id ?? null"), String(focused.id));
  await env.share(focused.id, false);
  await s.close();
});
