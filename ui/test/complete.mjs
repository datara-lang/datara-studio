// Completion is the one part of the editor that can be tested without a DOM:
// `completerFor` and the scanners under it are pure functions of source text.
// This reads them out of the shipped `ui/app.js` rather than importing a copy,
// so a test that passes is evidence about the file the browser will run.
//
// The fixtures are the compiler's own examples, not strings written to suit the
// assertions. `out`, `then`, `with` and the `class` + `behavior` split are all
// taken from what `forgen` ships and compiles.
//
//   node ui/test/complete.mjs
//
// Run from the repository root. No server, no browser, no network.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
// DS_APP_JS exists so the suite can be pointed at another revision - `git show
// HEAD:ui/app.js` - and asked whether it would have caught a regression. A test
// that has never been seen to fail is not evidence of anything.
const appSrc = readFileSync(process.env.DS_APP_JS || join(root, "ui", "app.js"), "utf8");
const appLines = appSrc.split("\n");

// Extraction is line-based, not brace-matched. A brace counter cannot tell a
// block from a regex literal, and `declaredTypes` contains `(?:\{|=>|$)` - an
// unmatched `{` that would run the counter off the end of the file. Every
// top-level declaration here closes with its bracket at column 0, which is a
// rule this file already keeps and which the build enforces elsewhere.
const isClose = (l) => l === "];" || l === "};";

/** Take `const NAME = ...;` from the start line to its closing bracket.
 *  A one-line const closes on its own line, and `COMPLETE_RANK` is one - the
 *  scan would otherwise run on into the next multi-line table and redeclare it. */
function takeConst(name) {
  const start = appLines.findIndex((l) => l.startsWith("const " + name + " = "));
  if (start < 0) throw new Error("no const " + name);
  const head = appLines[start].trimEnd();
  if (head.endsWith("};") || head.endsWith("];")) return appLines[start];
  const end = appLines.findIndex((l, i) => i > start && isClose(l));
  if (end < 0) throw new Error("unterminated const " + name);
  return appLines.slice(start, end + 1).join("\n");
}

/** Take a whole `function NAME(...) { ... }`, ending at a bare `}`. */
function takeFunction(name) {
  const start = appLines.findIndex((l) => l.startsWith("function " + name + "("));
  if (start < 0) throw new Error("no function " + name);
  const end = appLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error("unterminated function " + name);
  return appLines.slice(start, end + 1).join("\n");
}

/** Take a single-line `const NAME = <expr>;`. */
function takeLine(name) {
  const line = appLines.find((l) => l.startsWith("const " + name + " = "));
  if (!line) throw new Error("no const " + name);
  return line;
}

const source = [
  takeConst("KEYWORDS"),
  "const KEYWORD_SET = new Set(KEYWORDS);",
  takeLine("DECL_RE"),
  takeConst("COMPLETE_RANK"),
  takeConst("SNIPPETS"),
  takeConst("TYPES"),
  takeConst("BUILTINS"),
  takeFunction("byRank"),
  takeFunction("declaredTypes"),
  takeFunction("enclosingType"),
  takeFunction("localType"),
  takeFunction("memberCompletions"),
  takeFunction("completerFor"),
  "return { KEYWORDS, KEYWORD_SET, DECL_RE, SNIPPETS, declaredTypes, enclosingType, localType, memberCompletions, completerFor };",
].join("\n");

const L = new Function(source)();

let pass = 0, fail = 0;
const ok = (cond, what, detail) => {
  if (cond) { pass++; return; }
  fail++;
  console.log("  FAIL  " + what + (detail ? "\n        " + detail : ""));
};

// ------------------------------------------------------------------ fixtures
const EXAMPLES = join(process.env.LOCALAPPDATA || "", "Programs", "Datara", "examples");
const fixture = (name) => existsSync(join(EXAMPLES, name)) ? readFileSync(join(EXAMPLES, name), "utf8") : null;

const SPLIT = fixture("03_split_behavior.dtr");
const ENTITY = fixture("07_entity_process_model.dtr");
const POST = fixture("03_post_oop_class.dtr");

// ------------------------------------------------- the vocabulary is the real one
// The rule is: the official grammar's keyword list, corrected by the compiler.
// These are the corrections, and each one has a probe project behind it.
for (const dead of ["defer", "static", "self", "try", "catch", "nil", "flow"]) {
  ok(!L.KEYWORD_SET.has(dead), "keyword table drops '" + dead + "'");
}
// The ones the corpus is written in. `out` and `then` are in nearly every
// shipped example; `class` is what the stdlib declares 102 times.
for (const real of ["out", "then", "with", "class", "entity", "record", "role", "process", "packet", "module", "at", "match", "const", "val", "require"]) {
  ok(L.KEYWORD_SET.has(real), "keyword table carries '" + real + "'");
}
// The modifier family. These are real, but only in parameter position, which is
// where an earlier probe looked for them in the wrong place and concluded they
// did not exist. `view r: Rope` compiles; `r: view Rope` does not.
for (const mod of ["view", "own", "shared", "impl", "where", "as", "ensure"]) {
  ok(L.KEYWORD_SET.has(mod), "keyword table carries the modifier '" + mod + "'");
}
// `break` and `continue` compile, and the hover text used to say they did not.
for (const flow of ["break", "continue", "loop"]) {
  ok(L.KEYWORD_SET.has(flow), "keyword table carries '" + flow + "'");
}

