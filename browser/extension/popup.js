// The toolbar popup: shows whether agents may use the browser, pauses or resumes them, shares the
// current tab with agents or stops sharing it, and holds the access settings (which tabs agents can use,
// and the optional history and bookmarks permissions).

import { ALL_TABS, accessMode, setAccessMode, setShared, sharedTabs } from "./access.js";
import { isPaused, setPaused } from "./pause.js";
import { tabOwner } from "./agent-state.js";
import { logFailure } from "./shared.js";

// An element of popup.html, which has each one this script looks up.
/**
 * @template {HTMLElement} E
 * @param {string} id
 * @param {{ new (): E, prototype: E }} type
 * @returns {E}
 */
function element(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`popup.html has no ${type.name} #${id}`);
  return found;
}

const status = element("status-text", HTMLElement);
const toggle = element("toggle", HTMLButtonElement);
const hint = element("hint", HTMLElement);
element("name", HTMLElement).textContent = chrome.runtime.getManifest().name;

/** @param {boolean} paused */
function render(paused) {
  document.body.classList.toggle("paused", paused);
  status.textContent = paused ? "Agents are paused" : "Agents can use this browser";
  toggle.textContent = paused ? "Resume agents" : "Pause agents";
  hint.textContent = paused
    ? "Agents get an error until you resume. Their tabs stay open."
    : "Pausing stops agents at once and detaches them from every tab.";
}

let paused = await isPaused();
render(paused);
// The popup shows the new state once it is stored: closing the popup right after a click keeps it.
toggle.addEventListener("click", () => {
  paused = !paused;
  setPaused(paused)
    .then(() => render(paused))
    .catch(logFailure("Pausing or resuming agents"));
});

// --- Sharing ---

const shareButton = element("share", HTMLButtonElement);
const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
/** @param {string | undefined} url */
const webPage = (url) => /^(https?|file):/.test(url ?? "");
const modeRadios = [...document.querySelectorAll('input[name="mode"]')].filter((radio) => radio instanceof HTMLInputElement);

/** @param {number} tabId @param {chrome.tabs.Tab} tab */
function sharedItem(tabId, tab) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = tab.title || tab.url || "";
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "link";
  stop.textContent = "Stop";
  stop.addEventListener("click", () => {
    setShared(tabId, false)
      .then(renderSharing)
      .catch(logFailure("Stopping the share"));
  });
  item.append(label, stop);
  return item;
}

async function renderSharing() {
  const mode = await accessMode();
  for (const radio of modeRadios) radio.checked = radio.value === mode;
  element("sharing", HTMLElement).hidden = mode === ALL_TABS;
  const shared = await sharedTabs();
  const tabs = await Promise.all([...shared].map(async (id) => /** @type {const} */ ([id, await chrome.tabs.get(id).catch(() => null)])));
  element("shared", HTMLElement).replaceChildren(...tabs.flatMap(([id, tab]) => (tab ? [sharedItem(id, tab)] : [])));
  const currentId = current?.id;
  const isShared = currentId !== undefined && shared.has(currentId);
  const ownedByAgent = currentId !== undefined && Boolean(await tabOwner(currentId));
  shareButton.disabled = !current || ownedByAgent || (!isShared && !webPage(current.url));
  shareButton.textContent = ownedByAgent ? "This is an agent's tab" : isShared ? "Stop sharing this tab" : "Share this tab";
  shareButton.dataset.shared = String(isShared);
}

// The button is disabled without a current tab.
shareButton.addEventListener("click", () => {
  if (current?.id === undefined) return;
  setShared(current.id, shareButton.dataset.shared !== "true")
    .then(renderSharing)
    .catch(logFailure("Sharing the tab or stopping the share"));
});

for (const radio of modeRadios) {
  radio.addEventListener("change", () => {
    setAccessMode(radio.value)
      .then(renderSharing)
      .catch(logFailure("Changing which tabs agents can use"));
  });
}

await renderSharing();

// --- Optional permissions ---

for (const permission of /** @type {const} */ (["history", "bookmarks"])) {
  const box = element(`perm-${permission}`, HTMLInputElement);
  box.checked = await chrome.permissions.contains({ permissions: [permission] });
  box.addEventListener("change", () => {
    // The browser asks the user to confirm a new permission; a refusal leaves the box unchecked.
    (box.checked ? chrome.permissions.request({ permissions: [permission] }) : chrome.permissions.remove({ permissions: [permission] }).then((removed) => !removed))
      .then((checked) => {
        box.checked = checked;
      })
      .catch(logFailure(`Changing the ${permission} permission`));
  });
}
