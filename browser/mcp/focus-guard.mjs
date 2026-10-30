// Keeps the user's app in front while the agent works. Brave brings its window to the front when a
// page opens a tab or window (target=_blank, window.open), also when the agent's input caused it. The
// guard notes the frontmost app before the agent's clicks and key presses, and when a page of a tab it
// just gave input to opens something and the browser took the front, it gives the front back. macOS only.

import { execFile } from "node:child_process";
import { AGENT_INPUT_WINDOW_MS, isPressInput } from "../extension/shared.js";

const CHECK_DELAYS_MS = [20, 50, 80, 120, 180, 260, 400, 700, 1_000, 1_500];
const FRONT_CACHE_MS = 500;
// The test suite runs without it: its browsers stay in the background, so any browser in front is the user's.
const enabled = process.platform === "darwin" && !process.env.BRUSE_NO_FOCUS_GUARD;

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, { timeout: 2_000 }, (error, stdout) => resolve(error ? "" : stdout)));
}

async function frontmostApp() {
  const asn = (await run("lsappinfo", ["front"])).trim();
  if (!asn) return null;
  return (await run("lsappinfo", ["info", "-only", "bundleid", asn])).match(/bundleID="([^"]+)"/)?.[1] ?? null;
}

const inputs = new Map(); // tab id -> { app, at } for the agent's latest input
let cached = { app: null, at: 0 };

// Called before the agent's input reaches a tab.
export async function beforeInput(tabId) {
  if (!enabled) return;
  if (Date.now() - cached.at > FRONT_CACHE_MS) cached = { app: await frontmostApp(), at: Date.now() };
  inputs.set(tabId, { app: cached.app, at: Date.now() });
}

// Chromium-based browsers the extension may run in; only one of them taking the front is undone, so
// a switch the user makes to another app in the meantime stands.
const BROWSER_BUNDLE = /^(com\.brave\.Browser|com\.google\.Chrome|org\.chromium\.Chromium|com\.microsoft\.edgemac|com\.vivaldi\.Vivaldi|com\.operasoftware\.Opera|company\.thebrowser\.Browser)/;

// Called for every browser event; reacts to a tab or window opened by a page of a tab with recent input.
export function onEvent(event) {
  if (!enabled || (event.method !== "Page.windowOpen" && event.method !== "tabs.opened")) return;
  const input = inputs.get(event.tabId);
  if (!input?.app || BROWSER_BUNDLE.test(input.app) || Date.now() - input.at > AGENT_INPUT_WINDOW_MS) return;
  if (input.guarding) return;
  input.guarding = true;
  // The browser takes the front once per opening, within moments. One restore undoes it; after that,
  // the browser in front is the user's own choice.
  const check = async (index) => {
    const front = await frontmostApp();
    if (front && BROWSER_BUNDLE.test(front)) {
      cached = { app: null, at: 0 };
      // Only an app that still runs; `open` would launch one the user quit.
      if ((await run("lsappinfo", ["find", `bundleid=${input.app}`])).trim()) await run("open", ["-b", input.app]);
      return;
    }
    // The user's own switch to another app ends the guard too.
    if (front && front !== input.app) return;
    if (index + 1 < CHECK_DELAYS_MS.length) setTimeout(() => check(index + 1), CHECK_DELAYS_MS[index + 1] - CHECK_DELAYS_MS[index]);
  };
  setTimeout(() => check(0), CHECK_DELAYS_MS[0]);
}

// Browser calls whose input can make a page open a tab.
export function isOpeningInput(method, params) {
  return method === "cdp" && isPressInput(params?.method, params?.params);
}
