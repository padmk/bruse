// Persistent JavaScript session behind the `js` tool. Code runs as the body of an async function in a
// long-lived vm context; top-level declarations are rewritten into context globals (see hoist.mjs) so
// that values such as `const tab = …` survive between calls and can be redeclared.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import vm from "node:vm";
import { createCua } from "./cua/index.mjs";
import { hoistTopLevelDeclarations } from "./hoist.mjs";
import { useOutput } from "./cua/output.mjs";

// Text one call may return. MCP clients drop larger results from the model's view (Claude Code saves
// results over 25,000 tokens to a file instead), and a long accessibility tree of a busy page mostly
// costs reading time; values in the REPL stay complete.
const MAX_OUTPUT_CHARS = 30_000;

// Keeps the first MAX_OUTPUT_CHARS characters of the text items, cut at a line end, and says how to
// read the rest.
function limitText(items) {
  const total = items.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0);
  if (total <= MAX_OUTPUT_CHARS) return items;
  let left = MAX_OUTPUT_CHARS;
  const kept = [];
  for (const item of items) {
    if (item.type !== "text") kept.push(item);
    else if (left > 0) {
      let text = item.text;
      if (text.length > left) {
        const lineEnd = text.lastIndexOf("\n", left);
        text = text.slice(0, lineEnd > left / 2 ? lineEnd : left);
      }
      left -= text.length;
      kept.push({ type: "text", text });
    }
  }
  const note = `… Output truncated: ${MAX_OUTPUT_CHARS} of ${total} characters shown. Return values are complete, so read the rest in parts, e.g. \`const s = await tab.getAXState({ emit: false, disableDiffing: true }); nodeRepl.write(s.slice(${MAX_OUTPUT_CHARS - 10_000}, ${MAX_OUTPUT_CHARS + 10_000}))\`, or query the page with tab.playwright locators or evaluate().`;
  const last = kept.findLast((item) => item.type === "text");
  last.text += `\n${note}`;
  return kept;
}

function imagePayload(image, mimeType) {
  if (image instanceof Uint8Array || Buffer.isBuffer(image)) return { data: Buffer.from(image).toString("base64"), mimeType: mimeType ?? "image/png" };
  if (image && typeof image === "object" && image.bytes) return imagePayload(image.bytes, image.mimeType);
  if (typeof image === "string") {
    const dataUrl = image.match(/^data:([^;]+);base64,(.*)$/);
    if (dataUrl) return { data: dataUrl[2], mimeType: dataUrl[1] };
    const path = image.startsWith("file:") ? fileURLToPath(image) : image;
    const extension = path.split(".").pop().toLowerCase();
    const type = { jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[extension] ?? "image/png";
    return { data: readFileSync(path).toString("base64"), mimeType: type };
  }
  throw new Error("emitImage expects bytes, { bytes, mimeType }, a data URL or a file path");
}

export class Repl {
  constructor() {
    this.reset();
  }

  reset() {
    this.cuaSession?.dispose();
    for (const clear of this.timers?.values() ?? []) clear();
    this.cuaSession = createCua();
    // Timers the code scheduled, cleared on reset so that leftover callbacks never run.
    const timers = (this.timers = new Map());
    const track = (start, stop, once) => (callback, ms, ...args) => {
      const handle = start((...callbackArgs) => {
        if (once) timers.delete(handle);
        return callback(...callbackArgs);
      }, ms, ...args);
      timers.set(handle, () => stop(handle));
      return handle;
    };
    const untrack = (stop) => (handle) => {
      timers.delete(handle);
      stop(handle);
    };
    this.items = null;
    let context;
    // Writes from a context that was reset (for example a timed-out cell still running) are dropped.
    const write = (value) => {
      if (context === this.context) this.pushText(typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: 120 }));
    };
    const nodeRepl = {
      write,
      emitImage: async (image, mimeType) => {
        const { data, mimeType: type } = imagePayload(await image, mimeType);
        if (context === this.context) this.items?.push({ type: "image", data, mimeType: type });
      },
    };
    const consoleProxy = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => write(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" "))]));
    context = this.context = vm.createContext({
      cua: this.cuaSession.cua,
      nodeRepl,
      console: consoleProxy,
      setTimeout: track(setTimeout, clearTimeout, true),
      clearTimeout: untrack(clearTimeout),
      setInterval: track(setInterval, clearInterval, false),
      clearInterval: untrack(clearInterval),
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch,
      structuredClone,
      atob,
      btoa,
      performance,
    });
  }

  pushText(text) {
    if (!this.items) return;
    const last = this.items[this.items.length - 1];
    if (last?.type === "text") last.text += `\n${text}`;
    else this.items.push({ type: "text", text });
  }

  // Runs one `js` call and returns MCP content items plus whether it failed. The server sets the timeout.
  async run(code, timeoutMs) {
    this.items = [];
    useOutput({
      text: (text) => this.pushText(text),
      image: (data, mimeType) => this.items.push({ type: "image", data, mimeType }),
    });
    let isError = false;
    let timedOut = false;
    let timer;
    try {
      const script = new vm.Script(`(async () => {\n${hoistTopLevelDeclarations(code)}\n})()`, {
        filename: "repl.js",
        lineOffset: -1,
        // Lets code use import("node:fs") and other modules.
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Execution timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      // The vm timeout interrupts synchronous code (e.g. an endless loop before the first await).
      await Promise.race([script.runInContext(this.context, { timeout: timeoutMs }), timeout]);
    } catch (error) {
      isError = true;
      // Errors thrown in the vm come from another realm, so instanceof Error does not apply.
      const text = typeof error?.stack === "string" ? error.stack : error?.message ?? String(error);
      this.pushText(text.split("\n").filter((line) => !line.includes("node:internal")).slice(0, 6).join("\n"));
      if (/Script execution timed out/.test(text)) timedOut = true;
    } finally {
      // Also when the vm timeout threw before the race began, so the timer does not reject unobserved.
      clearTimeout(timer);
    }
    const notifications = await this.cuaSession.takeNotifications();
    if (notifications.length) this.pushText(`Notifications:\n${notifications.map((n) => `- ${n}`).join("\n")}`);
    const items = this.items.length ? limitText(this.items) : [{ type: "text", text: "" }];
    this.items = null;
    useOutput(null);
    // Code that outlived its call could still act; the server replaces this worker when it sees timedOut.
    if (timedOut) this.reset();
    return { content: items, isError, timedOut };
  }
}
