// Persistent JavaScript session behind the `js` tool. Code runs as the body of an async function in a
// long-lived vm context; top-level declarations are rewritten into context globals so that values
// such as `const tab = …` survive between calls.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import vm from "node:vm";
import { createCua } from "./cua/index.mjs";
import { useOutput } from "./cua/output.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

// Rewrites top-level (column 0) declarations into assignments to the context's globals.
export function hoistTopLevelDeclarations(code) {
  return code
    .split("\n")
    .map((line) => {
      let match = line.match(/^(?:const|let|var)\s+([{[][^=]*[}\]])\s*=\s*(.*?);?\s*$/);
      if (match) return `(${match[1]} = ${match[2]});`;
      match = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*;\s*$/);
      if (match) return `${match[1]} = undefined;`;
      line = line.replace(/^(?:const|let|var)\s+(?=[A-Za-z_$][\w$]*\s*=)/, "");
      line = line.replace(/^(async\s+)?function(\s*\*?\s*)([A-Za-z_$][\w$]*)/, (_, async = "", star, name) => `${name} = ${async}function${star}${name}`);
      line = line.replace(/^class\s+([A-Za-z_$][\w$]*)/, (_, name) => `${name} = class ${name}`);
      return line;
    })
    .join("\n");
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
    this.cuaSession = createCua();
    this.items = null;
    const write = (value) => this.pushText(typeof value === "string" ? value : inspect(value, { depth: 6, breakLength: 120 }));
    const nodeRepl = {
      write,
      emitImage: async (image, mimeType) => {
        const { data, mimeType: type } = imagePayload(await image, mimeType);
        this.items?.push({ type: "image", data, mimeType: type });
      },
    };
    const consoleProxy = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => write(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4 }))).join(" "))]));
    this.context = vm.createContext({
      cua: this.cuaSession.cua,
      nodeRepl,
      console: consoleProxy,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
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

  // Runs one `js` call and returns MCP content items plus whether it failed.
  async run(code, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.items = [];
    useOutput({
      text: (text) => this.pushText(text),
      image: (data, mimeType) => this.items.push({ type: "image", data, mimeType }),
    });
    let isError = false;
    try {
      const script = new vm.Script(`(async () => {\n${hoistTopLevelDeclarations(code)}\n})()`, {
        filename: "repl.js",
        lineOffset: -1,
        // Lets code use import("node:fs") and other modules.
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs} ms; the code may still be running`)), timeoutMs);
      });
      await Promise.race([script.runInContext(this.context), timeout]).finally(() => clearTimeout(timer));
    } catch (error) {
      isError = true;
      this.pushText(error instanceof Error ? (error.stack ?? error.message).split("\n").filter((line) => !line.includes("node:internal")).slice(0, 6).join("\n") : String(error));
    }
    const notifications = await this.cuaSession.takeNotifications();
    if (notifications.length) this.pushText(`Notifications:\n${notifications.map((n) => `- ${n}`).join("\n")}`);
    const items = this.items.length ? this.items : [{ type: "text", text: "" }];
    this.items = null;
    useOutput(null);
    return { content: items, isError };
  }
}
