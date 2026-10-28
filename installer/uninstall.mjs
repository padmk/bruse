// Removes what setup added: the MCP registrations, the installed copy and the pairing state. The
// browser extension is removed by the user on the extensions page.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentClients, fail, installRoot, installed, moveToTrash, note, product, source, step } from "./lib.mjs";

export async function uninstall() {
  step(`Uninstalling ${product}`);
  const { STATE_DIR } = await import(join(existsSync(installed) ? installed : source, "mcp", "config.mjs"));
  let failed = 0;
  for (const client of agentClients()) {
    if (!client.registeredPath()) {
      note(`${client.name}: was not registered`);
      continue;
    }
    const result = client.remove();
    if (result.status === 0) note(`${client.name}: removed`);
    else {
      failed++;
      note(`${client.name}: failed (${(result.stderr || result.stdout).trim()})`);
    }
  }
  // A registration left behind must still find its server, so the files stay until it is gone.
  if (failed) fail("Removing the MCP server failed for an agent CLI (see above); the installed files were kept.");
  for (const path of [installRoot, STATE_DIR]) {
    if (!existsSync(path)) continue;
    moveToTrash(path);
    note(`Moved ${path} to the Trash`);
  }
  step(`Remove the ${product} extension on the browser's extensions page to finish.`);
}
