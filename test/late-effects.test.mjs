import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startEnvironment, until } from "./harness.mjs";
import { ignore } from "../browser/extension/shared.js";

// A js call that times out or is cancelled ends with its REPL replaced. Browser requests it already sent
// may still be waiting in the extension for their last check; they must not take effect after the call
// has ended.

let env;
before(async () => {
  env = await startEnvironment();
});
after(async () => {
  await env?.close();
});

// Whether the tab is still open `ms` after the call, checked every 100 ms.
async function staysOpen(tabId, ms = 2_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await env.inPopup(`chrome.tabs.get(${tabId}).then(() => true, () => false)`))) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

const tabTitled = (title) => env.inPopup(`chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.title === ${JSON.stringify(title)}) ?? null)`);

// Opens a tab in the session's REPL as `tab`, and holds the session's next close of it at its last check,
// where the extension reads the agent state.
async function heldClose(s, title) {
  await s.js(`const tab = await cua.createBrowserTab("1", "data:text/html,<title>${title}</title>");`);
  const opened = await until(() => tabTitled(title), { message: `${title} to open` });
  const hold = await env.holdCall("chrome.storage.local.get", `args[0] === "agentState" && stack.includes("requireAgentEffect")`);
  return { opened, hold };
}

test("a close held at its last check when its call times out does not happen afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const { opened, hold } = await heldClose(s, "Timeout probe");
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  const reply = s.request("tools/call", { name: "js", arguments: { code: "await tab.close();", timeout_ms: 500 } });
  await hold.held();
  const { result } = await reply;
  assert.ok(result.isError, "the call reports its timeout");
  assert.match(result.content.map((item) => item.text).join("\n"), /timed out/);
  await hold.release();
  assert.ok(await staysOpen(opened.id), "the tab stays open");
});

test("a close held at its last check when its call is cancelled does not happen afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const { opened, hold } = await heldClose(s, "Cancel probe");
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  const id = s.nextRequestId;
  s.request("tools/call", { name: "js", arguments: { code: "await tab.close();" } }).catch(ignore("a cancelled call gets no reply"));
  await hold.held();
  s.notify("notifications/cancelled", { requestId: id });
  // The cancellation replaces the REPL; a later call runs in the new one.
  assert.match(await s.js("nodeRepl.write('next call');"), /previous call was cancelled/);
  await hold.release();
  assert.ok(await staysOpen(opened.id), "the tab stays open");
});
