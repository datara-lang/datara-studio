// Render test for the interface.
//
// Run:  node ui/test/render.test.mjs
//
// Why this exists: a real browser is not available in this environment (Chrome
// starts but is blocked from writing files or stdout, so neither --screenshot
// nor --dump-dom produces anything). That left the interface never rendered
// anywhere, which is not an acceptable state for the thing the user actually
// looks at.
//
// So the component tree is rendered to static markup with react-dom/server. That
// does not verify pixels - nothing but a browser can - but it does verify the
// part that would otherwise be pure hope: that the tree renders without
// throwing, that every piece of chrome is present, and that the class names the
// stylesheet depends on actually appear in the output. A typo in a class name is
// invisible in the source and obvious here.
//
// Effects do not run under static rendering, so the tree renders in its empty
// state: no files, no diagnostics, AI offline. That is exactly the state a
// first-time user sees, which makes it worth asserting.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, "..", "vendor");

// --- load the vendored UMD bundles without a module system -------------------
//
// Two details matter. Passing no module/exports makes the bundles take their
// global branch instead of calling `require`. And the bundles disagree about
// where the global lives: React uses `self`, htm uses `this`, so the function is
// invoked with the stub as its receiver as well as its `self` argument.
function loadUMD(file, win) {
  const src = readFileSync(join(vendor, file), "utf8");
  const fn = new Function("module", "exports", "window", "self", "globalThis", "require", src);
  fn.call(win, undefined, undefined, win, win, win, undefined);
}

const win = {};
loadUMD("react.production.min.js", win);
loadUMD("react-dom-server-legacy.production.min.js", win);
loadUMD("htm.umd.js", win);

// The app reads localStorage during its first render (column widths, last file,
// panel tab). linkedom does not provide one and neither does this stub, so
// without it every assertion below fails with "localStorage is not defined" -
// which is a harness gap, not a page bug. Same stub the boot and editor tests
// carry.
win.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; },
};

const React = win.React;
const ReactDOMServer = win.ReactDOMServer;
const htm = win.htm;

if (typeof React.createElement !== "function") throw new Error("react failed to load");
// The plain .browser build only exposes renderToReadableStream; the legacy
// build is the one that has renderToStaticMarkup and needs no stream support.
if (typeof ReactDOMServer.renderToStaticMarkup !== "function") throw new Error("react-dom/server legacy failed to load, got " + typeof ReactDOMServer);
if (typeof htm !== "function") throw new Error("htm failed to load, got " + typeof htm);

// --- load app.js with its dependencies injected ------------------------------
const appSrc = readFileSync(join(here, "..", "app.js"), "utf8");
const load = new Function(
  "React", "ReactDOM", "htm", "window", "document", "fetch", "localStorage",
  "performance", "TextEncoder", "TextDecoder", "atob", "setInterval", "setTimeout", "clearTimeout", "AbortController",
  appSrc + "\n; return { App, Editor, Palette, Tree, TreeNode, Panel, IntentBar, Mark, Browser, NewRow, Settings, coreHighlight, symbols, buildTree, resolveName, parseForgenDiagnostics, stripAnsi, checkTarget, checkBody, checkNote, dirOf, hoverInfo, fileIcon, completerFor, KEYWORDS, TYPES, BUILTINS, DATARA_DOCS, FILE_KINDS, DATARA_LANG, PLAIN_LANG, PROVIDERS, providerFor };"
);

const noop = () => {};
const Studio = load(
  React,
  { createRoot: () => ({ render: noop }) },
  htm,
  win,
  undefined,            // no document: the mount guard skips
  () => Promise.reject(new Error("no network in the render test")),
  win.localStorage,
  { now: () => 0 },
  TextEncoder,
  TextDecoder,
  () => "",
  noop, noop, noop,
  class { abort() {} }
);

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "\n        got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want)); }
}
function has(hay, needle) { return hay.includes(needle); }

console.log("component tree renders");
let out = "";
try {
  out = ReactDOMServer.renderToStaticMarkup(React.createElement(Studio.App));
  pass++;
  console.log("  PASS  App renders without throwing  (" + out.length + " bytes of markup)");
} catch (e) {
  fail++;
  console.log("  FAIL  App threw during render: " + e.message);
}

