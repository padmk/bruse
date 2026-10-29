// The toolbar popup: shows whether agents may use the browser, pauses or resumes them, shares the
// current tab with agents or stops sharing it, and holds the access settings (which tabs agents can use,
// and the optional history and bookmarks permissions).

import { ALL_TABS, accessMode, setAccessMode, setShared, sharedTabs } from "./access.js";
import { isPaused, setPaused } from "./pause.js";
import { tabOwner } from "./agent-state.js";

const status = document.getElementById("status-text");
const toggle = document.getElementById("toggle");
const hint = document.getElementById("hint");
document.getElementById("name").textContent = chrome.runtime.getManifest().name;

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
toggle.addEventListener("click", async () => {
  paused = !paused;
  await setPaused(paused);
  render(paused);
});

// --- Sharing ---

const shareButton = document.getElementById("share");
const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
const webPage = (url) => /^(https?|file):/.test(url ?? "");

function sharedItem(tab) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = tab.title || tab.url;
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "link";
  stop.textContent = "Stop";
  stop.addEventListener("click", async () => {
    await setShared(tab.id, false);
    await renderSharing();
  });
  item.append(label, stop);
  return item;
}

async function renderSharing() {
  const mode = await accessMode();
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === mode;
  document.getElementById("sharing").hidden = mode === ALL_TABS;
  const shared = await sharedTabs();
  const tabs = (await Promise.all([...shared].map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  document.getElementById("shared").replaceChildren(...tabs.map(sharedItem));
  const isShared = Boolean(current && shared.has(current.id));
  const ownedByAgent = Boolean(current && (await tabOwner(current.id)));
  shareButton.disabled = !current || ownedByAgent || (!isShared && !webPage(current.url));
  shareButton.textContent = ownedByAgent ? "This is an agent's tab" : isShared ? "Stop sharing this tab" : "Share this tab";
  shareButton.dataset.shared = String(isShared);
}

shareButton.addEventListener("click", async () => {
  await setShared(current.id, shareButton.dataset.shared !== "true");
  await renderSharing();
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener("change", async () => {
    await setAccessMode(radio.value);
    await renderSharing();
  });
}

await renderSharing();

// --- Optional permissions ---

for (const permission of ["history", "bookmarks"]) {
  const box = document.getElementById(`perm-${permission}`);
  box.checked = await chrome.permissions.contains({ permissions: [permission] });
  box.addEventListener("change", async () => {
    // The browser asks the user to confirm a new permission; a refusal leaves the box unchecked.
    box.checked = box.checked ? await chrome.permissions.request({ permissions: [permission] }) : !(await chrome.permissions.remove({ permissions: [permission] }));
  });
}
