#!/usr/bin/env node
// Where the optional AI companion lives. One question, one answer.
//
// Three things need this: `start.sh`, `start.cmd` and a person staring at
// "companion not found". It used to be answered by a hard-coded `../../python`
// in each launcher - correct while the studio lived at `D:\ryan\datara-studio`,
// and pointing at `D:\python`, which does not exist, ever since the workspace
// moved to `D:\IDE datara`. Measured on this machine: the companion is at
// `D:/ryan/python/forgen_ai/ide_daemon.py`.
//
// The search lives here instead of in each launcher for a reason that is not
// tidiness: the batch copy of it could not be run. `cmd.exe` is not reachable
// from this machine's tooling, so the Windows half of the fix would have shipped
// unexecuted - which is how the stale default survived in the first place. `node`
// is already a dependency of this repository (`scripts/build-ui.mjs` requires it
// for the interface build), so neither launcher pays anything new to ask, and
// this answer can be checked by running it. See `scripts/verify-companion.mjs`.
//
// Prints the directory that CONTAINS `forgen_ai/` - not the one that contains
// `python/`, which is the convention `st_ai_start` uses for its own `dir`
// argument. The two differ by one level, and `FORGEN_AI_DIR` means this one, in
// both launchers.
//
// Forward slashes on every platform, always. Both consumers need that: bash
// reads `D:\ryan\python` as a single filename with a colon in it, and `cmd`'s
// `cd /d` accepts `D:/ryan/python` perfectly well. The rest of this repository
// already spells Windows paths this way.
//
// Usage:
//   node scripts/find-companion.mjs           # the path, or nothing + exit 1
//   node scripts/find-companion.mjs --list    # every candidate, found or not
//   node scripts/find-companion.mjs --json    # { ok, dir, tried: [...] }

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from this file's own location, not from `process.cwd()`, so the answer
// does not depend on where the launcher happened to be invoked from.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// What makes a directory the companion's: the daemon itself. A bare `python/`
// folder is not enough - there are several of those on a working machine, and
// answering with one that has no daemon turns "found" into a launcher that
// starts nothing and says it started something.
const MARKER = join("forgen_ai", "ide_daemon.py");

const slash = (p) => p.replace(/\\/g, "/");

function candidateDirs() {
  const out = [];
  const add = (label, dir) => {
    if (!dir) return;
    const full = resolve(dir);
    if (out.some((c) => c.dir === full)) return;
    out.push({ label, dir: full });
  };

  // An explicit setting is a statement of fact and is tried first. When it is
  // wrong it is skipped rather than fatal, so a stale value in a shell profile
  // cannot make the companion unreachable - the same rule `start.sh` used.
  add("FORGEN_AI_DIR", process.env.FORGEN_AI_DIR);

  // Nearest ancestor first, and that is a correction rather than a preference.
  //
  // The old code had exactly one hard-coded path, `../../python`, and it was
  // right for the layout the studio was written in: `D:\ryan\datara-studio`,
  // where `$ROOT/..` is `D:\ryan` and the companion is at `D:\ryan\python`. So
  // `../python` is the candidate with history behind it, and `../../python` is
  // the one that was never right - it is `D:\python`, the directory that does
  // not exist. Listing `../../` first would pick the farther ancestor whenever
  // both exist. Caught by `scripts/verify-companion.mjs` check 3.
  add("$ROOT/../python", join(ROOT, "..", "python"));
  add("$ROOT/../../python", join(ROOT, "..", "..", "python"));

  // A documented install location, and a deliberate one. It outranks the sweep
  // below because a directory somebody chose on purpose beats a directory that
  // happened to sort first.
  add("$HOME/.datara/python", join(homedir(), ".datara", "python"));

  // Siblings of the studio's parent - last, and reluctantly.
  //
  // This is the candidate that actually finds `D:/ryan/python` from
  // `D:/IDE datara/datara-studio`, where no ancestor relationship exists at all
  // and the only alternatives are an environment variable or a sweep. It is a
  // single non-recursive listing, never a walk, and it is last because when the
  // studio sits one level below a drive root that listing is the drive root
  // itself. Measured here: 31 candidates, `$RECYCLE.BIN` and
  // `System Volume Information` among them, and exactly one hit.
  //
  // Sorted, because the order `readdir` returns is the filesystem's and not a
  // promise: NTFS hands these back roughly alphabetically, ext4 hands them back
  // by hash. Left unsorted, two machines with the same disk contents and two
  // matching candidates would disagree about which one is the companion, and
  // this repository does not ship answers that depend on the filesystem.
  const grandparent = resolve(ROOT, "..", "..");
  let entries = [];
  try {
    entries = readdirSync(grandparent, { withFileTypes: true });
  } catch {
    // An unreadable or absent grandparent is one fewer candidate, not a failure.
  }
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    add("$ROOT/../../*/python", join(grandparent, e.name, "python"));
  }

  return out;
}

const tried = candidateDirs();
const hit = tried.find((c) => existsSync(join(c.dir, MARKER)));

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const asList = args.includes("--list");

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: Boolean(hit),
        dir: hit ? slash(hit.dir) : "",
        foundVia: hit ? hit.label : "",
        tried: tried.map((c) => ({ via: c.label, dir: slash(c.dir), has: existsSync(join(c.dir, MARKER)) })),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(hit ? 0 : 1);
}

if (asList) {
  for (const c of tried) {
    const has = existsSync(join(c.dir, MARKER));
    process.stdout.write(`${has ? "*" : " "} ${c.label.padEnd(22)} ${slash(c.dir)}\n`);
  }
  process.exit(hit ? 0 : 1);
}

if (hit) {
  // Just the path on stdout: `start.cmd` reads this with `for /f`, where any
  // decoration at all would be captured as part of the directory.
  process.stdout.write(slash(hit.dir) + "\n");
  process.exit(0);
}

// Nothing on stdout, because the callers test for empty. The explanation goes to
// stderr where it cannot be mistaken for the answer.
process.stderr.write("the AI companion was not found. Looked in:\n");
for (const c of tried) process.stderr.write(`  ${c.label.padEnd(22)} ${slash(c.dir)}\n`);
process.stderr.write("set FORGEN_AI_DIR to the directory that contains forgen_ai/\n");
process.exit(1);