console.log("\nevery piece of chrome is present");
const wanted = [
  ["shell grid", 'class="shell"'],
  ["intent bar", 'class="intent"'],
  ["a settings button where the wordmark used to be", 'title="Settings   Ctrl+,"'],
  ["explorer create control", 'title="Create a file or a folder'],
  ["explorer create label", ">create</button>"],
  ["explorer filter field", 'class="filter"'],
  ["workspace path", 'class="ws"'],
  ["search field", 'class="search"'],
  // The top bar's search is a button that opens the palette, not a text input -
  // it was an input once, and this assertion still described that markup, which
  // is why it had been failing against the real component.
  ["search hint", 'class="searchhint"'],
  ["run control", 'class="run"'],
  ["run control split divider", 'class="div"'],
  ["run control chevron", 'class="chev"'],
  ["ai status led", 'class="led'],
  ["file tree", 'class="tree"'],
  ["tree section label", 'class="lbl"'],
  ["breadcrumb", 'class="crumbs"'],
  ["right panel", 'class="panel"'],
  ["panel tabs", 'class="ptabs"'],
  ["status bar", 'class="status"'],
];
for (const [label, needle] of wanted) check(label, has(out, needle), true);

console.log("\npanel tabs are all there, offline ones first");
for (const label of ["Problems", "Structure", "Project", "Layout", "AI", "Generate"]) {
  check("tab: " + label, has(out, label), true);
}
// the first tab must be one that works with no companion running
check("opens on Problems, not on AI", out.indexOf(">Problems") < out.indexOf(">AI<"), true);

console.log("\nthe run control says run, not check/build/lint");
check("labelled Run", has(out, ">Run<") || has(out, "Run</span>"), true);
check("no Check button in the chrome", has(out, ">Check<"), false);
check("no Build button in the chrome", has(out, ">Build<"), false);
check("no Lint button in the chrome", has(out, ">Lint<"), false);

console.log("\nthe status bar no longer reports telemetry");
for (const gone of ["tokens", "lex ", "chars", "UTF-8"]) {
  check("removed from status: " + gone, has(out, gone), false);
}
check("shows no file yet", has(out, "no file"), true);
check("offers output", has(out, "output"), true);

console.log("\nthe AI indicator is a dot, not a sentence");
check("ai status is a dot", has(out, 'class="led"'), true);
check("no 'ai off' text in the chrome", has(out, ">ai off<"), false);
check("no 'ai on' text in the chrome", has(out, ">ai on<"), false);

console.log("\nfirst-run state (effects do not run under static rendering)");
check("says no file open", has(out, "no file open"), true);
check("explorer header", has(out, "explorer"), true);
check("problems panel explains itself without AI", has(out, "No problems"), true);

console.log("\nno undefined leaked into the markup");
check("no 'undefined' text", /\bundefined\b/.test(out), false);
check("no 'NaN' text", /\bNaN\b/.test(out), false);
check("no '[object Object]'", has(out, "[object Object]"), false);

console.log("\nsymbol extraction");
{
  const src = "//! doc\npub struct Rope {\n    chunks: Int\n}\npub fn rope_len(r: Int) -> Int => r\nfn main() {}\n";
  const syms = Studio.symbols(src);
  check("finds struct, fn, fn", syms.map((s) => s.kind + ":" + s.name),
    ["struct:Rope", "fn:rope_len", "fn:main"]);
  check("reports correct lines", syms.map((s) => s.line), [2, 5, 6]);
}

