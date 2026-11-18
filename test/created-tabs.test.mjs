import assert from "node:assert/strict";
import { test } from "node:test";
import { tabsOpenedByWindowCreate } from "../browser/extension/created-tabs.js";

/** @param {number} id @param {number} index */
const tab = (id, index) => /** @type {chrome.tabs.Tab} */ ({ id, index });

test("a tab that joined the new window before it was reported is not counted as opened by the call", () => {
  const ids = (options, tabs) => tabsOpenedByWindowCreate(options, tabs).map((t) => t.id);
  assert.deepEqual(ids({ url: "https://example.com" }, [tab(1, 0), tab(9, 1)]), [1]);
  assert.deepEqual(ids({ url: ["https://a.test", "https://b.test"] }, [tab(9, 2), tab(2, 1), tab(1, 0)]), [1, 2]);
  assert.deepEqual(ids({}, [tab(1, 0), tab(9, 1)]), [1]);
  assert.deepEqual(ids({ tabId: 5 }, [tab(5, 0), tab(9, 1)]), []);
  assert.deepEqual(ids({ tabId: 5, url: "https://a.test" }, [tab(5, 0), tab(1, 1), tab(9, 2)]), [1]);
});
