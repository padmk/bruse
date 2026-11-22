// The extension's process can die under the browser (out of memory, a renderer crash). The extension
// must then come back and reconnect to the hub by itself, without the user reloading it.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ignore } from "../browser/extension/shared.js";
import { startEnvironment, until } from "./harness.mjs";

let env;

before(async () => {
  env = await startEnvironment();
});

after(async () => {
  await env?.close();
});

// Crashes the renderer process of the extension's pages and service worker, through an extension page
// opened in a tab, which shares that process. Returns the crashed tab's target: closing it is an event
// that would wake the worker, so the caller closes it only after the extension came back.
async function crashExtensionProcess() {
  const { cdp, extensionId } = env.browser;
  const worker = await env.worker();
  await worker.evaluate("globalThis.beforeCrash = true");
  await worker.close();
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await until(async () => (await cdp.send("Runtime.evaluate", { expression: 'location.protocol === "chrome-extension:" && document.readyState === "complete"', returnByValue: true }, sessionId)).result.value === true, { message: "the extension page to load" });
  await cdp.send("Page.crash", {}, sessionId).catch(ignore("the crash ends the target before it can answer"));
  // The service worker ended with the process: one that runs now (the browser may start it again for
  // an event at once) started after the crash.
  await until(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    if (!targetInfos.some((target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`))) return true;
    // A worker that ends between the listing and this check counts as not yet restarted.
    try {
      const restarted = await env.worker();
      try {
        return (await restarted.evaluate("globalThis.beforeCrash")) !== true;
      } finally {
        await restarted.close().catch(ignore("the worker may have ended meanwhile"));
      }
    } catch {
      return false;
    }
  }, { message: "the extension's service worker to end with its process" });
  return targetId;
}

test("the extension reconnects by itself after its process crashes", async () => {
  const session = await env.session();
  await session.js(`await cua.getState();`);

  const crashedTab = await crashExtensionProcess();
  try {
    // The browser starts the service worker again on its next alarm, scheduled every 30 s.
    const reconnected = await until(() => session.js(`await cua.getState(); nodeRepl.write("connected");`).catch(() => ""), {
      timeoutMs: 75_000,
      intervalMs: 1_000,
      message: "the extension to reconnect",
    });
    assert.match(reconnected, /connected/);
  } finally {
    await env.browser.cdp.send("Target.closeTarget", { targetId: crashedTab }).catch(ignore("the crashed tab may be gone already"));
  }
});
