import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite, until } from "./harness.mjs";

let env, site;
before(async () => {
  env = await startEnvironment();
  site = await startSite({
    "/": '<title>Opener</title><a href="/link" target="_blank">Open link</a><button onclick="window.open(\'/popup\')">Open popup</button>',
    "/link": '<title>Link child</title>',
    "/popup": '<title>Popup child</title>',
    "/page": '<title>Page</title>',
  });
});
after(async () => { await env?.close(); await site?.close(); });
const url = (path) => site.origin + path;
const pages = async () => (await env.browser.pages()).map((p) => p.url);
const present = async (u) => (await pages()).includes(u);
const waitPage = (u, exists) => until(async () => (await present(u)) === exists, { timeoutMs: 30000, message: `${u} ${exists ? 'open' : 'closed'}` });
const json = async (s, code) => lastJson(await s.js(`nodeRepl.write(JSON.stringify(${code}));`));

test('session closes its agent tabs and retains marked tabs', async () => {
  const s = await env.session();
  const a = url('/page?a'), b = url('/page?b'), c = url('/page?c');
  await s.js(`const a = await cua.createBrowserTab('1', ${JSON.stringify(a)}); const b = await cua.createBrowserTab('1', ${JSON.stringify(b)}); const c = await cua.createBrowserTab('1', ${JSON.stringify(c)}); await b.markDeliverable(); await c.markHandoff();`);
  for (const u of [a,b,c]) await waitPage(u, true);
  await s.close();
  await waitPage(a, false);
  assert.equal(await present(b), true); assert.equal(await present(c), true);
});

test('binding a user tab does not transfer ownership', async () => {
  const u = url('/page?user');
  await env.browser.cdp.send('Target.createTarget', {url:u});
  await waitPage(u, true);
  const s = await env.session();
  const tabs = await json(s, 'await cua.listTabs({emit:false})');
  const user = tabs.find(t => t.url === u);
  assert.ok(user);
  await s.js(`await cua.getTab(${JSON.stringify(user.id)});`);
  await s.close();
  assert.equal(await present(u), true);
});

test('input-created link and popup tabs are reported and closed', async () => {
  const s = await env.session();
  await s.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(url('/'))});`);
  for (const [name, path] of [['Open link','/link'], ['Open popup','/popup']]) {
    const output = await s.js(`await tab.playwright.getByText(${JSON.stringify(name)}).click();`);
    await waitPage(url(path), true);
    assert.match(output, /new tab/i);
    const match = output.match(/opened a new tab (\d+) \(([^)]+)\)/i);
    assert.ok(match, output);
    assert.equal(match[2], url(path));
    const tabs = await json(s, 'await cua.listTabs({emit:false})');
    assert.ok(tabs.some(t => String(t.id) === match[1] && t.url === url(path)));
  }
  await s.close();
  for (const path of ['/','/link','/popup']) await waitPage(url(path), false);
});

test('concurrent sessions retain independent ownership', async () => {
  const a = await env.session(), b = await env.session();
  const ua = url('/page?session=a'), ub = url('/page?session=b');
  await a.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(ua)});`);
  await b.js(`const tab = await cua.createBrowserTab('1', ${JSON.stringify(ub)});`);
  await a.close(); await waitPage(ua, false);
  assert.equal(await present(ub), true);
  assert.equal(await json(b, 'await tab.title()'), 'Page');
  await b.close(); await waitPage(ub, false);
});

test('agent tabs open in the background', async () => {
  const s = await env.session();
  const before = await json(s, 'await (await (await cua.getBrowser()).capabilities.get("management")).tabs.query({active:true})');
  await s.js(`await cua.createBrowserTab('1', ${JSON.stringify(url('/page?background'))});`);
  const after = await json(s, 'await (await (await cua.getBrowser()).capabilities.get("management")).tabs.query({active:true})');
  assert.ok(before.some(t => t.active));
  assert.deepEqual(after.filter(t => t.active).map(t => t.id), before.filter(t => t.active).map(t => t.id));
  await s.close();
});

// Headless Chromium keeps reporting the other window as last focused after windows.update.
// Reproduce with two CDP windows and retry when headless focus can be controlled.
test('selected tab follows the most recently focused window', { todo: true }, async () => {
  const s = await env.session();
  const u1 = url('/page?window=1'), u2 = url('/page?window=2');
  const t1 = await env.browser.cdp.send('Target.createTarget', {url:u1, newWindow:true});
  const t2 = await env.browser.cdp.send('Target.createTarget', {url:u2, newWindow:true});
  await waitPage(u1,true); await waitPage(u2,true);
  for (const [target, u] of [[t1.targetId,u1],[t2.targetId,u2],[t1.targetId,u1]]) {
    await env.browser.cdp.send('Target.activateTarget', {targetId:target});
    const tabs = await json(s, 'await (await (await cua.getBrowser()).capabilities.get("management")).tabs.query({})');
    const windowId = tabs.find(t => t.url === u).windowId;
    await s.js(`await (await (await cua.getBrowser()).capabilities.get('management')).windows.update(${windowId}, {focused:true});`);
    await until(async () => (await json(s, 'await (await (await cua.getBrowser()).tabs.selected())?.url()')) === u, {timeoutMs:30000, message:`selected ${u}`});
  }
  await s.close();
});
