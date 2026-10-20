// Element-level operations shared by accessibility indexes and locators: resolving nodes, finding
// a clickable point, and mouse input. `cdp` is a tab-bound CDP sender.

import { modifierMask } from "./keys.mjs";
import { OPT_OUT_OF_PASSWORD_MANAGERS } from "./page-scripts.mjs";

const BUTTONS = { left: "left", l: "left", right: "right", r: "right", middle: "middle", m: "middle" };

export async function callOn(cdp, backendNodeId, functionDeclaration, args = []) {
  const { object } = await cdp("DOM.resolveNode", { backendNodeId });
  try {
    const { result, exceptionDetails } = await cdp("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration,
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

export async function elementCenter(cdp, backendNodeId) {
  await cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  // Only a missing layout box means "not visible"; other failures (e.g. a lost debugger session) surface as they are.
  const { quads } = await cdp("DOM.getContentQuads", { backendNodeId }).catch((error) => {
    if (/Could not compute content quads/i.test(error.message)) return { quads: [] };
    throw error;
  });
  const quad = quads?.find((q) => q.length === 8 && Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 0) ?? quads?.[0];
  if (!quad) throw new Error("The element is not visible on the page (it has no layout box)");
  return [(quad[0] + quad[2] + quad[4] + quad[6]) / 4, (quad[1] + quad[3] + quad[5] + quad[7]) / 4];
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
  await callOn(cdp, backendNodeId, PREPARE_CLICK).catch(() => {});
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
