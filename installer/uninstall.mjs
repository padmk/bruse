// Removes what setup added: the MCP registrations, the installed copy and the pairing state. The user
// removes the extension on the extensions page, which this opens: the browser lets an extension remove
// itself without asking, or with a dialog only after a click, and agents must not be able to do the former.

import { installedPairingHosts } from "./native-host.mjs";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { agentClients, fail, failureReason, installRoot, installed, installedBrowser, moveToTrash, note, product, showPage, source, step } from "./lib.mjs";

export async function uninstall() {
  step(`Uninstalling ${product}`);
  const browserDir = existsSync(installed) ? installed : source;
  const { STATE_DIR } = await import(join(browserDir, "mcp", "config.mjs"));
  let failed = 0;
  for (const client of agentClients()) {
    const registration = client.registration();
    if (registration && !registration.path) {
      note(`${client.name}: was not registered`);
      continue;
    }
    const result = client.remove();
    if (result.status === 0) note(`${client.name}: removed`);
    else {
      failed++;
      note(`${client.name}: failed (${failureReason(result)})`);
    }
  }
  // A registration left behind, or one that could not be checked and removed, must still find its
  // server, so the files stay until it is gone.
  if (failed) fail("Removing the MCP server failed for an agent CLI (see above); the installed files were kept.");
  const left = [];
  for (const host of installedPairingHosts(installed)) {
    try {
      note(`Moving ${host.path} to the Trash`);
      moveToTrash(host.path);
    } catch (error) {
      fail(`Could not remove ${host.path}: ${error.message}. The installed files were kept; retry bruse uninstall.`);
    }
  }
  for (const path of [installRoot, STATE_DIR]) {
    if (!existsSync(path)) continue;
    // Moving the rest would leave an installation that remains without its pairing.
    if (left.includes(installRoot) && `${resolve(path)}${sep}`.startsWith(`${installRoot}${sep}`)) {
      note(`Kept ${path} with the installation it is in`);
      continue;
    }
    try {
      moveToTrash(path);
      note(`Moved ${path} to the Trash`);
    } catch (error) {
      left.push(path);
      note(`Could not move ${path} to the Trash: ${error.message}`);
    }
  }
  step("To finish");
  const browser = installedBrowser();
  note(`Remove the ${product} extension on the extensions page of the browser you loaded it in${browser ? ` (this opens ${browser.page})` : ""}.`);
  if (browser && !process.env.BRUSE_NO_OPEN) showPage(browser.app, browser.page);
  // The bruse command itself is a Homebrew package when it runs from Homebrew's Cellar.
  if (/\/Cellar\//.test(source)) note(`Run \`brew uninstall ${product.toLowerCase()}\` to remove the \`${product.toLowerCase()}\` command.`);
  note(`Restart agent sessions started before now; they keep running the removed MCP server until they end.`);
  if (left.length) fail(`These are left in place; move them to the Trash by hand: ${left.join(", ")}`);
}
