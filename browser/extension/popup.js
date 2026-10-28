// The toolbar popup: shows whether agents may use the browser and pauses or resumes them.

import { isPaused, setPaused } from "./pause.js";

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
toggle.addEventListener("click", async () => {
  paused = !paused;
  render(paused);
  await setPaused(paused);
});
