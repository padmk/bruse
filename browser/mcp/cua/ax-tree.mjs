// Accessibility snapshots of a page in an indented, numbered text form. Element numbers stay stable
// for the same DOM node across snapshots of one document, so later snapshots can be reported as a
// diff (~ changed, + added, removed ranges). Child frames that share the page's process are included.

import { PASSWORD_MANAGER_ELEMENTS } from "../../extension/shared.js";

const MAX_LINES = 3000;
const MAX_TEXT = 300;
const SKIPPED_ROLES = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
// Wrappers without their own meaning; unnamed ones are flattened unless they group several children.
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "group", "listitem", "paragraph", "section", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Pre", "time", "Abbr", "emphasis", "strong", "code", "mark", "subscript", "superscript", "DescriptionListTerm", "DescriptionListDetail", "blockquote", "figure", "Ruby", "label", "LabelText"]);
const ROLE_LABELS = {
  RootWebArea: "AXWebArea",
  WebArea: "AXWebArea",
  StaticText: "text",
  textbox: "text field",
  searchbox: "search text field",
  combobox: "combo box",
  PopUpButton: "pop up button",
  ComboBoxMenuButton: "pop up button",
  ComboBoxGrouping: "combo box",
  radio: "radio button",
  spinbutton: "stepper",
  img: "image",
  list: "content list",
  listbox: "list",
  tablist: "tab group",
  tabpanel: "tab panel",
  menubar: "menu bar",
  menuitem: "menu item",
  menuitemcheckbox: "menu item checkbox",
  menuitemradio: "menu item radio",
  columnheader: "column header",
  rowheader: "row header",
  gridcell: "cell",
  contentinfo: "footer",
  alertdialog: "alert dialog",
  Iframe: "frame",
  IframePresentational: "frame",
  LabelText: "label",
  LayoutTable: "container",
  LayoutTableRow: "container",
  LayoutTableCell: "container",
  generic: "container",
  group: "container",
  none: "container",
  presentation: "container",
  listitem: "list item",
  paragraph: "text group",
  DisclosureTriangle: "disclosure triangle",
  progressbar: "progress indicator",
  scrollbar: "scroll bar",
  separator: "separator",
  toolbar: "toolbar",
  tree: "outline",
  treeitem: "row",
};
const EXTENSION_UI_TAGS = new RegExp(PASSWORD_MANAGER_ELEMENTS, "i");
const EXTENSION_UI_IDS = /^(1p-|op-button|__lpform|bit-notification|protonpass-)/i;
const STRUCTURAL_ROLES = new Set(["row", "cell", "gridcell", "generic", "group", "list", "listitem", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "paragraph", "section", "region", "rowgroup", "table"]);
const SETTABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "checkbox", "radio", "switch", "listbox", "ComboBoxMenuButton"]);
const STATE_NAMES = { disabled: "disabled", checked: "checked", selected: "selected", pressed: "pressed", required: "required", readonly: "read only", invalid: "invalid" };

