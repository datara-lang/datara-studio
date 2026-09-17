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

import { readFileSync, writeFileSync, mkdtempSync, rmSync, rmdirSync, openSync, writeSync, closeSync } from "node:fs";
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

// Progress goes to its own file, written with `writeSync` so it lands the
// instant it is called. A stall here has to name its own cause: the first time
// this checker hung it printed nothing at all, and a build that stops with no
// output reads as a dead process rather than a snippet the compiler will not
// finish on. Set SNIP_TRACE=<path> to watch it.
const traceFd = process.env.SNIP_TRACE ? openSync(process.env.SNIP_TRACE, "w") : -1;
const trace = (line) => { if (traceFd >= 0) writeSync(traceFd, line + "\n"); };

// A compiler that never returns must not take the build with it.
const TIMEOUT_MS = 20000;

// `forgen check` colourises into a pipe and ignores NO_COLOR (SEAM-8), so the
// escape codes are stripped here rather than trusted to be absent.
const check = (name, source) => {
  const file = join(dir, name + ".dtr");
  writeFileSync(file, source);
  trace("    wrote " + name);
  let result;
  try {
    result = {
      out: strip(execFileSync(forgen, ["check", file], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS,
      })),
      code: 0,
    };
  } catch (e) {
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      trace("    ran   " + name + " TIMED OUT");
      result = { out: "TIMEOUT after " + TIMEOUT_MS + "ms", code: 124, timedOut: true };
    } else {
      trace("    ran   " + name + " exit=" + (e.status ?? 1));
      result = { out: strip(String(e.stdout || "") + String(e.stderr || "")), code: e.status ?? 1 };
    }
  }
  // The probe is removed as soon as it has been read, rather than swept up with
  // all the others at the end. The sweep is what hung the build: thirty-three
  // freshly written files were left for one `rmSync(dir, { recursive: true })`,
  // and on this machine that call never returns. The build then stopped dead
  // after the last snippet with no output at all, which reads as a dead process
  // rather than a check that failed - the least actionable failure there is.
  // Deleting each file while it is still warm, and finishing with a plain
  // `rmdir` that cannot walk into anything, is both faster and unable to hang on
  // a file the virus scanner has open.
  try { rmSync(file, { force: true }); } catch { /* the rmdir below is the backstop */ }
  return result;
};

const indent = (body) => body.split("\n").map((l) => (l.length ? "    " + l : l)).join("\n");
const codes = (out) => [...new Set(out.match(/E-[A-Z0-9-]+/g) || [])];
const verified = (out) => /Verified/.test(out);
const syntax = (out) => codes(out).some((c) => c.startsWith("E-SYNTAX"));

// Some words only exist in one position, so judging them at top level fails them
// for living where they belong. Each gets the context it actually appears in.
//
// The context is the whole point, not a convenience. `then` outside a `process`
// is not a weaker `then`, it is a different token, and a checker that did not
// know that would report a perfectly correct snippet as a syntax error - which
// is how `out`, `then` and `with` were all flagged the first time this ran.
//
// `with` is the case that has no context and therefore no snippet: it is a
// clause on a declaration header (`entity U with C`), so there is no line it can
// stand on alone. Its snippet was removed rather than taught a wrapper that
// would have been a lie about how the language works.
const inFunction = (body) =>
  "fn __probe() -> Int {\n" + indent(body) + "\n    return 0\n}\n";

// A process is a chain: a value, then the stages. `then` is only grammatical
// inside one, so that is where it is judged.
const inProcess = (body) =>
  "fn __step(x: Int) -> Int => x\nprocess __probe(x: Int) -> Int {\n"
  + indent("x") + "\n" + indent(body) + "\n}\n";

const WRAPPERS = {
  if: inFunction,
  while: inFunction,
  for: inFunction,
  match: inFunction,
  comptime: inFunction,
  defer: inFunction,
  unsafe: inFunction,
  out: inFunction,
  then: inProcess,
};

const rows = [];
for (const key of Object.keys(SNIPPETS)) {
  const body = SNIPPETS[key].body;
  const wrap = WRAPPERS[key];
  const wrapped = () => check(key + "_wrapped", wrap(body));

  // Progress goes to stderr as it happens. Without it, a `forgen` that hangs on
  // one body takes the whole build down with no output at all, and the run looks
  // like a dead build rather than a snippet the compiler cannot finish on. The
  // table below is still printed at the end; this is only so a stall names its
  // own cause.
  process.stderr.write("  checking " + key + " ...\n");

  // A wrapped snippet is judged inside its wrapper first, then at top level, so
  // a statement-shaped snippet is not failed for being a statement.
  const attempts = wrap
    ? [["inside " + (wrap === inProcess ? "a process" : "a function"), wrapped()], ["", check(key, body + "\n")]]
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
  trace("  judged " + key + " -> " + verdict);
}

trace("  loop finished with " + rows.length + " rows");
// Every probe file is already gone, so this removes an empty directory. It is
// deliberately not a recursive delete: nothing here may walk a tree, because
// that is the call that hung.
try { rmdirSync(dir); } catch { /* an empty directory left in temp is harmless */ }
trace("  removed the probe directory");
if (traceFd >= 0) closeSync(traceFd);
process.stderr.write("  checked " + rows.length + " snippets\n");

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

// app.js is a live application and installs timers while its scripts are
// evaluated. This checker is a command-line probe, not a server: leave no
// event-loop handles behind or the build appears to hang after all rows passed.
process.exit(0);
