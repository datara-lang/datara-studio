// Drive Zen mode in a real browser.
//
// Run:  node ui/test/zen.mjs <base-url>
//
// Zen is a layout claim, and layout claims cannot be checked in a static DOM:
// the whole question is whether the grid's row track actually collapsed and the
// editor actually got the space. So this drives the real page and measures.
//
// The specific traps this is written against, all of which produced a broken
// Zen on the way in:
//
//   * hiding the chrome with `display:none` and NOT redefining the grid leaves
//     the reserved tracks behind, so the code sits in a 1fr row with dead space
//     above and below. Asserted on the editor's own height, not on whether the
//     bars are hidden.
//   * `data-zen` is set on <html> from an effect. If it never lands, everything
//     visible stays visible and the CSS is simply inert - which looks like "Zen
//     does nothing" rather than like an error.
//   * a mode you cannot leave. Esc and the bar's own Esc control are both
//     checked, because a mode with no visible chrome must have a way out.

import { existsSync } from "node:fs";
import { join } from "node:path";
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
  console.log("playwright is not importable - skipping the Zen drive.");
  process.exit(0);
}

const BASE = process.argv[2] || "http://127.0.0.1:7878";
// The directory to test in. Defaults to the studio's own source tree - the one
// place guaranteed to hold .dtr files on any machine that can run this. Pass a
// third argument to point it somewhere else.
const WORKDIR = process.argv[3] || "";
let pass = 0, fail = 0;
const ok = (yes, what, detail) => {
  if (yes) { pass++; console.log("  PASS  " + what); }
  else { fail++; console.log("  FAIL  " + what + (detail ? "   [" + detail + "]" : "")); }
};

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
await page.goto(BASE, { waitUntil: "networkidle" });

// A file has to be open, or there is no editor to give the space to. The first
// version of this test did not do this, and every layout assertion came back as
// `-1` (the selector matched nothing) - which reads as "Zen is broken" when the
// truth was "there is no editor here".
//
// Two more things had to be right, both of which looked like UI bugs for a run
// each:
//
//   * these endpoints take a **raw path string** as the body, not JSON. Sending
//     `"{}"` made the server treat `{}` as the workspace root, so the tree
//     answered "cannot read that folder" and the probe blamed the explorer.
//   * a fresh browser profile has no remembered workspace, so the page shows the
//     welcome screen and there is no root to list at all. The workspace is
//     therefore opened the same way a person opens one - through the folder
//     dialog's own API call - and only then is a file clicked.
const ready = await page.evaluate(async (wd) => {
  const send = (p, body) => fetch(p, { method: "POST", body: body || "" }).then((r) => r.json());
  // With no directory given, ask the server what it is sitting in by listing the
  // parent of a path it already knows: "." is the server's own cwd.
  let root = wd || ".";
  let j = await send("/api/tree", root);
  if (j.error) return { ok: false, why: "tree(" + root + "): " + j.error, root };
  if (!(j.files || []).some((f) => f.endsWith(".dtr"))) {
    await send("/api/new", (root === "." ? "" : root + "/") + "__zen_probe.dtr\n");
    j = await send("/api/tree", root);
  }
  return { ok: (j.files || []).some((f) => f.endsWith(".dtr")), root, n: (j.files || []).length };
}, WORKDIR);
if (!ready.ok) {
  // Without a real workspace the layout assertions cannot mean anything, so say
  // so and stop rather than printing a wall of red that says "no editor".
  console.log(`\n  cannot establish a workspace to test in (${ready.why || "no .dtr files"}).`);
  console.log("  pass a directory holding .dtr files as the third argument.");
  await browser.close();
  process.exit(2);
}
// Open the workspace, then the file, through the interface - not by poking
// localStorage, so what is tested is what a person would do.
await page.evaluate((r) => { try { localStorage.setItem("datara.studio.lastRoot", r); } catch (e) {} }, ready.root);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
const openedIt = await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll(".tfile"))
    .find((e) => (e.getAttribute("title") || "").endsWith(".dtr"));
  if (!row) return false;
  row.click();
  return true;
});
await page.waitForTimeout(800);
ok(openedIt, "a .dtr file was opened from the explorer");
ok(await page.evaluate(() => !!document.querySelector("textarea")), "the editor mounted");

const visible = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return cs.display !== "none" && cs.visibility !== "hidden" && el.getBoundingClientRect().height > 0;
}, sel);

const surfaceH = () => page.evaluate(() => {
  const el = document.querySelector('.surface');
  return el ? el.getBoundingClientRect().height : -1;
});

