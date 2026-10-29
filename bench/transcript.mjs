// What a run's conversation shows beyond its answer: how the agent reached the page, where the time
// went and whether the browser was there at all. Claude Code's stream-json events arrive as lines; the
// runner stamps each line with the time it arrived, since the events carry no time of their own.

// Code in Bruse's js tool runs in Node.js, so these reach files, the network or processes without the
// browser. The page function passed to evaluate(), evaluateAll() or evaluateHandle() runs in the page
// instead and is left out before matching (see nodeCode).
const NODE_ACCESS = /\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bnode:|child_process|\bprocess\.(env|argv|exit)|XMLHttpRequest/;
const NOT_CONNECTED = /browser extension did not connect/i;

// The end of a call's first argument, from just inside its "(": the index of the "," or ")" that ends
// it, skipping strings, template literals and comments. Regular expression literals are not
// recognized, so a parenthesis in one can shift the end; the transcript stays the evidence to read.
function firstArgumentEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
    } else if (c === "/" && code[i + 1] === "/") {
      i = code.indexOf("\n", i);
      if (i < 0) return code.length;
    } else if (c === "/" && code[i + 1] === "*") {
      i = code.indexOf("*/", i + 2) + 1;
      if (i <= 0) return code.length;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
  }
  return code.length;
}

// The source without the page function passed to evaluate(), evaluateAll() or evaluateHandle(), which
// runs in the page; the other arguments are evaluated in Node.js and stay.
function nodeCode(code) {
  let out = "";
  let i = 0;
  for (const match of code.matchAll(/\.(?:evaluate|evaluateAll|evaluateHandle)\s*\(/g)) {
    if (match.index < i) continue;
    const start = match.index + match[0].length;
    out += code.slice(i, start);
    i = firstArgumentEnd(code, start);
  }
  return out + code.slice(i);
}

// `lines` holds { at, text } for every stdout line of `claude -p --output-format stream-json`.
export function readClaudeTranscript(lines, { browserTools }) {
  const calls = new Map(); // tool_use id -> { name, at }
  const summary = { browserCalls: 0, otherToolCalls: 0, toolMs: 0, slowestToolMs: 0, nodeAccess: [], extensionMissing: false };
  for (const { at, text } of lines) {
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of content) {
      if (event.type === "assistant" && item.type === "tool_use") {
        calls.set(item.id, { name: item.name, at });
        if (browserTools.some((prefix) => item.name.startsWith(prefix))) summary.browserCalls++;
        else summary.otherToolCalls++;
        const code = nodeCode(String(item.input?.code ?? ""));
        const match = item.name === "mcp__bruse__js" && code.match(NODE_ACCESS);
        if (match) summary.nodeAccess.push(match[0]);
      }
      if (event.type === "user" && item.type === "tool_result") {
        const call = calls.get(item.tool_use_id);
        if (call) {
          const ms = at - call.at;
          summary.toolMs += ms;
          summary.slowestToolMs = Math.max(summary.slowestToolMs, ms);
        }
        const result = Array.isArray(item.content) ? item.content.map((part) => part.text ?? "").join("") : String(item.content ?? "");
        if (NOT_CONNECTED.test(result)) summary.extensionMissing = true;
      }
    }
  }
  return summary;
}
