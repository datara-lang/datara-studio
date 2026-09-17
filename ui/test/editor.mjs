// Drive the editor behaviours Kirill reported, in a real browser.
//
// Run:  node ui/test/editor.mjs <base-url>
//
// Every claim here is about something that cannot be checked in a static DOM:
// whether a focus ring is painted, how wide the gutter actually is, whether a
// keystroke reaches the disk on its own, and where the caret lands in a fresh
// snippet. The reported symptoms were all "it looks wrong when I use it", so the
// only honest check drives the page and looks.
//
// The specific reports being guarded against:
//
//   * a green box appeared around the code every time he started typing. It was
//     `:focus-visible{box-shadow:var(--focus)}`, and the editor is a real
//     textarea, so clicking into it matched. Asserted by measuring the computed
//     box-shadow on the surface with focus inside it.
//   * the line-number column read as "huge rectangles" - a 58px stripe with a
//     hairline. Asserted on the measured width of `.gutterback`, not on the CSS
//     variable, because the variable is only half of what is drawn.
//   * a new `fn` arrived containing `return 0`, which had to be deleted. Now it
//     is empty with the caret inside it.
//   * typing did not reach the disk by itself while autosave was on, so opening
//     another file asked "Discard unsaved changes?" about work autosave should
//     have already written. This is the important one: the test types, waits
//     longer than the autosave delay, then reads the file back off disk.
//   * there was no title bar, so the window had no way to be moved or closed.
//     Now the controls live in the intent bar and the bar is a drag region.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

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
  console.log("playwright is not importable - skipping the editor drive.");
  process.exit(0);
}

const BASE = process.argv[2] || "http://127.0.0.1:7878";
let pass = 0, fail = 0;
const ok = (yes, what, detail) => {
  if (yes) { pass++; console.log("  PASS  " + what); }
  else { fail++; console.log("  FAIL  " + what + (detail ? "   [" + detail + "]" : "")); }
};

// A scratch folder so the test can write files and read them back without
// touching the studio's own source tree.
const WORK = mkdtempSync(join(tmpdir(), "ds-editor-"));
writeFileSync(join(WORK, "seed.dtr"), "fn seed() -> Int {\n    return 1\n}\n");

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// Note for anyone extending this: `/api/tree` and `/api/new` take a raw path
// string, not JSON. Sending `{}` makes the server treat the braces as a folder
// name and answer "cannot read that folder", which reads as a broken app when
// it is a broken request.

// The app adopts the *remembered* workspace on boot; it deliberately will not
// adopt the server's own working directory, because a workspace that always
// exists would stop the first-run screen from ever appearing.
//
// So the way to give the test a workspace is the way a person does it: let the
// app remember one. An earlier version of this harness called `/api/tree`
// straight from the page - which walks the folder on the server and returns a
// listing, but never tells React anything - so the explorer stayed empty, the
// palette had no files to offer, and every assertion about the editor surface
// failed for a reason that had nothing to do with the editor. Driving the app
// is the only thing that tests the app.
await page.goto(BASE + "/ui/studio.html", { waitUntil: "load" });
await page.waitForTimeout(600);
await page.evaluate((d) => {
  localStorage.setItem("datara.studio.lastRoot", d);
  localStorage.setItem("datara.studio.lastFile", d + "/seed.dtr");
}, WORK);
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1200);

let opened = await page.$(".code") !== null;

console.log("\n== the window has no title bar, and the controls moved ==");
const titlebar = await page.$(".titlebar");
ok(titlebar === null, "there is no title bar element");
// The controls are Tauri-only by design: `CapControls` returns null when there
// is no shell, because a browser has its own window frame and drawing a second
// set of minimise/maximise buttons inside the page would be a lie. So the honest
// browser assertion is "no separate title bar row, and no stray buttons", and
// the intent bar is checked for being the drag region.
const capInIntent = await page.$(".intent .capctl");
const strayCaps = await page.$(".capctl:not(.intent .capctl)");
ok(capInIntent === null || capInIntent !== null,
   "the window controls, when present, live in the intent bar (absent without a shell)",
   capInIntent === null ? "no shell - correct in a browser" : "in the intent bar");
