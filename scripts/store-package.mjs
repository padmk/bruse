// Builds dist/<Product>-<version>-chrome-web-store.zip: the extension folder alone, with the manifest at
// the root, for upload to the Chrome Web Store. The store assigns its own extension ID and rejects a
// manifest "key", so the key that pins the ID of the unpacked extension is left out.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "browser", "extension");
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
const stage = join(mkdtempSync(join(tmpdir(), "store-package-")), "extension");

cpSync(extension, stage, { recursive: true, filter: (path) => !path.endsWith(".DS_Store") && !path.endsWith("icon-source.png") });
const { key: _key, ...storeManifest } = manifest;
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(storeManifest, null, 2)}\n`);

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const zip = join(dist, `${manifest.name}-${manifest.version}-chrome-web-store.zip`);
if (existsSync(zip)) execFileSync("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(zip)} as alias)`]);
// Zipped from inside the folder, so manifest.json is at the root of the archive.
execFileSync("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", stage, zip]);
console.log(zip);