// The name rule the create row applies while the user types. It is a pure
// function, so it is the one part of the create flow that can be checked
// without a browser - and it is the part the user actually specified.
console.log("\nthe create name rule (default .txt, keep a typed extension)");
{
  const r = Studio.resolveName;
  check("a bare name becomes .txt", r("notes", false), "notes.txt");
  check("a typed extension is kept", r("datara.dtr", false), "datara.dtr");
  check("another typed extension is kept", r("readme.md", false), "readme.md");
  check("a dotted stem is not an extension", r("v1.2", false), "v1.2");
  check("a dotfile is left alone", r(".gitignore", false), "..gitignore".slice(1));
  check("a path keeps its folder", r("tools/check.dtr", false), "tools/check.dtr");
  check("a folder gets no extension", r("tools", true), "tools");
  check("whitespace is trimmed", r("  notes  ", false), "notes.txt");
  check("a trailing dot does not double up", r("notes.", false), "notes.txt");
  check("empty stays empty", r("   ", false), "");
}

// Folders come from the server as their own list, which is what makes an empty
// folder visible. Inferred from file paths alone it would not exist, and
// creating one looked like it had done nothing.
console.log("\nthe tree shows empty folders");
{
  const root = "D:/ws";
  const files = ["D:/ws/a.dtr", "D:/ws/src/b.dtr"];
  const dirs = ["D:/ws/src", "D:/ws/tools", "D:/ws/src/deep"];
  const t = Studio.buildTree(files, dirs, root);
  check("top-level folders", Object.keys(t.dirs).sort(), ["src", "tools"]);
  check("a folder with no files still exists", Object.keys(t.dirs.tools).sort(),
    ["dirs", "files", "key", "name"]);
  check("its key is the relative path", t.dirs.tools.key, "tools");
  check("nested folders", Object.keys(t.dirs.src.dirs), ["deep"]);
  check("files land in their folder", t.dirs.src.files.map((f) => f.name), ["b.dtr"]);
  check("top-level files stay at the top", t.files.map((f) => f.name), ["a.dtr"]);
  check("file keeps its full path", t.files[0].path, "D:/ws/a.dtr");
}

// The compiler's output is the source of the red squiggles, so the parser is
// the piece worth testing hardest: a wrong column puts the underline in the
// wrong place and a missed `\\?\` prefix means no diagnostic ever matches the
// open file.
// The explorer has to say what is wrong and offer the way out. A workspace that
// cannot be read used to render as "No files yet" - the most misleading state
// this interface has, because a stuck server and an empty project looked the
// same - and the error that replaced it arrived as mojibake until the server
// converted the shell's codepage on that path too.
console.log("\nthe explorer explains a workspace it cannot read");
{
  const noop = () => {};
  const base = {
    files: [], dirs: [], current: "", filter: "", setFilter: noop, onOpen: noop,
    dirty: false, root: "D:/", creating: null, createKey: "", onCreate: noop,
    onCommit: noop, onCancelCreate: noop, onDropInto: noop,
  };
  const bad = ReactDOMServer.renderToStaticMarkup(React.createElement(Studio.Tree, {
    ...base, onPickFolder: noop,
    error: "cannot read that folder - Системе не удается найти указанный путь.",
  }));
  check("the failure is stated", bad.includes("cannot read that folder"), true);
  check("the shell's own words survive, not mojibake", bad.includes("Системе"), true);
  check("and there is a way out", bad.includes("choose a folder"), true);

  const shallow = ReactDOMServer.renderToStaticMarkup(React.createElement(Studio.Tree, {
    ...base, note: "drive root - showing the top level only. Open a folder to see inside.",
  }));
  check("a drive root admits it is showing one level", shallow.includes("top level only"), true);
  check("a note is not dressed as an error", shallow.includes("note bad"), false);

  const empty = ReactDOMServer.renderToStaticMarkup(React.createElement(Studio.Tree, { ...base }));
  check("an empty workspace still says so", empty.includes("Nothing here yet"), true);
  check("an empty workspace is not an error", empty.includes("note bad"), false);
}

