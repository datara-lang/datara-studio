#!/usr/bin/env node
// The studio's version is written in six places, and they have to agree.
//
// Why this exists. They did not. Before this file, the tree said all of the
// following at once:
//
//   datara.toml                 0.1.0
//   package.json                0.3.0
//   src-tauri/Cargo.toml        0.3.0
//   src-tauri/tauri.conf.json   0.3.0
//   src/api.dtr                 0.3.0   <- what /api/health reports
//   src/main.dtr                0.3.0   <- what the banner prints
//
// Two of those are load-bearing in ways the others are not. `tauri.conf.json`
// names the installer - `Datara Studio_<version>_x64-setup.exe` - so it decides
// what a person downloads. `src/api.dtr` decides what the running server tells
// the interface it is. A release where those two disagree installs an
// application that denies being the version on the file it came from, and
// nothing in the build would have said so.
//
// The sixth check is the tag, and it only runs when there is one. The release
// workflow fires on `v*` and takes the asset names from the tag while the
// binaries take theirs from `tauri.conf.json`; if those disagree the release is
// incoherent in a way that is invisible until someone reads both.
//
// Run:  node scripts/verify-version.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// Each site, and how to pull the version out of it. A site that cannot be parsed
// is a failure rather than a skip: a pattern that silently stops matching is how
// a check like this quietly stops checking.
const SITES = [
  {
    file: "datara.toml",
    what: "the forgen project manifest",
    get: (t) => (/^\s*version\s*=\s*"([^"]+)"/m.exec(t) || [])[1],
  },
  {
    file: "package.json",
    what: "the development manifest",
    get: (t) => JSON.parse(t).version,
  },
  {
    file: "src-tauri/Cargo.toml",
    what: "the shell crate",
    get: (t) => (/^\s*version\s*=\s*"([^"]+)"/m.exec(t) || [])[1],
  },
  {
    file: "src-tauri/tauri.conf.json",
    what: "the installer name and the window",
    get: (t) => JSON.parse(t).version,
  },
  {
    file: "src/api.dtr",
    what: "what /api/health reports",
    get: (t) => (/\\"version\\":\\"([^"\\]+)\\"/.exec(t) || [])[1],
  },
  {
    file: "src/main.dtr",
    what: "what the banner prints",
    get: (t) => /Datara Studio (\d+\.\d+\.\d+)/.exec(t)?.[1],
  },
];

let passed = 0;
let failed = 0;
let skipped = 0;

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

process.stdout.write("version\n");

const found = [];
for (const site of SITES) {
  let value;
  try {
    value = site.get(read(site.file));
  } catch (e) {
    value = undefined;
  }
  check(`${site.file} carries a version (${site.what})`, Boolean(value), value === undefined ? "no version found - the pattern no longer matches" : "");
  if (value) found.push({ ...site, value });
}

if (found.length === SITES.length) {
  const distinct = [...new Set(found.map((f) => f.value))];
  check(
    "all six sites agree",
    distinct.length === 1,
    distinct.length === 1 ? "" : found.map((f) => `${f.file}=${f.value}`).join("  "),
  );
  process.stdout.write(`       version ${distinct[0]}\n`);

  // The tag, when there is one. On a branch this is not applicable rather than
  // passing - a check that reports success for something it did not do is worse
  // than no check.
  let tag = "";
  try {
    tag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    tag = "";
  }

  if (!tag) {
    skipped += 1;
    process.stdout.write("  skip the tag matches (HEAD is not tagged)\n");
  } else {
    const fromTag = tag.replace(/^v/, "");
    check(`the tag ${tag} matches the version`, fromTag === distinct[0], `tag says ${fromTag}, the tree says ${distinct[0]}`);
  }
}

process.stdout.write(`\n${passed}/${passed + failed} checks passed${skipped ? `, ${skipped} skipped` : ""}\n`);
process.exit(failed === 0 ? 0 : 1);
