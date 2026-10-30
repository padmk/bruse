// Checks an installation step by step and says what to do about each problem.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN_NODE_MAJOR, agentClients, clientId, installed, installedVersion, manifest, note, problemMessage, product, serverPath, source, step } from "./lib.mjs";

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

  // Setup registers only the clients the user picked, so an unregistered client is not a problem.
  const clients = agentClients();
  if (!clients.length) note("No supported agent client found; register the MCP server with your client by hand (see the README).");
  let registered = 0;
  for (const client of clients) {
    const registration = client.registration();
    if (!registration) bad(`${client.name}: could not read its MCP configuration.`);
    else if (registration.path === serverPath) {
      registered++;
      ok(`${client.name}: registered`);
    } else if (registration.path) bad(`${client.name}: registered with ${registration.path}, not the installed copy; run \`bruse setup --clients ${clientId(client)}\`.`);
    else note(`- ${client.name}: not registered (\`bruse setup --clients ${clientId(client)}\` adds it)`);
  }
  if (clients.length && !registered) bad("No agent client is registered; run `bruse setup`.");


  // The installed copy's own modules, so the check talks to the hub the way agents do.
  const browserDir = copy ? installed : source;
  const { EXTENSION_SECRET_PATH } = await import(join(browserDir, "mcp", "config.mjs"));
  const { callBrowser } = await import(join(browserDir, "mcp", "browser-link.mjs"));
  // The version stays the same between releases, so the code's fingerprint tells a browser that has
  // not reloaded the extension since an update.
  const { extensionBuild } = await import(join(browserDir, "extension", "shared.js"));
  const build = await extensionBuild((file) => readFile(join(browserDir, "extension", file), "utf8")).then(({ hash }) => hash, () => null);
  if (!build) bad(`The installation is damaged: the code in ${join(browserDir, "extension")} cannot be read in full. Reinstall ${product}, then run \`bruse setup\`.`);
  if (existsSync(EXTENSION_SECRET_PATH)) ok("Paired with an extension");
  else bad("No extension has paired yet; load the extension (see `bruse setup`).");
  try {
    const info = await callBrowser("browser.info");
    if (info.version === manifest.version && build && info.build !== build) bad(`Connected to ${info.name}, but its extension ${info.version} runs other code than ${join(browserDir, "extension")}, most likely from before an update; reload the extension (\`bruse setup\` does that).`);
    else if (info.version === manifest.version) ok(`Connected to ${info.name}, extension ${info.version}`);
    else bad(`Connected to ${info.name}, but its extension is ${info.version ? `version ${info.version}` : "an older version"}; run \`bruse setup\`.`);
    if (info.problem) bad(problemMessage(info));
    if (info.paused) bad(`Agents are paused in ${info.name}; resume them from the ${product} icon in the toolbar.`);
  } catch (error) {
    bad(`The browser did not connect: ${error.message}`);
  }

  step(problems ? `${problems} problem${problems === 1 ? "" : "s"} found.` : "Everything looks right.");
  return problems === 0;
}
