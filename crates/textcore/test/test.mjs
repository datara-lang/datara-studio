// Verification for the wasm text core.
//
// Run:  node crates/textcore/test/test.mjs
//
// The point of this file is the incremental line index. `doc_insert` and
// `doc_delete` splice the line list instead of rebuilding it, which is where
// the speed comes from and also where the bugs would be. `doc_verify`
// recomputes the index from scratch and compares, so the fast path is checked
// against the slow path rather than trusted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = join(here, "..", "..", "..", "ui", "vendor", "textcore.wasm");

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const w = instance.exports;
const mem = () => new Uint8Array(w.memory.buffer);
const enc = new TextEncoder();
const dec = new TextDecoder();

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + "\n        got  " + JSON.stringify(got) + "\n        want " + JSON.stringify(want)); }
}

// write a JS string into wasm memory, return [ptr, len]
function put(s) {
  const b = enc.encode(s);
  const p = w.alloc(b.length);
  mem().set(b, p);
  return [p, b.length];
}
function get(ptr, len) {
  return dec.decode(mem().subarray(ptr, ptr + len));
}

console.log("textcore version " + w.textcore_version());
console.log("wasm bytes " + bytes.length);

// ---------------------------------------------------------------- documents
console.log("\ndocument");
const h = w.doc_new();
let [p, n] = put("fn main() {\n    let x = 1\n    return x\n}\n");
check("doc_set returns byte length", w.doc_set(h, p, n), 41);
check("doc_len", w.doc_len(h), 41);
check("line_count", w.doc_line_count(h), 5);
check("line_start(0)", w.doc_line_start(h, 0), 0);
check("line_start(1)", w.doc_line_start(h, 1), 12);
check("line_start(3)", w.doc_line_start(h, 3), 39);
check("line_start(4) is the empty last line", w.doc_line_start(h, 4), 41);
check("line_of(0)", w.doc_line_of(h, 0), 0);
check("line_of(12)", w.doc_line_of(h, 12), 1);
check("line_of(39) is the closing brace", w.doc_line_of(h, 39), 3);
check("verify after set", w.doc_verify(h), 1);

// round-trip the content out
{
  const cap = w.doc_len(h);
  const out = w.alloc(cap);
  const wrote = w.doc_get(h, out, cap);
  check("doc_get round-trip", get(out, wrote), "fn main() {\n    let x = 1\n    return x\n}\n");
  w.dealloc(out, cap);
}
w.dealloc(p, n);

// ---------------------------------------------------------------- incremental edits
console.log("\nincremental edits (each step verified against a full rebuild)");
function edit(label, fn) {
  fn();
  const ok = w.doc_verify(h) === 1;
  if (ok) { pass++; console.log("  PASS  " + label + "  lines=" + w.doc_line_count(h) + " len=" + w.doc_len(h)); }
  else { fail++; console.log("  FAIL  " + label + "  line index diverged from a full rebuild"); }
}

edit("insert a newline in the middle of line 1", () => {
  const [q, m] = put("\n    let y = 2");
  w.doc_insert(h, 20, q, m);
  w.dealloc(q, m);
});
edit("insert at offset 0", () => {
  const [q, m] = put("// header\n");
  w.doc_insert(h, 0, q, m);
  w.dealloc(q, m);
});
edit("insert two newlines at once", () => {
  const [q, m] = put("a\nb\n");
  w.doc_insert(h, 5, q, m);
  w.dealloc(q, m);
});
edit("delete a range containing newlines", () => { w.doc_delete(h, 5, 4); });
edit("delete across a line boundary", () => { w.doc_delete(h, 10, 15); });
edit("delete everything", () => { w.doc_delete(h, 0, w.doc_len(h)); });
edit("insert into an empty document", () => {
  const [q, m] = put("x\ny\n");
  w.doc_insert(h, 0, q, m);
  w.dealloc(q, m);
});
edit("delete past the end (clamped)", () => { w.doc_delete(h, 1, 9999); });

// ---------------------------------------------------------------- offsets
console.log("\nUTF-8 byte offsets vs UTF-16 code units");
const h2 = w.doc_new();
{
  // 'a' = 1/1, U+1F600 = 4 bytes / 2 units, 'b' = 1/1, U+0416 = 2 bytes / 1 unit
  const s = "a\u{1F600}b\u{0416}";
  const [q, m] = put(s);
  w.doc_set(h2, q, m);
  w.dealloc(q, m);
}
check("byte length", w.doc_len(h2), 1 + 4 + 1 + 2);
check("utf16 length at end", w.doc_byte_to_utf16(h2, 8), 5);
check("astral is 2 utf16 units", w.doc_byte_to_utf16(h2, 5), 3);
check("utf16 3 -> byte 5", w.doc_utf16_to_byte(h2, 3), 5);
check("utf16 1 -> byte 1", w.doc_utf16_to_byte(h2, 1), 1);
check("round trip utf16->byte->utf16", w.doc_byte_to_utf16(h2, w.doc_utf16_to_byte(h2, 4)), 4);

