import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { moveToTrash } from "../installer/lib.mjs";

const installer = fileURLToPath(new URL("../installer/install.mjs", import.meta.url));
const dataHome = mkdtempSync(join(tmpdir(), "install-test-"));
after(() => moveToTrash(dataHome));

// Runs installFiles over an existing installation in its own process (fail() exits), with renames into
// the installed path failing as `failing` says: "staged" fails only the new copy, "both" also the restore,
// and "trash" fails no rename but the move of the previous copy to the Trash.
function update(name, failing) {
  const root = join(dataHome, name, "bruse");
  const installed = join(root, "browser");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "previous.txt"), "previous");
  const script = `
    import { renameSync } from "node:fs";
    const { installFiles } = await import(${JSON.stringify(installer)});
    installFiles({ rename: (from, to) => {
      if (to.endsWith("/browser") && (${JSON.stringify(failing)} === "both" || (${JSON.stringify(failing)} === "staged" && from.includes("browser.new-")))) throw new Error("injected");
      renameSync(from, to);
    }, ...(${JSON.stringify(failing)} === "trash" && { trash: () => { throw new Error("injected"); } }) });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, XDG_DATA_HOME: join(dataHome, name) } });
  return { root, installed, code: result.status, output: result.stdout + result.stderr };
}

test("a failed move of the new copy puts the previous installation back", { timeout: 60_000 }, () => {
  const { root, installed, code, output } = update("restore", "staged");
  assert.equal(code, 1, output);
  assert.equal(readFileSync(join(installed, "previous.txt"), "utf8"), "previous");
  assert.match(output, /Could not install the new copy \(injected\)/);
  assert.deepEqual(readdirSync(root), ["browser"]);
});

test("a failed restore keeps the backup and says how to restore it", { timeout: 60_000 }, () => {
  const { root, installed, code, output } = update("keep", "both");
  assert.equal(code, 1, output);
  assert.equal(existsSync(installed), false);
  const backups = readdirSync(root).filter((name) => name.startsWith("browser.previous-"));
  assert.equal(backups.length, 1);
  const backup = join(root, backups[0]);
  assert.equal(readFileSync(join(backup, "previous.txt"), "utf8"), "previous");
  assert.ok(output.includes(`mv '${backup}' '${installed}'`), output);
});

test("a failed move of the previous copy to the Trash keeps the new installation and names the leftover", { timeout: 60_000 }, () => {
  const { root, installed, code, output } = update("trash", "trash");
  assert.equal(code, 0, output);
  assert.equal(existsSync(join(installed, "previous.txt")), false);
  const backups = readdirSync(root).filter((name) => name.startsWith("browser.previous-"));
  assert.equal(backups.length, 1);
  assert.ok(output.includes(join(root, backups[0])), output);
});
