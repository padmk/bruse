// Registers the pairing host (browser/native-host/pairing.mjs) with the Chromium browsers of this user.
// Each browser looks for host manifests in NativeMessagingHosts inside its user data directory; the
// manifest names the extension IDs allowed to start the host. Chromium starts hosts with a minimal
// environment, so the manifest points at a launcher script with absolute paths.

import { accessSync, constants, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { extensionId } from "../browser/mcp/config.mjs";
import { PAIRING_HOST } from "../browser/extension/shared.js";

// User data directories of the Chromium browsers that load the extension.
export function browserDataDirs({ home = homedir(), os = platform(), config = process.env.XDG_CONFIG_HOME || join(home, ".config") } = {}) {
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support");
    return ["BraveSoftware/Brave-Browser", "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Google/Chrome for Testing", "Chromium", "Microsoft Edge", "Vivaldi"].map((dir) => join(support, dir));
  }
  return ["BraveSoftware/Brave-Browser", "google-chrome", "google-chrome-beta", "chromium", "microsoft-edge", "vivaldi"].map((dir) => join(config, dir));
}

export const hostManifestPath = (dataDir) => join(dataDir, "NativeMessagingHosts", `${PAIRING_HOST}.json`);

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Writes the launcher (by default next to the host) and a manifest into every given browser data
// directory. The launcher pins the state directory that this setup resolved (or `stateDir`),
// because the browser starts the host without the user's shell environment (XDG_DATA_HOME), and the hub
// must read the same secret. Returns the manifests written.
export async function installPairingHost({ browserDir, node, dataDirs = browserDataDirs(), stateDir, launcher = join(browserDir, "native-host", "pairing-host") }) {
  const { EXTENSION_ORIGINS, STATE_DIR } = await import(join(browserDir, "mcp", "config.mjs"));
  const env = `BROWSER_CONTROL_STATE_DIR=${shellQuote(stateDir ?? STATE_DIR)}`;
  writeFileSync(launcher, `#!/bin/sh\n# node: ${JSON.stringify(node)}\n${env} exec ${shellQuote(node)} ${shellQuote(join(browserDir, "native-host", "pairing.mjs"))}\n`);
  chmodSync(launcher, 0o755);
  const manifest = {
    name: PAIRING_HOST,
    description: "Gives the browser extension the secret it authenticates the local MCP hub with",
    path: launcher,
    type: "stdio",
    allowed_origins: [...EXTENSION_ORIGINS].map((origin) => `${origin}/`),
  };
  const written = [];
  for (const dataDir of dataDirs) {
    const path = hostManifestPath(dataDir);
    mkdirSync(join(dataDir, "NativeMessagingHosts"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    written.push(path);
  }
  return written;
}

// Manifests that point at this launcher, by browser data directory.
export function installedPairingHosts(launcherDir) {
  return browserDataDirs()
    .map((dataDir) => {
      try {
        return { dataDir, path: hostManifestPath(dataDir), launcher: JSON.parse(readFileSync(hostManifestPath(dataDir), "utf8")).path };
      } catch {
        return null;
      }
    })
    .filter((host) => host && (!launcherDir || host.launcher === join(launcherDir, "native-host", "pairing-host")));
}

// Validate every registered location, including malformed JSON and a missing executable.
export function pairingHostProblems(browserDir, dataDirs = browserDataDirs()) {
  const launcher = join(browserDir, "native-host", "pairing-host");
  return dataDirs.flatMap((dir) => {
    const path = hostManifestPath(dir);
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.name !== PAIRING_HOST || value.path !== launcher || value.type !== "stdio") throw new Error("incorrect host manifest");
      const { key } = JSON.parse(readFileSync(join(browserDir, "extension", "manifest.json"), "utf8"));
      const id = extensionId(key);
      if (JSON.stringify(value.allowed_origins) !== JSON.stringify([`chrome-extension://${id}/`])) throw new Error("incorrect allowed_origins");
      accessSync(launcher, constants.X_OK);
      const node = JSON.parse(readFileSync(launcher, "utf8").match(/^# node: (.+)$/m)?.[1] ?? "null");
      if (typeof node !== "string") throw new Error("invalid launcher");
      accessSync(node, constants.X_OK);
      accessSync(join(browserDir, "native-host", "pairing.mjs"), constants.R_OK);
      return [];
    } catch (error) {
      return [`${path}: ${error.message}. Run bruse setup.`];
    }
  });
}
