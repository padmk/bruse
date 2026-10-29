import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite } from "./harness.mjs";

let env, site, session;
const json = async (code) => lastJson(await session.js(`nodeRepl.write(JSON.stringify(await (${code})));`));
const number = (tree, text) => {
  const line = tree.split("\n").find((s) => s.includes(text) && /\d+/.test(s));
  assert.ok(line, `Missing ${text} in ${tree}`);
  return Number(line.match(/\d+/)[0]);
};
const STALE = /no longer on the page/;

before(async () => {
  site = await startSite({
    // A plain search field that a script replaces with a combo box of the same name, as Wikipedia does.
    "/widget": `<!doctype html><title>Widget</title><form id="search"><input id="plain" aria-label="Search site" name="q"></form>
      <script>window.mountWidget = () => { const input = document.createElement("input"); input.id = "widget"; input.setAttribute("role", "combobox"); input.setAttribute("aria-label", "Search site"); document.querySelector("#plain").replaceWith(input); };</script>`,
    // Two records with buttons of the same name; removing one must not redirect its number to the other.
    "/records": `<!doctype html><title>Records</title>
      <section id="first" aria-label="Record A"><button onclick="document.body.dataset.clicked='A'">Delete</button></section>
      <section id="second" aria-label="Record B"><button onclick="document.body.dataset.clicked='B'">Delete</button></section>`,
    // A button of the same name that is already in the page, hidden, when the agent reads it.
    "/hidden": `<!doctype html><title>Hidden</title>
      <button id="visible" onclick="document.body.dataset.clicked='visible'">Save</button>
      <button id="hidden" hidden onclick="document.body.dataset.clicked='hidden'">Save</button>`,
    "/repeated": `<!doctype html><title>Repeated replacement</title><button id="original">Save</button>`,
  });
  env = await startEnvironment();
  session = await env.session();
});
after(async () => {
  await env?.close();
  await site?.close();
});

test("an element a script replaced is found in its new form", async () => {
  const tree = await session.js(`var widgetTab = await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/widget`)});`);
  const field = number(tree, "Search site");
  await session.js(`await widgetTab.playwright.evaluate(() => window.mountWidget());`);
  await session.js(`await widgetTab.typeText(${field}, 'first');`);
  assert.equal(await json(`widgetTab.playwright.evaluate(() => document.querySelector('#widget').value)`), "first");

  // A number from a read that a later read no longer shows leads to the replacement too.
  await session.js(`await widgetTab.goto(${JSON.stringify(`${site.origin}/widget`)});`);
  const again = number(await session.js("await widgetTab.getAXState({disableDiffing:true});"), "Search site");
  await session.js(`await widgetTab.playwright.evaluate(() => window.mountWidget());`);
  await session.js("await widgetTab.getAXState();");
  await session.js(`await widgetTab.typeText(${again}, 'second');`);
  assert.equal(await json(`widgetTab.playwright.evaluate(() => document.querySelector('#widget').value)`), "second");
});

test("a removed element's number never acts on another element that was already there", async () => {
  const tree = await session.js(`var recordsTab = await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/records`)});`);
  const first = number(tree, "button Delete");
  await session.js(`await recordsTab.playwright.evaluate(() => document.querySelector('#first').remove());`);
  await assert.rejects(session.js(`await recordsTab.click(${first});`), STALE);
  assert.equal(await json(`recordsTab.playwright.evaluate(() => document.body.dataset.clicked ?? null)`), null);

  const hidden = await session.js(`var hiddenTab = await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/hidden`)});`);
  const save = number(hidden, "button Save");
  await session.js(`await hiddenTab.playwright.evaluate(() => { document.querySelector('#visible').remove(); document.querySelector('#hidden').hidden = false; });`);
  await assert.rejects(session.js(`await hiddenTab.click(${save});`), STALE);
  assert.equal(await json(`hiddenTab.playwright.evaluate(() => document.body.dataset.clicked ?? null)`), null);
});

test("a replacement's number does not later act on a control hidden during that replacement", async () => {
  const tree = await session.js(`var repeatedTab = await cua.createBrowserTab('1', ${JSON.stringify(`${site.origin}/repeated`)});`);
  const save = number(tree, "button Save");
  await session.js(`await repeatedTab.playwright.evaluate(() => {
    const hidden = document.createElement('button');
    hidden.id = 'unrelated'; hidden.hidden = true; hidden.textContent = 'Save';
    hidden.onclick = () => document.body.dataset.clicked = 'unrelated';
    document.body.append(hidden);
    const replacement = document.createElement('button');
    replacement.id = 'replacement'; replacement.textContent = 'Save';
    replacement.onclick = () => document.body.dataset.clicked = 'replacement';
    document.querySelector('#original').replaceWith(replacement);
  });`);
  await session.js(`await repeatedTab.click(${save});`);
  assert.equal(await json(`repeatedTab.playwright.evaluate(() => document.body.dataset.clicked)`), "replacement");
  await session.js(`await repeatedTab.playwright.evaluate(() => {
    document.querySelector('#replacement').remove();
    document.querySelector('#unrelated').hidden = false;
    delete document.body.dataset.clicked;
  });`);
  await assert.rejects(session.js(`await repeatedTab.click(${save});`), STALE);
  assert.equal(await json(`repeatedTab.playwright.evaluate(() => document.body.dataset.clicked ?? null)`), null);
});
