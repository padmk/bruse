// Checks an installation step by step and says what to do about each problem.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE_MAJOR, agentClients, installed, installedVersion, manifest, note, product, serverPath, source, step } from "./lib.mjs";

export async function doctor() {
  let problems = 0;
  const ok = (text) => note(`\x1b[32m✓\x1b[0m ${text}`);
  const bad = (text) => {
    problems++;
    note(`\x1b[31m✗\x1b[0m ${text}`);
  };
  step(`${product} ${manifest.version}`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) ok(`Node.js ${process.version}`);
  else bad(`Node.js ${process.version} is too old; ${product} needs ${MIN_NODE_MAJOR} or newer.`);

  const copy = installedVersion();
  if (!copy) bad(`Not installed in ${installed}; run \`bruse setup\`.`);
  else if (copy !== manifest.version) bad(`The installed copy is ${copy}; run \`bruse setup\` to install ${manifest.version}.`);
  else ok(`Installed in ${installed}`);

  const clients = agentClients();
  if (!clients.length) note("No Claude Code or Codex CLI found; register the MCP server with your client by hand (see the README).");
  for (const client of clients) {
    const registration = client.registration();
    if (!registration) bad(`${client.name}: could not read its MCP configuration.`);
    else if (registration.path === serverPath) ok(`${client.name}: registered`);
    else if (registration.path) bad(`${client.name}: registered with ${registration.path}, not the installed copy; run \`bruse setup\`.`);
    else bad(`${client.name}: not registered; run \`bruse setup\`.`);
  }

  // The installed copy's own modules, so the check talks to the hub the way agents do.
  const browserDir = copy ? installed : source;
  const { EXTENSION_SECRET_PATH } = await import(join(browserDir, "mcp", "config.mjs"));
  const { callBrowser } = await import(join(browserDir, "mcp", "browser-link.mjs"));
  if (existsSync(EXTENSION_SECRET_PATH)) ok("Paired with an extension");
  else bad("No extension has paired yet; load the extension (see `bruse setup`).");
  try {
    const info = await callBrowser("browser.info");
    if (info.version === manifest.version) ok(`Connected to ${info.name}, extension ${info.version}`);
    else bad(`Connected to ${info.name}, but its extension is ${info.version ? `version ${info.version}` : "an older version"}; run \`bruse setup\`.`);
  } catch (error) {
    bad(`The browser did not connect: ${error.message}`);
  }

  step(problems ? `${problems} problem${problems === 1 ? "" : "s"} found.` : "Everything looks right.");
  return problems === 0;
}