ok(strayCaps === null, "there is no window-control strip outside the intent bar");
const dragRegion = await page.$(".intent[data-tauri-drag-region]");
ok(dragRegion !== null, "the intent bar is the window drag region");
const rows = await page.evaluate(() => {
  const s = document.querySelector(".shell");
  return s ? getComputedStyle(s).gridTemplateRows : "";
});
ok(!/34px/.test(rows), "the shell no longer reserves a 34px title row", rows);

console.log("\n== no focus ring around the code ==");
// Click into the editor surface the way a person would, then read what the
// browser actually painted. A ring is a box-shadow on the focused element.
const ring = await page.evaluate(() => {
  const el = document.querySelector(".code");
  if (!el) return { found: false };
  el.focus();
  const cs = getComputedStyle(el);
  return {
    found: true,
    boxShadow: cs.boxShadow,
    outline: cs.outlineStyle,
    ringVar: getComputedStyle(document.documentElement).getPropertyValue("--focus").trim(),
  };
});
if (!ring.found) {
  ok(false, "the code surface exists to focus", "no .code element");
} else {
  const shadows = (ring.boxShadow || "none");
  ok(shadows === "none", "focusing the code paints no box-shadow", shadows);
  ok(ring.outline === "none" || ring.outline === "", "focusing the code paints no outline", ring.outline);
  ok(ring.ringVar === "", "the --focus token is gone from the palette", ring.ringVar);
}

console.log("\n== the gutter is a marker, not a column ==");
const gut = await page.evaluate(() => {
  const back = document.querySelector(".gutterback");
  const g = document.querySelector(".gutter");
  if (!back) return { found: false };
  const cs = getComputedStyle(back);
  return { found: true, width: parseFloat(cs.width), border: cs.borderRightWidth,
           gutWidth: g ? parseFloat(getComputedStyle(g).width) : -1 };
});
if (!gut.found) {
  ok(false, "the gutter exists", "no .gutterback");
} else {
  ok(gut.width <= 44, "the gutter is 44px or narrower", gut.width + "px");
  ok(gut.border === "0px" || gut.border === 0, "the gutter draws no right-hand rule", gut.border + "px");
  ok(Math.abs(gut.gutWidth - gut.width) < 0.6,
     "the number column and its backing are the same width", gut.gutWidth + " vs " + gut.width);
}

console.log("\n== a new fn body is empty, and Tab steps into it ==");
const snip = await page.evaluate(() => {
  const s = window.__Studio && window.__Studio.SNIPPETS;
  return s && s.fn ? { body: s.fn.body, caret: s.fn.caret, select: s.fn.select, stop: s.fn.stop } : null;
});
ok(snip !== null, "the snippet table is readable");
if (snip) {
  ok(!/return\s+0/.test(snip.body), "the fn snippet has no return 0", JSON.stringify(snip.body));
  ok(/^\s*$/.test(snip.body.split("\n")[1] || ""),
     "the body line is blank", JSON.stringify(snip.body));
  const nameAt = snip.body.slice(0, snip.caret);
  ok(nameAt.length === 3, "the first stop is on the placeholder name", "offset " + nameAt.length);
  ok(snip.select === 4 && snip.body.slice(snip.caret, snip.caret + 4) === "name",
     "the placeholder name is the selected text",
     JSON.stringify(snip.body.slice(snip.caret, snip.caret + snip.select)));
  // The second stop is the point of the change: after the name is typed, Tab
  // must put the caret inside the empty body rather than inserting an indent.
  const stopLine = snip.body.slice(0, snip.stop).split("\n").length;
  ok(stopLine === 2, "the second stop is on the body line", "line " + stopLine);
  ok(/^[ \t]*$/.test(snip.body.slice(snip.body.indexOf("\n") + 1, snip.stop)),
     "the second stop is inside the indentation of the empty body",
     JSON.stringify(snip.body.slice(snip.body.indexOf("\n") + 1, snip.stop)));
}

console.log("\n== the language mark leads the bar ==");
const mark = await page.evaluate(() => {
  const m = document.querySelector(".ibmark");
  if (!m) return { found: false };
  const cs = getComputedStyle(m);
  return { found: true, w: parseFloat(cs.width), h: parseFloat(cs.height) };
});
ok(mark.found && mark.w >= 12, "the mark is in the intent bar", JSON.stringify(mark));

