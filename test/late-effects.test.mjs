import assert from "node:assert/strict";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startEnvironment, tempDir, until } from "./harness.mjs";
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

test("a key held by a call that times out is released afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const page = `<title>Key held</title><script>addEventListener("keyup", (event) => (document.title = "Released " + event.key))</script>`;
  await s.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(`data:text/html,${page}`)});`);
  await until(() => tabTitled("Key held"), { message: "the page to open" });
  const { result } = await s.request("tools/call", {
    name: "js",
    arguments: { code: `await tab.cdpSender()("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }); await new Promise(() => {});`, timeout_ms: 1_000 },
  });
  assert.match(result.content.map((item) => item.text).join("\n"), /timed out/);
  await until(() => tabTitled("Released Shift"), { message: "the held Shift to be released" });
});

test("a key whose release is cancelled with its call is released afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const page = `<title>Release held</title><script>addEventListener("keyup", (event) => (document.title = "Released " + event.key))</script>`;
  await s.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(`data:text/html,${page}`)}); const send = tab.cdpSender();`);
  await until(() => tabTitled("Release held"), { message: "the page to open" });
  await s.js(`await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });`);
  // Holds the key-up at the debugger's check of the pause switch, so the call times out while it waits.
  const hold = await env.holdCall("chrome.storage.local.get", `args[0] === "paused" && stack.includes("requireDebugAccess")`);
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  const reply = s.request("tools/call", { name: "js", arguments: { code: `await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });`, timeout_ms: 1_000 } });
  await hold.held();
  const { result } = await reply;
  assert.match(result.content.map((item) => item.text).join("\n"), /timed out/);
  await hold.release();
  await until(() => tabTitled("Released Shift"), { message: "the held Shift to be released" });
});

test("a held key's release survives the cancel of a later call", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const page = `<title>Release survives</title><script>addEventListener("keyup", (event) => (document.title = "Released " + event.key))</script>`;
  await s.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(`data:text/html,${page}`)}); const send = tab.cdpSender();`);
  await until(() => tabTitled("Release survives"), { message: "the page to open" });
  await s.js(`await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });`);
  // Holds the server's release of the key, the next debugger command, at its check of the pause switch.
  const hold = await env.holdCall("chrome.storage.local.get", `args[0] === "paused" && stack.includes("requireDebugAccess")`);
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  const first = await s.request("tools/call", { name: "js", arguments: { code: "await new Promise(() => {});", timeout_ms: 500 } });
  assert.match(first.result.content.map((item) => item.text).join("\n"), /timed out/);
  await hold.held();
  // A second call that times out cancels the session's requests again while the release waits.
  const second = await s.request("tools/call", { name: "js", arguments: { code: "await new Promise(() => {});", timeout_ms: 500 } });
  assert.match(second.result.content.map((item) => item.text).join("\n"), /timed out/);
  await hold.release();
  await until(() => tabTitled("Released Shift"), { message: "the held Shift to be released" });
});

// js_reset keeps the worker when it answers in time; code left from before the reset must not act either.
test("a close held at its last check when the REPL is reset does not happen afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const { opened, hold } = await heldClose(s, "Reset probe");
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  // The close goes on after its call returned.
  await s.js("globalThis.closing = tab.close().catch(() => {});");
  await hold.held();
  const { result } = await s.request("tools/call", { name: "js_reset", arguments: {} });
  assert.match(result.content.map((item) => item.text).join("\n"), /The REPL was reset\.$/);
  await hold.release();
  assert.ok(await staysOpen(opened.id), "the tab stays open");
});

test("a mark held before the REPL is reset is not saved afterwards", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  await s.js(`const tab = await cua.createBrowserTab("1", "data:text/html,<title>Mark probe</title>");`);
  const opened = await until(() => tabTitled("Mark probe"), { message: "Mark probe to open" });
  const hold = await env.holdCall("chrome.storage.local.get", `args[0] === "agentState" && stack.includes("markTabNow")`);
  t.after(() => hold.release().catch(ignore("cleanup: a release the test made already fails")));
  await s.js("globalThis.marking = tab.markDeliverable().catch(() => {});");
  await hold.held();
  const { result } = await s.request("tools/call", { name: "js_reset", arguments: {} });
  assert.match(result.content.map((item) => item.text).join("\n"), /The REPL was reset\.$/);
  await hold.release();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const mark = await env.inPopup(`chrome.storage.local.get("agentState").then(({ agentState }) => agentState?.tabs?.[${opened.id}]?.mark ?? null)`);
  assert.equal(mark, null, "the cancelled mark is not saved");
});

test("a key held before the REPL is reset is released", async (t) => {
  const s = await env.session();
  t.after(() => s.close());
  const page = `<title>Reset key</title><script>addEventListener("keyup", (event) => (document.title = "Released " + event.key))</script>`;
  await s.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(`data:text/html,${page}`)});`);
  await until(() => tabTitled("Reset key"), { message: "the page to open" });
  await s.js(`await tab.cdpSender()("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });`);
  await s.request("tools/call", { name: "js_reset", arguments: {} });
  await until(() => tabTitled("Released Shift"), { message: "the held Shift to be released" });
});

// Before a press the server asks macOS which app is in front (the focus guard, see focus-guard.mjs), and
// it waits for the answer. Here the answer never comes (lsappinfo hangs until its 2 s limit), so the
// press waits while the REPL is reset.
test("a press waiting for the front app when the REPL is reset never reaches the page", { skip: process.platform !== "darwin" }, async (t) => {
  const bin = tempDir("bin");
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "lsappinfo"), "#!/bin/sh\nsleep 10\n");
  chmodSync(join(bin, "lsappinfo"), 0o755);
  const s = await env.session({ env: { BRUSE_NO_FOCUS_GUARD: "", PATH: `${bin}:${process.env.PATH}` } });
  t.after(() => s.close());
  const page = `<title>Waiting press</title><script>addEventListener("keydown", (event) => (document.title = "Pressed " + event.key))</script>`;
  await s.js(`const tab = await cua.createBrowserTab("1", ${JSON.stringify(`data:text/html,${page}`)}); const send = tab.cdpSender();`);
  await until(() => tabTitled("Waiting press"), { message: "the page to open" });
  await s.js(`globalThis.pressing = send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }).catch(() => null);`);
  const { result } = await s.request("tools/call", { name: "js_reset", arguments: {} });
  assert.match(result.content.map((item) => item.text).join("\n"), /The REPL was reset/);
  // Past the front app's 2 s limit, after which the press would go out.
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.ok(await tabTitled("Waiting press"), "the press never reached the page");
});
