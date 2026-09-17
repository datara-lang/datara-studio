// Editor test: mount the real interface, open a real file, and check that the
// text actually becomes visible.
//
// Run:  node ui/test/editor.test.mjs
//
// This exists because the editor came up blank in a real browser while every
// other test passed: the lexer worked, the highlighting pipeline was lossless on
// the same file, and the shell mounted. What none of them did was drive the
// editor the way the app does - set the text and look at what the layers ended
// up containing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const studio = join(here, "..", "..");

const html = readFileSync(join(studio, "ui", "studio.html"), "utf8");
const { window, document } = parseHTML(html);
window.self = window;
window.globalThis = window;
window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
window.WebAssembly = WebAssembly;
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.performance = performance;
window.AbortController = AbortController;
window.atob = (s) => Buffer.from(s, "base64").toString("binary");
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
window.fetch = () => Promise.reject(new Error("no network in this test"));

const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message || e.error)));

for (const s of document.querySelectorAll("script")) {
  if (s.textContent.trim()) runInContext(s.textContent, createContext(window));
}

await new Promise((r) => setTimeout(r, 300));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "\n        got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want)); }
};

const S = window.__Studio;
console.log("editor, driven the way the app drives it");
check("the module exported the editor", typeof S?.Editor?.setText, "function");

// The app mounts the editor only once a file is open - the title screen holds
// that space until then - so a cold boot leaves it unmounted and this test has
// to mount the surface itself, exactly as the app's effect does, before driving
// it. Asserting that the editor was already mounted was asserting the old
// behaviour, which is why this suite had been failing rather than testing.
const host = document.createElement("div");
document.body.appendChild(host);
S.Editor.mount(host, {
  onCursor: () => {}, onInput: () => {}, onLex: () => {},
  onZoom: () => {}, onHoverAsk: () => {},
});

check("the editor mounted into the DOM", !!S.Editor.ta, true);
check("the core loaded", typeof S.Editor.ta === "object" && !!S.Editor.el, true);

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

for (const file of ["PORTING.md", "README.md", "src/main.dtr", "ui/app.js"]) {
  const text = readFileSync(join(studio, file), "utf8");
  let threw = null;
  try { S.Editor.setText(text); } catch (e) { threw = e.message; }
  if (threw) { fail++; console.log("  FAIL  setText(" + file + ") threw: " + threw); continue; }

  const hl = S.Editor.hl.innerHTML;
  const lines = text.split("\n").length;
  check(file + " - the textarea holds the file", S.Editor.ta.value.length, text.length);
  check(file + " - the highlight layer is not empty", hl.length > 0, true);
  check(file + " - the highlight layer carries the whole file", strip(hl), text);
  check(file + " - one gutter row per line", S.Editor.gut.children.length, lines);
  check(file + " - the textarea is tall enough to scroll", parseInt(S.Editor.ta.style.height) >= lines * 21, true);
  // `.rail` was an older name for the gutter's backing panel and is not in the
  // markup any more, so this assertion failed against every file. What matters
  // is that every layer the editor paints into is actually mounted.
  check(file + " - every editor layer is mounted",
    ["gutterback", "gutter", "hl", "squig", "code", "ghost"]
      .every((c) => S.Editor.el.querySelector("." + c) !== null), true);
}

