import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extensionBuild } from "../browser/extension/shared.js";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "browser", "extension");
const manifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));

// The fingerprint of the extension folder with some files replaced, as a copy elsewhere would have them.
const buildWith = async (replaced = {}) => (await extensionBuild((file) => replaced[file] ?? readFile(join(extensionDir, file), "utf8"))).hash;
const unpacked = await buildWith();

test("the store package and a browser's copy of it have the unpacked folder's fingerprint", async () => {
  // scripts/store-package.mjs leaves out the key and writes the manifest again.
  const { key: _key, ...storeManifest } = manifest;
  assert.equal(await buildWith({ "manifest.json": `${JSON.stringify(storeManifest, null, 2)}\n` }), unpacked);
  // A browser that installs the store's package keeps the manifest with its own key and update URL.
  const installed = { update_url: "https://clients2.google.com/service/update2/crx", ...storeManifest, key: "c3RvcmUta2V5" };
  assert.equal(await buildWith({ "manifest.json": JSON.stringify(installed, null, 3) }), unpacked);
});

test("a change to the manifest or the code changes the fingerprint", async () => {
  const changed = [
    { ...manifest, permissions: [...manifest.permissions, "cookies"] },
    { ...manifest, host_permissions: ["https://example.com/*"] },
    { ...manifest, version: "0.0.1" },
    { ...manifest, minimum_chrome_version: "200" },
  ];
  for (const edited of changed) assert.notEqual(await buildWith({ "manifest.json": JSON.stringify(edited) }), unpacked, JSON.stringify(edited).slice(0, 200));
  const access = await readFile(join(extensionDir, "access.js"), "utf8");
  assert.notEqual(await buildWith({ "access.js": `${access}\n// changed` }), unpacked);
});
