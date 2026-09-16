// Shoot the interface, so a human can look at it.
//
// Run:  node ui/test/shoot.mjs <base-url> <out-dir>
//
// Why this exists: every other test in this directory verifies *structure*.
// A DOM without layout cannot catch a layout bug, so the README has always had
// to say "the visual result has never been seen by the author of this code".
// That was true and it was a hole. Playwright with Chromium is available on this
// machine, so the hole can be closed: this drives the real page in a real engine
// at a real viewport and writes PNGs.
//
// It needs `playwright` importable. It is not a project dependency - the studio
// ships no npm packages - so this is a development tool, and it says so and
// exits rather than pretending to pass when playwright is missing.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Finding playwright.
//
// The obvious answer, NODE_PATH, does not work: it is a CommonJS mechanism and
// Node's ESM resolver ignores it, so `import("playwright")` keeps failing no
// matter what NODE_PATH says. (That cost one debugging round - the harness
// reported "not importable" while the package sat exactly where it was told to
// look.) The path therefore has to be handed over explicitly, either as
// PLAYWRIGHT_ROOT or by probing the usual global roots.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (e) {}

  const roots = [];
  if (process.env.PLAYWRIGHT_ROOT) roots.push(process.env.PLAYWRIGHT_ROOT);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
  if (appdata) roots.push(join(appdata, "npm", "node_modules"));
  try {
    const { execSync } = await import("node:child_process");
    const r = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (r) roots.push(r);
  } catch (e) {}

  let last = null;
  for (const root of roots) {
    for (const entry of ["index.mjs", "index.js"]) {
      const file = join(root, "playwright", entry);
      if (!existsSync(file)) continue;
      try {
        return await import(pathToFileURL(file).href);
      } catch (e) {
        last = e;
      }
    }
  }
  if (last) console.log("playwright was found but failed to load: " + last.message);
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.log("playwright is not importable - skipping the screenshots.");
  console.log("  point the harness at it, e.g.");
  console.log("  PLAYWRIGHT_ROOT=\"C:/Users/<you>/AppData/Roaming/npm/node_modules\" \\");
  console.log("    PLAYWRIGHT_BROWSERS_PATH=\"C:/Users/<you>/AppData/Local/ms-playwright\" \\");
  console.log("    node ui/test/shoot.mjs http://127.0.0.1:7878 shots");
  process.exit(0);
}
const { chromium } = pw;

const base = process.argv[2] || "http://127.0.0.1:7878";
const out = process.argv[3] || "shots";
mkdirSync(out, { recursive: true });

const errors = [];
const browser = await chromium.launch();

/** A fresh page with the given localStorage seed. */
async function pageWith(seed, arg) {
  const ctx = await browser.newContext({
    viewport: { width: 1500, height: 940 },
    deviceScaleFactor: 2,
  });
  // addInitScript calls the function with the `arg` you hand it - and with
  // `undefined` if you hand it nothing. A seed written as `([r, f]) => ...`
  // therefore throws "undefined is not iterable" before the page even boots,
  // which silently leaves localStorage empty and makes every shot look like a
  // cold boot. Pass the argument explicitly.
  if (seed) await ctx.addInitScript(seed, arg);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text().slice(0, 300));
  });
  return { ctx, page };
}

async function shoot(name, seed, arg, act, clip) {
  const { ctx, page } = await pageWith(seed, arg);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  // the wasm core loads asynchronously and the boot effect polls the server
  await page.waitForTimeout(2500);
  if (act) await act(page);
  const file = join(out, name + ".png");
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log("  wrote " + file);
  await ctx.close();
}

// 1. Cold boot: the title screen, with nothing remembered.
await shoot("01-title", () => {
  try { localStorage.clear(); } catch (e) {}
}, null);

// 2. A real workspace open, with a Datara file in the editor - this is the one
//    that shows the .dtr mark, the gutter and the absence of a current-line
//    band.
const root = "D:/IDE datara/ryan-harness";
const open = "D:/IDE datara/ryan-harness/src/main.dtr";
await shoot("02-workspace", ([r, f]) => {
  try {
    localStorage.setItem("datara.studio.lastRoot", r);
    localStorage.setItem("datara.studio.lastFile", f);
  } catch (e) {}
}, [root, open], async (page) => {
  await page.waitForTimeout(2000);
});

// 3. The right panel, on the Generate tab, with a companion result - if the
//    companion is up this exercises the real network path.
await shoot("03-panel", ([r, f]) => {
  try {
    localStorage.setItem("datara.studio.lastRoot", r);
    localStorage.setItem("datara.studio.lastFile", f);
    localStorage.setItem("datara.studio.settings", JSON.stringify({ panelTab: "gen" }));
  } catch (e) {}
}, [root, open], async (page) => {
  await page.waitForTimeout(1500);
});

// 4. The far left at 2x, because "there is no clean corner on the left and it
//    is inconvenient" is a complaint about a specific 40 pixels.
const leftSeed = () => {
  try {
    localStorage.setItem("datara.studio.lastRoot", "D:/IDE datara/ryan-harness");
  } catch (e) {}
};
await shoot("04-left-corner", leftSeed, null, null, { x: 0, y: 0, width: 340, height: 240 });
await shoot("05-topbar", leftSeed, null, null, { x: 0, y: 0, width: 1500, height: 34 });

await browser.close();

console.log("");
if (errors.length) {
  console.log(errors.length + " browser error(s):");
  for (const e of errors.slice(0, 12)) console.log("  " + e);
  process.exit(1);
}
console.log("no browser errors, no page exceptions");