console.log("\nforgen output -> editor problems");
{
  const real = [
    "error[E-TYPE-001]: Type mismatch for argument 1: expected 'Int', got 'Str'",
    "  --> \\\\?\\D:\\IDE datara\\datara-studio\\.probe_check\\bad.dtr:7:12",
    "     | ",
    "   7 |     return helper(\"not an int\")",
    "     |            ^^^^^^^^^^^^^^^^^^^^",
    "     |",
    "     = note: for more details, run 'forgen explain E-TYPE-001'",
    "",
  ].join("\n");

  const d = Studio.parseForgenDiagnostics(real, "D:/IDE datara/datara-studio/.probe_check/bad.dtr");
  check("one diagnostic found", d.length, 1);
  check("severity", d[0].severity, "error");
  check("code", d[0].code, "E-TYPE-001");
  check("line", d[0].line, 7);
  check("column", d[0].col, 12);
  check("span length comes from the caret row", d[0].len, 20);
  check("the \\\\?\\ prefix is stripped so it matches the open file", d[0].here, true);
  check("message is kept whole", d[0].message,
    "Type mismatch for argument 1: expected 'Int', got 'Str'");

  // a clean run must produce nothing rather than a phantom problem
  const clean = "[Forgen check] Verified 100% OK in 138ms (1 modules, 0 errors, valid ownership & effects)\n";
  check("a clean run reports nothing", Studio.parseForgenDiagnostics(clean, "x.dtr").length, 0);

  // a problem in a different file is still reported, but not as this file's
  const other = real.replace(/bad\.dtr/, "other.dtr");
  const o = Studio.parseForgenDiagnostics(other, "D:/IDE datara/datara-studio/.probe_check/bad.dtr");
  check("another file's problem is marked as not-here", o[0].here, false);

  // a warning, and several diagnostics in one output
  const two = "warning[W0100]: class is deprecated\n  --> \\\\?\\D:\\a.dtr:2:1\n   |\n 2 | class X {\n   | ^^^^^\n\nerror[E-SYNTAX-001]: Unexpected token: Equal\n  --> \\\\?\\D:\\a.dtr:9:5\n   |\n 9 | x = 1\n   |     ^\n";
  const t = Studio.parseForgenDiagnostics(two, "D:/a.dtr");
  check("two diagnostics", t.length, 2);
  check("first is a warning", t[0].severity, "warning");
  check("second is an error", t[1].severity, "error");
  check("second line number", t[1].line, 9);

  // The `= help:` line is the compiler telling you what to type instead, and it
  // is the single most useful line it emits.
  const withHelp = [
    "error[E-TYPE-001]: Type mismatch in return statement: expected 'Int', got 'Str'",
    "  --> \\\\?\\D:\\p\\src\\a.dtr:2:5",
    "     | ",
    "   2 |     return \"wrong\"",
    "     |     ^^^^^^^^^^^^^^",
    "     |",
    "     = help: parse String to Int using 'str_to_int(val)'",
    "     = note: for more details, run 'forgen explain E-TYPE-001'",
  ].join("\n");
  const h = Studio.parseForgenDiagnostics(withHelp, "D:/p/src/a.dtr");
  check("the help line is captured", h[0].help, "parse String to Int using 'str_to_int(val)'");
  check("the span covers the expression", h[0].len, 14);
  check("the note does not overwrite the help", h[0].help.includes("note"), false);

  // A diagnostic with no help must not borrow the next one's.
  const noHelp = withHelp.replace(/^.*= help:.*$/m, "");
  check("no help means no help", Studio.parseForgenDiagnostics(noHelp, "D:/p/src/a.dtr")[0].help, "");

  // The exact bytes `forgen check` writes, captured from the installed 1.3.4
  // binary. Note what is in them: the compiler colourises **even when its output
  // is a pipe**, so every line that matters is wrapped in ESC [ ... m.
  //
  // That is one defect with two faces. At the JSON layer a raw control character
  // makes the whole document invalid, so `/api/check` returned unparseable JSON
  // *exactly when the compiler reported an error* - the one moment the editor
  // needed to read it, and the reason a file with a real mistake in it never got
  // a squiggle. And behind it, a single ESC byte in front of `-->` means the
  // location line never matches, so the diagnostic would be dropped even if the
  // JSON had survived. Both are covered here.
  const coloured =
    "\x1b[1;31merror[E-TYPE-001]\x1b[0m: \x1b[1mType mismatch in return statement: expected 'Int', got 'Str'\x1b[0m\n" +
    "  \x1b[1;34m-->\x1b[0m \\\\?\\D:\\IDE datara\\datara-studio\\.probe_check\\bad2.dtr:2:5\n" +
    "     \x1b[1;34m|\x1b[0m \n" +
    "   2 \x1b[1;34m|\x1b[0m     return \"wrong\"\n" +
    "     \x1b[1;34m|\x1b[0m     \x1b[1;31m^^^^^^^^^^^^^^\x1b[0m\n" +
    "     \x1b[1;34m|\x1b[0m\n" +
    "     \x1b[1;34m=\x1b[0m \x1b[1;36mhelp:\x1b[0m parse String to Int using 'str_to_int(val)'\n" +
    "     \x1b[1;34m=\x1b[0m \x1b[2mnote: for more details, run 'forgen explain E-TYPE-001'\x1b[0m\n";

  const spaced = "D:/IDE datara/datara-studio/.probe_check/bad2.dtr";
  const c = Studio.parseForgenDiagnostics(coloured, spaced);
  check("a coloured diagnostic is still found", c.length, 1);
  check("its line", c[0].line, 2);
  check("its column", c[0].col, 5);
  check("its span comes from the caret row through the colour", c[0].len, 14);
  check("its code survives the colour", c[0].code, "E-TYPE-001");
  check("no escape is left inside the message", /\x1b/.test(c[0].message), false);
  check("the help line survives the colour", c[0].help,
    "parse String to Int using 'str_to_int(val)'");
  check("a path with spaces in it still matches the open file", c[0].here, true);

  // The colours are decoration: stripping them must not change a single field.
  const plain = Studio.stripAnsi(coloured);
  check("stripping removes every escape", /\x1b/.test(plain), false);
  check("stripping keeps the text", plain.includes("Type mismatch in return statement"), true);
  check("coloured and plain parse to the same thing",
    JSON.stringify(Studio.parseForgenDiagnostics(plain, spaced)), JSON.stringify(c));
}

