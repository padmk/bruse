// Key chords in xdotool-style syntax ("Return", "ctrl+a", "super+c", "shift+Tab", "KP_0") translated
// into CDP Input.dispatchKeyEvent parameters.

const MODIFIERS = {
  alt: { bit: 1, key: "Alt", code: "AltLeft", keyCode: 18 },
  option: { bit: 1, key: "Alt", code: "AltLeft", keyCode: 18 },
  ctrl: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  control: { bit: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  meta: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  super: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  cmd: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  command: { bit: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  shift: { bit: 8, key: "Shift", code: "ShiftLeft", keyCode: 16 },
};

const NAMED_KEYS = {
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  kp_enter: { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  page_up: { key: "PageUp", code: "PageUp", keyCode: 33 },
  prior: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  page_down: { key: "PageDown", code: "PageDown", keyCode: 34 },
  next: { key: "PageDown", code: "PageDown", keyCode: 34 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
for (let n = 0; n <= 9; n++) NAMED_KEYS[`kp_${n}`] = { key: String(n), code: `Numpad${n}`, keyCode: 96 + n, text: String(n) };

const SHIFTED = { "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`" };
const PUNCTUATION_CODES = { "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote" };

// Editing commands that key events alone do not trigger on macOS.
const EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

function characterKey(char) {
  const base = SHIFTED[char] ?? char.toLowerCase();
  let code;
  if (/^[a-z]$/.test(base)) code = `Key${base.toUpperCase()}`;
  else if (/^[0-9]$/.test(base)) code = `Digit${base}`;
  else code = PUNCTUATION_CODES[base] ?? "";
  const keyCode = /^[a-z0-9]$/.test(base) ? base.toUpperCase().charCodeAt(0) : 0;
  return { key: char, code, keyCode, text: char };
}

function parseChord(chord) {
  const parts = chord.split("+").filter(Boolean);
  // "ctrl++" and "+" mean the plus key itself.
  if (chord.endsWith("++") || chord === "+") parts.push("+");
  const keyName = parts.pop();
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in key "${chord}"`);
    return modifier;
  });
  const named = MODIFIERS[keyName.toLowerCase()] ?? NAMED_KEYS[keyName.toLowerCase()];
  const key = named ?? (keyName.length === 1 ? characterKey(keyName) : null);
  if (!key) throw new Error(`Unknown key "${keyName}"`);
  const mask = modifiers.reduce((sum, modifier) => sum | modifier.bit, 0);
  const commandModifier = mask & (MODIFIERS.meta.bit | MODIFIERS.ctrl.bit);
  let command;
  if (commandModifier && key.key.length === 1) {
    const lower = key.key.toLowerCase();
    command = mask & MODIFIERS.shift.bit && lower === "z" ? "redo" : EDIT_COMMANDS[lower];
  }
  return { modifiers, mask, key, command };
}

// Sends key down/up events for a chord. Text is only produced when no command modifier is held.
export async function pressChord(send, chord, { durationMs = 0 } = {}) {
  const { modifiers, mask, key, command } = parseChord(chord);
  let held = 0;
  for (const modifier of modifiers) {
    held |= modifier.bit;
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held });
  }
  const producesText = key.text && !(mask & (MODIFIERS.ctrl.bit | MODIFIERS.meta.bit | MODIFIERS.alt.bit));
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: mask };
  await send("Input.dispatchKeyEvent", {
    type: producesText ? "keyDown" : "rawKeyDown",
    ...base,
    ...(producesText ? { text: key.text, unmodifiedText: key.text } : {}),
    ...(command ? { commands: [command] } : {}),
  });
  if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(durationMs, 30_000)));
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  for (const modifier of [...modifiers].reverse()) {
    held &= ~modifier.bit;
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held });
  }
}

// Modifier bitmask for a chord of modifiers only, as used by click({ key }).
export function modifierMask(chord) {
  if (!chord) return 0;
  return chord.split("+").reduce((mask, part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}"`);
    return mask | modifier.bit;
  }, 0);
}
