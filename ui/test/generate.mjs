// Does the Generate panel continue the open file, or does it paste the file
// into itself?
//
// Run:  PLAYWRIGHT_ROOT=... node ui/test/generate.mjs <base-url>
//
// Why this exists. The panel sends the open file as context and the companion
// returns the whole program with the new part in it - the context is echoed back
// at the head of `code`. The panel used to insert that entire string, so asking
// for a second function wrote a second copy of the file into the file. From the
// outside that reads as "it does not understand what was written before", and
// the outside was right: it understood, and then duplicated it.
//
// No screenshot can show this. The failure mode is a buffer that contains the
// right code twice, which looks completely normal in a PNG. So the assertions
// here are counts over the real textarea value, and the last one reads the bytes
// off disk.
//
// The two requests are fixed rather than generated because the companion's
// classifier is keyword-based: these two were probed against the running daemon
// and both clear the 0.5 confidence floor, so the weak-result dialog never
// enters the picture and the test measures the one thing it is about.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) {}
  const roots = [];
  if (process.env.PLAYWRIGHT_ROOT) roots.push(process.env.PLAYWRIGHT_ROOT);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
  if (appdata) roots.push(join(appdata, "npm", "node_modules"));
  for (const root of roots) {
    for (const entry of ["index.mjs", "index.js"]) {
      const file = join(root, "playwright", entry);
      if (existsSync(file)) { try { return await import(pathToFileURL(file).href); } catch (e) {} }
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.log("playwright is not importable - skipping the generate drive.");
  process.exit(0);
}

const base = process.argv[2] || "http://127.0.0.1:7878";

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
};

// ---- the companion has to be up, or there is nothing to measure
const alive = await fetch("http://127.0.0.1:7890/", { signal: AbortSignal.timeout(3000) })
  .then((r) => r.ok).catch(() => false);
if (!alive) {
  console.log("the companion is not answering on :7890 - skipping the generate drive.");
  process.exit(0);
}

// ---- a scratch workspace
//
// A real project rather than a loose file. `datara.toml` is what the companion
// uses to decide which tree to verify against, and `src/` is where forgen looks
// for the modules a file imports. With neither, a context that imports its
// siblings cannot resolve - and that is the defect this layout exists to catch:
// the companion checked the merged text against its *own* repository, so every
// `use` in the open file came back `E-RESOLVE-005` and `verified` was false for
// code that compiles in the project it was written for.
const ws = join(tmpdir(), "ds-generate");
rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, "src"), { recursive: true });
writeFileSync(join(ws, "datara.toml"),
  '[package]\nname = "ds_generate"\nversion = "0.1.0"\nedition = "2026"\n'
  + 'entry = "src/main.dtr"\n');
writeFileSync(join(ws, "src", "helper.dtr"),
  "fn st_double(x: Int) -> Int {\n    return x + x\n}\n");
const HELLO = "use helper\n\nfn main() -> Int {\n    return st_double(2)\n}\n";
writeFileSync(join(ws, "src", "main.dtr"), HELLO);
const wsPosix = ws.replace(/\\/g, "/");
const file = join(ws, "src", "main.dtr");
console.log("scratch workspace: " + wsPosix);

const REQ1 = "reverse a list of integers";
const REQ2 = "read a file and print it";

/** Occurrences of a fixed string in a haystack. The whole point of the test. */
const count = (hay, needle) => hay.split(needle).length - 1;

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
await ctx.addInitScript((r) => {
  // `lastRoot` is the key the boot actually reads. This said `datara.studio.root`
  // for as long as the test has existed, which nothing reads - so there was no
  // workspace here, `lastFile` alone opened the file, and every assertion in
  // this file happened to be about the Generate panel rather than about the
  // tree. Found from the sibling search test, where the missing workspace was
  // visible as a Project panel that never left "Reading the workspace ...".
  localStorage.setItem("datara.studio.lastRoot", r);
  localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
  localStorage.setItem("datara.studio.lastFile", r + "/src/main.dtr");
  localStorage.removeItem("datara.studio.settings");
}, wsPosix);
const page = await ctx.newPage();
const errs = [];
const native = [];
// Which Generate endpoint the panel actually talked to. The stream is the one
// that reports attempts as they happen; the bare POST is the fallback. A run
// that quietly used the fallback would still pass every other assertion here.
const genCalls = [];
page.on("request", (r) => {
  const u = r.url();
  if (/\/generate(\/stream)?$/.test(u)) genCalls.push(u.replace(/^https?:\/\/[^/]+/, ""));
});
page.on("pageerror", (e) => errs.push(e.message));
page.on("dialog", async (d) => { native.push(d.message()); await d.dismiss().catch(() => {}); });
await page.goto(base, { waitUntil: "domcontentloaded" });
// Wait for the file to be in the buffer rather than for a fixed number of
// milliseconds. The workspace now has a manifest and a sibling module, so the
// boot does more work before the editor is filled - and a fixed sleep made this
// suite fail on a machine that was merely busy, which reads as "the file did
// not open" when the truth was "the assertion ran too early".
const openDeadline = Date.now() + 15000;
while (Date.now() < openDeadline) {
  if ((await page.locator(".code").count())
      && (await page.locator(".code").inputValue()).includes("fn main")) break;
  await page.waitForTimeout(200);
}
await page.waitForTimeout(600);

