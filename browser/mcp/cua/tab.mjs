// A bound browser tab: accessibility state, screenshots, input by element index or point, navigation,
// dialogs, Playwright-style locators and console logs.

import { AXTracker, fetchPageTree } from "./ax-tree.mjs";
import { createContentApi } from "./content.mjs";
import { callOn, clickAt, dragBetween, elementCenter, focusNode } from "./elements.mjs";
import { pressChord } from "./keys.mjs";
import { Locator, functionSource } from "./locator.mjs";
import { emitImage, emitText } from "./output.mjs";
import { DISPATCH_PASTE, SELECT_TEXT, SET_VALUE } from "./page-scripts.mjs";

const SETTLE_LOAD_MS = 5_000;
const SETTLE_DELAY_MS = 150;
const SCROLL_PAGE_FRACTION = 0.85;
const DIRECTIONS = { up: [0, -1], u: [0, -1], down: [0, 1], d: [0, 1], left: [-1, 0], l: [-1, 0], right: [1, 0], r: [1, 0] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBytes(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function urlMatches(url, pattern) {
  if (pattern instanceof RegExp) return pattern.test(url);
  if (typeof pattern === "function") return pattern(new URL(url));
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
    return regex.test(url);
  }
  return url === pattern;
}

export class Tab {
  constructor(context, info) {
    this.context = context; // { call(method, params), waitForEvent(predicate, timeoutMs) }
    this.tabId = info.id;
    this.id = String(info.id);
    this.tracker = new AXTracker();
    this.playwright = this.createPlaywright();
    this.dev = { logs: (options) => this.logs(options) };
    this.clipboard = {
      readText: () => this.evaluateInPage("navigator.clipboard.readText()"),
      writeText: (text) => this.evaluateInPage(`navigator.clipboard.writeText(${JSON.stringify(text)})`),
    };
    this.content = createContentApi(this);
    this.capabilities = {
      list: async () => [],
      get: async (id) => {
        throw new Error(`Tab capability "${id}" is not available`);
      },
    };
  }

  // CDP sender for the tab, or for a cross-origin frame's session.
  cdpSender(sessionId = null) {
    return (method, params = {}) => this.context.call("cdp", { tabId: this.tabId, method, params, ...(sessionId ? { sessionId } : {}) });
  }

  async info() {
    return this.context.call("tabs.get", { tabId: this.tabId });
  }

  async settle() {
    const info = await this.info();
    if (info.status === "loading") await this.context.call("tabs.waitForLoad", { tabId: this.tabId, timeoutMs: SETTLE_LOAD_MS });
    await sleep(SETTLE_DELAY_MS);
  }

  async afterInput() {
    await sleep(50);
  }

  async evaluateInPage(expression) {
    const { result, exceptionDetails } = await this.cdpSender()("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    return result.value;
  }

  async nodeFor(index) {
    return this.tracker.nodeRef(index);
  }

  // Top-left of a frame session's viewport in main-page coordinates.
  async frameOffset(sessionId) {
    if (!sessionId) return [0, 0];
    const { frames } = await this.context.call("page.state", { tabId: this.tabId });
    const frame = frames.find((f) => f.sessionId === sessionId);
    if (!frame) throw new Error("The frame of this element is gone; call getAXState() again");
    const parent = this.cdpSender(frame.parentSessionId);
    const { backendNodeId } = await parent("DOM.getFrameOwner", { frameId: frame.frameId });
    const { model } = await parent("DOM.getBoxModel", { backendNodeId });
    const [px, py] = await this.frameOffset(frame.parentSessionId);
    return [px + model.content[0], py + model.content[1]];
  }

  async pointFor(target) {
    if (Array.isArray(target)) return target;
    const { backendNodeId, sessionId } = await this.nodeFor(target);
    const [x, y] = await elementCenter(this.cdpSender(sessionId), backendNodeId);
    const [dx, dy] = await this.frameOffset(sessionId);
    return [x + dx, y + dy];
  }

  // --- Observation ---

  async renderState(options = {}) {
    await this.settle();
    const [info, state] = await Promise.all([this.info(), this.context.call("page.state", { tabId: this.tabId })]);
    const header = `Browser tab: ${this.id}, Title: ${JSON.stringify(info.title ?? "")}, URL: ${JSON.stringify(info.url ?? "")}.`;
    if (state.dialog) {
      const { type, message } = state.dialog;
      return `${header}\nA JavaScript ${type} dialog is open: ${JSON.stringify(message)}. Handle it with \`const dialog = await tab.getJsDialog()\` and \`dialog.accept()\` or \`dialog.dismiss()\`.`;
    }
    const page = await fetchPageTree((sessionId) => this.cdpSender(sessionId), state.frames);
    const { text, focusedLine } = this.tracker.render(page, options);
    return `${header}\n${text}${focusedLine ? `\nThe focused UI element is ${focusedLine}` : ""}`;
  }

  async getAXState({ emit = true, disableDiffing = false } = {}) {
    const text = await this.renderState({ disableDiffing });
    if (emit) emitText(text);
    return text;
  }

  async captureScreenshot({ fullPage = false, clip } = {}) {
    const params = { format: "jpeg", quality: 80 };
    if (fullPage || clip) {
      const metrics = await this.cdpSender()("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.captureBeyondViewport = true;
      params.clip = clip ? { ...clip, scale: 1 } : { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
    }
    const { data } = await this.cdpSender()("Page.captureScreenshot", params);
    return toBytes(data);
  }

  async getScreenshot({ emit = true } = {}) {
    await this.settle();
    const bytes = await this.captureScreenshot();
    if (emit) emitImage(bytes, "image/jpeg");
    return bytes;
  }

  async getAXStateAndScreenshot({ emit = true, disableDiffing = false } = {}) {
    const state = await this.getAXState({ emit, disableDiffing });
    const screenshot = await this.captureScreenshot();
    if (emit) emitImage(screenshot, "image/jpeg");
    return { state, screenshot };
  }

  async screenshot(options = {}) {
    return this.captureScreenshot(options);
  }

  async url() {
    return (await this.info()).url;
  }

  async title() {
    return (await this.info()).title;
  }

  // --- Input ---

  async click(target, options = {}) {
    await clickAt(this.cdpSender(), await this.pointFor(target), options);
    await this.afterInput();
  }

  async drag(from, to) {
    await dragBetween(this.cdpSender(), from, to);
    await this.afterInput();
  }

  async scroll(target, direction, pages = 1) {
    const vector = DIRECTIONS[direction];
    if (!vector) throw new Error(`Unknown direction ${direction}`);
    const cdp = this.cdpSender();
    const metrics = await cdp("Page.getLayoutMetrics");
    const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    const point = target === undefined || target === null ? [viewport.clientWidth / 2, viewport.clientHeight / 2] : await this.pointFor(target);
    const distance = typeof pages === "object" ? pages.pixels : pages * SCROLL_PAGE_FRACTION * (vector[1] ? viewport.clientHeight : viewport.clientWidth);
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: point[0], y: point[1], deltaX: vector[0] * distance, deltaY: vector[1] * distance });
    await sleep(200);
  }

  async selectText(elementIndex, text, { prefix, suffix, selectionType = "text" } = {}) {
    const { backendNodeId, sessionId } = await this.nodeFor(elementIndex);
    await callOn(this.cdpSender(sessionId), backendNodeId, SELECT_TEXT, [text, prefix ?? null, suffix ?? null, selectionType]);
  }

  async setValue(elementIndex, value) {
    const { backendNodeId, sessionId } = await this.nodeFor(elementIndex);
    await callOn(this.cdpSender(sessionId), backendNodeId, SET_VALUE, [value]);
    await this.afterInput();
  }

  async performSecondaryAction(elementIndex, action) {
    const name = action.toLowerCase().replace(/[\s_-]/g, "");
    const { backendNodeId: node, sessionId } = await this.nodeFor(elementIndex);
    const cdp = this.cdpSender(sessionId);
    if (["press", "click", "activate", "open", "expand", "collapse", "toggle", "select", "raise"].includes(name)) return this.click(elementIndex);
    if (["showmenu", "contextmenu", "menu"].includes(name)) return this.click(elementIndex, { mouseButton: "right" });
    if (name === "increment" || name === "decrement") {
      await focusNode(cdp, node);
      return pressChord(this.cdpSender(), name === "increment" ? "Up" : "Down");
    }
    if (["cancel", "dismiss", "close"].includes(name)) {
      await focusNode(cdp, node);
      return pressChord(this.cdpSender(), "Escape");
    }
    if (name === "focus") return focusNode(cdp, node);
    if (name === "scrolltovisible" || name === "scrollintoview") return cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
    throw new Error(`Unsupported secondary action "${action}". Supported: Press, Expand, Collapse, ShowMenu, Increment, Decrement, Cancel, Focus, ScrollToVisible`);
  }

  async focusTarget(elementIndex) {
    if (elementIndex === null || elementIndex === undefined) return;
    const { backendNodeId, sessionId } = await this.nodeFor(elementIndex);
    await focusNode(this.cdpSender(sessionId), backendNodeId);
  }

  async typeText(elementIndex, text) {
    await this.focusTarget(elementIndex);
    await this.cdpSender()("Input.insertText", { text });
    await this.afterInput();
  }

  async pressKey(elementIndex, key, options = {}) {
    await this.focusTarget(elementIndex);
    await pressChord(this.cdpSender(), key, options);
    await this.afterInput();
  }

  async paste(elementIndex, text, { format = "text" } = {}) {
    await this.focusTarget(elementIndex);
    const cdp = this.cdpSender();
    const mimeType = format === "html" ? "text/html" : "text/plain";
    const { result } = await cdp("Runtime.evaluate", { expression: "document.activeElement", returnByValue: false });
    let handled = false;
    if (result.objectId) {
      const { node } = await cdp("DOM.describeNode", { objectId: result.objectId });
      handled = await callOn(cdp, node.backendNodeId, DISPATCH_PASTE, [mimeType, text]);
    }
    if (!handled) {
      if (format === "html") await this.evaluateInPage(`document.execCommand("insertHTML", false, ${JSON.stringify(text)})`);
      else await cdp("Input.insertText", { text });
    }
    await this.afterInput();
  }

  // Overrides the page viewport for responsive testing; resetViewport() restores the window's size.
  async setViewport({ width, height, deviceScaleFactor = 0, mobile = false }) {
    await this.cdpSender()("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
  }
  async resetViewport() {
    await this.cdpSender()("Emulation.clearDeviceMetricsOverride");
  }

  // --- Navigation and lifecycle ---

  async goto(url) {
    await this.context.call("tabs.navigate", { tabId: this.tabId, url });
  }
  async back() {
    await this.context.call("tabs.history", { tabId: this.tabId, direction: "back" });
  }
  async forward() {
    await this.context.call("tabs.history", { tabId: this.tabId, direction: "forward" });
  }
  async reload() {
    await this.context.call("tabs.history", { tabId: this.tabId, direction: "reload" });
  }
  async close() {
    await this.context.call("tabs.close", { tabId: this.tabId });
  }
  async markDeliverable() {
    await this.context.call("tabs.mark", { tabId: this.tabId, mark: "deliverable" });
  }
  async markHandoff() {
    await this.context.call("tabs.mark", { tabId: this.tabId, mark: "handoff" });
  }

  async getJsDialog() {
    const { dialog } = await this.context.call("page.state", { tabId: this.tabId });
    if (!dialog) return undefined;
    const handle = (accept, promptText) => this.cdpSender()("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
    const result = { type: dialog.type, message: dialog.message, dismiss: () => handle(false) };
    if (dialog.type === "confirm" || dialog.type === "beforeunload") result.accept = () => handle(true);
    if (dialog.type === "prompt") result.accept = (text = dialog.defaultPrompt ?? "") => handle(true, text);
    return result;
  }

  async logs({ filter, levels, limit } = {}) {
    let entries = await this.context.call("page.console", { tabId: this.tabId });
    if (levels?.length) entries = entries.filter((entry) => levels.includes(entry.level) || (entry.level === "warn" && levels.includes("warning")));
    if (filter) entries = entries.filter((entry) => entry.message.includes(filter));
    return limit ? entries.slice(-limit) : entries;
  }

  // --- Playwright-style API ---

  createPlaywright() {
    const root = new Locator(this, []);
    const tab = this;
    return {
      locator: (selector, options) => root.locator(selector, options),
      getByRole: (role, options) => root.getByRole(role, options),
      getByText: (text, options) => root.getByText(text, options),
      getByLabel: (text, options) => root.getByLabel(text, options),
      getByPlaceholder: (text, options) => root.getByPlaceholder(text, options),
      getByTestId: (id) => root.getByTestId(id),
      frameLocator: (selector) => root.frameLocator(selector),
      async evaluate(fn, arg) {
        return tab.evaluateInPage(`(${functionSource(fn, "arg")})(${JSON.stringify(arg ?? null)})`);
      },
      async domSnapshot() {
        return tab.evaluateInPage(`(() => {
          const clone = document.documentElement.cloneNode(true);
          clone.querySelectorAll("script, style, noscript, svg").forEach((el) => el.remove());
          const frames = document.querySelectorAll("iframe");
          clone.querySelectorAll("iframe").forEach((frame, i) => {
            try { const body = frames[i].contentDocument?.body; if (body) frame.setAttribute("data-body", body.innerHTML.slice(0, 20000)); } catch {}
          });
          return clone.outerHTML;
        })()`);
      },
      waitForTimeout: (ms) => sleep(ms),
      async waitForLoadState({ state = "load", timeoutMs = 30_000 } = {}) {
        await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs });
        if (state === "networkidle") await sleep(500);
      },
      async waitForURL(pattern, { timeoutMs = 30_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (!urlMatches(await tab.url(), pattern)) {
          if (Date.now() > deadline) throw new Error(`URL did not match ${pattern} within ${timeoutMs} ms`);
          await sleep(100);
        }
        await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs: Math.max(1, deadline - Date.now()) });
      },
      async expectNavigation(action, { timeoutMs = 30_000, url } = {}) {
        const before = await tab.url();
        const result = await action();
        const deadline = Date.now() + timeoutMs;
        while ((await tab.url()) === before || (url && !urlMatches(await tab.url(), url))) {
          if (Date.now() > deadline) throw new Error("No navigation happened in time");
          await sleep(100);
        }
        await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs: Math.max(1, deadline - Date.now()) });
        return result;
      },
      async waitForEvent(event, { timeoutMs = 30_000 } = {}) {
        if (event === "download") {
          const download = tab.context.call("downloads.wait", { timeoutMs });
          return { path: async () => (await download).path };
        }
        if (event === "filechooser") {
          await tab.cdpSender()("Page.setInterceptFileChooserDialog", { enabled: true });
          const opened = await tab.context.waitForEvent((e) => e.tabId === tab.tabId && e.method === "Page.fileChooserOpened", timeoutMs);
          return {
            isMultiple: () => opened.params.mode === "selectMultiple",
            setFiles: async (files) => {
              await tab.cdpSender()("DOM.setFileInputFiles", { backendNodeId: opened.params.backendNodeId, files: Array.isArray(files) ? files : [files] });
              await tab.cdpSender()("Page.setInterceptFileChooserDialog", { enabled: false });
            },
          };
        }
        throw new Error(`Unsupported event ${event}; use "download" or "filechooser"`);
      },
    };
  }
}