// The editing aids. These are pure text edits with a caret to place, which is
// exactly the kind of code that silently corrupts a document: every one of them
// has to leave the text, the highlight layer and the caret agreeing, and a
// wrong caret puts the next keystroke in the wrong place.
console.log("\nediting aids");
{
  const E = S.Editor;
  const load = (text, caret) => {
    E.setText(text);
    E.ta.selectionStart = E.ta.selectionEnd = caret === undefined ? text.length : caret;
  };
  const caret = () => E.ta.selectionStart;

  // auto-indent
  load("fn main() {\n    let a = 1\n");
  E.ta.selectionStart = E.ta.selectionEnd = 25;      // end of "    let a = 1"
  E.newlineWithIndent("    ");
  check("Enter carries the indentation", E.ta.value.split("\n")[2], "    ");
  check("  and the text that was there is untouched", E.ta.value.split("\n")[1], "    let a = 1");

  load("fn main() {");
  E.ta.selectionStart = E.ta.selectionEnd = 11;      // just after the brace
  E.newlineWithIndent("    ");
  check("Enter after an opening brace adds a level", E.ta.value.split("\n")[1], "    ");
  check("and the caret lands at the end of it", caret(), E.ta.value.length);

  // auto-close
  load("", 0);
  check("typing { inserts the pair", E.autoClose("{", "}"), true);
  check("  and the document has both", E.ta.value, "{}");
  check("  and the caret sits between them", caret(), 1);

  load("{}", 1);
  check("typing } over an existing one steps past it", E.autoClose("}", "}"), true);
  check("  without doubling it", E.ta.value, "{}");
  check("  and the caret moves out", caret(), 2);

  load("abc", 0);
  E.ta.selectionStart = 0; E.ta.selectionEnd = 3;
  E.autoClose("(", ")");
  check("a selection is wrapped, not replaced", E.ta.value, "(abc)");
  check("  and the caret follows the selection", caret(), 4);

  // the rule is about the character AFTER the caret, not about the word before
  // it: at the end of `int` there is nothing next, so a pair is correct
  load("int", 3);
  check("a pair at the end of a word is fine", E.autoClose("(", ")"), true);
  check("  and it is inserted", E.ta.value, "int()");
  load("int", 1);
  check("no pair in the middle of a word", E.autoClose("(", ")"), false);
  check("  and nothing was inserted", E.ta.value, "int");

  // backspace
  load("{}", 1);
  check("backspace between an empty pair removes both", E.backspacePair("{", "}"), true);
  check("  leaving nothing", E.ta.value, "");
  check("  with the caret where the pair was", caret(), 0);
  load("{ x }", 3);
  check("backspace is left alone when the pair is not empty", E.backspacePair("{", "}"), false);

  // toggle comment
  load("    let a = 1\n    let b = 2");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.toggleComment("//");
  check("commenting keeps the indentation", E.ta.value.split("\n")[0], "    // let a = 1");
  check("  and does both lines", E.ta.value.split("\n")[1], "    // let b = 2");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.toggleComment("//");
  check("toggling again restores the original", E.ta.value, "    let a = 1\n    let b = 2");
  check("a language with no comment syntax does nothing", E.toggleComment(""), false);
  load("a\n\nb");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.toggleComment("//");
  check("a blank line is left blank", E.ta.value.split("\n")[1], "");

  // indent / outdent
  load("a\n  b");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.indentSelection(1, "    ");
  check("indent adds a level to every line", E.ta.value.split("\n")[0], "    a");
  check("  including the already-indented one", E.ta.value.split("\n")[1], "      b");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.indentSelection(-1, "    ");
  check("outdent removes it again", E.ta.value, "a\n  b");

  // and the layers must still agree after all of that
  load("fn main() {\n    return 0\n}");
  E.ta.selectionStart = 0; E.ta.selectionEnd = E.ta.value.length;
  E.toggleComment("//");
  check("the highlight layer still carries the text", strip(E.hl.innerHTML), E.ta.value);
  check("the gutter still has one row per line", E.gut.children.length, E.ta.value.split("\n").length);
}

// Snippets: typing a declaration keyword and accepting the completion has to
// produce the shape, indented for where it was typed, with the caret on the
// placeholder. The three things that can go wrong are all silent - the wrong
// caret, the wrong indentation, and no expansion at all, which is what it used
// to do: accepting `fn` inserted the `fn` already on screen.
console.log("\nsnippets");
{
  const E = S.Editor;
  const type = (text, word, caretAt) => {
    E.setText(text);
    E.ta.selectionStart = E.ta.selectionEnd = caretAt === undefined ? text.length : caretAt;
    // exactly what the input listener does: ask for completions, then accept
    E.completer = (w) => S.completerFor(w, [], []);
    E.updateComplete();
    return E.comp && E.comp.items[0] && E.comp.items[0].label === word;
  };
  const sel = () => E.ta.value.slice(E.ta.selectionStart, E.ta.selectionEnd);

  check("typing fn offers a snippet", type("fn", "fn"), true);
  check("  and the hint says it expands",
    E.comp.items[0].hint, "snippet");
  E.acceptComplete();
  check("accepting fn writes a whole function",
    E.ta.value, "fn name() {\n    \n}");
  check("  with an empty body, not a return 0",
    !/return/.test(E.ta.value), true);
  check("  with the name selected so typing replaces it", sel(), "name");
  check("  and the caret at the start of it", E.ta.selectionStart, 3);
  check("  and a second stop armed for the body",
    !!(E.pendingStop && E.pendingStop.line === 2), true);

  // The tab stop, which is the reason `return 0` could be removed at all: after
  // the name is typed, Tab goes into the body instead of inserting an indent.
  E.ta.selectionStart = 3;
  E.ta.selectionEnd = 7;
  E.ta.value = "fn probe() {\n    \n}";
  E.updateCursor && E.updateCursor();
  check("  Tab consumes the stop", E.takeStop(), true);
  check("  and the caret is in the empty body",
    E.ta.value.slice(0, E.ta.selectionStart).split("\n").length, 2);
  check("  and no indent was inserted",
    E.ta.value, "fn probe() {\n    \n}");
  check("  and the stop is not reusable", E.takeStop(), false);

  // the indentation rule: continuation lines take the line's own indent
  check("a nested fn indents to where it was typed",
    type("    fn", "fn", 6) && (E.acceptComplete(), true), true);
  check("  and the body follows",
    E.ta.value, "    fn name() {\n        \n    }");
  check("  and the caret still lands on the name", E.ta.selectionStart, 7);

  check("a snippet replaces only the word typed, not the line",
    type("let x = fn", "fn", 10) && (E.acceptComplete(), true), true);
  check("  and the text before it is untouched",
    E.ta.value.startsWith("let x = fn name() {"), true);

  // the caret goes inside the quotes for the capability scope, because the
  // justification is not optional and an empty one does not compile
  check("unsafe puts the caret between the quotes",
    type("unsafe", "unsafe") && (E.acceptComplete(), true), true);
  check("  and the caret is inside them",
    E.ta.value.slice(0, E.ta.selectionStart).endsWith('"')
      && E.ta.value.slice(E.ta.selectionEnd).startsWith('"'), true);

  // a keyword with no shape must still insert as itself, not vanish
  check("a plain keyword still inserts as the word",
    type("let", "let") && (E.acceptComplete(), true), true);
  check("  and it is still there", E.ta.value, "let");

  // and the whole table has to survive being accepted
  const bad = [];
  for (const k of S.KEYWORDS) {
    const snip = S.SNIPPETS[k];
    if (!snip) continue;
    if (!type(k, k)) { bad.push(k + ": not offered"); continue; }
    E.acceptComplete();
    const v = E.ta.value;
    if (!v.startsWith(k)) bad.push(k + ": does not start with the keyword");
    if (v.indexOf("\n") >= 0 && !snip.body.includes("\n")) bad.push(k + ": grew lines");
    if (E.ta.selectionStart < k.length) bad.push(k + ": caret before the keyword");
    // the placeholder has to be on the first line or the indent step moves it
    if (snip.caret > snip.body.indexOf("\n") && snip.body.includes("\n")) {
      bad.push(k + ": placeholder is not on the first line");
    }
    if (v !== snip.body) bad.push(k + ": body differs: " + JSON.stringify(v));
  }
  if (bad.length) console.log("        " + bad.join("\n        "));
  check("every snippet in the table expands to itself at column 0",
    bad.length === 0, true);
  console.log("        " + Object.keys(S.SNIPPETS).length + " snippets: "
    + Object.keys(S.SNIPPETS).join(" "));
  check("the table covers every declaration keyword", Object.keys(S.SNIPPETS).length >= 15, true);
  E.completer = null;
}

