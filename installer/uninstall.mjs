// Removes what setup added: the MCP registrations, the installed copy and the pairing state. The
// browser extension is removed by the user on the extensions page.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentClients, installRoot, installed, moveToTrash, note, product, source, step } from "./lib.mjs";

export async function uninstall() {
  step(`Uninstalling ${product}`);
  const { STATE_DIR } = await import(join(existsSync(installed) ? installed : source, "mcp", "config.mjs"));
  for (const client of agentClients()) {
    const result = client.remove();
    note(`${client.name}: ${result.status === 0 ? "removed" : "was not registered"}`);
  }
  for (const path of [installRoot, STATE_DIR]) {
    if (!existsSync(path)) continue;
    moveToTrash(path);
    note(`Moved ${path} to the Trash`);
  }
  step(`Remove the ${product} extension on the browser's extensions page to finish.`);
}
