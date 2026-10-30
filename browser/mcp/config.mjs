// MCP server settings. The extension's manifest carries its own copy of the product name.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HUB_PORT } from "../extension/shared.js";

// User-visible product name; the extension's manifest carries the same name.
export const PRODUCT_NAME = "Bruse";

export const PORT = HUB_PORT;

// Everything setup and the server keep for this user: the installed copy (browser/) and the pairing
// state (state/).
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), PRODUCT_NAME.toLowerCase());

export const STATE_DIR = process.env.BROWSER_CONTROL_STATE_DIR ?? join(DATA_DIR, "state");

// Secret that MCP servers present to the hub; web pages cannot read it, so they cannot drive the hub.
export const TOKEN_PATH = join(STATE_DIR, "hub-token");

// Code of the error a server gets when the hub on the port runs another version, which it cannot talk to.
export const HUB_VERSION_MISMATCH = "HUB_VERSION_MISMATCH";

// Secret the extension paired with on first connection; hub and extension prove it to each other.
export const EXTENSION_SECRET_PATH = join(STATE_DIR, "extension-secret");

// Chromium derives an extension's ID from the SHA-256 of its manifest key, written with letters a-p.
function extensionId(manifestKey) {
  const hash = createHash("sha256").update(Buffer.from(manifestKey, "base64")).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

// The extension the hub accepts: the unpacked copy, whose ID the manifest key pins.
export const EXTENSION_ORIGINS = new Set([`chrome-extension://${extensionId(manifest.key)}`]);

// The release version, from the manifest of the extension shipped with this server.
export const VERSION = manifest.version;
