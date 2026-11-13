// The user's switch that stops agents. While paused, the extension holds no debugger session and runs no
// agent request; the toolbar popup turns it on and off, and so does the browser's own "Cancel" on its
// debugging bar. The state lives in storage, so it survives restarts and every context sees one value.
// isPaused reads it from there each time: the change event that updates `paused` (for the toolbar badge
// and the listeners) arrives a moment after the user switches.

import { logFailure } from "./shared.js";

/** @typedef {(paused: boolean) => void} PausedListener */

/** @type {Set<PausedListener>} */
const listeners = new Set();
let paused = false;
chrome.storage.local.get("paused").then(({ paused: stored }) => apply(Boolean(stored))).catch(logFailure("Reading whether agents are paused"));

export const PAUSED_ERROR = `The user paused ${chrome.runtime.getManifest().name} in the browser, so agents cannot use it now. Tell the user; they can resume it from the ${chrome.runtime.getManifest().name} icon in the browser toolbar.`;

export async function isPaused() {
  const { paused: stored } = await chrome.storage.local.get("paused");
  return Boolean(stored);
}

/** @param {boolean} value */
export function setPaused(value) {
  return chrome.storage.local.set({ paused: Boolean(value) });
}

// Called with the new state whenever it changes.
/** @param {PausedListener} listener */
export function onPausedChange(listener) {
  listeners.add(listener);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "paused" in changes) apply(Boolean(changes.paused.newValue));
});

/** @param {boolean} value */
function apply(value) {
  const changed = value !== paused;
  paused = value;
  const name = chrome.runtime.getManifest().name;
  chrome.action.setBadgeText({ text: paused ? "II" : "" }).catch(logFailure("Showing the paused state on the toolbar badge"));
  chrome.action.setBadgeBackgroundColor({ color: "#b3261e" }).catch(logFailure("Coloring the toolbar badge"));
  chrome.action.setTitle({ title: paused ? `${name}: agents paused` : name }).catch(logFailure("Showing the paused state in the toolbar title"));
  if (changed) for (const listener of listeners) listener(paused);
}