export function clip(text, max = MAX_TEXT) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function shortUrl(url) {
  return String(url).replace(/^https?:\/\//, "").replace(/^www\./, "");
}

// Link targets on the page's own host are shown as a path, others as host and path.
function linkTarget(url, pageHost) {
  try {
    const parsed = new URL(url);
    if (parsed.host === pageHost) return clip(`${parsed.pathname}${parsed.search}${parsed.hash}`, 80);
  } catch {}
  return clip(shortUrl(url), 100);
}

export function property(node, name) {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

const sessionKey = (sessionId) => sessionId ?? "main";

// Records DOM attributes of one document, keyed by session and backend node ID.
function collectAttributes(domRoot, sessionId, attributes) {
  const walk = (domNode) => {
    if (domNode.attributes) {
      const attrs = {};
      for (let i = 0; i < domNode.attributes.length; i += 2) attrs[domNode.attributes[i]] = domNode.attributes[i + 1];
      attributes.set(`${sessionKey(sessionId)}:${domNode.backendNodeId}`, { id: attrs.id, placeholder: attrs.placeholder, tag: domNode.localName });
    }
    for (const child of domNode.children ?? []) walk(child);
    if (domNode.contentDocument) walk(domNode.contentDocument);
    for (const shadow of domNode.shadowRoots ?? []) walk(shadow);
  };
  walk(domRoot);
}

// Collects the AX trees of the main frame, of same-process child frames, and of cross-origin frames
// that run in their own process (`outOfProcessFrames`: [{ frameId, sessionId, parentSessionId, url }]),
// plus DOM attributes. `cdpFor(sessionId)` returns a sender for that frame session (null: main).
export async function fetchPageTree(cdpFor, outOfProcessFrames = []) {
  const main = cdpFor(null);
  const [{ frameTree }, { root: domRoot }, { nodes: mainNodes }] = await Promise.all([
    main("Page.getFrameTree"),
    main("DOM.getDocument", { depth: -1, pierce: true }),
    main("Accessibility.getFullAXTree"),
  ]);
  const attributes = new Map();
  collectAttributes(domRoot, null, attributes);

  const frames = [];
  const collect = (tree) => {
    frames.push(tree.frame);
    for (const child of tree.childFrames ?? []) collect(child);
  };
  collect(frameTree);
  const remote = new Map(outOfProcessFrames.map((frame) => [frame.frameId, frame]));
  for (const frame of outOfProcessFrames) if (!frames.some((f) => f.id === frame.frameId)) frames.push({ id: frame.frameId, url: frame.url });

  const trees = []; // { frameId, sessionId, nodes, ownerKey, main }
  const unavailableFrames = [];
  await Promise.all(
    frames.map(async (frame, index) => {
      if (index === 0) {
        trees.push({ frameId: frame.id, sessionId: null, nodes: mainNodes, ownerKey: null, main: true });
        return;
      }
      const remoteFrame = remote.get(frame.id);
      try {
        if (remoteFrame) {
          const child = cdpFor(remoteFrame.sessionId);
          const parent = cdpFor(remoteFrame.parentSessionId);
          const [{ nodes }, { root }, { backendNodeId }] = await Promise.all([
            child("Accessibility.getFullAXTree"),
            child("DOM.getDocument", { depth: -1, pierce: true }),
            parent("DOM.getFrameOwner", { frameId: frame.id }),
          ]);
          collectAttributes(root, remoteFrame.sessionId, attributes);
          trees.push({ frameId: frame.id, sessionId: remoteFrame.sessionId, nodes, ownerKey: `${sessionKey(remoteFrame.parentSessionId)}:${backendNodeId}` });
        } else {
          const [{ nodes }, { backendNodeId }] = await Promise.all([main("Accessibility.getFullAXTree", { frameId: frame.id }), main("DOM.getFrameOwner", { frameId: frame.id })]);
          trees.push({ frameId: frame.id, sessionId: null, nodes, ownerKey: `main:${backendNodeId}` });
        }
      } catch {
        unavailableFrames.push(frame);
      }
    }),
  );

  // Frames inside a cross-origin frame that share its process are reached through that frame's session.
  await Promise.all(
    outOfProcessFrames.map(async (remoteFrame) => {
      const child = cdpFor(remoteFrame.sessionId);
      const { frameTree: remoteTree } = await child("Page.getFrameTree").catch(() => ({ frameTree: null }));
      const nested = [];
      const walkTree = (tree) => {
        for (const sub of tree?.childFrames ?? []) {
          if (!remote.has(sub.frame.id)) nested.push(sub.frame);
          walkTree(sub);
        }
      };
      walkTree(remoteTree);
      await Promise.all(
        nested.map(async (frame) => {
          try {
            const [{ nodes }, { backendNodeId }] = await Promise.all([
              child("Accessibility.getFullAXTree", { frameId: frame.id }),
              child("DOM.getFrameOwner", { frameId: frame.id }),
            ]);
            trees.push({ frameId: frame.id, sessionId: remoteFrame.sessionId, nodes, ownerKey: `${sessionKey(remoteFrame.sessionId)}:${backendNodeId}` });
          } catch {
            unavailableFrames.push(frame);
          }
        }),
      );
    }),
  );
  const included = new Set(trees.map((tree) => tree.frameId));
  return {
    loaderId: frameTree.frame.loaderId,
    url: frameTree.frame.url,
    // A frame session's ID changes when the debugger attaches again; its frame ID does not.
    sessionFrames: new Map(outOfProcessFrames.map((frame) => [frame.sessionId, frame.frameId])),
    trees,
    attributes,
    unavailableFrames: [...new Map(unavailableFrames.filter((f) => !included.has(f.id)).map((f) => [f.id, f.url])).values()],
  };
}

// Builds the simplified element tree: { key, node, sessionId, attrs, children }.
export function simplifyTree(page) {
  const frameRoots = new Map(); // owner key -> [AX roots of child frames]
  const frameInfo = new Map(); // frameId -> { byId, sessionId }
  let mainRoot = null;
  for (const tree of page.trees) {
    frameInfo.set(tree.frameId, { byId: new Map(tree.nodes.map((node) => [node.nodeId, node])), sessionId: tree.sessionId });
    const root = tree.nodes.find((node) => !node.parentId) ?? tree.nodes[0];
    if (tree.main) mainRoot = { root, frameId: tree.frameId };
    else if (root) frameRoots.set(tree.ownerKey, [...(frameRoots.get(tree.ownerKey) ?? []), { root, frameId: tree.frameId }]);
  }
  if (!mainRoot?.root) return null;

  const simplify = (node, frameId) => {
    if (!node) return [];
    const role = node.role?.value ?? "";
    if (SKIPPED_ROLES.has(role)) return [];
    const { byId, sessionId } = frameInfo.get(frameId);
    // An editable field shows its text as its value; its inner nodes only repeat it.
    const fieldRoot = !node.ignored && property(node, "editable");
    let children = fieldRoot ? [] : (node.childIds ?? []).flatMap((id) => simplify(byId.get(id), frameId));
    for (const frame of frameRoots.get(`${sessionKey(sessionId)}:${node.backendDOMNodeId}`) ?? []) children = children.concat(simplify(frame.root, frame.frameId));
    if (node.ignored) return children;
    // Password manager buttons and live regions injected into the page are not part of it.
    const attrs = page.attributes.get(`${sessionKey(sessionId)}:${node.backendDOMNodeId}`);
    if (attrs && (EXTENSION_UI_TAGS.test(attrs.tag ?? "") || EXTENSION_UI_IDS.test(attrs.id ?? ""))) return [];
    const name = clip(node.name?.value ?? "");
    if (TRANSPARENT_ROLES.has(role) && !name && !property(node, "focusable")) return children.length >= 2 ? [entry(node, frameId, children)] : children;
    if (role === "StaticText" && !name) return [];
    // Empty structural cells, rows and wrappers carry nothing.
    if (!name && !children.length && STRUCTURAL_ROLES.has(role) && !property(node, "focusable")) return [];
    // Unlabeled images carry nothing a reader can use.
    if ((role === "image" || role === "img") && !name && !children.length) return [];
    // Text leaves that repeat part of this element's name, or the value of an editable field, add nothing.
    const editable = property(node, "editable") || SETTABLE_ROLES.has(role);
    children = children.filter((child) => {
      if (child.node.role?.value !== "StaticText" || child.children.length) return true;
      if (editable) return false;
      const text = clip(child.node.name?.value ?? "");
      return !(name && name.includes(text));
    });
    return [entry(node, frameId, children)];
  };
  // Element keys name a frame session by its frame, so element numbers survive a new debugger session.
  const frameKey = (sessionId) => (sessionId ? (page.sessionFrames.get(sessionId) ?? sessionId) : "main");
  const entry = (node, frameId, children) => {
    const { sessionId } = frameInfo.get(frameId);
    return {
      // Nodes without a DOM node get a key from their position when the tree is rendered.
      key: node.backendDOMNodeId !== undefined ? `b${frameKey(sessionId)}:${node.backendDOMNodeId}` : null,
      node,
      sessionId,
      frameId: sessionId ? page.sessionFrames.get(sessionId) : null,
      attrs: page.attributes.get(`${sessionKey(sessionId)}:${node.backendDOMNodeId}`) ?? {},
      children,
    };
  };
  const [root] = simplify(mainRoot.root, mainRoot.frameId);
  return root ?? null;
}

function describe(element, pageHost) {
  const { node, attrs } = element;
  const role = node.role?.value ?? "unknown";
  if (role === "RootWebArea" || role === "WebArea") return `AXWebArea ${clip(node.name?.value ?? "")}, URL: ${shortUrl(property(node, "url") ?? "")}`;
  const label = ROLE_LABELS[role] ?? role;
  const states = [];
  const editable = property(node, "editable");
  if ((SETTABLE_ROLES.has(role) || editable) && !property(node, "disabled")) states.push("settable");
  for (const [name, text] of Object.entries(STATE_NAMES)) {
    const value = property(node, name);
    if (value === true || value === "true") states.push(text);
    else if (value === "mixed") states.push(`${text}: mixed`);
  }
  const expanded = property(node, "expanded");
  if (expanded === true) states.push("expanded");
  else if (expanded === false) states.push("collapsed");

  const parts = [];
  const name = clip(node.name?.value ?? "");
  const value = clip(node.value?.value ?? "");
  const url = property(node, "url");
  const level = property(node, "level");
  if (name) parts.push(name);
  if (role === "heading" && level) parts.push(`Value: ${level}`);
  else if (url) parts.push(`Value: ${linkTarget(url, pageHost)}`);
  else if (value && value !== name) parts.push(`Value: ${value}`);
  if (!value && attrs.placeholder && attrs.placeholder !== name) parts.push(`Placeholder: ${clip(attrs.placeholder)}`);
  const description = clip(node.description?.value ?? "");
  if (description && description !== name) parts.push(`Help: ${description}`);
  if (attrs.id && (SETTABLE_ROLES.has(role) || role === "button" || editable)) parts.push(`ID: ${attrs.id}`);

  return `${label}${states.length ? ` (${states.join(", ")})` : ""}${parts.length ? ` ${parts.join(", ")}` : ""}`;
}

// Per-tab snapshot state: stable element numbers and the previous snapshot for diffs.
export class AXTracker {
  constructor() {
    this.reset(null);
  }

  reset(loaderId) {
    this.loaderId = loaderId;
    this.indexByKey = new Map();
    this.nextIndex = 1;
    this.previous = null; // Map key -> { index, depth, text }
    this.backendByIndex = new Map();
  }

  indexFor(key, isRoot) {
    if (isRoot) {
      this.indexByKey.set(key, 0);
      return 0;
    }
    if (!this.indexByKey.has(key)) this.indexByKey.set(key, this.nextIndex++);
    return this.indexByKey.get(key);
  }

  // Returns { text, focused } for a fetched page; text is a full tree or a diff.
  render(page, { disableDiffing = false } = {}) {
    if (page.loaderId !== this.loaderId) this.reset(page.loaderId);
    const root = simplifyTree(page);
    let pageHost = "";
    try {
      pageHost = new URL(page.url).host;
    } catch {}
    if (!root) return { text: "The page has no accessibility tree yet.", focusedLine: null };

    const current = new Map();
    const order = [];
    // Only elements in this snapshot can be acted on.
    this.backendByIndex = new Map();
    const lastChildOf = new Map(); // parent key -> key of the previous sibling seen
    let focusedLine = null;
    let truncated = false;
    const positionalCounts = new Map();
    const visit = (element, depth, parentKey = null) => {
      // AX node IDs change between snapshots, so a node without a DOM node is keyed by parent, role, name and order.
      if (element.key === null) {
        const base = `${parentKey}>${element.node.role?.value}:${element.node.name?.value ?? ""}`;
        const count = positionalCounts.get(base) ?? 0;
        positionalCounts.set(base, count + 1);
        element.key = `${base}#${count}`;
      }
      if (order.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      const index = this.indexFor(element.key, depth === 0);
      const line = `${index} ${describe(element, pageHost)}`;
      if (element.node.backendDOMNodeId !== undefined) this.backendByIndex.set(index, { backendNodeId: element.node.backendDOMNodeId, sessionId: element.sessionId, frameId: element.frameId });
      const previousSibling = lastChildOf.get(parentKey) ?? null;
      lastChildOf.set(parentKey, element.key);
      current.set(element.key, { index, depth, line, parent: parentKey, previousSibling });
      order.push(element.key);
      if (property(element.node, "focused")) focusedLine = line;
      for (const child of element.children) visit(child, depth + 1, element.key);
    };
    visit(root, 0);

    const format = ({ depth, line }) => `${"\t".repeat(depth)}${line}`;
    let text;
    if (!this.previous || disableDiffing) {
      text = order.map((key) => format(current.get(key))).join("\n");
    } else {
      const changes = [];
      for (const key of order) {
        const now = current.get(key);
        const before = this.previous.get(key);
        if (!before) changes.push(`+${format(now)}`);
        // A node that moved to another parent or position counts as changed. A new previous sibling that
        // was only inserted or removed next to it is not a move.
        else if (before.line !== now.line || before.parent !== now.parent || this.reordered(before, now, current)) changes.push(`~${format(now)}`);
      }
      const removed = [...this.previous.entries()].filter(([key]) => !current.has(key)).map(([, value]) => value.index).sort((a, b) => a - b);
      if (!changes.length && !removed.length) text = "There has been no change in the accessibility tree.";
      else if (changes.length > order.length * 0.6) text = order.map((key) => format(current.get(key))).join("\n");
      else {
        text = "The following is a diff from the previous accessibility tree with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range.\n" + changes.join("\n");
        if (removed.length) text += `\nRemoved: ${summarizeRanges(removed)}`;
      }
    }
    if (truncated) text += `\n… truncated after ${MAX_LINES} elements; scroll or use playwright locators for the rest.`;
    if (page.unavailableFrames.length) text += `\nCross-origin frames not included: ${page.unavailableFrames.map(shortUrl).join(", ")}`;
    this.previous = current;
    return { text, focusedLine };
  }

  reordered(before, now, current) {
    if (before.previousSibling === now.previousSibling) return false;
    const newNeighbourExisted = now.previousSibling === null || this.previous.has(now.previousSibling);
    const oldNeighbourRemains = before.previousSibling === null || current.has(before.previousSibling);
    return newNeighbourExisted && oldNeighbourRemains;
  }

  // Returns { backendNodeId, sessionId, frameId } for an element number of the latest snapshot.
  nodeRef(index) {
    const id = this.backendByIndex.get(index);
    if (id === undefined) throw new Error(`Element ${index} is not in the latest accessibility state of this tab; call getAXState() again`);
    return id;
  }
}

function summarizeRanges(numbers) {
  const ranges = [];
  let start = numbers[0];
  let end = numbers[0];
  for (const n of numbers.slice(1)) {
    if (n === end + 1) end = n;
    else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = end = n;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}
