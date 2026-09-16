// Every snippet the editor offers, checked against the real compiler.
//
// The editor test proves a snippet expands to the text written in the table.
// That is not the same as proving the text is Datara. A skeleton that inserts a
// construct the compiler rejects is worse than no skeleton at all: it teaches a
// shape that does not exist, and the error only appears one keystroke later, in
// a file the person is trying to write. The table is data, and data drifts.
//
// So this runs `forgen check` on each body. Three outcomes:
//
//   valid      the body is valid Datara on its own
//   shape      it parses and the only errors are E-RESOLVE-*, which is exactly
//              what an unfilled placeholder looks like - `use module_name` with
//              no such module, `behavior Name` with no such class, `defer
//              action()` with no such function
//   syntax     a grammar error. Always a failure: a placeholder cannot excuse
//              the skeleton's own shape being wrong.
//
// The body is tried at top level first, then wrapped in a function, so a
// statement-shaped snippet (`if`, `for`, `unsafe`) is judged on its own terms
// instead of being failed for living inside a body.
//
// Run:  node scripts/check-snippets.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const studio = join(here, "..");
const forgen = process.env.FORGEN || "forgen";

// The table lives inside the built page, so read it from there rather than
// re-parsing app.js: one source of truth, and it also proves the table survived
// the inline build.
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
window.fetch = () => Promise.reject(new Error("no network"));
for (const s of document.querySelectorAll("script")) {
  if (s.textContent.trim()) runInContext(s.textContent, createContext(window));
}

const SNIPPETS = window.__Studio?.SNIPPETS;
if (!SNIPPETS) {
  console.error("FAIL  the built page does not export SNIPPETS");
  process.exit(1);
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const dir = mkdtempSync(join(tmpdir(), "snipcheck-"));

// `forgen check` colourises into a pipe and ignores NO_COLOR (SEAM-8), so the
// escape codes are stripped here rather than trusted to be absent.
const check = (name, source) => {
  const file = join(dir, name + ".dtr");
  writeFileSync(file, source);
  try {
    return { out: strip(execFileSync(forgen, ["check", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })), code: 0 };
  } catch (e) {
    return { out: strip(String(e.stdout || "") + String(e.stderr || "")), code: e.status ?? 1 };
  }
};

const indent = (body) => body.split("\n").map((l) => (l.length ? "    " + l : l)).join("\n");
const codes = (out) => [...new Set(out.match(/E-[A-Z0-9-]+/g) || [])];
const verified = (out) => /Verified/.test(out);
const syntax = (out) => codes(out).some((c) => c.startsWith("E-SYNTAX"));

// Measured against forgen 1.4.1: these parse inside a function body and are a
// syntax error at top level, because they are statements.
//
// Everything else is a declaration and is judged at top level only. That
// restriction is not fussiness - wrapping a declaration in a function is how
// `mod name` nearly passed this check: inside a body the parser reads it as two
// identifier expressions and reports only an unresolved symbol, so a construct
// the language does not have looked like a placeholder that had not been filled.
const STATEMENTS = new Set(["if", "while", "for", "match", "comptime", "defer", "unsafe"]);

const rows = [];
for (const key of Object.keys(SNIPPETS)) {
  const body = SNIPPETS[key].body;
  const wrapped = () => check(key + "_wrapped",
    "fn __probe() -> Int {\n" + indent(body) + "\n    return 0\n}\n");

  const attempts = STATEMENTS.has(key)
    ? [["inside a function", wrapped()], ["", check(key, body + "\n")]]
    : [["", check(key, body + "\n")]];

  let verdict = "SYNTAX", note = "";
  for (const [where, r] of attempts) {
    if (verified(r.out)) { verdict = "valid"; note = where; break; }
    const seen = codes(r.out);
    // an unfilled placeholder is E-RESOLVE-*; a grammar error never is
    verdict = seen.length && seen.every((c) => c.startsWith("E-RESOLVE")) ? "shape" : "SYNTAX";
    note = seen.join(",") + (where ? " " + where : "");
    if (verdict !== "SYNTAX") break;
  }
  rows.push([key, verdict, note]);
}

rmSync(dir, { recursive: true, force: true });

let bad = 0;
console.log("snippets, checked by " + forgen);
for (const [key, verdict, note] of rows) {
  if (verdict === "SYNTAX") bad++;
  console.log("  " + (verdict === "SYNTAX" ? "FAIL " : "PASS ") + "  " +
    key.padEnd(10) + verdict.padEnd(7) + note);
}
const by = (v) => rows.filter((r) => r[1] === v).length;
console.log("\n" + rows.length + " snippets: " + by("valid") + " valid outright, " +
  by("shape") + " valid with the placeholder filled, " + bad + " that do not compile");

if (bad) {
  console.log("\nA snippet that does not compile is worse than no snippet: it teaches a shape");
  console.log("the language does not have, and the error lands one keystroke later.");
  process.exit(1);
}
