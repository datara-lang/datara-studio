// Mutate the shipped source, run a suite, put it back - and say so when the
// mutation never applied.
//
// Why this exists. "A test never seen to fail is not evidence" is a rule this
// project works to, and the way it goes wrong is silent: a search-and-replace
// whose pattern matches nothing exits 0 and changes nothing, so the suite runs
// against unmodified source, passes, and the run is recorded as proof that the
// assertion catches the defect. It did not - the defect was never introduced.
// This script refuses to report a result unless it saw the file change, and
// unless it saw the file change *back*.
//
// Usage:
//   node scripts/mutate.mjs <spec.json>
//
// The spec is a list of mutations. Each names a file, the exact text to find,
// the text to put in its place, the command to run, and the strings the command
// is expected to print. Paths in `cmd` are relative to the repository root and
// are run from there.
//
//   {
//     "repo": "D:/IDE datara/datara-studio",
//     "mutations": [
//       {
//         "name": "the walk-up is shortened to one level",
//         "file": "src-tauri/src/main.rs",
//         "old": "for _ in 0..8 {",
//         "new": "for _ in 0..1 {",
//         "cmd": "cargo test --manifest-path src-tauri/Cargo.toml",
//         "expect": ["2 failed"]
//       }
//     ]
//   }
//
// `expect` is what must appear in the output for the mutation to count as
// caught. A mutation that runs clean is a hole in the suite, and is reported as
// such rather than as a pass.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node scripts/mutate.mjs <spec.json>");
  process.exit(2);
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const repo = resolve(spec.repo || process.cwd());

const backupOf = (file) => file + ".mutation-backup";

// A run that is killed - by a timeout, by Ctrl+C, by the harness that started it
// - leaves the mutation applied and a backup beside it. The next run would then
// find its pattern already applied, report BROKEN, and carry on with a tree that
// is not the committed one; worse, it would take its own backup of the mutated
// file and lose the original for good. Recover before doing anything else.
let recovered = 0;
for (const m of spec.mutations) {
  const file = isAbsolute(m.file) ? m.file : join(repo, m.file);
  if (existsSync(backupOf(file))) {
    copyFileSync(backupOf(file), file);
    unlinkSync(backupOf(file));
    recovered++;
    console.log("  RESTORED  " + m.file + "   [a previous run was killed mid-mutation]");
  }
}
if (recovered) console.log("");

/** How many times `needle` occurs in `hay`. `split` rather than a regex, because
 *  the needles are source text with regex metacharacters in them. */
const occurrences = (hay, needle) => hay.split(needle).length - 1;

/** Match on LF and write back with whatever the file used.
 *
 *  The first version of this script did not, and a five-line needle written with
 *  `\n` against a Python file saved with CRLF matched nothing - so the mutation
 *  was reported as BROKEN. Which is the point of the check, but the cause is
 *  worth removing: a spec author cannot see line endings, and a mutation that
 *  cannot be expressed is a guarantee that cannot be tested.
 */
function lineEndingOf(text) {
  const crlf = occurrences(text, "\r\n");
  const lf = occurrences(text, "\n") - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function swap(text, old, replacement) {
  const eol = lineEndingOf(text);
  const flat = text.split("\r\n").join("\n");
  const needle = old.split("\r\n").join("\n");
  if (occurrences(flat, needle) !== 1) return null;
  return flat.replace(needle, replacement).split("\n").join(eol);
}

let caught = 0;
const holes = [];
const broken = [];

/** Put the file back if this process is interrupted.
 *
 *  `execSync` runs a suite that can take minutes, which is long enough for a
 *  timeout or a Ctrl+C to land in the middle of it. Leaving the tree mutated is
 *  the worst outcome available: the next run cannot tell a mutation that was
 *  already applied from one that does not match, and the source that was
 *  committed is gone. Recovery on startup is the real safety net; this just
 *  makes the common case tidy.
 */
let inFlight = null;
const restoreInFlight = () => {
  if (!inFlight) return;
  try {
    renameSync(inFlight.backup, inFlight.file);
    inFlight = null;
  } catch (e) {}
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { restoreInFlight(); process.exit(130); });
}

for (const m of spec.mutations) {
  const file = isAbsolute(m.file) ? m.file : join(repo, m.file);
  const original = readFileSync(file, "utf8");
  const backup = file + ".mutation-backup";

  const found = occurrences(original.split("\r\n").join("\n"), m.old.split("\r\n").join("\n"));
  const mutatedText = swap(original, m.old, m.new);
  if (found !== 1 || mutatedText === null) {
    // Not a caught mutation and not a hole in the suite - the mutation itself is
    // wrong, and reporting it either way would be a lie.
    broken.push(m.name + ": the pattern occurs " + found + " time(s), not once");
    console.log("  BROKEN  " + m.name + "   [pattern occurs " + found + " time(s)]");
    continue;
  }

  copyFileSync(file, backup);
  writeFileSync(file, mutatedText);
  inFlight = { file, backup };
  const mutated = readFileSync(file, "utf8");
  if (mutated === original) {
    broken.push(m.name + ": the file did not change");
    console.log("  BROKEN  " + m.name + "   [the file did not change]");
    renameSync(backup, file);
    inFlight = null;
    continue;
  }

  let out = "";
  try {
    out = execSync(m.cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }

  renameSync(backup, file);
  inFlight = null;
  const restored = readFileSync(file, "utf8");
  if (restored !== original) {
    // The most expensive failure mode: a suite run against a tree that is not
    // the one that was committed.
    broken.push(m.name + ": the file was not restored");
    console.log("  BROKEN  " + m.name + "   [the file was not restored]");
    continue;
  }

  const missing = (m.expect || []).filter((needle) => !out.includes(needle));
  if (missing.length === 0) {
    caught++;
    console.log("  CAUGHT  " + m.name + "   [" + m.expect.join(", ") + "]");
  } else {
    holes.push(m.name + ": expected " + JSON.stringify(missing) + " in the output");
    console.log("  HOLE    " + m.name + "   [missing " + JSON.stringify(missing) + "]");
  }
}

console.log("");
console.log(caught + " of " + spec.mutations.length + " mutation(s) caught");
for (const h of holes) console.log("HOLE " + h);
for (const b of broken) console.log("BROKEN " + b);
process.exit(holes.length || broken.length ? 1 : 0);
