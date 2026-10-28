#!/usr/bin/env node
// Command-line entry point: installs, checks and removes Bruse for the current user.

const USAGE = `Usage: bruse <command>

Commands:
  setup      install or update the extension files and the MCP server, register the server with
             Claude Code and Codex, and wait for the browser extension to connect
  doctor     check the installation, the registrations and the browser connection
  uninstall  remove the registrations, the installed files and the pairing state
  version    print the version`;

const [command, ...rest] = process.argv.slice(2);
if (rest.length) {
  console.error(USAGE);
  process.exit(2);
}
switch (command) {
  case "setup": {
    const { setup } = await import("../installer/install.mjs");
    await setup();
    process.exit(0);
  }
  case "doctor": {
    const { doctor } = await import("../installer/doctor.mjs");
    process.exit((await doctor()) ? 0 : 1);
  }
  case "uninstall": {
    const { uninstall } = await import("../installer/uninstall.mjs");
    await uninstall();
    process.exit(0);
  }
  case "version":
  case "--version": {
    const { manifest } = await import("../installer/lib.mjs");
    console.log(`bruse ${manifest.version}`);
    process.exit(0);
  }
  case "help":
  case "--help":
  case "-h":
  case undefined:
    console.log(USAGE);
    process.exit(command === undefined ? 2 : 0);
  default:
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exit(2);
}