// A project-wide check has to be aimed at a project. `forgen check` resolves
// `use` statements against the nearest `datara.toml`, so pointing it at a
// workspace root that is *above* the project reports every import as a missing
// package - a false error, for a project that compiles clean. That is what the
// first version of this did, which is why the target is a function with a test
// rather than an expression inline in an event handler.
console.log("\nwhat a project check is aimed at");
{
  check("the open file's directory, not the file",
    Studio.checkTarget("D:/ws/proj/src/a.dtr", "D:/ws"), "D:/ws/proj/src");
  check("the root is the fallback", Studio.checkTarget("", "D:/ws"), "D:/ws");
  check("neither open nor rooted is empty, not undefined",
    Studio.checkTarget("", ""), "");
  check("a null open file is not a target", Studio.checkTarget(null, "D:/ws"), "D:/ws");
  check("backslashes are normalised", Studio.dirOf("D:\\ws\\proj\\a.dtr"), "D:/ws/proj");
  check("a drive root keeps its slash", Studio.dirOf("D:/a.dtr"), "D:/");
  check("a bare name has no directory", Studio.dirOf("a.dtr"), "");
  // the body carries the bound, or the walk can leave the workspace
  check("the body is two lines", Studio.checkBody("D:/ws/proj/src/a.dtr", "D:/ws"),
    "D:/ws/proj/src\nD:/ws");
  check("with nothing open it still carries the bound", Studio.checkBody("", "D:/ws"),
    "D:/ws\nD:/ws");
  // a directory with no project file reports every import as a missing package,
  // so the sentence has to say that rather than count them as problems
  check("a real project is named", Studio.checkNote("D:/ws/proj", "D:/ws/proj/src", 0),
    "clean: D:/ws/proj");
  check("problems are counted against the project",
    Studio.checkNote("D:/ws/proj", "D:/ws/proj/src", 3), "3 problem(s) in D:/ws/proj");
  check("no project file is said out loud, not counted",
    Studio.checkNote("", "D:/ws", 23).includes("no datara.toml"), true);
  check("and it does not claim 23 problems", Studio.checkNote("", "D:/ws", 23).includes("23"), false);
}

