// What the end-to-end tests run against, kept apart from any Bruse installation on this machine: a copy of
// browser/ whose hub listens on a free port, Chromium with that copy's extension in a temporary profile,
// MCP servers (agent sessions) with their own state directory, and local test sites.

import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const until = async (condition, { timeoutMs = 20_000, intervalMs = 100, message = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `bruse-test-${prefix}-`));
}

// Directories made by tempDir; tests remove only these.
function removeTemp(path) {
  if (path.startsWith(tmpdir()) && path.includes("bruse-test-")) rmSync(path, { recursive: true, force: true });
}

export async function freePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  return port;
}

// Chrome for Testing or Playwright's Chromium; branded Chrome does not load unpacked extensions this way.
export function findChromium() {
  if (process.env.BRUSE_TEST_CHROME) return process.env.BRUSE_TEST_CHROME;
  const cache = platform() === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
  const candidates = [
    ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
  ];
  const versions = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)) : [];
  versions.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const version of versions) {
    for (const parts of candidates) {
      const path = join(cache, version, ...parts);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

// Replaces the value of `const name = …;` in a file of the copy.
function setConstant(file, name, value) {
  const source = readFileSync(file, "utf8");
  const changed = source.replace(new RegExp(`(const ${name} = )[^;]+;`), `$1${value};`);
  if (changed === source) throw new Error(`${name} not found in ${file}`);
  writeFileSync(file, changed);
}

// A copy of browser/ whose extension and servers use `port` for the hub. `absentSessionGraceMs`
// shortens how long the extension waits before it ends a session the hub no longer reports.
export function browserCopy(port, { absentSessionGraceMs } = {}) {
  const dir = tempDir("browser");
  cpSync(join(root, "browser"), join(dir, "browser"), { recursive: true, filter: (path) => !path.endsWith(".DS_Store") });
  setConstant(join(dir, "browser", "extension", "shared.js"), "HUB_PORT", port);
  if (absentSessionGraceMs !== undefined) setConstant(join(dir, "browser", "extension", "sessions.js"), "ABSENT_SESSION_GRACE_MS", absentSessionGraceMs);
  return {
    dir,
    browserDir: join(dir, "browser"),
    extensionDir: join(dir, "browser", "extension"),
    serverPath: join(dir, "browser", "mcp", "server.mjs"),
    remove: () => removeTemp(dir),
  };
}

// A minimal Chrome DevTools Protocol client over the browser's WebSocket.
async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`CDP connection to ${url} failed`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry?.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
    },
    on: (listener) => listeners.add(listener),
    close: () => socket.close(),
  };
}

// Headless Chromium with the extension from `extensionDir` loaded, in a fresh profile with Developer mode on
// (without it Chromium disables an unpacked extension that reloads itself).
export async function launchBrowser(extensionDir) {
  const executable = findChromium();
  if (!executable) throw new Error("No Chromium for tests found; install one with `npx playwright install chromium` or set BRUSE_TEST_CHROME");
  const profile = tempDir("profile");
  // Downloads go to the profile, not the user's Downloads folder.
  const downloads = join(profile, "Downloads");
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const args = [
    "--headless=new",
    "--enable-unsafe-extension-debugging",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
    ...(platform() === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
  const exited = once(child, "exit");
  let cdp = null;
  const stop = async () => {
    cdp?.send("Browser.close").catch(() => {});
    cdp?.close();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(timer);
    removeTemp(profile);
  };
  try {
    return await prepare();
  } catch (error) {
    await stop();
    throw error;
  }

  async function prepare() {
    const portFile = join(profile, "DevToolsActivePort");
    // The browser may be caught writing the file, before its second line (the path).
    const [port, path] = await until(() => {
      const lines = existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split("\n") : [];
      return lines.length >= 2 && lines;
    }, {
      timeoutMs: 60_000,
      message: `Chromium to start (${stderr.slice(-500)})`,
    });
    cdp = await connectCdp(`ws://127.0.0.1:${port}${path}`);

    const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://extensions" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await until(
      async () => {
        const { result } = await cdp.send(
          "Runtime.evaluate",
          { expression: "typeof chrome.developerPrivate?.updateProfileConfiguration", returnByValue: true },
          sessionId,
        );
        return result.value === "function";
      },
      { message: "chrome://extensions to load" },
    );
    await cdp.send(
      "Runtime.evaluate",
      { expression: "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })", awaitPromise: true },
      sessionId,
    );
    await cdp.send("Target.closeTarget", { targetId });
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir });

    return {
      cdp,
      extensionId,
      downloads,
      // Pages (not extension or internal targets) open in the browser.
      async pages() {
        const { targetInfos } = await cdp.send("Target.getTargets");
        return targetInfos.filter((target) => target.type === "page" && !target.url.startsWith("chrome"));
      },
      close: stop,
    };
  }
}

