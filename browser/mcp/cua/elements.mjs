// Element-level operations shared by accessibility indexes and locators: resolving nodes, finding
// a clickable point, and mouse input. `cdp` is a tab-bound CDP sender.

import { isUnresponsivePageError } from "../../extension/shared.js";
import { modifierMask } from "./keys.mjs";
import { quadToSquare } from "./geometry.mjs";
import { OPT_OUT_OF_PASSWORD_MANAGERS } from "./page-scripts.mjs";

// Long presses are capped well below a call's timeout, so the button is always released.
const MAX_HOLD_MS = 5_000;
const BUTTONS = { left: "left", l: "left", right: "right", r: "right", middle: "middle", m: "middle" };

// Commands that read whole pages or run the agent's code in them may take this long.
export const PAGE_CODE_MS = 30_000;

// The error a page threw in Runtime.evaluate or Runtime.callFunctionOn, without its stack.
export function pageException(exceptionDetails) {
  return new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
}

export const STALE_ELEMENT_MESSAGE = "The element is no longer on the page (it was removed or replaced); call getAXState() for current element numbers";

// Calls a function with `this` = the node. A node that left the document fails instead of being
// changed without any effect on the page.
export async function callOn(cdp, backendNodeId, functionDeclaration, args = []) {
  const { object } = await cdp("DOM.resolveNode", { backendNodeId });
  try {
    const { result, exceptionDetails } = await cdp("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function (...args) {
        if (!this.isConnected) throw new Error(${JSON.stringify(STALE_ELEMENT_MESSAGE)});
        return (${functionDeclaration}).apply(this, args);
      }`,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw pageException(exceptionDetails);
    return result.value;
  } finally {
    // Remote handles pin their DOM nodes until released.
    cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

// Whether a node from an earlier snapshot is still in its document.
export async function isAttached(cdp, backendNodeId) {
  try {
    return await callOn(cdp, backendNodeId, "function () { return true; }");
  } catch (error) {
    if (error.message.includes(STALE_ELEMENT_MESSAGE) || /No node with given id|does not belong to the document/i.test(error.message)) return false;
    throw error;
  }
}

// Center of the element's visible part: the part of its box inside the viewport of its frame session.
export async function elementCenter(cdp, backendNodeId) {
  await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch((error) => {
    if (isUnresponsive(error)) throw error;
  });
  // Only a missing layout box means "not visible"; other failures (e.g. a lost debugger session) surface as they are.
  const [{ quads }, metrics] = await Promise.all([
    cdp("DOM.getContentQuads", { backendNodeId }).catch((error) => {
      if (/Could not compute content quads/i.test(error.message)) return { quads: [] };
      throw error;
    }),
    cdp("Page.getLayoutMetrics").catch(() => null),
  ]);
  const quad = quads?.find((q) => q.length === 8 && Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 0) ?? quads?.[0];
  if (!quad) throw new Error("The element is not visible on the page (it has no layout box)");
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const viewport = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
  const left = Math.max(Math.min(...xs), 0);
  const top = Math.max(Math.min(...ys), 0);
  const right = Math.min(Math.max(...xs), viewport?.clientWidth ?? Infinity);
  const bottom = Math.min(Math.max(...ys), viewport?.clientHeight ?? Infinity);
  if (right <= left || bottom <= top) throw new Error("The element is outside the visible area of the page and could not be scrolled into view");
  return [(left + right) / 2, (top + bottom) / 2];
}

// Focuses an element in one call, after opting the field out of password manager menus. An element
// that cannot take focus itself (a wrapper of a field) passes it to its single field. Returns whether
// focus is now on the element or inside it.
const FOCUS_ELEMENT = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  // Focus is read from the element's own root, which also covers closed shadow trees.
  const inside = () => {
    let active = el.getRootNode().activeElement ?? el.ownerDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    for (let node = active; node; node = node.parentNode ?? node.host) if (node === el) return true;
    return false;
  };
  (function () {${OPT_OUT_OF_PASSWORD_MANAGERS}
  }).call(el);
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  el.focus({ preventScroll: true });
  if (inside()) return true;
  // Text inside an editing host (a contenteditable region) is reached through the host's focus.
  if (el.isContentEditable && el.getRootNode().activeElement?.contains(el)) return true;
  const fields = el.querySelectorAll('input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]');
  if (fields.length === 1) {
    (function () {${OPT_OUT_OF_PASSWORD_MANAGERS}
    }).call(fields[0]);
    fields[0].focus({ preventScroll: true });
  }
  return inside();
}`;
// Run before a click that may focus a field.
const PREPARE_CLICK = `function () {${OPT_OUT_OF_PASSWORD_MANAGERS}
}`;

// With `requireFocus` (for text input), fails when focus did not land on the element instead of letting
// the input go to whatever was focused before. Key presses stay lenient: keyboard widgets often handle
// keys on a focused container rather than on the item named.
export async function focusNode(cdp, backendNodeId, { requireFocus = false } = {}) {
  let focused;
  try {
    focused = await callOn(cdp, backendNodeId, FOCUS_ELEMENT);
  } catch (error) {
    if (error.message.includes(STALE_ELEMENT_MESSAGE)) throw error;
    await cdp("DOM.focus", { backendNodeId });
    return;
  }
  if (!focused && requireFocus) throw new Error("The element cannot take keyboard focus, so typed text would go elsewhere; use the element number of the text field itself, or click the element first");
}

// A page that does not respond (the extension's error for a timed-out quick command).
const isUnresponsive = (error) => isUnresponsivePageError(error?.message);

export async function prepareClick(cdp, backendNodeId) {
  await callOn(cdp, backendNodeId, PREPARE_CLICK).catch((error) => {
    if (error.message.includes(STALE_ELEMENT_MESSAGE) || isUnresponsive(error)) throw error;
  });
}

// What the hit test reports when no element is at the click point.
export const OFF_PAGE = "off-page";

// this = the element about to be clicked, (x, y) = the click point in its frame session's viewport.
// Checks every document from the session root down to the element's own: the point must hit the next
// frame's owner and finally the element. Returns null when the click reaches the element (or the check
// cannot tell), otherwise a short description of what would receive the click instead.
const HIT_TEST = `function (points, mainSession, ownersOnly) {
  let [x, y] = points[0];
  const target = this.nodeType === 1 ? this : this.parentElement;
  if (!target) return null;
  const owners = [];
  let win = target.ownerDocument.defaultView;
  while (win.frameElement) {
    owners.unshift(win.frameElement);
    win = win.parent;
  }
  // A same-process frame under a cross-origin parent: its coordinates cannot be traced here.
  if (mainSession && win !== win.top) return null;
  const deepHit = (doc) => {
    let hit = doc.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // The click reaches the element when the topmost element at the point is the element itself, inside
  // it, or a label of it.
  // Also through slots (slotted content), and when the hit is a shadow host whose closed or built-in
  // shadow tree holds the element (for example the controls of a <video>).
  const reaches = (hit, el) => {
    if (!hit) return false; // the point is outside the document
    for (let node = hit; node; node = node.assignedSlot ?? node.parentNode ?? node.host) if (node === el) return true;
    let crossed = false;
    for (let node = el; node; ) {
      if (node === hit && crossed) return true;
      if (node.parentNode instanceof ShadowRoot) crossed = true;
      node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
    }
    const label = hit.closest?.("label");
    return Boolean(label && label.control === el);
  };
  const describe = (hit) => {
    const classes = typeof hit.className === "string" ? hit.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    return "<" + hit.localName + (hit.id ? "#" + hit.id : "") + classes.map((c) => "." + c).join("") + ">";
  };
  // points[i] is the click point in the document of level i: the session root, then the documents of
  // same-process frames down to the element's. Without them the frame owners are reported, so that the
  // caller can map the point (through any transform) and ask again.
  const chain = [...owners, target];
  // The owners go back by reference; elements can hold cycles (framework properties) that a by-value
  // result cannot carry.
  if (ownersOnly) return owners;
  // Viewport size of each frame (its owner's content box, untransformed), to map points into it.
  if (points.length < chain.length) {
    return { sizes: owners.map((owner) => {
      const style = getComputedStyle(owner);
      return [owner.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), owner.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)];
    }) };
  }
  for (let i = 0; i < chain.length; i++) {
    [x, y] = points[i];
    const hit = deepHit(chain[i].ownerDocument);
    if (!hit) return ${JSON.stringify(OFF_PAGE)};
    if (!reaches(hit, chain[i])) return describe(hit);
  }
  return null;
}`;

// What would receive a click at `point` (in the node's frame session) instead of the node, or null.
// Same-process frames between the session root and the node are passed by mapping the point into each
// frame's document through the frame's quad.
export async function coveringElement(cdp, backendNodeId, point, mainSession) {
  const { object } = await cdp("DOM.resolveNode", { backendNodeId });
  const objectGroup = `hit-${Math.random().toString(36).slice(2)}`;
  const call = (points, returnByValue, ownersOnly = false) =>
    cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: HIT_TEST, arguments: [{ value: points }, { value: mainSession }, { value: ownersOnly }], returnByValue, objectGroup });
  try {
    const first = await call([point], true);
    const verdict = first.result.value;
    if (verdict === null || typeof verdict === "string") return verdict;
    // Frame owners as remote objects, to read their content boxes.
    const { result } = await call([point], false, true);
    const { result: items } = await cdp("Runtime.getProperties", { objectId: result.objectId, ownProperties: true });
    const owners = items.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => a.name - b.name);
    const points = [point];
    for (const [i, owner] of owners.entries()) {
      const { node } = await cdp("DOM.describeNode", { objectId: owner.value.objectId });
      // The content box is where the frame's document is drawn; its quad maps the frame's viewport.
      const { model } = await cdp("DOM.getBoxModel", { backendNodeId: node.backendNodeId }).catch(() => ({}));
      if (!model) return null;
      const [u, v] = quadToSquare(model.content)(...point);
      const [width, height] = verdict.sizes[i];
      points.push([u * width, v * height]);
    }
    return (await call(points, true)).result.value;
  } finally {
    cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    cdp("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

export async function clickAt(cdp, [x, y], { mouseButton = "left", clickCount = 1, key, durationMs = 0 } = {}) {
  const button = BUTTONS[mouseButton];
  if (!button) throw new Error(`Unknown mouse button ${mouseButton}`);
  const modifiers = modifierMask(key);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  for (let count = 1; count <= clickCount; count++) {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers });
    if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, MAX_HOLD_MS)));
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count, modifiers });
  }
}

export async function dragBetween(cdp, [x1, y1], [x2, y2]) {
  const steps = 12;
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    const y = y1 + ((y2 - y1) * i) / steps;
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
}
