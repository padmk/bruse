// Rewrites top-level declarations of a code cell into assignments, so that names declared with
// const/let/var/function/class persist as globals of the REPL context and can be redeclared in later
// cells. Nested scopes are left alone. A small scanner skips strings, template literals, comments and
// regular expressions to find statements at bracket depth 0.

// A line break does not end a statement after these tokens, or before these tokens.
const CONTINUES_AFTER = new Set(["=", ",", "?", ":", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~", "<", ">", ".", "(", "[", "{", "=>", "new", "typeof", "instanceof", "in", "of", "await", "yield", "delete", "void"]);
const CONTINUES_BEFORE = new Set([".", "?", ":", ",", ")", "]", "}", "=", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "(", "[", "`", "=>", "in", "of", "instanceof"]);
const CONDITION_KEYWORDS = new Set(["if", "while", "for", "with"]);
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const IDENT = /[A-Za-z0-9_$\u0080-\uffff]/;

// Returns [{ start, end, kind, depth, statementStart }] tokens that matter for hoisting.
function scan(code) {
  const tokens = [];
  const brackets = []; // stack of "(", "[", "{", "${"
  let i = 0;
  let lastSignificant = ""; // last token text, for regex detection and statement starts
  let newlineSinceLast = true;
  let statementStart = true;

  const push = (start, end, kind, extra) => {
    const text = code.slice(start, end);
    const previous = tokens[tokens.length - 1];
    // A line break at depth 0 ends the statement unless the surrounding tokens continue it. A prefix
    // ++ or -- continues onto its operand; a postfix one ends the expression.
    const lineBoundary =
      newlineSinceLast && brackets.length === 0 && !!previous && !CONTINUES_AFTER.has(previous.text) && !previous.prefix && !CONTINUES_BEFORE.has(text[0] === "`" ? "`" : text);
    tokens.push({ start, end, kind, text, depth: brackets.length, lineBoundary, statementStart: statementStart || lineBoundary || !previous, ...extra });
    lastSignificant = text;
    newlineSinceLast = false;
    statementStart = false;
  };

  while (i < code.length) {
    const c = code[i];
    if (c === "\n") {
      newlineSinceLast = true;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
    } else if (c === "'" || c === '"') {
      const start = i++;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
      push(start, ++i, "string");
    } else if (c === "`" || (c === "}" && brackets[brackets.length - 1] === "${")) {
      // Template literal text, from a backtick or from the end of a ${ } substitution.
      const start = i;
      if (c === "}") brackets.pop();
      i++;
      while (i < code.length && code[i] !== "`" && !(code[i] === "$" && code[i + 1] === "{")) i += code[i] === "\\" ? 2 : 1;
      if (code[i] === "$") {
        brackets.push("${");
        i += 2;
      } else i++;
      push(start, i, "template");
    } else if (c === "/" && (!lastSignificant || /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant) || KEYWORDS_BEFORE_REGEX.has(lastSignificant))) {
      const start = i++;
      let inClass = false;
      while (i < code.length && (code[i] !== "/" || inClass)) {
        if (code[i] === "\\") i++;
        else if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
        i++;
      }
      i++;
      while (i < code.length && /[a-z]/i.test(code[i])) i++;
      push(start, i, "regex");
    } else if (IDENT.test(c)) {
      const start = i;
      while (i < code.length && IDENT.test(code[i])) i++;
      push(start, i, "word");
    } else if ("([{".includes(c)) {
      // A parenthesis after if/while/for/with holds a condition; a "/" right after it starts a regex.
      const opener = c === "(" && CONDITION_KEYWORDS.has(lastSignificant) ? "(condition" : c;
      push(i, i + 1, "open");
      brackets.push(opener);
      i++;
      if (c === "{") statementStart = true;
    } else if (")]}".includes(c)) {
      const opener = brackets.pop();
      push(i, i + 1, "close");
      if (opener === "(condition") lastSignificant = ";";
      i++;
      if (c === "}") statementStart = true;
    } else if (c === ";") {
      push(i, i + 1, "punct");
      i++;
      statementStart = true;
    } else if ((c === "+" || c === "-") && code[i + 1] === c) {
      // ++ and -- are one token. After an operand (a name, a literal, a closing bracket) on the same
      // line they are postfix, and a line break after them ends the statement.
      const previous = tokens[tokens.length - 1];
      const postfix = !newlineSinceLast && !!previous && (previous.kind === "word" || previous.kind === "string" || previous.kind === "template" || previous.kind === "regex" || previous.text === ")" || previous.text === "]");
      push(i, i + 2, "punct", postfix ? undefined : { prefix: true });
      i += 2;
    } else {
      push(i, i + 1, "punct");
      i++;
    }
  }
  return tokens;
}

export function hoistTopLevelDeclarations(code) {
  // Cells run in sloppy mode so that rewritten names become globals; a leading directive would undo that.
  code = code.replace(/^(\s*)(["'])use strict\2;?/, "$1");
  const tokens = scan(code);
  const edits = []; // { at, remove, insert }
  const exportedFunctions = [];
  // A declaration turned into an assignment expression needs a ";" after its body.
  const terminate = (from) => {
    let d = from;
    while (d < tokens.length && !(tokens[d].text === "{" && tokens[d].depth === 0)) d++;
    while (d < tokens.length && !(tokens[d].text === "}" && tokens[d].depth === 0)) d++;
    if (d < tokens.length) edits.push({ at: tokens[d].end, remove: 0, insert: ";" });
  };
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t];
    if (token.depth !== 0 || !token.statementStart || token.kind !== "word") continue;
    const next = tokens[t + 1];
    if (!next) continue;

    if (["const", "let", "var"].includes(token.text) && (next.kind === "word" || next.text === "{" || next.text === "[")) {
      if (next.kind === "word" && next.text === "of") continue;
      // Remove the keyword (and the whitespace after it).
      edits.push({ at: token.start, remove: next.start - token.start, insert: "" });
      // Find the end of this declaration: ; or a newline at depth 0 that ends the statement.
      let end = t + 1;
      while (end + 1 < tokens.length && !(tokens[end + 1].depth === 0 && (tokens[end + 1].text === ";" || tokens[end + 1].lineBoundary))) end++;
      if (next.text === "{" || next.text === "[") {
        // A destructuring assignment must be parenthesized to parse as an expression.
        edits.push({ at: next.start, remove: 0, insert: "(" });
        edits.push({ at: tokens[end].end, remove: 0, insert: ")" });
      } else {
        // Declarators without an initializer become explicit undefined assignments.
        for (let d = t + 1; d <= end; d++) {
          const isName = tokens[d].kind === "word" && tokens[d].depth === 0 && (d === t + 1 || tokens[d - 1].text === ",");
          const following = tokens[d + 1];
          if (isName && (!following || following.text === "," || following.text === ";" || d === end)) {
            edits.push({ at: tokens[d].end, remove: 0, insert: " = undefined" });
          }
        }
      }
    } else if (token.text === "function" || (token.text === "async" && next.text === "function")) {
      // Function declarations stay declarations (they are hoisted within the cell); the cell starts by
      // publishing them as globals.
      const fnToken = token.text === "async" ? next : token;
      let nameIndex = tokens.indexOf(fnToken) + 1;
      if (tokens[nameIndex]?.text === "*") nameIndex++;
      const name = tokens[nameIndex];
      if (name?.kind === "word") exportedFunctions.push(name.text);
    } else if (token.text === "class" && next.kind === "word" && next.text !== "extends") {
      edits.push({ at: token.start, remove: 0, insert: `${next.text} = ` });
      terminate(t + 1);
    }
  }
  let result = code;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    result = result.slice(0, edit.at) + edit.insert + result.slice(edit.at + edit.remove);
  }
  const prologue = exportedFunctions.map((name) => `globalThis.${name} = ${name};`).join(" ");
  return prologue ? `${prologue}\n${result}` : result;
}
