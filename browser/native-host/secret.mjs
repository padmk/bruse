// The secret the extension and the hub prove to each other. The native host creates it on first use, and
// setup creates it too, because a hub of a version before native pairing stores a secret that any local
// process offers while none exists.

import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXTENSION_SECRET_PATH, STATE_DIR } from "../mcp/config.mjs";

// What a complete secret looks like; the extension takes no other.
const SECRET = /^[0-9a-f]{64}$/;

/** @param {string} path @returns {string | null} the file's content, or null when there is no file */
function readSecret(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Returns the secret in `stateDir`, creating it only when there is none. A new secret is written in full
// to a file of its own first and then put in place, so that a crash or a full disk never leaves a partial
// secret behind; one left by an earlier version (empty or cut short) is replaced.
export function ensureExtensionSecret(stateDir = STATE_DIR) {
  const path = join(stateDir, basename(EXTENSION_SECRET_PATH));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  let stored = readSecret(path);
  if (stored === null || !SECRET.test(stored)) {
    const temp = join(stateDir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(temp, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx", flush: true });
      // A link does not replace a secret that another process put in place meanwhile.
      if (stored === null) {
        try {
          linkSync(temp, path);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        stored = readSecret(path);
      }
      if (stored === null || !SECRET.test(stored)) renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    stored = readSecret(path);
  }
  chmodSync(path, 0o600);
  if (stored === null || !SECRET.test(stored)) throw new Error(`The pairing secret in ${path} is not complete`);
  return stored;
}