const buf = () => page.locator(".code").inputValue();

// ---- the file is open and the panel is reachable
check("the file is open in the editor", (await buf()).includes("fn main"),
  JSON.stringify((await buf()).slice(0, 30)));

await page.locator(".ptabs button", { hasText: "Generate" }).first().click();
await page.waitForTimeout(700);
const field = page.locator(".card .field").first();
check("the Generate panel has a request field", await field.count() === 1);

// Before any request there is nothing to report about context, and the readout
// must be absent rather than showing a zero it has not earned.
check("no context readout before the first request",
  await page.locator(".genctx").count() === 0);
// Same for the verify loop: no request has been made, so there is no loop to
// report. An empty block here would claim a verification that never happened.
check("no verify loop before the first request",
  await page.locator(".genloop").count() === 0);

/** Send one request and wait for the file to grow. Returns the new buffer. */
async function generate(req, before) {
  await field.fill(req);
  await page.locator("button.mini", { hasText: /^generate$/ }).first().click();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const now = await buf();
    if (now.length > before.length && now !== before) return now;
    await page.waitForTimeout(400);
  }
  return await buf();
}

// ---- 1. the first request appends, and appends once
const after1 = await generate(REQ1, HELLO);
check("the first request added something", after1.length > HELLO.length,
  HELLO.length + " -> " + after1.length + " chars");
check("the file was not duplicated by the first request",
  count(after1, HELLO.trim()) === 1, count(after1, HELLO.trim()) + " copies of the original");
check("the original code is still at the top",
  after1.startsWith(HELLO.trim()), JSON.stringify(after1.slice(0, 24)));
check("the generated code went after it, not before it",
  after1.indexOf("fn reverse_str") > after1.indexOf("fn main"),
  "fn reverse_str at " + after1.indexOf("fn reverse_str") + ", fn main at " + after1.indexOf("fn main"));

// ---- 2. the readout says what was sent and whether it was used
//
// `innerText` comes back upper-cased for the status words because the stylesheet
// applies `text-transform: uppercase` to them, so every match here is
// case-insensitive on purpose. The first version of these assertions was not,
// and failed against a panel that was working.
const ctxCount = await page.locator(".genctx").count();
const ctxText = ctxCount ? (await page.locator(".genctx").innerText()).replace(/\s+/g, " ").trim() : "";
check("the panel reports the context it sent", ctxCount === 1, ctxText);
check("the context it reports is the file it sent",
  /of the open file/i.test(ctxText) && !/\b0 chars\b/i.test(ctxText), ctxText);
check("it says whether the companion used the context",
  /companion (read|did not use) it/i.test(ctxText), ctxText);
check("the companion used it", /companion read it/i.test(ctxText), ctxText);

// ---- 3. a second request continues the program instead of restarting it
const after2 = await generate(REQ2, after1);
check("the second request added something", after2.length > after1.length,
  after1.length + " -> " + after2.length + " chars");
check("the file was not duplicated by the second request",
  count(after2, HELLO.trim()) === 1, count(after2, HELLO.trim()) + " copies of the original");
check("the first request's code survived the second",
  count(after2, "fn reverse_str") === 1, count(after2, "fn reverse_str") + " copies");
check("the second request's code is there too",
  after2.includes("fn count_lines"), "fn count_lines present: " + after2.includes("fn count_lines"));
// The strongest form of "it did not restart": the buffer the panel produced
// after the first request is still in the buffer, once, as its opening. A
// duplicate would show up here as two occurrences even though the length check
// above would pass - a second request that re-emitted the whole first answer is
// exactly the failure this panel was reported for.
check("the first answer is still a single unbroken prefix",
  count(after2, after1.trim()) === 1, count(after2, after1.trim()) + " copies of the first answer");
