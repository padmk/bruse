// A bound browser tab: accessibility state, screenshots, input by element index or point, navigation,
// dialogs, Playwright-style locators and console logs.

import { ariaSnapshot } from "./aria-snapshot.mjs";
import { squareToQuad } from "./geometry.mjs";
import { AXTracker, fetchPageTree } from "./ax-tree.mjs";
import { createContentApi } from "./content.mjs";
import { OFF_PAGE, callOn, clickAt, coveringElement, dragBetween, elementCenter, focusNode, prepareClick } from "./elements.mjs";
import { pressChord } from "./keys.mjs";
import { Locator, functionSource, isRegExp } from "./locator.mjs";
import { emitImage, emitText } from "./output.mjs";
import { DISPATCH_PASTE, SELECT_TEXT, SET_VALUE } from "./page-scripts.mjs";

const SETTLE_LOAD_MS = 5_000;
// After an action, state reads wait until the DOM has had no mutations for QUIET_MS, for at most
// SETTLE_WINDOW_MS from the action.
const QUIET_MS = 60;
const SETTLE_WINDOW_MS = 1_000;
const WAIT_FOR_QUIET_DOM = `(quietMs, maxMs) => new Promise((resolve) => {
  let timer;
  const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(limit); resolve(); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(done, quietMs);
  const limit = setTimeout(done, Math.max(quietMs, maxMs));
})`;
const SCROLL_PAGE_FRACTION = 0.85;
const NETWORK_IDLE_MS = 500;
const DOWNLOAD_WAIT_MS = 30_000;
// Shorter than a call's default timeout, so the wait ends (and stops intercepting) within the call.
const FILE_CHOOSER_WAIT_MS = 20_000;
// How long a click by element number waits for something covering the element (an animation, a toast) to go away.
const COVERED_WAIT_MS = 1_000;
const DIRECTIONS = { up: [0, -1], u: [0, -1], down: [0, 1], d: [0, 1], left: [-1, 0], l: [-1, 0], right: [1, 0], r: [1, 0] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toBytes(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function urlMatches(url, pattern) {
  if (isRegExp(pattern)) return pattern.test(url);
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
    this.dev = { logs: (options) => this.logs(options), requests: (options) => this.requests(options) };
    this.clipboard = {
      readText: () => this.evaluateInPage("navigator.clipboard.readText()", { userGesture: true }),
      writeText: (text) => this.evaluateInPage(`navigator.clipboard.writeText(${JSON.stringify(text)})`, { userGesture: true }),
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

  // Waits for a loading page and, after a recent action, until the DOM has been quiet for a moment.
  // Returns whether anything may have changed while waiting.
  async settle(info) {
    const sinceAction = Date.now() - (this.lastActionAt ?? 0);
    const loading = (info ?? (await this.info())).status === "loading";
    if (loading) await this.context.call("tabs.waitForLoad", { tabId: this.tabId, timeoutMs: SETTLE_LOAD_MS }).catch(() => {});
    if (sinceAction < SETTLE_WINDOW_MS) {
      await this.evaluateInPage(`(${WAIT_FOR_QUIET_DOM})(${QUIET_MS}, ${SETTLE_WINDOW_MS - sinceAction})`).catch(() => sleep(QUIET_MS));
      return true;
    }
    return loading;
  }

  async afterInput() {
    this.lastActionAt = Date.now();
  }

  // `userGesture` lets the code use APIs that need user activation (the clipboard). State reads run
  // without it, so a page cannot use the agent's reads to open popups or pickers.
  async evaluateInPage(expression, { userGesture = false } = {}) {
    const { result, exceptionDetails } = await this.cdpSender()("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    return result.value;
  }

  async nodeFor(index) {
    return this.tracker.nodeRef(index);
  }

  // A frame session's owner element in its parent session, with the quad of the frame's content box
  // there and the frame's viewport size, which together map points into the parent (also through CSS
  // transforms such as scale).
  async frameOwner(sessionId) {
    const { frames } = await this.context.call("page.state", { tabId: this.tabId });
    const frame = frames.find((f) => f.sessionId === sessionId);
    if (!frame) throw new Error("The frame of this element is gone; call getAXState() again");
    const parent = this.cdpSender(frame.parentSessionId);
    const { backendNodeId } = await parent("DOM.getFrameOwner", { frameId: frame.frameId });
    const [{ model }, { result }] = await Promise.all([
      parent("DOM.getBoxModel", { backendNodeId }),
      this.cdpSender(sessionId)("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true }),
    ]);
    const [width, height] = result.value ?? [model.width, model.height];
    const toUnit = squareToQuad(model.content);
    const toParent = ([x, y]) => toUnit(x / width, y / height);
    return { parentSessionId: frame.parentSessionId, backendNodeId, toParent };
  }

  // A point in a frame session's viewport mapped to main-page coordinates.
  async pagePoint(sessionId, point) {
    if (!sessionId) return point;
    const { parentSessionId, toParent } = await this.frameOwner(sessionId);
    return this.pagePoint(parentSessionId, toParent(point));
  }

  // What would receive a click at `point` (in the node's session) instead of the node, through all
  // frames up to the page, or null.
  async coveringAt(backendNodeId, sessionId, point) {
    const covering = await coveringElement(this.cdpSender(sessionId), backendNodeId, point, !sessionId);
    if (covering || !sessionId) return covering;
    const owner = await this.frameOwner(sessionId);
    return this.coveringAt(owner.backendNodeId, owner.parentSessionId, owner.toParent(point));
  }

  // Main-page point at the center of a node. With `hitTest`, waits until a click there would reach the
  // node and fails if another element stays on top (`force` skips the check).
  async nodePoint(backendNodeId, sessionId, { hitTest = false, force = false, timeoutMs = COVERED_WAIT_MS } = {}) {
    const cdp = this.cdpSender(sessionId);
    await prepareClick(cdp, backendNodeId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const point = await elementCenter(cdp, backendNodeId);
      const covering = hitTest && !force ? await this.coveringAt(backendNodeId, sessionId, point) : null;
      if (!covering) return this.pagePoint(sessionId, point);
      if (Date.now() > deadline) {
        if (covering === OFF_PAGE) throw new Error("The element's visible part is outside the page area (scrolled away or transformed off screen); scroll it into view first, or pass { force: true } to click the point anyway");
        throw new Error(`A click on the element would reach ${covering} instead: something covers the element or it does not take pointer events. Close or click what covers it first, or pass { force: true } to click the point anyway`);
      }
      await sleep(100);
    }
  }

  async pointFor(target, options) {
    if (Array.isArray(target)) return target;
    const { backendNodeId, sessionId } = await this.nodeFor(target);
    return this.nodePoint(backendNodeId, sessionId, options);
  }

  // --- Observation ---

  async renderState(options = {}) {
    let [info, state] = await Promise.all([this.info(), this.context.call("page.state", { tabId: this.tabId })]);
    if (await this.settle(info)) [info, state] = await Promise.all([this.info(), this.context.call("page.state", { tabId: this.tabId })]);
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

  // Captures in CSS pixels, so a point in the image is the same point for click([x, y]).
  async captureScreenshot({ fullPage = false, clip } = {}) {
    const cdp = this.cdpSender();
    const [metrics, ratio] = await Promise.all([cdp("Page.getLayoutMetrics"), this.evaluateInPage("devicePixelRatio").catch(() => 1)]);
    const viewport = metrics.cssVisualViewport;
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const scale = 1 / (ratio || 1);
    let region;
    if (clip) region = { x: viewport.pageX + clip.x, y: viewport.pageY + clip.y, width: clip.width, height: clip.height };
    else if (fullPage) region = { x: 0, y: 0, width: size.width, height: size.height };
    else region = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
    const { data } = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: fullPage, clip: { ...region, scale } });
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
    await this.ensureNoDialog();
    await clickAt(this.cdpSender(), await this.pointFor(target, { hitTest: true, force: options.force }), options);
    await this.afterInput();
  }

  // Moves the pointer over an element or point, e.g. to open hover menus.
  async hover(target) {
    await this.ensureNoDialog();
    const [x, y] = await this.pointFor(target);
    await this.cdpSender()("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.afterInput();
  }

  // Drags between element numbers or viewport points.
  async drag(from, to) {
    await this.ensureNoDialog();
    await dragBetween(this.cdpSender(), await this.pointFor(from), await this.pointFor(to));
    await this.afterInput();
  }

  async scroll(target, direction, pages = 1) {
    const vector = DIRECTIONS[direction];
    if (!vector) throw new Error(`Unknown direction ${direction}`);
    await this.ensureNoDialog();
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

  async focusTarget(elementIndex, options) {
    if (elementIndex === null || elementIndex === undefined) return;
    const { backendNodeId, sessionId } = await this.nodeFor(elementIndex);
    await focusNode(this.cdpSender(sessionId), backendNodeId, options);
  }

  // Input events are dropped while a JavaScript dialog blocks the page, so input that would be lost
  // fails instead of reporting success.
  async ensureNoDialog() {
    const { dialog } = await this.context.call("page.state", { tabId: this.tabId });
    if (dialog) throw new Error(`A JavaScript ${dialog.type} dialog is open on this tab (${JSON.stringify(dialog.message)}); handle it with getJsDialog() first`);
  }

  async typeText(elementIndex, text) {
    await this.ensureNoDialog();
    await this.focusTarget(elementIndex, { requireFocus: true });
    await this.cdpSender()("Input.insertText", { text });
    await this.afterInput();
  }

  async pressKey(elementIndex, key, options = {}) {
    await this.ensureNoDialog();
    await this.focusTarget(elementIndex);
    await pressChord(this.cdpSender(), key, options);
    await this.afterInput();
  }

  async paste(elementIndex, text, { format = "text" } = {}) {
    await this.ensureNoDialog();
    await this.focusTarget(elementIndex, { requireFocus: true });
    const cdp = this.cdpSender();
    const mimeType = format === "html" ? "text/html" : "text/plain";
    const { result } = await cdp("Runtime.evaluate", { expression: "document.activeElement", returnByValue: false });
    let handled = false;
    if (result.objectId) {
      const { node } = await cdp("DOM.describeNode", { objectId: result.objectId });
      cdp("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
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

  // Recent network requests of the tab (fetch, XHR, documents, …), oldest first.
  async requests({ filter, types, limit } = {}) {
    let entries = await this.context.call("page.network", { tabId: this.tabId });
    if (types?.length) entries = entries.filter((entry) => types.includes(entry.type));
    if (filter) entries = entries.filter((entry) => entry.url.includes(filter));
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
        return tab.evaluateInPage(`(${functionSource(fn, "arg")})(${JSON.stringify(arg ?? null)})`, { userGesture: true });
      },
      // ARIA snapshot of the page in Playwright's format; it does not change element numbers.
      async domSnapshot() {
        await tab.settle();
        const { frames } = await tab.context.call("page.state", { tabId: tab.tabId });
        return ariaSnapshot(await fetchPageTree((sessionId) => tab.cdpSender(sessionId), frames));
      },
      waitForTimeout: (ms) => sleep(ms),
      // "networkidle" waits until the tab has had no request in flight for NETWORK_IDLE_MS.
      async waitForLoadState({ state = "load", timeoutMs = 30_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        const timedOut = (what) => new Error(`The page did not reach ${what} within ${timeoutMs} ms`);
        if (state === "domcontentloaded") {
          while ((await tab.evaluateInPage("document.readyState").catch(() => "loading")) === "loading") {
            if (Date.now() > deadline) throw timedOut("domcontentloaded");
            await sleep(50);
          }
          return;
        }
        const { loaded } = await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs });
        if (!loaded) throw timedOut("load");
        if (state !== "networkidle") return;
        for (;;) {
          const { inflightRequests, networkQuietMs } = await tab.context.call("page.state", { tabId: tab.tabId });
          if (networkQuietMs >= NETWORK_IDLE_MS) return;
          if (Date.now() > deadline) throw new Error(`The network did not become idle within ${timeoutMs} ms (${inflightRequests} requests still loading)`);
          await sleep(Math.max(50, Math.min(NETWORK_IDLE_MS - networkQuietMs, 100)));
        }
      },
      async waitForURL(pattern, { timeoutMs = 30_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (!urlMatches(await tab.url(), pattern)) {
          if (Date.now() > deadline) throw new Error(`URL did not match ${pattern} within ${timeoutMs} ms`);
          await sleep(100);
        }
        await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs: Math.max(1, deadline - Date.now()) });
      },
      // Waits for a new document, so a reload or a submission back to the same URL also counts.
      async expectNavigation(action, { timeoutMs = 30_000, url } = {}) {
        const loaderId = async () => (await tab.cdpSender()("Page.getFrameTree")).frameTree.frame.loaderId;
        const before = await loaderId();
        const result = await action();
        const deadline = Date.now() + timeoutMs;
        while ((await loaderId().catch(() => before)) === before || (url && !urlMatches(await tab.url(), url))) {
          if (Date.now() > deadline) throw new Error("No navigation happened in time");
          await sleep(100);
        }
        await tab.context.call("tabs.waitForLoad", { tabId: tab.tabId, timeoutMs: Math.max(1, deadline - Date.now()) });
        return result;
      },
      async waitForEvent(event, { timeoutMs } = {}) {
        if (event === "download") {
          // Only a download this tab starts counts, not unrelated ones elsewhere in the browser.
          const download = tab.context.call("downloads.wait", { tabId: tab.tabId, timeoutMs: timeoutMs ?? DOWNLOAD_WAIT_MS });
          download.catch(() => {}); // the caller may never ask for the path
          return { path: async () => (await download).path };
        }
        if (event === "filechooser") {
          const cdp = tab.cdpSender();
          await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
          let opened;
          try {
            opened = await tab.context.waitForEvent((e) => e.tabId === tab.tabId && e.method === "Page.fileChooserOpened", timeoutMs ?? FILE_CHOOSER_WAIT_MS);
          } finally {
            // Leave the user's own file pickers working; setFiles needs no interception.
            await cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          }
          return {
            isMultiple: () => opened.params.mode === "selectMultiple",
            setFiles: async (files) => {
              await tab.cdpSender()("DOM.setFileInputFiles", { backendNodeId: opened.params.backendNodeId, files: Array.isArray(files) ? files : [files] });
              await tab.afterInput();
            },
          };
        }
        throw new Error(`Unsupported event ${event}; use "download" or "filechooser"`);
      },
    };
  }
}
