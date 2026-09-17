#!/usr/bin/env node
// Checks `scripts/find-companion.mjs` by running it.
//
// Why this exists. The companion's location was answered by a hard-coded
// `../../python` in `start.sh` and again in `start.cmd`, and it was wrong in
// both - it resolved to `D:\python`, which does not exist, from the day the
// workspace moved. Nobody noticed, because nothing tested it and the batch copy
// could not be run at all on a machine whose tooling cannot reach `cmd.exe`. The
// search now lives in one Node file that both launchers call, and this is the
// part that makes the difference real: the file is executed, against a fixture
// tree whose answers are known.
//
// The fixture is a copy of the real script rather than a restatement of its
// rules. A restatement would keep passing after the original changed.
//
// Run:  node scripts/verify-companion.mjs

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = join(HERE, "find-companion.mjs");

// Canonicalise before comparing any two paths, and do it to both sides.
//
// macOS makes this mandatory rather than tidy: `mkdtempSync` returns
// `/var/folders/...`, while the script under test derives its answer from
// `import.meta.url`, which Node has already resolved through the symlink, so it
// answers `/private/var/folders/...`. Both are the same directory and a string
// comparison says they are not. Measured on the macOS runner: this test was the
// only failure in the whole interface job, and it was the test that was wrong -
// the search had found exactly the right directory.
//
// "Both sides" is not decoration, and this file got it wrong once. An answer
// derived from `import.meta.url` arrives already canonicalised, so comparing it
// against `real(x)` happens to work. An answer taken from `FORGEN_AI_DIR` does
// not: it is the environment string verbatim, so `j.dir === real(mine)` compared
// a raw path against a canonical one and failed on macOS alone - 11/12, on a
// search that had returned the right directory. Canonicalise the left side too.
//
// Reproduce that on any platform, without a Mac: point TMP at a symlink whose
// target differs from its own path, then run this file.
//
//     mkdir real-tmp && node -e "require('fs').symlinkSync('<abs>/real-tmp','<abs>/link-tmp','junction')"
//     TMP=<abs>/link-tmp node scripts/verify-companion.mjs
//
// `realpathSync` throws on a path that does not exist, and the value being
// canonicalised may be an empty string when the script under test failed - which
// is exactly the case this test is supposed to report as a failure, not crash on.
const real = (p) => {
  try {
    return realpathSync(p).replace(/\\/g, "/");
  } catch {
    return String(p).replace(/\\/g, "/");
  }
};

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n`);
    if (detail !== undefined) process.stdout.write(`         ${detail}\n`);
  }
}

// A companion is a directory holding `forgen_ai/ide_daemon.py` and nothing else
// that matters. Creating the marker is the whole fixture.
function plantCompanion(dir) {
  mkdirSync(join(dir, "forgen_ai"), { recursive: true });
  writeFileSync(join(dir, "forgen_ai", "ide_daemon.py"), "# fixture\n");
}

function run(script, { env = {}, cwd, args = [] } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: r.stderr || "" };
}

// The tree is three levels deep so the sweep has a bounded grandparent to look
// in. `$ROOT/../..` is `<tmp>/a`, so the sweep is `<tmp>/a/*/python` and never
// reaches a real drive root - which matters, because the answer there is an
// accident of ordering rather than a fact about this fixture.
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), "ds-companion-"));
  const root = join(base, "a", "b", "studio");
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(REAL, join(root, "scripts", "find-companion.mjs"));
  return { base, root, script: join(root, "scripts", "find-companion.mjs") };
}

// `os.homedir()` reads USERPROFILE on Windows and HOME everywhere else, and an
// unoverridden home could shadow the sweep with a real `~/.datara/python`.
const fakeHome = (base) => ({ HOME: join(base, "home"), USERPROFILE: join(base, "home") });

process.stdout.write("companion search\n");

// ---- 1. the sweep, and only the sweep -------------------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  const r = run(script, { env: fakeHome(base), args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("finds a sibling project's companion when nothing else matches", r.code === 0 && real(j.dir) === real(join(base, "a", "ryan", "python")), `${r.code} ${j.dir}`);
  check("and says it found it by the sweep", j.foundVia === "$ROOT/../../*/python", j.foundVia);
  rmSync(base, { recursive: true, force: true });
}

