// The secret the extension and the hub prove to each other. The native host creates it on first use, and
// setup creates it too, because a hub of a version before native pairing stores a secret that any local
// process offers while none exists.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXTENSION_SECRET_PATH, STATE_DIR } from "../mcp/config.mjs";

// Returns the secret in `stateDir`, creating it only when there is none.
export function ensureExtensionSecret(stateDir = STATE_DIR) {
  const path = join(stateDir, basename(EXTENSION_SECRET_PATH));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  return readFileSync(path, "utf8").trim();
}