// An agent session: the MCP server over stdio, with the js tool as `js(code)`.
export async function startSession(serverPath, { stateDir, env = {} } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BROWSER_CONTROL_STATE_DIR: stateDir, ...env },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr = (stderr + chunk).slice(-8000)));
  const exited = once(child, "exit");
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (method, params = {}, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`No reply to ${method} within ${timeoutMs} ms. Server stderr:\n${stderr}`)), timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bruse-tests", version: "0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    request,
    get stderr() {
      return stderr;
    },
    // Runs a cell; resolves with its text output, rejects with it when the cell failed.
    async js(code, timeoutMs) {
      const reply = await request("tools/call", { name: "js", arguments: { code } }, timeoutMs);
      const text = (reply.result?.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (reply.error || reply.result?.isError) throw Object.assign(new Error(text || JSON.stringify(reply.error)), { output: text });
      return text;
    },
    // Ends the session the way an MCP client does, by closing stdin; the server closes its tabs and exits.
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      if (child.exitCode === null && child.signalCode === null) await exited;
      clearTimeout(timer);
    },
    kill: () => child.kill("SIGKILL"),
  };
}

// The value a cell printed with nodeRepl.write(JSON.stringify(value)).
export function lastJson(text) {
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  throw new Error(`No JSON in output:\n${text}`);
}

// A connection to the hub the way a peer MCP server makes it (mutual authentication with the token in
// `stateDir`), for sending requests to the extension directly: `call(method, params)` resolves with the
// result or rejects with the error.
export async function hubClient(port, stateDir, { sessionId = randomUUID() } = {}) {
  const token = readFileSync(join(stateDir, "hub-token"), "utf8").trim();
  const hmac = (message) => createHmac("sha256", token).update(message).digest("hex");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/client`);
  const nonce = randomBytes(32).toString("hex");
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    let hubNonce = null;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "challenge") {
        hubNonce = message.nonce;
        socket.send(JSON.stringify({ type: "auth", nonce, mac: hmac(`client:${hubNonce}:${nonce}`) }));
      } else if (message.type === "auth-ok") {
        if (message.mac === hmac(`hub:${nonce}:${hubNonce}`)) resolve();
        else reject(new Error("The hub did not prove the token"));
      } else if (message.id !== undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    socket.addEventListener("close", () => reject(new Error("The hub closed the connection")));
  });
  socket.send(JSON.stringify({ type: "hello", sessionId }));
  return {
    sessionId,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (reply) => (reply.error ? reject(Object.assign(new Error(reply.error), { code: reply.code })) : resolve(reply.result)));
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}

// A local site serving `routes` ({ "/path": html string or (req, res) => void }) on 127.0.0.1 or localhost.
export async function startSite(routes, host = "127.0.0.1") {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    if (typeof route === "function") return route(req, res);
    if (route === undefined) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(route);
  });
  server.listen(0, host);
  await once(server, "listening");
  return { origin: `http://${host}:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Everything one test file needs: a browser copy on a free port, Chromium with its extension, a state
// directory, and a way to start sessions. Call `close()` in after(). `options` go to browserCopy.
export async function startEnvironment(options = {}) {
  const port = await freePort();
  const copy = browserCopy(port, options);
  const stateDir = tempDir("state");
  const browser = await launchBrowser(copy.extensionDir);
  const sessions = [];
  return {
    port,
    copy,
    stateDir,
    browser,
    async session(options = {}) {
      const session = await startSession(copy.serverPath, { stateDir, ...options });
      sessions.push(session);
      return session;
    },
    // Runs an expression in the extension's popup page, opened as a tab, the way the user's clicks there
    // change settings. The expression may await and import the extension's modules.
    async inPopup(expression) {
      const { cdp, extensionId } = browser;
      const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
      try {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const evaluate = (code) => cdp.send("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true }, sessionId);
        // A new tab starts with a loaded about:blank document; wait for the popup itself.
        await until(async () => (await evaluate('location.protocol === "chrome-extension:" && document.readyState === "complete"')).result.value === true, { message: "popup to load" });
        const { result, exceptionDetails } = await evaluate(`(async () => (${expression}))()`);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      } finally {
        await cdp.send("Target.closeTarget", { targetId });
      }
    },
    // Shares a tab with agents, as "Share this tab" in the popup does.
    share(tabId, shared = true) {
      return this.inPopup(`import("./access.js").then((access) => access.setShared(${Number(tabId)}, ${shared}))`);
    },
    // Switches between "agent-tabs" (the default) and "all-tabs".
    setAccessMode(mode) {
      return this.inPopup(`import("./access.js").then((access) => access.setAccessMode(${JSON.stringify(mode)}))`);
    },
    async close() {
      await Promise.all(sessions.map((session) => session.close().catch(() => session.kill())));
      await browser.close();
      copy.remove();
      removeTemp(stateDir);
    },
  };
}
