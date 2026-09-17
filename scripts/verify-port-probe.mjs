// Prove the Unix half of `st_port_busy` on a real Unix.
//
// Why this exists. `st_port_busy` was Windows-only and could not be caught from
// a Windows machine, because that path is correct on the platform it was written
// for: on Linux and macOS it returned false for every port, so `st_ai_start`
// started another companion on every call. Fixing it is not the hard part -
// *checking* it is, because there is no Linux host here and the tools it uses
// (`lsof`, `ss`) do not exist on Windows, so a local run only ever exercises the
// `netstat` fallback.
//
// So the shell text is not copied into a test. It is **extracted from
// `src/explorer.dtr`**, with the port substituted, and run. A second copy of a
// probe is a second probe; the copy would keep passing after the real one broke,
// which is the failure mode this whole repository keeps running into. Extraction
// means the check fails the moment the Datara source stops being valid shell.
//
// On Windows this still passes - through the netstat fallback, which is honest
// but weak. It is `ubuntu-latest` and `macos-latest` in the workflow that make it
// mean something, and that is where it is wired in.
//
// Run:  node scripts/verify-port-probe.mjs

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = join(HERE, "..");
const SRC = join(STUDIO, "src", "explorer.dtr");

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
};

// ---- pull the probe out of the Datara source -------------------------------
//
// The branch is a run of quoted fragments joined with `+` around the `p` variable
// and ending in `st_ok_mark()`. Decoding them is a small parse rather than a
// regex over the whole file, so a change that breaks the shape fails loudly
// instead of silently extracting something plausible.
const text = readFileSync(SRC, "utf8");
const start = text.indexOf("let probe =");
if (start < 0) {
  console.error("  FAIL  could not find `let probe =` in src/explorer.dtr");
  process.exit(1);
}
const end = text.indexOf("st_ok_mark()", start);
if (end < 0) {
  console.error("  FAIL  the probe no longer ends with st_ok_mark()");
  process.exit(1);
}
const expr = text.slice(start + "let probe =".length, end);

let probe = "";
let sawPort = 0;
for (const raw of expr.split("+")) {
  const part = raw.trim();
  if (part === "" ) continue;
  if (part === "p") { probe += "__PORT__"; sawPort++; continue; }
  if (part.startsWith('"') && part.endsWith('"')) {
    // decode the Datara string literal: \" is the only escape the probe uses
    probe += part.slice(1, -1).replace(/\\"/g, '"');
    continue;
  }
  console.error("  FAIL  unrecognised fragment in the probe: " + JSON.stringify(part));
  process.exit(1);
}
// `st_ok_mark()` is the last term, and its value is the marker the Datara side
// looks for. Restated here on purpose: if the marker changes, this check should
// notice rather than agree with itself.
const MARK = "__DS_OK__";
probe += MARK;

check("the probe was extracted from src/explorer.dtr", probe.length > 80 && sawPort === 3,
  sawPort + " port substitutions, " + probe.length + " chars");

// ---- run it against a port that is listening, and one that is not ----------
//
// A real listener, opened here rather than assumed: the probe's job is to see a
// socket in the LISTEN state, and a port that merely *was* busy at some point is
// not the same test.
const listener = createServer();
const port = await new Promise((resolve, reject) => {
  listener.on("error", reject);
  listener.listen(0, "127.0.0.1", () => resolve(listener.address().port));
});

const run = (p) => spawnSync("sh", ["-c", probe.replace(/__PORT__/g, String(p))],
  { encoding: "utf8", timeout: 20000 });

const busy = run(port);
const busyHit = (busy.stdout || "").includes(MARK);
check("a listening port is reported as busy", busyHit,
  "port " + port + " -> " + JSON.stringify((busy.stdout || "").trim()) + " (status " + busy.status + ")");

// A port nobody holds. Taken from the ephemeral range by opening and closing, so
// it is free at the moment of the test rather than a number guessed to be unused.
const probeSock = createServer();
const freePort = await new Promise((resolve) => {
  probeSock.listen(0, "127.0.0.1", () => {
    const p = probeSock.address().port;
    probeSock.close(() => resolve(p));
  });
});
await new Promise((r) => setTimeout(r, 300));

const free = run(freePort);
const freeHit = (free.stdout || "").includes(MARK);
check("a free port is not reported as busy", !freeHit,
  "port " + freePort + " -> " + JSON.stringify((free.stdout || "").trim()));

// ---- and it must not depend on a tool being installed ---------------------
//
// This is the part that only means something off Windows: on Linux and macOS the
// probe has to work with `lsof` or `ss` or `netstat`, whichever is present. On
// Windows none of the three is, so this reports which branch could have answered
// and does not fail - the workflow's Linux and macOS jobs are what make it real.
const which = (t) => spawnSync("sh", ["-c", "command -v " + t], { encoding: "utf8" }).status === 0;
const tools = ["lsof", "ss", "netstat"].filter(which);
check("at least one of lsof/ss/netstat is available to answer", tools.length > 0,
  tools.length ? "found: " + tools.join(", ") : "none - the probe cannot answer on this machine");
if (process.platform !== "win32") {
  check("on this platform the probe answered through a real Unix tool",
    tools.length > 0 && busyHit);
}

listener.close();

const bad = results.filter((r) => !r).length;
console.log("\n" + (results.length - bad) + "/" + results.length + " checks passed");
process.exit(bad ? 1 : 0);
