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
const holdDownloadSearch = () => env.holdCall("chrome.downloads.search", "true", { answered: true, timeoutMs: 15000 });
// A tab the user opens, shared with agents unless `share` is false, and bound in the session as `name`.
async function sharedUserTab(name, share = true) {
  const url = `${site.origin}/?${name}`;
  await env.browser.cdp.send("Target.createTarget", { url });
  await until(async () => (await env.browser.pages()).some((page) => page.url === url), { message: `${url} to open` });
  const id = await until(() => env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id ?? null)`), { message: `${url} in the tabs API` });
  if (share) await env.share(id);
  await session.js(`const ${name} = await cua.getTab(${JSON.stringify(String(id))});`);
  return id;
}
const downloadFrom = (name, timeoutMs = 15000) =>
  session.js(
    `const wait_${name} = ${name}.playwright.waitForEvent("download", {timeoutMs: ${timeoutMs}}); await ${name}.playwright.getByRole("link", {name: "Download"}).click(); nodeRepl.write(JSON.stringify(await (await wait_${name}).path()));`,
  );
test("stopping a share while its finished download is looked up withholds the file", async () => {
  const id = await sharedUserTab("stopped");
  const hold = await holdDownloadSearch();
  const result = downloadFrom("stopped").then(
    () => null,
    (error) => error,
  );
  await hold.held();
  await env.share(id, false);
  await hold.release();
  assert.match(String((await result)?.message), /stopped sharing/);
});
test("a shared tab that closes while its finished download is looked up still hands it over", async () => {
  const id = await sharedUserTab("closing");
  const hold = await holdDownloadSearch();
  const result = downloadFrom("closing");
  await hold.held();
  await env.inPopup(`chrome.tabs.remove(${id})`);
  await until(async () => !(await env.browser.pages()).some((page) => page.url.endsWith("/?closing")), { message: "the shared tab to close" });
  await hold.release();
  assert.match(readFileSync(lastJson(await result), "utf8"), /^content \d+$/);
});

// Holds the read of `key` with which the extension checks whether the waiting session may have the file,
// answered with what storage held then, until the extension has heard of the user's change of it; so the
// change comes while access is checked, and its event finds no grant to end yet.
async function holdAccessCheck(area, key, change) {
  const hold = await env.holdCall(`chrome.storage.${area}.get`, `args[0] === ${JSON.stringify(key)} && stack.includes("proofOfAccess")`, { answered: true });
  const storage = await env.watchStorage();
  try {
    await hold.held();
    await change();
    await storage.seen(key);
  } finally {
    await hold.release();
    await storage.close();
  }
}
test("stopping a share while the download's access is checked withholds the file", async () => {
  const id = await sharedUserTab("stoppedWhileChecked");
  const result = downloadFrom("stoppedWhileChecked", 8000).then(
    () => null,
    (error) => error,
  );
  await holdAccessCheck("session", "sharedTabs", () => env.share(id, false));
  assert.match(String((await result)?.message), /no download that completed in time/);
});
test("switching off all tabs while the download's access is checked withholds the file", async (t) => {
  await env.setAccessMode("all-tabs");
  t.after(() => env.setAccessMode("agent-tabs"));
  await sharedUserTab("allTabsWhileChecked", false);
  const result = downloadFrom("allTabsWhileChecked", 8000).then(
    () => null,
    (error) => error,
  );
  await holdAccessCheck("local", "accessMode", () => env.setAccessMode("agent-tabs"));
  assert.match(String((await result)?.message), /no download that completed in time/);
});
