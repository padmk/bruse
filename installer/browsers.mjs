// The Chromium browsers Bruse supports: where each keeps its user data (where it also looks for native
// messaging hosts), how to tell that it is installed, and its extensions page.

import { accessSync, constants, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

// In the order setup prefers them for opening the extensions page. On macOS a browser is installed when
// one of its `apps` is in /Applications or ~/Applications; on Linux when one of its `commands` is on PATH.
// Chrome for Testing has neither, so it counts once its first data directory exists, that is, once it ran.
// Chrome's documentation names Google/ChromeForTesting for its hosts, while it keeps its data in
// Google/Chrome for Testing, so both get one.
const BROWSERS = [
  {
    name: "Brave",
    page: "brave://extensions",
    darwin: { apps: ["Brave Browser"], dirs: ["BraveSoftware/Brave-Browser"] },
    linux: { commands: ["brave-browser", "brave"], dirs: ["BraveSoftware/Brave-Browser"] },
  },
  {
    name: "Chrome",
    page: "chrome://extensions",
    darwin: { apps: ["Google Chrome"], dirs: ["Google/Chrome"] },
    linux: { commands: ["google-chrome", "google-chrome-stable"], dirs: ["google-chrome"] },
  },
  {
    name: "Edge",
    page: "edge://extensions",
    darwin: { apps: ["Microsoft Edge"], dirs: ["Microsoft Edge"] },
    linux: { commands: ["microsoft-edge", "microsoft-edge-stable"], dirs: ["microsoft-edge"] },
  },
  {
    name: "Chromium",
    page: "chrome://extensions",
    darwin: { apps: ["Chromium"], dirs: ["Chromium"] },
    linux: { commands: ["chromium", "chromium-browser"], dirs: ["chromium"] },
  },
  {
    name: "Vivaldi",
    page: "vivaldi://extensions",
    darwin: { apps: ["Vivaldi"], dirs: ["Vivaldi"] },
    linux: { commands: ["vivaldi", "vivaldi-stable"], dirs: ["vivaldi"] },
  },
  {
    name: "Chrome Beta",
    page: "chrome://extensions",
    darwin: { apps: ["Google Chrome Beta"], dirs: ["Google/Chrome Beta"] },
    linux: { commands: ["google-chrome-beta"], dirs: ["google-chrome-beta"] },
  },
  {
    name: "Chrome Canary",
    page: "chrome://extensions",
    darwin: { apps: ["Google Chrome Canary"], dirs: ["Google/Chrome Canary"] },
  },
  {
    name: "Chrome for Testing",
    page: "chrome://extensions",
    darwin: { dirs: ["Google/Chrome for Testing", "Google/ChromeForTesting"] },
    linux: { dirs: ["google-chrome-for-testing"] },
  },
];

const defaults = () => ({ home: homedir(), os: platform(), config: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), path: process.env.PATH ?? "" });

function onPath(command, path) {
  return path.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// The supported browsers of this platform, each with its data directories as absolute paths and whether
// it is installed.
function browsers(options = {}) {
  const { home, os, config, path } = { ...defaults(), ...options };
  const base = os === "darwin" ? join(home, "Library", "Application Support") : config;
  return BROWSERS.flatMap(({ name, page, ...platforms }) => {
    const entry = platforms[os === "darwin" ? "darwin" : "linux"];
    if (!entry) return [];
    const dataDirs = entry.dirs.map((dir) => join(base, dir));
    const app = entry.apps?.find((bundle) => ["/Applications", join(home, "Applications")].some((dir) => existsSync(join(dir, `${bundle}.app`))));
    const installed = entry.apps ? Boolean(app) : entry.commands ? entry.commands.some((command) => onPath(command, path)) : existsSync(dataDirs[0]);
    return [{ name, page, app, dataDirs, installed }];
  });
}

// Every data directory a supported browser may use on this platform, installed or not.
export const browserDataDirs = (options) => browsers(options).flatMap((browser) => browser.dataDirs);

// The data directories of the browsers installed here.
export const installedBrowserDataDirs = (options) => browsers(options).filter((browser) => browser.installed).flatMap((browser) => browser.dataDirs);

// The names of the supported browsers, for messages.
export const supportedBrowserNames = (options) => browsers(options).map((browser) => browser.name);

// The first installed browser on this Mac with an app, whose extensions page setup and uninstall open.
export function installedBrowser(options) {
  if ((options?.os ?? platform()) !== "darwin") return null;
  return browsers(options).find((browser) => browser.installed && browser.app) ?? null;
}
