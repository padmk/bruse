// Playwright-style locators evaluated with the in-page locator engine. Single-element actions are
// strict: they wait for exactly one match and fail on ambiguity.

import { PAGE_CODE_MS, callOn, clickAt, dragBetween, focusNode, pageException } from "./elements.mjs";
import { pressChord } from "./keys.mjs";
import { LOCATOR_ENGINE, SET_VALUE } from "./page-scripts.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

// Regular expressions created in the REPL come from another realm, so instanceof RegExp is false.
export function isRegExp(value) {
  return Object.prototype.toString.call(value) === "[object RegExp]";
}

function serializeMatcher(matcher) {
  return isRegExp(matcher) ? { regex: matcher.source, flags: matcher.flags } : matcher;
}

// Accepts a function, a function source string or an expression string.
export function functionSource(fn, parameters) {
  if (typeof fn === "function") return fn.toString();
  const source = String(fn).trim();
  if (/^(async\s+)?(function\b|\(?[\w\s,{}[\]]*\)?\s*=>)/.test(source)) return source;
  return `function (${parameters}) { return (${source}); }`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Locator {
  constructor(tab, steps) {
    this.tab = tab;
    this.steps = steps;
  }

  chain(step) {
    return new Locator(this.tab, [...this.steps, step]);
  }

  locator(selector, options = {}) {
    const next = this.chain({ kind: "css", selector });
    return Object.keys(options).length ? next.filter(options) : next;
  }
  getByRole(role, { name, exact, includeHidden } = {}) {
    return this.chain({ kind: "role", role, name: name === undefined ? undefined : serializeMatcher(name), exact, includeHidden });
  }
  getByText(text, { exact } = {}) {
    return this.chain({ kind: "text", text: serializeMatcher(text), exact });
  }
  getByLabel(text, { exact } = {}) {
    return this.chain({ kind: "label", text: serializeMatcher(text), exact });
  }
  getByPlaceholder(text, { exact } = {}) {
    return this.chain({ kind: "placeholder", text: serializeMatcher(text), exact });
  }
  getByTestId(id) {
    return this.chain({ kind: "testid", id });
  }
  frameLocator(selector) {
    return this.chain({ kind: "frame", selector });
  }
  nth(index) {
    return this.chain({ kind: "nth", index });
  }
  first() {
    return this.nth(0);
  }
  last() {
    return this.nth(-1);
  }
  filter({ has, hasNot, hasText, hasNotText, visible } = {}) {
    return this.chain({
      kind: "filter",
      has: has?.steps,
      hasNot: hasNot?.steps,
      hasText: hasText === undefined ? undefined : serializeMatcher(hasText),
      hasNotText: hasNotText === undefined ? undefined : serializeMatcher(hasNotText),
      visible,
    });
  }
  and(other) {
    return this.chain({ kind: "and", steps: other.steps });
  }
  or(other) {
    return this.chain({ kind: "or", steps: other.steps });
  }

  // Where the steps run. Each frame step moves into the frame's document: a frame in another process
  // (a cross-origin iframe) through its own CDP session, a frame in the same process through its owner
  // element (`rootId`). Returns { sessionId, rootId, steps } for the remaining steps.
  async scope() {
    let sessionId = null;
    let rootId = null;
    let steps = this.steps;
    for (;;) {
      const cut = steps.findIndex((step) => step.kind === "frame");
      if (cut < 0) return { sessionId, rootId, steps };
      const owners = await this.matchIn({ sessionId, rootId }, [...steps.slice(0, cut), { kind: "css", selector: steps[cut].selector }]);
      // Several or no matching frames are left to the in-page engine, which can only enter same-origin ones.
      if (owners.length !== 1) return { sessionId, rootId, steps };
      const { node } = await this.tab.cdpSender(sessionId)("DOM.describeNode", { backendNodeId: owners[0] });
      const { frames } = await this.tab.pageState();
      const frame = frames.find((f) => f.frameId === node.frameId);
      if (frame) [sessionId, rootId] = [frame.sessionId, null];
      else rootId = owners[0];
      steps = steps.slice(cut + 1);
    }
  }

  // Runs the locator engine on `steps` in a scope and passes its result to `consume` (a function source
  // taking the matched elements and `arg`). Returns the CDP result object.
  async runEngine({ sessionId, rootId }, steps, consume, arg, options, timeoutMs) {
    const cdp = this.tab.cdpSender(sessionId, timeoutMs ? { timeoutMs } : undefined);
    const call = `function (steps, arg) {
      const root = this.nodeType === 9 ? this : this.contentDocument;
      if (!root) return (${consume})([], arg);
      return (${consume})((${LOCATOR_ENGINE})(steps, root), arg);
    }`;
    // A frame's document resolves in the frame's own context, so this also works for a cross-origin
    // frame that shares the parent's process (same site), whose contentDocument the parent cannot read.
    const objectGroup = options.objectGroup ?? `engine-${Math.random().toString(36).slice(2)}`;
    let objectId;
    if (rootId) {
      const { node } = await cdp("DOM.describeNode", { backendNodeId: rootId });
      const documentId = node.contentDocument?.backendNodeId ?? rootId;
      objectId = (await cdp("DOM.resolveNode", { backendNodeId: documentId, objectGroup })).object.objectId;
    } else objectId = (await cdp("Runtime.evaluate", { expression: "document", objectGroup })).result.objectId;
    try {
      const { result, exceptionDetails } = await cdp("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: call,
        arguments: [{ value: steps }, { value: arg ?? null }],
        awaitPromise: true,
        ...options,
        objectGroup,
      });
      if (exceptionDetails) throw pageException(exceptionDetails);
      return result;
    } finally {
      // Without a group of the caller's, nothing from this call is needed afterwards.
      if (!options.objectGroup) cdp("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  // Backend node IDs matched by `steps` in a scope. Handles live in one object group released at the end.
  async matchIn(scope, steps) {
    const cdp = this.tab.cdpSender(scope.sessionId);
    const objectGroup = `locator-${Math.random().toString(36).slice(2)}`;
    try {
      const result = await this.runEngine(scope, steps, "(elements) => elements", null, { returnByValue: false, objectGroup });
      const { result: properties } = await cdp("Runtime.getProperties", { objectId: result.objectId, ownProperties: true });
      const elements = properties.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).sort((a, b) => Number(a.name) - Number(b.name));
      return Promise.all(elements.map(async (element) => (await cdp("DOM.describeNode", { objectId: element.value.objectId })).node.backendNodeId));
    } finally {
      cdp("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  // Returns { ids, sessionId, cdp } for the elements currently matched.
  async resolveAll() {
    const scope = await this.scope();
    return { ids: await this.matchIn(scope, scope.steps), sessionId: scope.sessionId, cdp: this.tab.cdpSender(scope.sessionId) };
  }

  // Waits for exactly one match and returns { id, sessionId, cdp }.
  async resolveOne({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { ids, sessionId, cdp } = await this.resolveAll();
      if (ids.length === 1) return { id: ids[0], sessionId, cdp };
      if (ids.length > 1) throw new Error(`Locator matched ${ids.length} elements; narrow it with filter(), nth(), first() or a more specific selector`);
      if (Date.now() > deadline) throw new Error(`Locator matched no element within ${timeoutMs} ms: ${JSON.stringify(this.steps)}`);
      await sleep(POLL_MS);
    }
  }

  async count() {
    return (await this.resolveAll()).ids.length;
  }
  async all() {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  // The agent's own code may take its time; it gets the long command limit.
  async evaluate(fn, arg, { timeoutMs } = {}) {
    const { id, sessionId } = await this.resolveOne({ timeoutMs });
    return callOn(this.tab.cdpSender(sessionId, { timeoutMs: PAGE_CODE_MS }), id, `function (arg) { return (${functionSource(fn, "element, arg")})(this, arg); }`, [arg]);
  }
  async evaluateAll(fn, arg) {
    const scope = await this.scope();
    return (await this.runEngine(scope, scope.steps, functionSource(fn, "elements, arg"), arg, { returnByValue: true }, PAGE_CODE_MS)).value;
  }

  async textContent(options) {
    return this.evaluate((el) => el.textContent, undefined, options);
  }
  async innerText(options) {
    return this.evaluate((el) => el.innerText, undefined, options);
  }
  async allTextContents() {
    return this.evaluateAll((els) => els.map((el) => el.textContent));
  }
  async getAttribute(name, options) {
    return this.evaluate((el, attribute) => el.getAttribute(attribute), name, options);
  }
  async isVisible() {
    const { ids, cdp } = await this.resolveAll();
    if (!ids.length) return false;
    return callOn(cdp, ids[0], "function () { const r = this.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!this.checkVisibility || this.checkVisibility({ checkVisibilityCSS: true })); }");
  }
  async isEnabled() {
    return this.evaluate((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
  }

  async waitFor({ state = "visible", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const count = await this.count();
      const done =
        state === "attached" ? count > 0 : state === "detached" ? count === 0 : state === "hidden" ? count === 0 || !(await this.isVisible()) : count > 0 && (await this.isVisible());
      if (done) return;
      if (Date.now() > deadline) throw new Error(`Locator did not become ${state} within ${timeoutMs} ms`);
      await sleep(POLL_MS);
    }
  }

  // Waits, within the timeout, until a click at the element's center would reach the element.
  async click({ button = "left", modifiers = [], timeoutMs = DEFAULT_TIMEOUT_MS, clickCount = 1, force = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    const { id, sessionId } = await this.resolveOne({ timeoutMs });
    const point = await this.tab.nodePoint(id, sessionId, { hitTest: true, force, timeoutMs: Math.max(0, deadline - Date.now()) });
    await clickAt(this.tab.cdpSender(), point, { mouseButton: button, clickCount, key: modifiers.join("+") });
    await this.tab.afterInput();
  }
  async dblclick(options = {}) {
    return this.click({ ...options, clickCount: 2 });
  }

  async hover({ timeoutMs } = {}) {
    const { id, sessionId } = await this.resolveOne({ timeoutMs });
    const [x, y] = await this.tab.nodePoint(id, sessionId);
    await this.tab.cdpSender()("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.tab.afterInput();
  }

  // Drags this element onto the target locator's element.
  async dragTo(target, { timeoutMs } = {}) {
    const [from, to] = [await this.resolveOne({ timeoutMs }), await target.resolveOne({ timeoutMs })];
    await dragBetween(this.tab.cdpSender(), await this.tab.nodePoint(from.id, from.sessionId), await this.tab.nodePoint(to.id, to.sessionId));
    await this.tab.afterInput();
  }

  async fill(value, { timeoutMs } = {}) {
    const { id, cdp } = await this.resolveOne({ timeoutMs });
    await callOn(cdp, id, SET_VALUE, [value]);
    await this.tab.afterInput();
  }
  // Key and text input goes to the tab; the browser routes it to the focused frame.
  async pressSequentially(text, { timeoutMs } = {}) {
    const { id, cdp } = await this.resolveOne({ timeoutMs });
    await focusNode(cdp, id, { requireFocus: true });
    for (const char of text) await this.tab.cdpSender()("Input.insertText", { text: char });
    await this.tab.afterInput();
  }
  async type(text, options) {
    return this.pressSequentially(text, options);
  }
  async press(key, { timeoutMs } = {}) {
    const { id, cdp } = await this.resolveOne({ timeoutMs });
    await focusNode(cdp, id);
    await pressChord(this.tab.cdpSender(), key);
    await this.tab.afterInput();
  }

  async setChecked(checked, options = {}) {
    const current = await this.evaluate((el) => (el.checked ?? el.getAttribute("aria-checked") === "true"), undefined, options);
    if (Boolean(current) !== Boolean(checked)) await this.click(options);
  }
  async check(options) {
    return this.setChecked(true, options);
  }
  async uncheck(options) {
    return this.setChecked(false, options);
  }

  async selectOption(values, { timeoutMs } = {}) {
    const wanted = (Array.isArray(values) ? values : [values]).map((v) => (typeof v === "string" ? { value: v, label: v } : v));
    await this.evaluate(
      (el, items) => {
        if (!(el instanceof HTMLSelectElement)) throw new Error("selectOption needs a <select> element");
        const options = [...el.options];
        const picked = items.map((item) => options.find((o, i) => (item.index !== undefined && i === item.index) || (item.value !== undefined && o.value === item.value) || (item.label !== undefined && o.label.trim() === item.label)));
        if (picked.some((o) => !o)) throw new Error("Some options were not found in the select");
        for (const o of options) o.selected = picked.includes(o);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      wanted,
      { timeoutMs },
    );
    await this.tab.afterInput();
  }

  async setInputFiles(files, { timeoutMs } = {}) {
    const { id, cdp } = await this.resolveOne({ timeoutMs });
    await cdp("DOM.setFileInputFiles", { backendNodeId: id, files: Array.isArray(files) ? files : [files] });
    await this.tab.afterInput();
  }
}
