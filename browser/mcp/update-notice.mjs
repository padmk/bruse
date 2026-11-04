// Tells the agent, once per session, that a newer version is installed than the copy this server runs
// from. A package upgrade (such as `brew upgrade bruse`) replaces the command, but agents keep the
// installed copy until the user runs `bruse setup`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME, UPDATE_SOURCE_FILE, VERSION } from "./config.mjs";

const ownCopy = fileURLToPath(new URL("..", import.meta.url));

const manifestVersion = (browserDir) => JSON.parse(readFileSync(join(browserDir, "extension", "manifest.json"), "utf8")).version;

// The version in the folder setup copied from, when setup has not installed it yet. A checkout or a test
// copy has no record, and a moved or removed source has nothing to compare. When setup already replaced
// this copy (a session started before it), the extension's version note tells the agent to start a new
// session instead (see browserInfo in cua/index.mjs).
function waitingVersion() {
  try {
    const { browserDir } = JSON.parse(readFileSync(join(ownCopy, UPDATE_SOURCE_FILE), "utf8"));
    const version = manifestVersion(browserDir);
    if (typeof version !== "string" || version === VERSION) return null;
    return version === manifestVersion(ownCopy) ? null : version;
  } catch {
    return null;
  }
}

let told = false;

// The note to add to a tool result, or null once told or while nothing waits.
export function updateNotice() {
  if (told) return null;
  const version = waitingVersion();
  if (!version) return null;
  told = true;
  const command = PRODUCT_NAME.toLowerCase();
  return `${PRODUCT_NAME} ${version} is installed, but this session uses ${VERSION}. Tell the user to run \`${command} setup\` in a terminal to finish the update; agent sessions started after that use ${version}.`;
}
