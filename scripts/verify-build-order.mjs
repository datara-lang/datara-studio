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
// What it checks, for each entry point:
//
//   1. all three build steps are named at all;
//   2. every occurrence of the interface step is preceded by the other two
//      since the previous one - so a file with two independent build sequences,
//      like `ci.yml` with its `interface` and `shell` jobs, has to get both
//      right and cannot pass on the strength of the first.
//
// Comment lines are dropped, and for Markdown only fenced code blocks are read,
// so that an explanation of the order does not count as an occurrence of it -
// `release.yml`, `build-desktop.cmd` and `README.md` all discuss `build-ui.mjs`
// in prose away from the step that runs it.
//
// Run:  node scripts/verify-build-order.mjs

import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The order the build actually requires, and why each step is not optional.
const STEPS = [
  { file: "build-wasm.mjs", what: "ui/vendor/textcore.js, which build-ui.mjs inlines" },
  { file: "build-icons.mjs", what: "src-tauri/icons/ and ui/mark.ico, which build-ui.mjs embeds" },
  { file: "build-ui.mjs", what: "ui/studio.html, a bundled resource" },
];
const INTERFACE = "build-ui.mjs";

// Every path from "I have the source" to "the interface exists". A new one
// belongs in this list; that is the point of the list.
//
// The last three were added after this file had already shipped, because the
// list was the bug. `scripts/build-desktop.sh` ran the interface BEFORE the
// icons and never built the text core - the identical defect this test was
// written to catch, in the one script that builds the Linux and macOS app. It
// survived because it was not on the list, and the machine it was written on is
// Windows. `start.sh` and `start.cmd` had the same omission behind their
// "if the interface is missing" guard, which fires on exactly the fresh checkout
// where it does the most damage. A verifier is only as good as its coverage.
const ENTRY_POINTS = [
  "scripts/build.sh",
  "scripts/build-desktop.sh",
  "scripts/build-desktop.cmd",
  "start-tauri.cmd",
  "start.sh",
  "start.cmd",
  "README.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];

const isComment = (line) => /^\s*(#|REM\b|REM\s|<!--|\/\/)/i.test(line);

/** The parts of a file that instruct rather than explain. */
function instructionsOf(rel, text) {
  const lines = text.split(/\r?\n/);
  if (extname(rel) !== ".md") return lines.filter((l) => !isComment(l)).join("\n");

  // Markdown: only what is inside a fenced block. Prose that happens to name
  // `build-icons.mjs` while discussing icon geometry is not a build step.
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inside = !inside;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** The build steps named, in order, with consecutive repeats collapsed.
 *
 *  Collapsing is what makes `build-ui.mjs && node scripts/build-ui.mjs --core`
 *  one event rather than two - the `--core` line is the same step run twice, and
 *  treating it as a second sequence would demand a second text-core build that
 *  nothing needs. */
function stepsIn(code) {
  const found = [];
  for (const s of STEPS) {
    let i = code.indexOf(s.file);
    while (i >= 0) {
      found.push({ at: i, file: s.file });
      i = code.indexOf(s.file, i + 1);
    }
  }
  found.sort((a, b) => a.at - b.at);
  return found.filter((f, n) => n === 0 || f.file !== found[n - 1].file);
}

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

/** The rule, as a function, so the negative controls can run the real thing. */
function findProblem(code) {
  const named = new Set(stepsIn(code).map((s) => s.file));
  const missing = STEPS.filter((s) => !named.has(s.file));
  if (missing.length) {
    return { kind: "missing", detail: `never runs ${missing.map((s) => s.file).join(", ")} - ${missing[0].what} would be missing` };
  }

  const seen = new Set();
  for (const step of stepsIn(code)) {
    if (step.file === INTERFACE) {
      const lacking = STEPS.filter((s) => s.file !== INTERFACE && !seen.has(s.file));
      if (lacking.length) {
        return { kind: "order", detail: `${INTERFACE} is reached without ${lacking.map((s) => s.file).join(", ")} before it` };
      }
      seen.clear();
    } else {
      seen.add(step.file);
    }
  }
  return null;
}

process.stdout.write("build order\n");

for (const rel of ENTRY_POINTS) {
  const code = instructionsOf(rel, readFileSync(join(ROOT, rel), "utf8"));
  const problem = findProblem(code);
  const label = problem ? `${rel}: ${problem.kind === "missing" ? "builds all three" : "in the order wasm -> icons -> interface"}` : `${rel}: ok`;
  check(label, !problem, problem ? problem.detail : "");
}

// The negative controls. Each is fed through `findProblem` itself rather than
// through a second copy of the rule, because a test that cannot fail is not
// evidence - and the first of these is the real pre-fix content of
// `scripts/build-desktop.cmd`, which shipped in that state.
{
  const controls = [
    {
      name: "rejects interface-first (build-desktop.cmd as it was)",
      code: "node scripts\\build-ui.mjs\nnode scripts\\build-icons.mjs",
    },
    {
      name: "rejects a second sequence that omits the text core",
      code: [
        "node scripts/build-wasm.mjs",
        "node scripts/build-icons.mjs",
        "node scripts/build-ui.mjs",
        "node scripts/build-icons.mjs",
        "node scripts/build-ui.mjs",
      ].join("\n"),
    },
    {
      name: "accepts a correct second sequence",
      code: [
        "node scripts/build-wasm.mjs",
        "node scripts/build-icons.mjs",
        "node scripts/build-ui.mjs",
        "node scripts/build-wasm.mjs",
        "node scripts/build-icons.mjs",
        "node scripts/build-ui.mjs",
      ].join("\n"),
    },
  ];
  for (const c of controls) {
    const problem = findProblem(c.code);
    const wantProblem = !c.name.startsWith("accepts");
    check(c.name, wantProblem ? Boolean(problem) : !problem, problem ? problem.detail : "no problem found");
  }
}

process.stdout.write(`\n${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