console.log("\nhover help comes from local data, not from AI");
{
  const outline = [{ kind: "fn", name: "rope_len", line: 5 }];
  const lines = ["", "", "", "", "pub fn rope_len(r: Rope) -> Int => r", ""];
  const decl = Studio.hoverInfo("rope_len", outline, lines);
  check("a declaration in this file is found", decl.kind, "fn");
  check("and shows its source line", decl.detail.includes("pub fn rope_len"), true);

  const kw = Studio.hoverInfo("str_len", outline, lines);
  check("a builtin is documented", kw.kind, "builtin");
  check("and the byte-counting trap is called out", kw.detail.includes("Byte length"), true);

  const view = Studio.hoverInfo("view", outline, lines);
  check("view is documented", view.kind, "keyword");
  check("including where it goes", view.detail.includes("BEFORE"), true);

  check("an unknown word gives nothing", Studio.hoverInfo("zzzz", outline, lines), null);
  check("an empty word gives nothing", Studio.hoverInfo("", outline, lines), null);
}

console.log("\ncompletion is local-first, so it never waits on the network");
{
  const outline = [{ kind: "fn", name: "rope_len", line: 1 }, { kind: "struct", name: "rope_box", line: 2 }];
  const items = Studio.completerFor("rope", outline, []);
  check("this file's symbols come first", items.slice(0, 2).map((i) => i.label), ["rope_len", "rope_box"]);
  check("keywords are offered", Studio.completerFor("whi", outline, []).some((i) => i.label === "while"), true);
  check("types are offered", Studio.completerFor("Ou", outline, []).some((i) => i.label === "Outcome"), true);
  check("builtins are offered", Studio.completerFor("str_", outline, []).length > 5, true);
  check("companion suggestions are folded in", Studio.completerFor("foo", outline,
    [{ insert_text: "foo_bar()" }]).some((i) => i.label === "foo_bar()"), true);
  // the tables themselves: they were referenced but undefined, so completion
  // threw on every keystroke and nothing ever appeared
  check("KEYWORDS is defined and non-empty", Studio.KEYWORDS.length > 20, true);
  check("TYPES is defined and non-empty", Studio.TYPES.length > 15, true);
  check("BUILTINS is defined and non-empty", Studio.BUILTINS.length > 40, true);
  check("no duplicate keywords", new Set(Studio.KEYWORDS).size, Studio.KEYWORDS.length);
}

console.log("\nother languages are detected without Datara diagnostics");
{
  check(".dtr selects Datara", Studio.providerFor("src/main.dtr").id, "datara");
  check(".py selects Python", Studio.providerFor("tools/build.py").id, "python");
  check(".ts selects TypeScript", Studio.providerFor("ui/app.ts").id, "javascript");
  check(".rs selects Rust", Studio.providerFor("src/lib.rs").id, "rust");
  check(".json selects data", Studio.providerFor("package.json").id, "data");
  check("unknown files stay plain", Studio.providerFor("notes.xyz").id, "plain");
  check("Python uses hash comments", Studio.providerFor("a.py").comment, "#");
  check("Rust uses slash comments", Studio.providerFor("a.rs").comment, "//");
  check("non-Datara files have no compiler check", await Studio.providerFor("a.py").check("a.py", () => {
    throw new Error("plain provider called the compiler");
  }), []);
  check("non-Datara highlighting escapes source", Studio.providerFor("a.py").highlight("<x>").lines, ["&lt;x&gt;"]);
}