// A new function is named for the project it is written in, and the tab stops
// have to move with the name. This is driven through the accept path rather than
// asserted on the pure function, because the offsets are where a derived name
// breaks: `calculate` is five characters longer than `name`, so a `stop` left at
// the table's 16 would put the second Tab in the middle of the braces, and a
// `select` left at 4 would only half-select the name.
console.log("\na new fn is named for the project");
{
  const E = S.Editor;
  const sel = () => E.ta.value.slice(E.ta.selectionStart, E.ta.selectionEnd);
  const type = (text, word, caretAt, ctx) => {
    E.setText(text);
    E.ta.selectionStart = E.ta.selectionEnd = caretAt === undefined ? text.length : caretAt;
    E.completer = (w) => S.completerFor(w, [], [], ctx);
    E.updateComplete();
    return E.comp && E.comp.items[0] && E.comp.items[0].label === word;
  };
  const ctx = { file: "/x/calculator/main.dtr", root: "/x/calculator" };

  check("in a calculator project fn is still offered", type("fn", "fn", undefined, ctx), true);
  check("  and the hint names what it will write",
    E.comp.items[0].hint, "snippet - calculate");
  E.acceptComplete();
  check("  and accepting writes the derived name",
    E.ta.value, "fn calculate() {\n    \n}");
  check("  with the whole derived name selected", sel(), "calculate");
  check("  and the caret at the start of it", E.ta.selectionStart, 3);
  check("  and a second stop armed for the body",
    !!(E.pendingStop && E.pendingStop.line === 2), true);

  // The stop is stored as a line and a column, so it survives the name being
  // replaced - but it has to have been recorded from the shifted offset in the
  // first place, which is what this checks.
  E.ta.value = "fn calculate() {\n    \n}";
  E.ta.selectionStart = 3;
  E.ta.selectionEnd = 3 + "calculate".length;
  E.updateCursor && E.updateCursor();
  check("  Tab consumes the stop", E.takeStop(), true);
  check("  and lands in the empty body, not after the name",
    E.ta.value.slice(0, E.ta.selectionStart).split("\n").length, 2);
  check("  with the braces intact", E.ta.value, "fn calculate() {\n    \n}");
  check("  and the stop is not reusable", E.takeStop(), false);

  // the file's own name wins, and a project the table does not know is neutral
  check("the file's own name beats the folder's",
    type("fn", "fn", undefined, { file: "/x/calculator/sorter.dtr", root: "/x/calculator" })
      && (E.acceptComplete(), E.ta.value), "fn sort() {\n    \n}");
  check("a project the table does not know keeps the placeholder",
    type("fn", "fn", undefined, { file: "/x/studio/main.dtr", root: "/x/studio" })
      && (E.comp.items[0].hint === "snippet")
      && (E.acceptComplete(), E.ta.value), "fn name() {\n    \n}");

  // and the indentation rule still applies to a derived name
  check("an indented derived fn indents its body to match",
    type("    fn", "fn", 6, ctx) && (E.acceptComplete(), E.ta.value),
    "    fn calculate() {\n        \n    }");
  check("  and the caret still lands on the name", E.ta.selectionStart, 7);
  E.completer = null;
}

console.log("");
if (errors.length) for (const e of errors) { fail++; console.log("  FAIL  window error: " + e); }
else { pass++; console.log("  PASS  no window errors"); }

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