check("the buffer is not the first answer twice",
  after2.length !== after1.length * 2 || count(after2, after1.trim()) === 1,
  after2.length + " chars, first answer was " + after1.length);

// ---- 4. what the panel says it did is what it did
const whereText = (await page.locator(".genwhere").innerText()).replace(/\s+/g, " ").trim();
check("the panel names the file it wrote into", /main\.dtr/.test(whereText), whereText);
check("the panel says the code was appended, not inserted at the caret",
  /appended/i.test(whereText), whereText);

// ---- 4b. the verify loop is visible, not only its outcome
//
// The companion checks the code with forgen, repairs what the diagnostics
// explain, and checks again - up to three times. Until this block existed the
// panel showed only the outcome, so a run that needed three attempts looked
// exactly like one that passed first time, and "it self-corrected" was a claim
// with nothing behind it. These requests pass on the first check, so what is
// asserted here is that the loop reports its attempt honestly rather than
// inventing work it did not do.
//
// `innerText` uppercases the attempt tag because `.tag` carries
// `text-transform: uppercase`, so every match below is case-insensitive.
const loopCount = await page.locator(".genloop").count();
const stepCount = await page.locator(".genloop .step").count();
// `.first()`, not the bare locator. Playwright's strict mode throws when a
// locator matches more than one element, and a suite that throws on the first
// symptom stops being diagnostic: the failure arrives as a timeout in an
// unrelated assertion instead of as "there are two verify loops". The count is
// asserted separately below, so reading one of them here loses nothing.
const loopText = loopCount
  ? (await page.locator(".genloop").first().innerText()).replace(/\s+/g, " ").trim() : "";
check("the panel shows the verify loop", loopCount === 1, loopText);
check("the loop has at least one attempt", stepCount >= 1, stepCount + " step(s)");
check("the first attempt is numbered", /attempt 1\b/i.test(loopText), loopText);
check("every attempt says what forgen check did",
  (loopText.match(/forgen check (passed|failed)/gi) || []).length === stepCount, loopText);
// These two requests match a known shape, so the honest report is a single
// passing attempt. A second step here would mean the loop is claiming work.
check("a request that compiles first time reports exactly one attempt",
  stepCount === 1 && /forgen check passed/i.test(loopText), stepCount + " steps: " + loopText);
check("the loop block names itself", /verify loop/i.test(loopText), loopText);

// ---- 4c. the check ran against the project the file belongs to
//
// The context imports `helper`, which lives beside it in `src/`. The companion
// used to write its scratch file into its own repository, where no `helper`
// module exists, so forgen answered `E-RESOLVE-005: Module 'helper' not found`
// and the panel reported `unverified` - for code that compiles perfectly well
// in the project it was written for. Measured before the fix on a faithful
// scratch project: 0 of 8 requests verified, every failure being one of the
// file's own `use` lines.
//
// `verified` is read off the result card rather than inferred, because the tag
// is what the user sees and it is the claim being tested.
const resText = (await page.locator(".card").last().innerText()).replace(/\s+/g, " ").trim();
check("a context that imports its siblings still verifies",
  /verified/i.test(resText) && !/unverified/i.test(resText),
  resText.slice(0, 160));
check("the failure is not a module that could not be resolved",
  !/E-RESOLVE-005/.test(resText), resText.slice(0, 160));

// ---- 4d. the panel watched the loop rather than being told about it
check("the panel used the streaming endpoint",
  genCalls.includes("/generate/stream"), genCalls.join(" "));
check("the panel did not have to fall back to the plain endpoint",
  !genCalls.includes("/generate"), genCalls.join(" "));

// ---- 5. and it is really in the file, not only in the panel
await page.keyboard.press("Control+s");
await page.waitForTimeout(1400);
const onDisk = readFileSync(file, "utf8");
check("Ctrl+S wrote it to disk", onDisk.length > HELLO.length, onDisk.length + " bytes on disk");
check("the file on disk has one copy of the original",
  count(onDisk, HELLO.trim()) === 1, count(onDisk, HELLO.trim()) + " copies");
check("the file on disk has both additions",
  onDisk.includes("fn reverse_str") && onDisk.includes("fn count_lines"),
  "reverse_str " + onDisk.includes("fn reverse_str") + ", count_lines " + onDisk.includes("fn count_lines"));

