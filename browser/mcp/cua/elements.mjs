// Element-level operations shared by accessibility indexes and locators: resolving nodes, finding
// a clickable point, and mouse input. `cdp` is a tab-bound CDP sender.

import { modifierMask } from "./keys.mjs";
import { OPT_OUT_OF_PASSWORD_MANAGERS } from "./page-scripts.mjs";

const BUTTONS = { left: "left", l: "left", right: "right", r: "right", middle: "middle", m: "middle" };

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
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] ?? exceptionDetails.text);
    return result.value;
  } finally {
    // Remote handles pin their DOM nodes until released.
    cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  }
}

// Center of the element's visible part: the part of its box inside the viewport of its frame session.
export async function elementCenter(cdp, backendNodeId) {
  await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
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

// Focuses an element in one call, after opting the field out of password manager menus.
const FOCUS_ELEMENT = `function () {${OPT_OUT_OF_PASSWORD_MANAGERS}
  this.scrollIntoView({ block: "nearest", inline: "nearest" });
  this.focus({ preventScroll: true });
}`;
// Run before a click that may focus a field.
const PREPARE_CLICK = `function () {${OPT_OUT_OF_PASSWORD_MANAGERS}
}`;

export async function focusNode(cdp, backendNodeId) {
  await callOn(cdp, backendNodeId, FOCUS_ELEMENT).catch(() => cdp("DOM.focus", { backendNodeId }));
}

export async function prepareClick(cdp, backendNodeId) {
  await callOn(cdp, backendNodeId, PREPARE_CLICK).catch((error) => {
    if (error.message.includes(STALE_ELEMENT_MESSAGE)) throw error;
  });
}

// this = the element about to be clicked, (x, y) = the click point in its frame session's viewport.
// Checks every document from the session root down to the element's own: the point must hit the next
// frame's owner and finally the element. Returns null when the click reaches the element (or the check
// cannot tell), otherwise a short description of what would receive the click instead.
const HIT_TEST = `function (x, y, mainSession) {
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
  // it (also across shadow roots), or a label of it.
  const reaches = (hit, el) => {
    if (!hit) return false;
    for (let node = hit; node; node = node.parentNode ?? node.host) if (node === el) return true;
    const label = hit.closest?.("label");
    return Boolean(label && label.control === el);
  };
  const describe = (hit) => {
    if (!hit) return "no element (the point is outside the page)";
    const classes = typeof hit.className === "string" ? hit.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    return "<" + hit.localName + (hit.id ? "#" + hit.id : "") + classes.map((c) => "." + c).join("") + ">";
  };
  for (const el of [...owners, target]) {
    const hit = deepHit(el.ownerDocument);
    if (!reaches(hit, el)) return describe(hit);
    if (el !== target) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      x -= rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      y -= rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    }
  }
  return null;
}`;

export function coveringElement(cdp, backendNodeId, [x, y], mainSession) {
  return callOn(cdp, backendNodeId, HIT_TEST, [x, y, mainSession]);
}

export async function clickAt(cdp, [x, y], { mouseButton = "left", clickCount = 1, key, durationMs = 0 } = {}) {
  const button = BUTTONS[mouseButton];
  if (!button) throw new Error(`Unknown mouse button ${mouseButton}`);
  const modifiers = modifierMask(key);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  for (let count = 1; count <= clickCount; count++) {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count, modifiers });
    if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, 30_000)));
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
