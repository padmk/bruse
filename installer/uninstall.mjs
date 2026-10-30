// Removes what setup added: the MCP registrations, the installed copy and the pairing state. The
// browser extension is removed by the user on the extensions page.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentClients, fail, failureReason, installRoot, installed, moveToTrash, note, product, source, step } from "./lib.mjs";

export async function uninstall() {
  step(`Uninstalling ${product}`);
  const { STATE_DIR } = await import(join(existsSync(installed) ? installed : source, "mcp", "config.mjs"));
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
  for (const path of [installRoot, STATE_DIR]) {
    if (!existsSync(path)) continue;
    moveToTrash(path);
    note(`Moved ${path} to the Trash`);
  }
  step("To finish");
  note(`Remove the ${product} extension on the browser's extensions page.`);
  // The bruse command itself is a Homebrew package when it runs from Homebrew's Cellar.
  if (/\/Cellar\//.test(source)) note(`Run \`brew uninstall ${product.toLowerCase()}\` to remove the \`${product.toLowerCase()}\` command.`);
  note(`Restart agent sessions started before now; they keep running the removed MCP server until they end.`);
}
