// Functions evaluated inside the page with Runtime.callFunctionOn / Runtime.evaluate. They are kept as
// source text because they run in the page, not in Node.

// Statement block run with `this` = an element the agent is about to focus. It adds the attributes
// password managers honor to skip a field: their inline menus are frames of another extension, which
// make the browser cut off debugger access to the tab.
export const OPT_OUT_OF_PASSWORD_MANAGERS = `
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this.isContentEditable) {
    for (const [name, value] of [["data-1p-ignore", ""], ["data-lpignore", "true"], ["data-bwignore", "true"], ["data-form-type", "other"]]) {
      if (!this.hasAttribute(name)) this.setAttribute(name, value);
    }
  }`;

// this = target element. Sets an input, textarea, select, contenteditable or checkable value and fires
// the events frameworks listen for.
export const SET_VALUE = `function (value) {${OPT_OUT_OF_PASSWORD_MANAGERS}
  const el = this;
  const fire = (type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find((o) => o.value === value) ?? [...el.options].find((o) => o.label.trim() === value || o.text.trim() === value);
    if (!option) throw new Error("No option " + JSON.stringify(value) + " in this select");
    el.value = option.value;
    fire("input"); fire("change");
    return;
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const want = value === true || value === "true" || value === "on" || value === "1";
    if (el.checked !== want) el.click();
    return;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    fire("input"); fire("change");
    return;
  }
  if (el.isContentEditable) {
    el.focus();
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, value);
    return;
  }
  throw new Error("Element " + el.tagName.toLowerCase() + " has no settable value");
}`;