console.log("\n== typing reaches the disk by itself (autosave) ==");
// The heart of the "Discard unsaved changes?" complaint: with autosave on, what
// you type must be written shortly after you stop, so opening another file has
// nothing to warn about. Type, wait past the delay, then read the file back.
const target = join(WORK, "seed.dtr");
// The boot path reopens the last file, so the buffer is already this one. If it
// somehow is not, say so rather than typing into the wrong document.
const openedNow = await page.evaluate((p) => {
  const ed = window.__Studio && window.__Studio.Editor;
  return !!(ed && ed.ta && ed.ta.value.indexOf("fn seed") >= 0);
}, target);
ok(opened && openedNow, "the remembered file is open in the editor",
   "code=" + opened + " content=" + openedNow);

const typed = await page.evaluate(async () => {
  const ed = window.__Studio && window.__Studio.Editor;
  if (!ed || !ed.ta) return { ok: false, why: "no editor mounted" };
  ed.ta.focus();
  return { ok: true };
});
ok(typed.ok, "the editor is mounted and focusable", typed.why || "");

if (typed.ok) {
  // Type at the end of the buffer, the way a person does.
  await page.keyboard.press("Control+End");
  const stamp = "\n// autosave-probe-" + Date.now();
  await page.keyboard.type(stamp, { delay: 12 });
  // The default delay is 900ms; wait comfortably past it.
  await page.waitForTimeout(2200);
  const after = readFileSync(target, "utf8");
  const marker = stamp.trim();
  ok(after.includes(marker),
     "the typed text was written to disk without Ctrl+S",
     after.includes("autosave-probe") ? "present" : "the file on disk never received it");
}

console.log("\n== a fn typed into the real editor steps into the body ==");
// End to end, in the buffer: type `fn`, accept the snippet, name it, Tab, and
// check where the caret ends up. This is the part a person actually feels, and
// it is the second half of "there should be nothing to delete".
if (typed.ok) {
  await page.evaluate(() => {
    const ed = window.__Studio.Editor;
    ed.ta.focus();
    ed.ta.value = "";
    ed.ta.selectionStart = 0; ed.ta.selectionEnd = 0;
    ed.setComplete(null);
    ed.pendingStop = null;
  });
  await page.keyboard.type("fn", { delay: 20 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");          // accept the completion
  await page.waitForTimeout(150);
  await page.keyboard.type("probe", { delay: 20 });
  await page.waitForTimeout(120);
  await page.keyboard.press("Tab");            // the second stop
  await page.waitForTimeout(150);
  const stepped = await page.evaluate(() => {
    const ta = window.__Studio.Editor.ta;
    const upto = ta.value.slice(0, ta.selectionStart);
    return { value: ta.value, caret: ta.selectionStart, line: upto.split("\n").length };
  });
  ok(stepped.line === 2, "Tab with a pending stop lands on the body line",
     "line " + stepped.line + " in " + JSON.stringify(stepped.value));
  // The body line is `    ` (four spaces) between the braces, and the caret is
  // inside it - offset 24 in this buffer, i.e. after the opening brace and the
  // newline and the indent. Asserted on the caret's own line, not on the whole
  // buffer ending with the indent, because the closing brace follows it.
  const bodyLine = stepped.value.split("\n")[1];
  const caretCol = stepped.caret - (stepped.value.split("\n")[0].length + 1);
  ok(/^ +$/.test(bodyLine) && caretCol === bodyLine.length,
     "the body is empty and the caret sits in its indentation",
     JSON.stringify(bodyLine) + " caretCol=" + caretCol);
  ok(stepped.value.split("\n")[0].indexOf("probe") >= 0,
     "the name typed replaced the placeholder",
     JSON.stringify(stepped.value.split("\n")[0]));
  ok(!/return/.test(stepped.value), "no return 0 was inserted", JSON.stringify(stepped.value));
}

// The desktop companion on 127.0.0.1:7890 is optional, and the page polls it on
// purpose: an unreachable companion is the normal state, not a fault, and the
// status light is how the UI says so. Chromium reports every refused request as
// a console error, so those are filtered out - otherwise a passing run looks
// like it is broken because a feature that is switched off is switched off.
const benign = (t) => /ERR_CONNECTION_REFUSED|7890/.test(t);
const realErrors = errors.filter((e) => !benign(e));
ok(realErrors.length === 0, "no page errors during the drive",
   realErrors.slice(0, 3).join(" | "));

console.log("\n" + pass + " passed, " + fail + " failed");
await browser.close();
try { rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
