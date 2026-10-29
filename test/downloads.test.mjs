import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { lastJson, startEnvironment, startSite, until } from "./harness.mjs";

let env,
  site,
  session,
  count = 0;
before(async () => {
  env = await startEnvironment();
  site = await startSite({
    "/": '<a href="/file" download>Download</a><a href="/file" target="_blank">Blank</a><a href="/slow" target="_blank">Delayed</a>',
    "/file": (_req, res) =>
      res.writeHead(200, { "content-disposition": 'attachment; filename="file.txt"', "content-type": "text/plain" }).end(`content ${++count}`),
    // Answers after the new tab exists, so the extension holds the response and sees the file.
    "/slow": (_req, res) =>
      setTimeout(() => res.writeHead(200, { "content-disposition": 'attachment; filename="slow.txt"', "content-type": "text/plain" }).end("slow"), 1000),
  });
  session = await env.session();
});
after(async () => {
  await env?.close();
  await site?.close();
});

async function tab(name) {
  await session.js(`const ${name} = await cua.createBrowserTab("1", ${JSON.stringify(site.origin)});`);
}
async function download(name, link) {
  return lastJson(
    await session.js(
      `const wait_${name} = ${name}.playwright.waitForEvent("download"); await ${name}.playwright.getByRole("link", {name: ${JSON.stringify(link)}}).click(); nodeRepl.write(JSON.stringify(await (await wait_${name}).path()));`,
    ),
  );
}
test("download attribute saves the attachment", async () => {
  await tab("first");
  const path = await download("first", "Download");
  assert.equal(readFileSync(path, "utf8"), "content 1");
});
// The new tab turns into the download and closes before its response can be held.
test("blank attachment belongs to its opener", async () => {
  await tab("blank");
  const path = lastJson(
    await session.js(
      `const waitBlank = blank.playwright.waitForEvent("download", {timeoutMs: 15000}); await blank.playwright.getByRole("link", {name: "Blank"}).click(); nodeRepl.write(JSON.stringify(await (await waitBlank).path()));`,
    ),
  );
  assert.equal(readFileSync(path, "utf8"), "content 2");
});
test("slow blank attachment belongs to its opener", async () => {
  await tab("slowBlank");
  const path = lastJson(
    await session.js(
      `const waitSlow = slowBlank.playwright.waitForEvent("download", {timeoutMs: 15000}); await slowBlank.playwright.getByRole("link", {name: "Delayed"}).click(); nodeRepl.write(JSON.stringify(await (await waitSlow).path()));`,
    ),
  );
  assert.equal(readFileSync(path, "utf8"), "slow");
});
test("tabs downloading the same URL receive their own files", async () => {
  await tab("left");
  await tab("right");
  const paths = lastJson(
    await session.js(
      `const a = left.playwright.waitForEvent("download"); const b = right.playwright.waitForEvent("download"); await left.playwright.getByRole("link", {name: "Download"}).click(); await right.playwright.getByRole("link", {name: "Download"}).click(); nodeRepl.write(JSON.stringify([await (await a).path(), await (await b).path()]));`,
    ),
  );
  assert.notEqual(paths[0], paths[1]);
  assert.equal(readFileSync(paths[0], "utf8"), "content 3");
  assert.equal(readFileSync(paths[1], "utf8"), "content 4");
});
test("download wait times out", async () => {
  await tab("idle");
  await assert.rejects(session.js('await (await idle.playwright.waitForEvent("download", {timeoutMs: 500})).path();'), /no download that completed in time/i);
});

// Holds chrome.downloads.search in the extension's service worker until `release()`, so that the user can
// act while the extension looks up a download that completed.
async function holdDownloadSearch() {
  const { cdp, extensionId } = env.browser;
  const { targetInfos } = await cdp.send("Target.getTargets");
  const worker = targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  const evaluate = async (expression) => (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  await evaluate(`(() => {
    const original = chrome.downloads.search;
    const held = (globalThis.heldSearch = { original, calls: 0, release: null });
    chrome.downloads.search = async (query) => {
      const items = await original.call(chrome.downloads, query);
      held.calls++;
      await new Promise((resolve) => (held.release = resolve));
      return items;
    };
  })()`);
  return {
    searched: () => until(() => evaluate("globalThis.heldSearch.calls > 0"), { timeoutMs: 15000, message: "the download to be looked up" }),
    async release() {
      await evaluate("chrome.downloads.search = globalThis.heldSearch.original; globalThis.heldSearch.release()");
      await cdp.send("Target.detachFromTarget", { sessionId });
    },
  };
}
async function sharedUserTab(name) {
  const url = `${site.origin}/?${name}`;
  await env.browser.cdp.send("Target.createTarget", { url });
  await until(async () => (await env.browser.pages()).some((page) => page.url === url), { message: `${url} to open` });
  const id = await env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)}).id)`);
  await env.share(id);
  await session.js(`const ${name} = await cua.getTab(${JSON.stringify(String(id))});`);
  return id;
}
const downloadFrom = (name) =>
  session.js(
    `const wait_${name} = ${name}.playwright.waitForEvent("download", {timeoutMs: 15000}); await ${name}.playwright.getByRole("link", {name: "Download"}).click(); nodeRepl.write(JSON.stringify(await (await wait_${name}).path()));`,
  );
test("stopping a share while its finished download is looked up withholds the file", async () => {
  const id = await sharedUserTab("stopped");
  const hold = await holdDownloadSearch();
  const result = downloadFrom("stopped").then(
    () => null,
    (error) => error,
  );
  await hold.searched();
  await env.share(id, false);
  await hold.release();
  assert.match(String((await result)?.message), /stopped sharing/);
});
test("a shared tab that closes while its finished download is looked up still hands it over", async () => {
  const id = await sharedUserTab("closing");
  const hold = await holdDownloadSearch();
  const result = downloadFrom("closing");
  await hold.searched();
  await env.inPopup(`chrome.tabs.remove(${id})`);
  await until(async () => !(await env.browser.pages()).some((page) => page.url.endsWith("/?closing")), { message: "the shared tab to close" });
  await hold.release();
  assert.match(readFileSync(lastJson(await result), "utf8"), /^content \d+$/);
});