// this = editable element. Selects the matching text, or places the caret before or after it.
export const SELECT_TEXT = `function (text, prefix, suffix, selectionType) {${OPT_OUT_OF_PASSWORD_MANAGERS}
  const el = this;
  const source = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent;
  const needle = (prefix ?? "") + text + (suffix ?? "");
  const at = source.indexOf(needle);
  if (at < 0) throw new Error("Text " + JSON.stringify(needle) + " not found in the element");
  let start = at + (prefix ?? "").length;
  let end = start + text.length;
  if (selectionType === "cursor_before") end = start;
  else if (selectionType === "cursor_after") start = end;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.setSelectionRange(start, end);
    return;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0, startSet = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = offset + node.data.length;
    if (!startSet && start <= next) { range.setStart(node, start - offset); startSet = true; }
    if (startSet && end <= next) { range.setEnd(node, end - offset); break; }
    offset = next;
  }
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

// this = element. Dispatches a paste event carrying the given data; returns whether the page handled it.
export const DISPATCH_PASTE = `function (mimeType, data) {${OPT_OUT_OF_PASSWORD_MANAGERS}
  const transfer = new DataTransfer();
  transfer.setData(mimeType, data);
  if (mimeType !== "text/plain") transfer.setData("text/plain", data);
  const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  return !this.dispatchEvent(event);
}`;

// Finds elements for a chain of locator steps. Returns an array of elements.
export const LOCATOR_ENGINE = `function (steps) {
  const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim();
  const matches = (text, matcher, exact) => {
    text = norm(text);
    if (matcher && typeof matcher === "object" && "regex" in matcher) return new RegExp(matcher.regex, matcher.flags).test(text);
    const want = norm(String(matcher));
    return exact ? text === want : text.toLowerCase().includes(want.toLowerCase());
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const allElements = (root) => {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const implicitRole = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.localName;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button") return "button";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
      if (type === "hidden") return null;
      return el.hasAttribute("list") ? "combobox" : "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
    const map = { ul: "list", ol: "list", li: "listitem", nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", form: "form", table: "table", tr: "row", td: "cell", th: "columnheader", option: "option", dialog: "dialog", article: "article", section: "region", progress: "progressbar", details: "group", summary: "button", fieldset: "group", menu: "list" };
    if (map[tag]) return map[tag];
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return "textbox";
    return null;
  };
  const textOf = (el) => norm(el instanceof HTMLElement ? el.innerText : el.textContent);
  const labelText = (el) => {
    const ids = el.getAttribute("aria-labelledby");
    if (ids) return ids.split(/\\s+/).map((id) => textOf(document.getElementById(id) ?? document.createElement("x"))).join(" ");
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    const labels = el.labels ? [...el.labels].map(textOf).join(" ") : "";
    return labels;
  };
  const accessibleName = (el) => {
    const label = labelText(el);
    if (norm(label)) return label;
    if (el.localName === "img") return el.getAttribute("alt") ?? "";
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return el.value || el.type;
    const role = implicitRole(el);
    if (["button", "link", "heading", "tab", "menuitem", "option", "checkbox", "radio", "cell", "columnheader", "listitem", "treeitem", "switch"].includes(role)) return textOf(el) || el.getAttribute("title") || "";
    return el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "";
  };
  const textMatches = (roots, matcher, exact) => {
    const found = [];
    for (const root of roots) {
      for (const el of allElements(root)) {
        if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(el.tagName)) continue;
        if (!matches(textOf(el), matcher, exact)) continue;
        // Prefer the innermost element whose text matches.
        const childMatches = [...el.children].some((child) => matches(textOf(child), matcher, exact));
        if (!childMatches) found.push(el);
      }
    }
    return found;
  };
  const run = (stepList, startRoots) => {
    let current = startRoots;
    let scopedToRoots = true;
    for (const step of stepList) {
      const roots = scopedToRoots ? current : current;
      let next = [];
      if (step.kind === "css") {
        for (const root of roots) {
          if (step.selector.startsWith("text=")) next.push(...textMatches([root], step.selector.slice(5).replace(/^"|"$/g, ""), step.selector.slice(5).startsWith('"')));
          else if (step.selector.startsWith("xpath=") || step.selector.startsWith("//")) {
            const xp = step.selector.replace(/^xpath=/, "");
            const result = document.evaluate(xp, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < result.snapshotLength; i++) next.push(result.snapshotItem(i));
          } else next.push(...root.querySelectorAll(step.selector));
        }
      } else if (step.kind === "role") {
        for (const root of roots) for (const el of allElements(root)) {
          if (implicitRole(el) !== step.role) continue;
          if (step.name !== undefined && !matches(accessibleName(el), step.name, step.exact)) continue;
          if (!step.includeHidden && !visible(el)) continue;
          next.push(el);
        }
      } else if (step.kind === "text") next = textMatches(roots, step.text, step.exact);
      else if (step.kind === "label") {
        for (const root of roots) for (const el of allElements(root)) if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.getAttribute("role") || el.isContentEditable) {
          if (matches(labelText(el), step.text, step.exact)) next.push(el);
        }
      } else if (step.kind === "placeholder") {
        for (const root of roots) for (const el of root.querySelectorAll("[placeholder]")) if (matches(el.getAttribute("placeholder"), step.text, step.exact)) next.push(el);
      } else if (step.kind === "testid") {
        for (const root of roots) next.push(...root.querySelectorAll('[data-testid="' + CSS.escape(step.id) + '"]'));
      } else if (step.kind === "frame") {
        for (const root of roots) for (const frame of root.querySelectorAll(step.selector)) {
          if (frame.contentDocument) next.push(frame.contentDocument);
        }
      } else if (step.kind === "nth") {
        const i = step.index < 0 ? current.length + step.index : step.index;
        next = current[i] ? [current[i]] : [];
      } else if (step.kind === "filter") {
        next = current.filter((el) => {
          if (step.hasText !== undefined && !matches(textOf(el), step.hasText, false)) return false;
          if (step.hasNotText !== undefined && matches(textOf(el), step.hasNotText, false)) return false;
          if (step.visible !== undefined && visible(el) !== step.visible) return false;
          if (step.has && !run(step.has, [el]).length) return false;
          if (step.hasNot && run(step.hasNot, [el]).length) return false;
          return true;
        });
      } else if (step.kind === "and") {
        const other = new Set(run(step.steps, startRoots));
        next = current.filter((el) => other.has(el));
      } else if (step.kind === "or") {
        const other = run(step.steps, startRoots);
        next = [...new Set([...current, ...other])];
      }
      current = [...new Set(next)];
    }
    return current;
  };
  return run(steps, [document]);
}`;
