import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite } from "./harness.mjs";

let env, site, frame, session;
const json = async (code) => lastJson(await session.js(`nodeRepl.write(JSON.stringify(await (${code})));`));
const number = (tree, name) => {
  const line = tree.split("\n").find((s) => s.includes(name) && /\d+/.test(s));
  assert.ok(line, `Missing ${name} in ${tree}`);
  return Number(line.match(/\d+/)[0]);
};
before(async () => {
  frame = await startSite({ "/": "<label>Frame input <input></label><button onclick=\"this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);this.textContent='Frame clicked'\">Frame button</button>" }, "localhost");
  site = await startSite({
    "/": `<!doctype html><title>Actions</title>
    <button onclick="this.textContent='Changed'">Change</button><p>Unchanged marker</p>
    <form onsubmit="event.preventDefault(); window.submitted=true"><label>Typed <input name="typed"></label><label>Set input <input name="set"></label><label>Choice <select><option>First</option><option>Second</option></select></label><label>Agree <input type="checkbox"></label><button>Submit</button></form>
    <button onclick="window.roleClicked=true">Role action</button><button>Duplicate</button><button>Duplicate</button>
    <button onclick="window.deleted=true"><svg aria-label="Delete"></svg></button><a href="#home"><img alt="Home"></a>
    <label>Label field <input></label><input placeholder="Placeholder field"><input data-testid="test-field"><div class="item">Alpha</div><div class="item">Beta</div>
    <div style="position:relative;width:160px;height:40px"><button id="covered" style="position:absolute;inset:0">Covered</button><div id="overlay" style="position:absolute;inset:0" onclick="window.overlayClicked=true">Overlay</div></div>
    <iframe src="${frame.origin}/"></iframe><button onclick="window.confirmed=confirm('Proceed?')">Confirm</button>
    <button onclick="console.log('hello log');console.error('hello error')">Log</button><input aria-label="Keys" value="select me">
    <button onclick="while(true){}">Hang</button>`,
  });
  env = await startEnvironment();
  session = await env.session();
});
after(async () => {
  await env?.close();
  await site?.close();
  await frame?.close();
});

test("numbered AX tree, diffs and full state", async () => {
  const tree = await session.js(`var tab = await cua.createBrowserTab('1', ${JSON.stringify(site.origin)});`);
  assert.match(tree, /\d+ button Change/);
  await session.js(`await tab.click(${number(tree, "button Change")});`);
  const diff = await session.js("await tab.getAXState();");
  assert.match(diff, /Changed/);
  assert.doesNotMatch(diff, /Unchanged marker/);
  const full = await session.js("await tab.getAXState({disableDiffing:true});");
  assert.match(full, /Changed/);
  assert.match(full, /Unchanged marker/);
});

test("element numbers operate form controls", async () => {
  const tree = await session.js("await tab.getAXState({disableDiffing:true});");
  await session.js(
    `await tab.click(${number(tree, "text field (settable) Typed")}); await tab.typeText(null, 'hello'); await tab.setValue(${number(tree, "text field (settable) Set input")}, 'world'); await tab.setValue(${number(tree, "combo box (settable, collapsed) Choice")}, 'Second'); await tab.setValue(${number(tree, "checkbox (settable) Agree")}, 'true'); await tab.click(${number(tree, "text field (settable) Typed")}); await tab.pressKey(null, 'Return');`,
  );
  assert.deepEqual(
    await json(
      `tab.playwright.evaluate(() => [document.querySelector('[name=typed]').value, document.querySelector('[name=set]').value, document.querySelector('select').value, document.querySelector('[type=checkbox]').checked, window.submitted])`,
    ),
    ["hello", "world", "Second", true, true],
  );
});

