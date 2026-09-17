// Measure the interface in a real engine, instead of looking at a PNG.
//
// Run:  node ui/test/measure.mjs <base-url>
//
// Why this exists next to shoot.mjs: a screenshot tells you something looks
// cramped, and then you are reduced to guessing which rule is responsible. This
// prints the numbers - computed colour, font size and family, and the box
// geometry of the regions that are most often wrong. Every value it reports is
// one that has already been wrong at least once in this project.
//
// It is deliberately read-only: it opens the page, seeds a workspace, reads and
// exits. Nothing it prints is a test that can fail, so it is a tool rather than
// part of the suite. The checks that guard these values live in render.test.mjs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) {}
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
  for (const root of roots) {
    for (const entry of ["index.mjs", "index.js"]) {
      const file = join(root, "playwright", entry);
      if (!existsSync(file)) continue;
      try { return await import(pathToFileURL(file).href); } catch (e) {}
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.log("playwright is not importable - cannot measure.");
  process.exit(0);
}

const base = process.argv[2] || "http://127.0.0.1:7878";

// A scratch workspace with one Datara file, so the editor path is the real one.
const ws = join(tmpdir(), "ds-measure");
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "main.dtr"), "use cli\n\nfn main() -> Int {\n    return 0\n}\n");
const wsPosix = ws.replace(/\\/g, "/");

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript((r) => {
  localStorage.setItem("datara.studio.root", r);
  localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
  localStorage.setItem("datara.studio.panelW", "264");
  localStorage.setItem("datara.studio.treeW", "232");
}, wsPosix);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

/** Computed style + box for one selector. */
async function probe(label, selector) {
  const r = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return {
      box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      fs: cs.fontSize, ff: cs.fontFamily.split(",")[0].replace(/"/g, ""),
      fw: cs.fontWeight, color: cs.color, bg: cs.backgroundColor,
      lh: cs.lineHeight, ls: cs.letterSpacing,
      over: el.scrollWidth > el.clientWidth ? (el.scrollWidth - el.clientWidth) : 0,
      sw: el.scrollWidth, cw: el.clientWidth,
    };
  }, selector);
  if (!r) { console.log(`${label.padEnd(26)} ABSENT  ${selector}`); return null; }
  const [x, y, w, h] = r.box;
  console.log(
    `${label.padEnd(26)} ${String(x).padStart(5)},${String(y).padStart(4)} ` +
    `${String(w).padStart(4)}x${String(h).padStart(3)}  ${r.fs.padStart(7)} ` +
    `${r.ff.padEnd(12)} w${r.fw}  ${r.color.padEnd(18)} ${r.bg}` +
    (r.over ? `  OVERFLOW +${r.over}px (sw ${r.sw} cw ${r.cw})` : "")
  );
  return r;
}

console.log(`\nviewport 1440x900, workspace ${wsPosix}\n`);
console.log("region".padEnd(26) + "  x,y      wxh    size     family       weight  ink                fill");

await probe("shell", ".shell");
await probe("titlebar row", ".shell > *:first-child");
await probe("body", ".body");
await probe("tree col", ".col.tree-col");
await probe("panel col", ".col.panel-col");
await probe("editor col", ".col.edit-col");
await probe("statusbar", ".shell > *:last-child");
console.log("");
await probe("panel", ".panel");
await probe("ptab strip", ".ptabs");
await probe("ptab button.on", ".ptabs button.on");
await probe("ptab last button", ".ptabs button:last-child");
await probe("pbody", ".pbody");
await probe("card", ".card");
await probe("card ch b", ".card .ch b");
await probe("card pre", ".card pre");
console.log("");
await probe("tree", ".tree");
await probe("tree hd lbl", ".tree .hd .lbl");
await probe("filter input", ".tree .filter");
await probe("tree row", ".tree .row");
await probe("tree row name", ".tree .row .nm");
console.log("");
await probe("gutter", ".gut, .gutter, .rail");
await probe("code layer", ".code");
await probe("textarea", "textarea");

// Every tab that the strip is meant to show, and whether it fits.
const tabs = await page.evaluate(() => {
  const strip = document.querySelector(".ptabs");
  if (!strip) return null;
  const all = [...strip.querySelectorAll("button")].map((b) => {
    const r = b.getBoundingClientRect();
    return { label: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right) };
  });
  const sr = strip.getBoundingClientRect();
  return { stripLeft: Math.round(sr.left), stripRight: Math.round(sr.right), scrollW: strip.scrollWidth, clientW: strip.clientWidth, all };
});
if (tabs) {
  console.log("\npanel tabs");
  console.log(`  strip x ${tabs.stripLeft}..${tabs.stripRight}  scrollWidth ${tabs.scrollW}  clientWidth ${tabs.clientW}`);
  for (const t of tabs.all) {
    const cut = t.right > tabs.stripRight;
    console.log(`  ${cut ? "CUT " : "    "} ${t.label.padEnd(10)} ${t.left}..${t.right}`);
  }
}

if (errors.length) {
  console.log("\npage errors");
  for (const e of errors) console.log("  " + e);
}
await browser.close();
