// Keeps the user's app in front while the agent works. Brave brings its window to the front when a
// page opens a tab or window (target=_blank, window.open), also when the agent's input caused it. The
// guard notes the frontmost app before the agent's clicks and key presses, and when a page of a tab it
// just gave input to opens something and another app took the front, it gives the front back. macOS only.

import { execFile } from "node:child_process";

const INPUT_WINDOW_MS = 4_000; // how long after the agent's input an opening counts as caused by it
const CHECK_DELAYS_MS = [20, 50, 80, 120, 180, 260, 400, 700, 1_000, 1_500, 2_200, 3_000];
const FRONT_CACHE_MS = 500;
const enabled = process.platform === "darwin";

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

// Called for every browser event; reacts to a tab or window opened by a page of a tab with recent input.
export function onEvent(event) {
  if (!enabled || (event.method !== "Page.windowOpen" && event.method !== "tabs.opened")) return;
  const input = inputs.get(event.tabId);
  if (!input?.app || Date.now() - input.at > INPUT_WINDOW_MS) return;
  for (const delay of CHECK_DELAYS_MS) {
    setTimeout(async () => {
      const front = await frontmostApp();
      if (front && front !== input.app) {
        cached = { app: null, at: 0 };
        await run("open", ["-b", input.app]);
      }
    }, delay);
  }
}

// Input events that can make a page open a tab: a pressed mouse button or key.
export function isOpeningInput(method, params) {
  if (method !== "cdp") return false;
  const type = params?.params?.type;
  return (params.method === "Input.dispatchMouseEvent" && type === "mousePressed") || (params.method === "Input.dispatchKeyEvent" && (type === "keyDown" || type === "rawKeyDown"));
}