test("locators identify and operate elements, and enforce strictness", async () => {
  await session.js(`await tab.playwright.getByRole('button',{name:'Role action'}).click(); await tab.playwright.getByRole('button',{name:'Delete'}).click();`);
  assert.equal(await json(`tab.playwright.getByRole('link',{name:'Home'}).count()`), 1);
  assert.equal(await json(`tab.playwright.getByRole('button',{name:'Duplicate'}).count()`), 2);
  await assert.rejects(session.js(`await tab.playwright.getByRole('button',{name:'Duplicate'}).click();`), /matched 2 elements/);
  await session.js(
    `await tab.playwright.getByLabel('Label field').fill('label'); await tab.playwright.getByPlaceholder('Placeholder field').fill('placeholder'); await tab.playwright.getByTestId('test-field').fill('test');`,
  );
  assert.equal(await json(`tab.playwright.locator('.item').filter({hasText:'Beta'}).textContent()`), "Beta");
  assert.deepEqual(
    await json(
      `tab.playwright.evaluate(() => [window.roleClicked,window.deleted,...Array.from(document.querySelectorAll('input')).slice(-4,-1).map(x=>x.value)])`,
    ),
    [true, true, "label", "placeholder", "test"],
  );
});

test("overlay prevents click unless forced", async () => {
  await assert.rejects(session.js(`await tab.playwright.locator('#covered').click({timeout:1000});`), /overlay/i);
  await session.js(`await tab.playwright.locator('#covered').click({force:true});`);
  assert.equal(await json(`tab.playwright.evaluate(() => window.overlayClicked)`), true);
});

test("cross-origin frame appears in AX tree and accepts both action styles", async () => {
  const tree = await session.js("await tab.getAXState({disableDiffing:true});");
  await session.js(
    `await tab.typeText(${number(tree, "text field (settable) Frame input")}, 'inside'); await tab.playwright.frameLocator('iframe').getByRole('button',{name:'Frame button'}).click();`,
  );
  assert.equal(await json(`tab.playwright.frameLocator('iframe').getByLabel('Frame input').evaluate(el => el.value)`), "inside");
  assert.equal(await json(`tab.playwright.frameLocator('iframe').getByRole('button',{name:'Frame clicked'}).count()`), 1);
  assert.equal(await json(`tab.playwright.frameLocator('iframe').getByRole('button').getAttribute('data-clicks')`), "1");
  const clicked = await session.js("await tab.getAXState({disableDiffing:true});");
  await session.js(`await tab.click(${number(clicked, "button Frame clicked")});`);
  assert.equal(await json(`tab.playwright.frameLocator('iframe').getByRole('button').getAttribute('data-clicks')`), "2");
});

test("confirm notification and acceptance", async () => {
  const output = await session.js(`await tab.playwright.getByRole('button',{name:'Confirm'}).click();`);
  assert.match(output, /dialog|confirm/i);
  assert.deepEqual(await json(`(async()=>{const d=await tab.getJsDialog(); return [d.type,d.message]})()`), ["confirm", "Proceed?"]);
  await session.js(`await (await tab.getJsDialog()).accept();`);
  assert.equal(await json(`tab.playwright.evaluate(() => window.confirmed)`), true);
});

test("console logs include page messages", async () => {
  await session.js(`await tab.playwright.getByRole('button',{name:'Log'}).click();`);
  const logs = await json("tab.dev.logs()");
  assert.ok(logs.some((x) => x.level === "log" && x.message.includes("hello log")));
  assert.ok(logs.some((x) => x.level === "error" && x.message.includes("hello error")));
});

test("ControlOrMeta+A selects input text", async () => {
  await session.js(`await tab.playwright.getByLabel('Keys').press('ControlOrMeta+A');`);
  assert.deepEqual(await json(`tab.playwright.getByLabel('Keys').evaluate(el => [el.selectionStart,el.selectionEnd])`), [0, 9]);
});

test("text output is capped", async () => {
  const output = await session.js(`nodeRepl.write('x'.repeat(40000));`);
  assert.match(output, /Output truncated/);
  assert.ok(output.length < 31000);
});

test("unresponsive page commands time out", { timeout: 60000 }, async () => {
  await assert.rejects(session.js(`await tab.playwright.getByRole('button',{name:'Hang',exact:true}).click();`, 40000), /did not respond within 8 s/);
  const start = Date.now();
  await assert.rejects(session.js(`await tab.pressKey(null, 'Tab');`, 40000), /respond|timed out/i);
  assert.ok(Date.now() - start < 20000);
});