console.log("\nevery language gets its own glyph");
{
  // .dtr carries the project's own artwork rather than a glyph drawn from
  // primitives, so it resolves to the CSS-backed `dtr-mark` and not `file-dtr`
  check("datara", Studio.fileIcon("main.dtr")[0], "dtr-mark");
  check("python", Studio.fileIcon("daemon.py")[0], "file-py");
  check("javascript", Studio.fileIcon("app.js")[0], "file-js");
  check("typescript", Studio.fileIcon("app.ts")[0], "file-ts");
  check("rust", Studio.fileIcon("lib.rs")[0], "file-rs");
  check("c++", Studio.fileIcon("main.cpp")[0], "file-cpp");
  check("c", Studio.fileIcon("main.c")[0], "file-cpp");
  check("toml", Studio.fileIcon("datara.toml")[0], "file-toml");
  check("markdown", Studio.fileIcon("README.md")[0], "file-md");
  check("json", Studio.fileIcon("package.json")[0], "file-json");
  check("html", Studio.fileIcon("index.html")[0], "file-html");
  check("css", Studio.fileIcon("style.css")[0], "file-css");
  check("shell", Studio.fileIcon("build.sh")[0], "file-sh");
  check("plain text", Studio.fileIcon("notes.txt")[0], "file-txt");
  check("a dotfile", Studio.fileIcon(".gitignore")[0], "file-txt");
  check("an unknown extension falls back", Studio.fileIcon("thing.qqq")[0], "file");
  check("no extension falls back", Studio.fileIcon("Makefile")[0], "file");
  check("only the basename matters", Studio.fileIcon("D:/a/b/main.dtr")[0], "dtr-mark");
  check("every glyph is distinct where it must be",
    new Set(["dtr", "py", "js", "rs", "cpp", "md"].map((e) => Studio.fileIcon("x." + e)[0])).size, 6);
}

// The seam the IDE is built around. A boundary with one implementation is an
// abstraction nobody has tested, which is why the plain-text provider exists:
// these assertions are the proof that the editor really does not know what
// Datara is.
console.log("\nthe language provider seam");
{
  const API = ["id", "label", "extensions", "indent", "comment", "keywords", "types",
    "builtins", "docs", "symbols", "check", "complete"];
  for (const p of Studio.PROVIDERS) {
    check("provider '" + p.id + "' has the full API",
      API.filter((k) => p[k] === undefined), []);
    check("provider '" + p.id + "' has an id and a label", !!p.id && !!p.label, true);
  }

  check("a .dtr file belongs to Datara", Studio.providerFor("src/main.dtr").id, "datara");
  check("a .py file selects Python", Studio.providerFor("daemon.py").id, "python");
  check("a .rs file selects Rust", Studio.providerFor("lib.rs").id, "rust");
  check("a file with no extension does not", Studio.providerFor("Makefile").id, "plain");
  check("a path is judged by its basename", Studio.providerFor("D:/a/b/c.dtr").id, "datara");
  check("nothing open still resolves", Studio.providerFor("").id, "plain");
  check("Datara claims only dtr", Studio.DATARA_LANG.extensions, ["dtr"]);
  check("Python claims py", Studio.providerFor("x.py").extensions.includes("py"), true);
  check("Rust claims rs", Studio.providerFor("x.rs").extensions.includes("rs"), true);
  check("the plain provider claims none", Studio.PLAIN_LANG.extensions, []);

  // the plain provider must offer nothing rather than something wrong
  check("plain offers no keywords", Studio.PLAIN_LANG.keywords.length, 0);
  check("plain offers no builtins", Studio.PLAIN_LANG.builtins.length, 0);
  check("plain completes nothing", Studio.PLAIN_LANG.complete("pri").length, 0);
  check("plain finds no symbols", Studio.PLAIN_LANG.symbols("fn main() {}").length, 0);

  // and the editor's help must come from the provider, not from a global table
  const pyLines = ["def main():", "    pass"];
  check("a Datara keyword gets no help in a plain file",
    Studio.hoverInfo("str_len", [], pyLines, Studio.PLAIN_LANG.docs), null);
  check("the same word does get help under Datara",
    Studio.hoverInfo("str_len", [], pyLines, Studio.DATARA_LANG.docs).kind, "builtin");

  // the compiler check is async and comes from the provider, so a language with
  // no compiler is simply never asked
  const plainHits = await Studio.PLAIN_LANG.check("x.py", () => { throw new Error("must not call the server"); });
  check("plain never calls the compiler", plainHits.length, 0);

  check("Datara's symbols are wired to the real scanner",
    Studio.DATARA_LANG.symbols("pub fn rope_len() {}").map((s) => s.name), ["rope_len"]);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
