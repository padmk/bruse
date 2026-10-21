// Builds dist/<Product>-<version>.zip: the browser files, the installer and a double-click entry point.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { name, version } = JSON.parse(readFileSync(join(root, "browser", "extension", "manifest.json"), "utf8"));
const bundleName = `${name}-${version}`;
const stage = join(tmpdir(), `package-${process.pid}`, bundleName);
const skip = (path) => !path.endsWith(".DS_Store") && !path.endsWith("icon-source.png");

mkdirSync(stage, { recursive: true });
cpSync(join(root, "browser"), join(stage, "browser"), { recursive: true, filter: skip });
cpSync(join(root, "installer", "install.mjs"), join(stage, "installer", "install.mjs"));
cpSync(join(root, "installer", "Install.command"), join(stage, `Install ${name}.command`));
chmodSync(join(stage, `Install ${name}.command`), 0o755);

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const zip = join(dist, `${bundleName}.zip`);
if (existsSync(zip)) execFileSync("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(zip)} as alias)`]);
execFileSync("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--keepParent", stage, zip]);
console.log(zip);
