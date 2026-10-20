// Playwright-style locators evaluated with the in-page locator engine. Single-element actions are
// strict: they wait for exactly one match and fail on ambiguity.

import { callOn, clickAt, elementCenter, focusNode } from "./elements.mjs";
import { pressChord } from "./keys.mjs";
import { LOCATOR_ENGINE, SET_VALUE } from "./page-scripts.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

export function serializeMatcher(matcher) {
  return matcher instanceof RegExp ? { regex: matcher.source, flags: matcher.flags } : matcher;
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

  // Returns the backend node IDs currently matched.
  async resolveAll() {
    const cdp = this.tab.cdpSender();
    const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
      expression: `(${LOCATOR_ENGINE})(${JSON.stringify(this.steps)})`,
      returnByValue: false,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    const { result: properties } = await cdp("Runtime.getProperties", { objectId: result.objectId, ownProperties: true });
    const elements = properties.filter((p) => /^\d+$/.test(p.name) && p.value?.objectId).sort((a, b) => Number(a.name) - Number(b.name));
    const ids = [];
    for (const element of elements) ids.push((await cdp("DOM.describeNode", { objectId: element.value.objectId })).node.backendNodeId);
    await cdp("Runtime.releaseObject", { objectId: result.objectId }).catch(() => {});
    return ids;
  }

  async resolveOne({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ids = await this.resolveAll();
      if (ids.length === 1) return ids[0];
      if (ids.length > 1) throw new Error(`Locator matched ${ids.length} elements; narrow it with filter(), nth(), first() or a more specific selector`);
      if (Date.now() > deadline) throw new Error(`Locator matched no element within ${timeoutMs} ms: ${JSON.stringify(this.steps)}`);
      await sleep(POLL_MS);
    }
  }

  async count() {
    return (await this.resolveAll()).length;
  }
  async all() {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  async evaluate(fn, arg, { timeoutMs } = {}) {
    const id = await this.resolveOne({ timeoutMs });
    return callOn(this.tab.cdpSender(), id, `function (arg) { return (${functionSource(fn, "element, arg")})(this, arg); }`, [arg]);
  }
  async evaluateAll(fn, arg) {
    const cdp = this.tab.cdpSender();
    const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
      expression: `(${functionSource(fn, "elements, arg")})((${LOCATOR_ENGINE})(${JSON.stringify(this.steps)}), ${JSON.stringify(arg ?? null)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    return result.value;
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
    const ids = await this.resolveAll();
    if (!ids.length) return false;
    return callOn(this.tab.cdpSender(), ids[0], "function () { const r = this.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!this.checkVisibility || this.checkVisibility({ checkVisibilityCSS: true })); }");
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

  async click({ button = "left", modifiers = [], timeoutMs, clickCount = 1 } = {}) {
    const id = await this.resolveOne({ timeoutMs });
    const cdp = this.tab.cdpSender();
    await clickAt(cdp, await elementCenter(cdp, id), { mouseButton: button, clickCount, key: modifiers.map((m) => (m === "ControlOrMeta" ? "meta" : m)).join("+") });
    await this.tab.afterInput();
  }
  async dblclick(options = {}) {
    return this.click({ ...options, clickCount: 2 });
  }

  async fill(value, { timeoutMs } = {}) {
    const id = await this.resolveOne({ timeoutMs });
    await callOn(this.tab.cdpSender(), id, SET_VALUE, [value]);
    await this.tab.afterInput();
  }
  async pressSequentially(text, { timeoutMs } = {}) {
    const id = await this.resolveOne({ timeoutMs });
    const cdp = this.tab.cdpSender();
    await focusNode(cdp, id);
    for (const char of text) await cdp("Input.insertText", { text: char });
    await this.tab.afterInput();
  }
  async type(text, options) {
    return this.pressSequentially(text, options);
  }
  async press(key, { timeoutMs } = {}) {
    const id = await this.resolveOne({ timeoutMs });
    const cdp = this.tab.cdpSender();
    await focusNode(cdp, id);
    await pressChord(cdp, key.replace(/\bControlOrMeta\b/, "meta"));
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
    const id = await this.resolveOne({ timeoutMs });
    await this.tab.cdpSender()("DOM.setFileInputFiles", { backendNodeId: id, files: Array.isArray(files) ? files : [files] });
    await this.tab.afterInput();
  }
}
