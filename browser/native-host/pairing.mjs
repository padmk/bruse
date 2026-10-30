// Native messaging host through which the browser extension gets its pairing secret. The browser starts
// this program only for the extension IDs named in its host manifest (see installer/native-host.mjs), so
// the secret never goes to whatever happens to listen on the hub's port: a program of another account
// that took the port first gets no secret and cannot authenticate to the extension.
//
// It answers one request, { type: "secret" }, with { secret }, creating the secret on first use. The
// hub reads the same file to check the extension and to prove itself to it.

import { ensureExtensionSecret } from "./secret.mjs";

// A native message is JSON preceded by its length as a 32-bit integer in native byte order, which is
// little-endian on every platform the browsers support.
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

let answered = false;
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  if (answered) return;
  input = Buffer.concat([input, chunk]);
  if (input.length >= 4 && input.readUInt32LE(0) > 4096) { process.exit(1); return; }
  if (input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
  answered = true;
  let request = null;
  try {
    request = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)).toString());
  } catch {}
  try {
    reply(request?.type === "secret" ? { secret: ensureExtensionSecret() } : { error: "Unknown request" });
  } catch (error) {
    reply({ error: error.message });
  }
});