// ---- 2. nearer ancestors outrank the sweep --------------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  plantCompanion(join(base, "a", "python"));
  const r = run(script, { env: fakeHome(base), args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("$ROOT/../../python outranks the sweep", j.foundVia === "$ROOT/../../python", j.foundVia);
  rmSync(base, { recursive: true, force: true });
}

// ---- 3. the nearest ancestor wins ----------------------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "python"));
  plantCompanion(join(base, "a", "b", "python"));
  const r = run(script, { env: fakeHome(base), args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("$ROOT/../python outranks $ROOT/../../python", j.foundVia === "$ROOT/../python", j.foundVia);
  rmSync(base, { recursive: true, force: true });
}

// ---- 4. an explicit setting is obeyed ------------------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  const mine = join(base, "elsewhere", "python");
  plantCompanion(mine);
  const r = run(script, { env: { ...fakeHome(base), FORGEN_AI_DIR: mine }, args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("FORGEN_AI_DIR wins over every guess", j.foundVia === "FORGEN_AI_DIR" && real(j.dir) === real(mine), j.dir);
  rmSync(base, { recursive: true, force: true });
}

// ---- 5. a wrong setting is skipped, not fatal ----------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  const empty = join(base, "empty");
  mkdirSync(empty, { recursive: true });
  const r = run(script, { env: { ...fakeHome(base), FORGEN_AI_DIR: empty }, args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("a directory without forgen_ai/ is rejected, and the search continues", r.code === 0 && j.foundVia !== "FORGEN_AI_DIR", `${r.code} ${j.foundVia}`);
  rmSync(base, { recursive: true, force: true });
}

// ---- 6. nothing found is an empty stdout and a non-zero exit -------------
{
  const { base, script } = makeTree();
  const r = run(script, { env: fakeHome(base) });
  check("nothing found exits 1 with an empty stdout", r.code === 1 && r.out === "", `code=${r.code} out=${JSON.stringify(r.out)}`);
  check("and explains itself on stderr, not stdout", r.err.includes("FORGEN_AI_DIR") && r.err.includes("$ROOT/"), JSON.stringify(r.err.slice(0, 80)));
  rmSync(base, { recursive: true, force: true });
}

// ---- 7. the documented install location, with no other candidate ---------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "home", ".datara", "python"));
  const r = run(script, { env: fakeHome(base), args: ["--json"] });
  const j = JSON.parse(r.out || "{}");
  check("$HOME/.datara/python is found on its own", j.foundVia === "$HOME/.datara/python", j.foundVia);
  rmSync(base, { recursive: true, force: true });
}

// ---- 8. the shape the launchers consume ---------------------------------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  const r = run(script, { env: fakeHome(base) });
  check("stdout is one line and nothing else", r.code === 0 && r.out.split("\n").length === 1, JSON.stringify(r.out));
  // bash reads `D:\ryan\python` as a single filename containing a colon, and
  // `cmd`'s `cd /d` takes forward slashes happily. Both consumers need this.
  check("the path is spelled with forward slashes on every platform", !r.out.includes("\\"), JSON.stringify(r.out));
  rmSync(base, { recursive: true, force: true });
}

// ---- 9. the answer does not depend on where it was called from -----------
{
  const { base, script } = makeTree();
  plantCompanion(join(base, "a", "ryan", "python"));
  const fromRoot = run(script, { env: fakeHome(base), cwd: dirname(script) });
  const fromElsewhere = run(script, { env: fakeHome(base), cwd: base });
  check("the same answer from two different working directories", fromRoot.out === fromElsewhere.out && fromRoot.out !== "", `${fromRoot.out} vs ${fromElsewhere.out}`);
  rmSync(base, { recursive: true, force: true });
}

process.stdout.write(`\n${passed}/${passed + failed} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