// Every snippet must be offerable. The list used to be driven by KEYWORDS
// alone, so a snippet whose word was not also a keyword could never appear.
{
  const outline = [], sugg = [];
  const reachable = new Set();
  for (const k of L.KEYWORDS.concat(Object.keys(L.SNIPPETS))) reachable.add(k);
  const missed = Object.keys(L.SNIPPETS).filter((k) => !reachable.has(k));
  ok(missed.length === 0, "every snippet word is reachable", "unreachable: " + missed.join(", "));
  // And a snippet that IS reachable really comes back out of completerFor.
  const cls = L.completerFor("cla", outline, sugg, null);
  const clsItem = cls.find((i) => i.label === "class");
  ok(!!clsItem, "'cla' offers the class snippet");
  ok(!!clsItem && /deprecated/.test(clsItem.hint), "the class snippet warns it is deprecated",
    clsItem ? "hint was: " + clsItem.hint : "");
  ok(!!clsItem && clsItem.insert.indexOf("class Name {") === 0, "the class snippet inserts a class shape");
}

// ------------------------------------------------------------------ ranking
// Provenance beats length. `str_len` is shorter than a name declared in the file
// and used to win on that alone.
{
  const outline = [{ kind: "fn", name: "str_length_report", line: 1 }];
  const items = L.completerFor("str_", outline, [], null);
  ok(items[0].label === "str_length_report",
    "a name declared in the file outranks a stdlib builtin", "first was " + items[0].label);
  ok(items[0].rank === 0 && items[items.length - 1].rank >= 5, "ranks ascend down the list");
}

// ------------------------------------------------------------------ class + behavior
if (SPLIT) {
  const types = L.declaredTypes(SPLIT);
  ok(!!types.User, "the class User is found");
  // `class User` and `behavior User` are two blocks with one name. The second
  // used to overwrite the first and take its fields with it.
  ok(!!types.User && types.User.fields.length === 2, "the fields survive the behavior block",
    types.User ? "fields: " + JSON.stringify(types.User.fields.map((f) => f.name)) : "");
  ok(!!types.User && types.User.methods.some((m) => m.name === "greet"),
    "the arrow-bodied method in the behavior is found",
    types.User ? "methods: " + JSON.stringify(types.User.methods.map((m) => m.name)) : "");

  const pos = SPLIT.indexOf("out user.greet()") + "out user.".length;
  const members = L.memberCompletions(SPLIT, pos, "user");
  const names = members.map((m) => m.name).sort();
  ok(names.indexOf("name") >= 0 && names.indexOf("age") >= 0 && names.indexOf("greet") >= 0,
    "user. offers the fields and the method", "got: " + names.join(", "));
  ok(L.localType(SPLIT, pos, "user") === "User", "user is resolved to User");
}

// ------------------------------------------------------- this. inside a behavior
if (POST) {
  const types = L.declaredTypes(POST);
  ok(!!types.Counter && types.Counter.methods.length === 2, "both fn-prefixed methods are found",
    types.Counter ? "methods: " + JSON.stringify(types.Counter.methods.map((m) => m.name)) : "");
  ok(!!types.Counter && types.Counter.methods.some((m) => m.signature === "Int()"),
    "a method's signature is read", types.Counter ? JSON.stringify(types.Counter.methods) : "");

  const pos = POST.indexOf("return this.val") + "return this.".length;
  ok(L.enclosingType(POST, pos) === "Counter", "this. resolves to the enclosing class");
  const members = L.memberCompletions(POST, pos, "this").map((m) => m.name);
  ok(members.indexOf("val") >= 0, "this. offers the field", "got: " + members.join(", "));
  ok(members.indexOf("increment") >= 0, "this. offers the methods", "got: " + members.join(", "));
}

// ------------------------------------------------- parameters and `with` composition
if (ENTITY) {
  const types = L.declaredTypes(ENTITY);
  ok(!!types.User && types.User.with.indexOf("Timestamped") >= 0,
    "the `with` clause is recorded", types.User ? JSON.stringify(types.User.with) : "");

  // `out "stock left: {store.stock}"` - store is a parameter, not a `let`.
  const pos = ENTITY.indexOf("stock left: {store.") + "stock left: {store.".length;
  ok(L.localType(ENTITY, pos, "store") === "Store", "a parameter resolves to its declared type",
    "got: " + L.localType(ENTITY, pos, "store"));
  const names = L.memberCompletions(ENTITY, pos, "store").map((m) => m.name);
  ok(names.indexOf("stock") >= 0 && names.indexOf("title") >= 0,
    "store. offers the entity's own fields", "got: " + names.join(", "));
  ok(names.indexOf("created_at") >= 0 && names.indexOf("updated_at") >= 0,
    "store. offers the composed component's fields", "got: " + names.join(", "));
  ok(names.indexOf("release_stock") >= 0, "store. offers the method from the separate behavior block",
    "got: " + names.join(", "));

  // A receiver that cannot be resolved offers nothing rather than everything.
  const unknown = L.memberCompletions(ENTITY, pos, "nosuchthing");
  ok(unknown.length === 0, "an unresolved receiver offers nothing, not the keyword list");
}

// ---------------------------------------------------- a call is not a method
if (ENTITY) {
  const types = L.declaredTypes(ENTITY);
  const store = types.Store || { methods: [] };
  const bad = store.methods.filter((m) => L.KEYWORD_SET.has(m.name));
  ok(bad.length === 0, "no keyword is mistaken for a method",
    "found: " + bad.map((m) => m.name).join(", "));
}

// ------------------------------------------------------------------ receiver gate
{
  const items = L.completerFor("", [], [], { src: "", pos: 0, receiver: "nope" });
  ok(items.length === 0, "a dot with an unresolvable receiver returns an empty list");
  const plain = L.completerFor("fn", [], [], null);
  ok(plain.length > 0 && plain[0].label === "fn", "without a receiver the normal list still works");
}

console.log("\ncomplete.mjs: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