// ---------------------------------------------------------------- lexer
console.log("\nlexer");
const h3 = w.doc_new();
const SRC = 'fn main() -> Int {\n    // note\n    let s = "hi"\n    return 42\n}\n';
{
  const [q, m] = put(SRC);
  w.doc_set(h3, q, m);
  w.dealloc(q, m);
}
const count = w.lex(h3);
check("token count is positive", count > 0, true);
{
  const view = new Uint32Array(w.memory.buffer, w.lex_ptr(), count * 3);
  const toks = [];
  for (let i = 0; i < count; i++) toks.push([view[i * 3], view[i * 3 + 1], view[i * 3 + 2]]);
  const kinds = {};
  for (const [st, l, k] of toks) {
    if (k !== 0) (kinds[k] = kinds[k] || []).push(SRC.slice(st, st + l));
  }
  check("keywords found", kinds[1].includes("fn") && kinds[1].includes("let") && kinds[1].includes("return"), true);
  check("type found", kinds[2].includes("Int"), true);
  check("string found", kinds[3].includes('"hi"'), true);
  check("comment found", kinds[4].includes("// note"), true);
  check("number found", kinds[5].includes("42"), true);
  check("function found", kinds[6].includes("main"), true);
  let covered = 0, ok = true;
  for (const [st, l] of toks) {
    if (st !== covered) ok = false;
    covered = st + l;
  }
  check("tokens tile the source exactly", ok && covered === SRC.length, true);
}

// ---------------------------------------------------------------- search
console.log("\nsearch");
const h4 = w.doc_new();
{
  const [q, m] = put("alpha beta gamma beta");
  w.doc_set(h4, q, m);
  w.dealloc(q, m);
}
{
  const u32 = v => v >>> 0;
  const [q, m] = put("beta");
  check("first match", u32(w.doc_find(h4, q, m, 0)), 6);
  check("next match", u32(w.doc_find(h4, q, m, 7)), 17);
  check("no match returns u32::MAX", u32(w.doc_find(h4, q, m, 18)), 0xFFFFFFFF);
  w.dealloc(q, m);
}

// ---------------------------------------------------------------- performance
console.log("\nperformance");
const h5 = w.doc_new();
let src = "";
for (let i = 0; i < 20000; i++) {
  src += "    let value_" + i + " = compute(" + i + ") // comment " + i + "\n";
}
const [qp, mp] = put(src);
let t = performance.now();
w.doc_set(h5, qp, mp);
const tSet = performance.now() - t;

// Timing on a shared machine is noisy and noise only ever adds time, so the
// minimum of several runs is the honest measure of the algorithm.
let tLex = Infinity, tokCount = 0;
for (let r = 0; r < 3; r++) {
  t = performance.now();
  tokCount = w.lex(h5);
  tLex = Math.min(tLex, performance.now() - t);
}
t = performance.now();
const verified = w.doc_verify(h5);
const tVerify = performance.now() - t;

// realistic edit: one character in the middle of the document
const mid = Math.floor(w.doc_len(h5) / 2);
t = performance.now();
for (let i = 0; i < 100; i++) {
  const [e, el] = put("x");
  w.doc_insert(h5, mid, e, el);
  w.doc_delete(h5, mid, 1);
  w.dealloc(e, el);
}
const tEdit = performance.now() - t;

// worst case: an insert at offset 0 shifts every line start
t = performance.now();
{
  const [e, el] = put("x");
  w.doc_insert(h5, 0, e, el);
  w.dealloc(e, el);
}
const tFront = performance.now() - t;
w.dealloc(qp, mp);

console.log("  source              " + (src.length / 1024).toFixed(0) + " KB, 20000 lines");
console.log("  doc_set             " + tSet.toFixed(1) + " ms");
console.log("  lex whole document  " + tLex.toFixed(1) + " ms  (best of 3)  -> " + tokCount + " tokens");
console.log("  doc_verify          " + tVerify.toFixed(1) + " ms");
console.log("  100 edits mid-doc   " + tEdit.toFixed(1) + " ms  -> " + (tEdit / 100).toFixed(3) + " ms per edit");
console.log("  1 edit at offset 0  " + tFront.toFixed(1) + " ms  (worst case: shifts every line start)");
check("verify holds on 20k lines", verified, 1);
check("lex of 20k lines under 50ms", tLex < 50, true);
check("per-edit cost mid-document under 1ms", tEdit / 100 < 1, true);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