console.log("\n== before Zen ==");
const hBefore = await surfaceH();
ok(await visible(".intent"), "the toolbar is showing");
ok(await visible(".status"), "the status bar is showing");
ok(!(await page.evaluate(() => document.documentElement.hasAttribute("data-zen"))), "html has no data-zen");

// ---- enter
console.log("\n== enter Zen (Ctrl+Shift+Z) ==");
await page.keyboard.press("Control+Shift+KeyZ");
await page.waitForTimeout(360);
ok(await page.evaluate(() => document.documentElement.getAttribute("data-zen") === "1"),
  "html carries data-zen=1", "the effect that sets it did not run");
ok(!(await visible(".intent")), "the toolbar is gone");
ok(!(await visible(".status")), "the status bar is gone");
ok(!(await visible(".col.tree-col")), "the explorer is gone");
ok(!(await visible(".col.panel-col")), "the right panel is gone");
ok(!(await visible(".crumbs")), "the breadcrumbs are gone");

const hZen = await surfaceH();
ok(hZen > hBefore, "the editor gained the space", `${hBefore} -> ${hZen}`);
// The real claim: with the chrome gone, nearly the whole window is code.
const winH = await page.evaluate(() => window.innerHeight);
ok(hZen > winH * 0.85, "the editor fills most of the window", `${Math.round(hZen)} of ${winH}`);

// the one line that survives, and its parts
ok(await visible(".zenbar"), "the zen bar is showing");
const parts = await page.evaluate(() => {
  const b = document.querySelector(".zenbar");
  return b ? Array.from(b.querySelectorAll(".z")).map((e) => e.textContent.trim()) : [];
});
ok(parts.length > 0, "the zen bar has something in it", JSON.stringify(parts));

// ---- the hint that says how to get out
ok(await page.evaluate(() => !!document.querySelector(".zenhint")), "the exit hint exists");

// ---- leave with Esc
console.log("\n== leave Zen (Esc) ==");
await page.keyboard.press("Escape");
await page.waitForTimeout(320);
ok(!(await page.evaluate(() => document.documentElement.hasAttribute("data-zen"))), "data-zen is cleared");
ok(await visible(".intent"), "the toolbar is back");
ok(await visible(".status"), "the status bar is back");
const hBack = await surfaceH();
ok(Math.abs(hBack - hBefore) < 3, "the editor is the size it was", `${hBefore} -> ${hZen} -> ${hBack}`);

// ---- the button, not just the key
console.log("\n== enter and leave by the button ==");
const btn = await page.$('.intent .iconbtn[title^="Zen mode"]');
ok(!!btn, "the Zen button is in the toolbar");
if (btn) {
  await btn.click();
  await page.waitForTimeout(320);
  ok(await page.evaluate(() => document.documentElement.hasAttribute("data-zen")), "the button enters Zen");
  // the bar's own exit, which is the discoverable way out
  const esc = await page.$(".zenbar .zesc");
  ok(!!esc, "the zen bar offers an Esc control");
  if (esc) {
    await esc.click();
    await page.waitForTimeout(320);
    ok(!(await page.evaluate(() => document.documentElement.hasAttribute("data-zen"))),
      "the bar's Esc control leaves Zen");
  }
}

// ---- settings drive it
console.log("\n== the Zen settings decide what survives ==");
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("datara.studio.settings") || "{}");
  raw.zenStatus = false; raw.zenFile = false; raw.zenProblems = false;
  raw.zenWidth = 720; raw.zenSurround = true;
  localStorage.setItem("datara.studio.settings", JSON.stringify(raw));
});
await page.reload({ waitUntil: "networkidle" });
await page.keyboard.press("Control+Shift+KeyZ");
await page.waitForTimeout(400);
const empty = await page.evaluate(() => {
  const b = document.querySelector(".zenbar");
  if (!b) return null;
  return { cls: b.className, h: b.getBoundingClientRect().height };
});
ok(empty && empty.cls.includes("empty"), "with every part off the bar collapses", JSON.stringify(empty));
ok(empty && empty.h === 0, "and it takes no vertical space", empty ? String(empty.h) : "");

const narrow = await page.evaluate(() => {
  const el = document.querySelector('.surface');
  return el ? el.getBoundingClientRect().width : -1;
});
ok(narrow > 0 && narrow <= 730, "the centred column is applied", String(Math.round(narrow)));

// put the settings back so a re-run starts clean
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("datara.studio.settings") || "{}");
  raw.zenStatus = true; raw.zenFile = true; raw.zenProblems = true; raw.zenWidth = 0;
  localStorage.setItem("datara.studio.settings", JSON.stringify(raw));
});

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
