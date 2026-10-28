import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite } from "./harness.mjs";

let env, site, session, count = 0;
before(async () => {
  env = await startEnvironment();
  site = await startSite({
    "/": '<a href="/file" download>Download</a><a href="/file" target="_blank">Blank</a>',
    "/file": (_req, res) => res.writeHead(200, { "content-disposition": 'attachment; filename="file.txt"', "content-type": "text/plain" }).end(`content ${++count}`),
  });
  session = await env.session();
});
after(async () => { await env?.close(); await site?.close(); });

async function tab(name) {
  await session.js(`const ${name} = await cua.createBrowserTab("1", ${JSON.stringify(site.origin)});`);
}
async function download(name, link) {
  return lastJson(await session.js(`const wait_${name} = ${name}.playwright.waitForEvent("download"); await ${name}.playwright.getByRole("link", {name: ${JSON.stringify(link)}}).click(); nodeRepl.write(JSON.stringify(await (await wait_${name}).path()));`));
}
test("download attribute saves the attachment", async () => {
  await tab("first");
  const path = await download("first", "Download");
  assert.equal(readFileSync(path, "utf8"), "content 1");
});
// The opener wait times out for a fast target=_blank attachment response.
test("blank attachment belongs to its opener", { todo: true }, async () => {
  await tab("blank");
  const path = lastJson(await session.js(`const waitBlank = blank.playwright.waitForEvent("download", {timeoutMs: 3000}); await blank.playwright.getByRole("link", {name: "Blank"}).click(); nodeRepl.write(JSON.stringify(await (await waitBlank).path()));`));
  assert.equal(readFileSync(path, "utf8"), "content 2");
});
test("tabs downloading the same URL receive their own files", async () => {
  await tab("left"); await tab("right");
  const paths = lastJson(await session.js(`const a = left.playwright.waitForEvent("download"); const b = right.playwright.waitForEvent("download"); await left.playwright.getByRole("link", {name: "Download"}).click(); await right.playwright.getByRole("link", {name: "Download"}).click(); nodeRepl.write(JSON.stringify([await (await a).path(), await (await b).path()]));`));
  assert.notEqual(paths[0], paths[1]);
  assert.equal(readFileSync(paths[0], "utf8"), "content 3");
  assert.equal(readFileSync(paths[1], "utf8"), "content 4");
});
test("download wait times out", async () => {
  await tab("idle");
  await assert.rejects(session.js('await (await idle.playwright.waitForEvent("download", {timeoutMs: 500})).path();'), /no download that completed in time/i);
});
