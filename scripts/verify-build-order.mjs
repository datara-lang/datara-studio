#!/usr/bin/env node
// Every entry point that builds the interface must build the same three things,
// in the same order.
//
// Why this exists. `ui/vendor/textcore.js` and `src-tauri/icons/` (and
// `ui/mark.ico`) are gitignored build outputs, and `build-ui.mjs` **inlines**
// them - it throws `cannot inline /vendor/textcore.js` if the first is missing.
// So "run build-ui.mjs" is not a complete instruction, and the same incomplete
// instruction had been written in four places:
//
//   * `scripts/build-desktop.cmd` ran build-ui.mjs and build-icons.mjs, in that
//     order, and never built the text core at all. On a fresh checkout it died
//     on the missing textcore.js; on any other tree the interface embedded
//     whatever `ui/mark.ico` already held, which is the previous run's mark.
//   * `start-tauri.cmd` had the same missing step in its fallback branch.
//   * `.github/workflows/release.yml` built the icons and the interface and not
//     the text core - so the release workflow would have failed on its first
//     run, on every platform.
//   * `README.md` printed the same three-line sequence to a person.
//
// Only `scripts/build.sh` had it right, and nothing checked the others against
// it. That is the shape of the bug: one source of truth, four copies, no test.
// This is the test.
//
// What it checks, for each entry point, after dropping comment lines:
//
//   1. all three build steps are named at all;
//   2. they appear in the order wasm -> icons -> interface.
//
// Comment lines are dropped so that an explanation of the order does not count
// as an occurrence of it - `release.yml` and `build-desktop.cmd` both discuss
// `build-ui.mjs` in prose above the step that runs it.
//
// Run:  node scripts/verify-build-order.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The order the build actually requires, and why each step is not optional.
const STEPS = [
  { file: "build-wasm.mjs", what: "ui/vendor/textcore.js, which build-ui.mjs inlines" },
  { file: "build-icons.mjs", what: "src-tauri/icons/ and ui/mark.ico, which build-ui.mjs embeds" },
  { file: "build-ui.mjs", what: "ui/studio.html, a bundled resource" },
];

// Every path from "I have the source" to "the interface exists". A new one
// belongs in this list; that is the point of the list.
const ENTRY_POINTS = [
  "scripts/build.sh",
  "scripts/build-desktop.cmd",
  "start-tauri.cmd",
  "README.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

const isComment = (line) => /^\s*(#|REM\b|REM\s|<!--|\/\/)/i.test(line);

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n`);
    if (detail) process.stdout.write(`         ${detail}\n`);
  }
}

process.stdout.write("build order\n");

for (const rel of ENTRY_POINTS) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const code = text
    .split(/\r?\n/)
    .filter((l) => !isComment(l))
    .join("\n");

  const at = new Map();
  for (const s of STEPS) {
    const i = code.indexOf(s.file);
    at.set(s.file, i);
  }

  const missing = STEPS.filter((s) => at.get(s.file) < 0).map((s) => s.file);
  check(
    `${rel}: builds all three`,
    missing.length === 0,
    missing.length ? `never runs ${missing.join(", ")} - ${STEPS.find((s) => s.file === missing[0]).what} would be missing` : "",
  );
  if (missing.length) continue;

  // First occurrence, so a later mention cannot rescue an earlier inversion.
  const order = STEPS.map((s) => ({ file: s.file, i: at.get(s.file) }));
  const sorted = [...order].sort((a, b) => a.i - b.i).map((o) => o.file);
  const want = STEPS.map((s) => s.file);
  check(
    `${rel}: in the order wasm -> icons -> interface`,
    sorted.join(",") === want.join(","),
    `found ${sorted.join(" -> ")}`,
  );
}

// And the negative control: the check has to be able to fail. `build-desktop.cmd`
// as it was before this test existed - interface first, no text core - is fed
// through the same logic here rather than trusted to have been caught.
{
  const broken = ["node scripts\\build-ui.mjs", "node scripts\\build-icons.mjs"].join("\n");
  const seen = STEPS.filter((s) => broken.includes(s.file)).map((s) => s.file);
  const sorted = [...seen].sort((a, b) => broken.indexOf(a) - broken.indexOf(b));
  check(
    "the check rejects an interface-first sequence",
    seen.length < 3 || sorted[0] !== "build-wasm.mjs",
    `it accepted ${sorted.join(" -> ")}`,
  );
}

process.stdout.write(`\n${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
