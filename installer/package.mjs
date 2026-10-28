// Builds dist/<Product>-<version>.zip: the browser files, the installer, a double-click entry point and
// installation instructions for agents.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
for (const file of ["install.mjs", "lib.mjs", "doctor.mjs", "uninstall.mjs"]) cpSync(join(root, "installer", file), join(stage, "installer", file));
cpSync(join(root, "bin", "bruse.mjs"), join(stage, "bin", "bruse.mjs"));
cpSync(join(root, "installer", "Install.command"), join(stage, `Install ${name}.command`));
chmodSync(join(stage, `Install ${name}.command`), 0o755);
for (const file of ["LICENSE", "SECURITY.md", "CHANGELOG.md"]) cpSync(join(root, file), join(stage, file));
// README links to files the package leaves out point to this version in the repository instead.
const { homepage } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\]\(([^)#:]+)\)/g, (link, path) =>
  existsSync(join(stage, path)) ? link : `](${homepage}/blob/v${version}/${path})`,
);
writeFileSync(join(stage, "README.md"), readme);
// Agents opened in the unpacked package read these: Codex reads AGENTS.md, Claude Code reads CLAUDE.md.
cpSync(join(root, "installer", "agent-instructions.md"), join(stage, "AGENTS.md"));
writeFileSync(join(stage, "CLAUDE.md"), "@AGENTS.md\n");

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const zip = join(dist, `${bundleName}.zip`);
if (existsSync(zip)) execFileSync("osascript", ["-e", `tell application "Finder" to delete (POSIX file ${JSON.stringify(zip)} as alias)`]);
execFileSync("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--keepParent", stage, zip]);
console.log(zip);
