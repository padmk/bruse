// Playwright-style ARIA snapshot of a page (the YAML-like form of locator.ariaSnapshot()), built from
// the same simplified accessibility tree as getAXState(), including cross-origin frames.

import { property, simplifyTree } from "./ax-tree.mjs";

const MAX_LINES = 5000;
const MAX_TEXT = 300;
// Chrome's internal roles mapped to ARIA roles; roles in FLATTENED only pass their children through.
const ROLES = {
  StaticText: "text",
  Iframe: "iframe",
  IframePresentational: "iframe",
  image: "img",
  ComboBoxMenuButton: "combobox",
  ComboBoxGrouping: "combobox",
  PopUpButton: "combobox",
  DisclosureTriangle: "button",
  LabelText: "label",
};
const FLATTENED = new Set(["generic", "none", "presentation", "group", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Section", "section", "Pre", "time", "Abbr", "emphasis", "strong", "code", "mark", "subscript", "superscript", "Ruby", "label", "LabelText", "MenuListPopup"]);
const STATES = ["checked", "disabled", "expanded", "pressed", "selected"];

function clip(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

// Plain text stays unquoted unless YAML would read it as something else.
function scalar(text) {
  return /^[\s\-[\]{}"'!&*#?|>%@`]|: |:$|\s$/.test(text) ? JSON.stringify(text) : text;
}

export function ariaSnapshot(page) {
  const root = simplifyTree(page);
  if (!root) return "";
  const lines = [];
  const visit = (element, depth) => {
    if (lines.length >= MAX_LINES) return;
    const { node, attrs } = element;
    const chromeRole = node.role?.value ?? "";
    const name = clip(node.name?.value ?? "");
    const indent = "  ".repeat(depth);
    if (chromeRole === "StaticText") {
      if (name) lines.push(`${indent}- text: ${scalar(name)}`);
      return;
    }
    // A frame's document shows up as the content of its iframe entry.
    if ((FLATTENED.has(chromeRole) && !name) || chromeRole === "RootWebArea" || chromeRole === "WebArea") {
      for (const child of element.children) visit(child, depth);
      return;
    }
    const role = ROLES[chromeRole] ?? chromeRole;
    let head = `${indent}- ${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
    if (role === "iframe" && attrs.id) head += ` [id=${JSON.stringify(attrs.id)}]`;
    const level = property(node, "level");
    if (role === "heading" && level) head += ` [level=${level}]`;
    for (const state of STATES) {
      const value = property(node, state);
      if (value === true || value === "true") head += ` [${state}]`;
      else if (value === "mixed") head += ` [${state}=mixed]`;
    }
    const value = clip(node.value?.value ?? "");
    const extras = [];
    const url = property(node, "url");
    if (role === "link" && url) extras.push(`${indent}  - /url: ${scalar(url)}`);
    if (attrs.placeholder && !value) extras.push(`${indent}  - /placeholder: ${scalar(clip(attrs.placeholder))}`);
    if (!element.children.length && !extras.length) {
      lines.push(value && value !== name ? `${head}: ${scalar(value)}` : head);
      return;
    }
    if (element.children.length === 1 && !extras.length && element.children[0].node.role?.value === "StaticText" && !value) {
      const text = clip(element.children[0].node.name?.value ?? "");
      lines.push(text ? `${head}: ${scalar(text)}` : head);
      return;
    }
    lines.push(`${head}:`);
    lines.push(...extras);
    for (const child of element.children) visit(child, depth + 1);
  };
  // The document itself is not part of the snapshot, only its content.
  for (const child of root.children) visit(child, 0);
  if (lines.length >= MAX_LINES) lines.push(`# truncated after ${MAX_LINES} lines; use locators for the rest`);
  if (page.unavailableFrames.length) lines.push(`# cross-origin frames not included: ${page.unavailableFrames.join(", ")}`);
  return lines.join("\n");
}
