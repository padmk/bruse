// The basic path: a session reaches the test browser, the extension pairs, and input changes a page.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite } from "./harness.mjs";

let env;
let site;

before(async () => {
  env = await startEnvironment();
  site = await startSite({
    "/": `<!doctype html><title>Counter</title><button onclick="this.textContent = 'Clicked ' + (++window.n || (window.n = 1))">Press me</button>`,
  });
});

after(async () => {
  await env?.close();
  await site?.close();
});

test("a session pairs with the extension and operates a page", async () => {
  const session = await env.session();
  const output = await session.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(site.origin + "/")});`);
  assert.match(output, /\d+ button Press me/);
  assert.ok(existsSync(join(env.stateDir, "extension-secret")), "the hub stored the extension's secret");

  await session.js(`await tab.playwright.getByRole("button", { name: "Press me" }).click();`);
  const text = lastJson(await session.js(`nodeRepl.write(JSON.stringify(await tab.playwright.locator("button").textContent()));`));
  assert.equal(text, "Clicked 1");
});