// ---- 6. the panel folds a streamed run, attempt by attempt
//
// The two requests above pass on the first check, so they cannot show what the
// loop looks like when it has to work. This one is answered with a crafted
// stream: attempt 1 fails, a repair is applied, attempt 2 passes. It is the one
// shape the companion's own output almost never produces - measured over 30
// requests, 0 reached the repair branch - and it is exactly the shape the panel
// would get wrong, because it has to attach the repair to the attempt above it
// rather than open a third.
//
// What this does NOT assert is that the attempts appear *while* the request is
// running. A fulfilled route delivers its body in one write, so the reader loop
// sees every event in the same tick; the incremental delivery is measured in
// the companion's own suite instead, where the events are timed over a real
// socket. Everything between the socket and the pixels is covered here.
const STREAM_FIX = "List<Int>() -> []";
const STREAM_ADD = "\nfn st_stream_probe() -> Int {\n    return 7\n}\n";
await page.route("**/generate/stream", async (route) => {
  const sent = route.request().postDataJSON() || {};
  const ctx = sent.context || "";
  const step1 = { iteration: 1, ok: false, errors: ["error[E-TYPE-001]: mismatch"], fixes: [STREAM_FIX] };
  const step2 = { iteration: 2, ok: true, errors: [], fixes: [] };
  const events = [
    { event: "start", seq: 0 },
    { event: "plan", seq: 1, task: "list", title: "Streamed", confidence: 0.9 },
    { event: "shape", seq: 2, fragments: ["stream"] },
    { event: "assembled", seq: 3, chars: ctx.length + STREAM_ADD.length },
    { event: "check", seq: 4, iteration: 1, ok: false, errors: step1.errors },
    { event: "repair", seq: 5, iteration: 1, fixes: [STREAM_FIX] },
    { event: "check", seq: 6, iteration: 2, ok: true, errors: [] },
    { event: "done", seq: 7, success: true, verified: true, iterations: 2,
      task: "list", title: "Streamed", confidence: 0.9, fragments: ["stream"],
      steps: [step1, step2], code: ctx + STREAM_ADD },
  ];
  await route.fulfill({
    status: 200,
    contentType: "application/x-ndjson; charset=utf-8",
    body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  });
});

const beforeStream = await buf();
await field.fill("a request that needs two attempts");
await page.locator("button.mini", { hasText: /^generate$/ }).first().click();
const streamDeadline = Date.now() + 20000;
while (Date.now() < streamDeadline && (await buf()).length === beforeStream.length) {
  await page.waitForTimeout(200);
}
// The append and the result land in the same tick; the render that follows them
// is what is being read here.
await page.waitForTimeout(400);
const streamedText = (await page.locator(".genloop").first().innerText()).replace(/\s+/g, " ").trim();
const streamedSteps = await page.locator(".genloop .step").count();
check("a streamed run shows both attempts", streamedSteps === 2, streamedSteps + " step(s): " + streamedText);
check("the streamed run shows the failed attempt",
  /attempt 1\b/i.test(streamedText) && /forgen check failed \(1 error\)/i.test(streamedText), streamedText);
check("the streamed run shows the attempt that passed",
  /attempt 2\b/i.test(streamedText) && /forgen check passed/i.test(streamedText), streamedText);
// The repair belongs to the attempt that provoked it. Rendering it as its own
// attempt, or dropping it, is the failure this catches.
//
// Compared on a lowercased copy, because `.tag` carries `text-transform:
// uppercase` and `innerText` reports what is painted - so the painted text says
// "ATTEMPT 1" and a case-sensitive `indexOf("attempt 1")` finds nothing, which
// makes the ordering assertion pass for the wrong reason or fail for none.
const lowText = streamedText.toLowerCase();
const repairAt = lowText.indexOf("repaired: " + STREAM_FIX.toLowerCase());
check("the repair is attached to the attempt it repaired",
  repairAt > lowText.indexOf("attempt 1") && repairAt < lowText.indexOf("attempt 2"),
  "attempt 1 at " + lowText.indexOf("attempt 1") + ", repair at " + repairAt
  + ", attempt 2 at " + lowText.indexOf("attempt 2"));
// One loop, not two. The trace the panel folded while the request was running
// is the trace it keeps - so a run cannot be described one way in flight and
// another way once it lands. Two blocks here would mean the panel is rendering
// the live trace and the response's copy side by side.
check("the panel shows exactly one verify loop",
  await page.locator(".genloop").count() === 1, (await page.locator(".genloop").count()) + " loop(s)");
check("the streamed code reached the file",
  (await buf()).includes("fn st_stream_probe"), "probe present: " + (await buf()).includes("fn st_stream_probe"));

check("no native dialog was raised", native.length === 0, native.join(" | "));
check("no page errors", errs.length === 0, errs.join(" | "));

await ctx.close();
await browser.close();

const failed = results.filter((r) => !r).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
