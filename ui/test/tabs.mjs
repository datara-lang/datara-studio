// Drive the panel's tab strip: does every tab become reachable?
//
// Run:  node ui/test/tabs.mjs <base-url>
//
// This is the check that the PNG could not make. Before the fix the strip was
// 380px of tabs in a 264px box with a hidden scrollbar and no arrows, and
// selecting the last tab scrolled the first one out the LEFT edge of its own
// container. So the assertions here are about reachability, not appearance:
// every tab can be brought fully inside the panel's box, and none can be left
// outside it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
if (!pw) { console.log("playwright is not importable - skipping."); process.exit(0); }

const base = process.argv[2] || "http://127.0.0.1:7878";
const variant = process.argv[3] || "";

const ws = join(tmpdir(), "ds-tabs");
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "main.dtr"), "fn main() -> Int {\n    return 0\n}\n");
const wsPosix = ws.replace(/\\/g, "/");

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
};

const browser = await pw.chromium.launch();

/** Geometry of the strip and its tabs, in one call. */
const geometry = (page) => page.evaluate(() => {
  const strip = document.querySelector(".ptabs");
  if (!strip) return null;
  const sr = strip.getBoundingClientRect();
  const box = { l: sr.left, r: sr.right };
  return {
    box,
    over: strip.scrollWidth - strip.clientWidth,
    tabs: [...strip.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.textContent.trim(), l: Math.round(r.left), r: Math.round(r.right),
               on: b.classList.contains("on") };
    }),
  };
});

/** Everything a tab needs to be usable: fully inside the strip, on screen. */
const problems = (g, width) =>
  g.tabs.filter((t) => t.l < g.box.l - 1 || t.r > Math.min(g.box.r, width) + 1)
       .map((t) => `${t.label} ${t.l}..${t.r} vs strip ${Math.round(g.box.l)}..${Math.round(g.box.r)}`);

for (const [size, w, h] of [["1440x900", 1440, 900]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((r) => {
    localStorage.setItem("datara.studio.root", r);
    localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
    localStorage.removeItem("datara.studio.settings");
  }, wsPosix);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(base + variant, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2800);

  console.log(`\n${size}${variant || ""}`);
  let g = await geometry(page);
  if (!g) { check("the tab strip exists", false); await ctx.close(); continue; }

  const n = g.tabs.length;
  check("the strip exists", true, `${n} tabs`);
  const overflow = g.over > 1;

  // The arrows have to be there exactly when the row does not fit. An affordance
  // that is always present is clutter; one that is missing when the row overflows
  // is the bug this whole change exists to fix.
  const arrows = await page.locator(".pscroll .tabnav").count();
  check(overflow ? "arrows appear when the row overflows" : "no arrows when the row fits",
    overflow ? arrows === 2 : arrows === 0, `overflow ${g.over}px, ${arrows} arrows`);

  // The first tab must not be pushed outside the strip's own left edge ON LOAD.
  //
  // This is the exact regression: `Problems` sat at x 1066 with the strip
  // starting at 1176, i.e. dragged out sideways over the code column, because
  // the auto-scroll to the selected tab ran to an unclamped offset. On load the
  // strip must be at rest, showing the beginning of the row.
  const shoved = g.tabs.filter((t) => t.l < g.box.l - 1);
  check("no tab is pushed off the left edge on load", shoved.length === 0,
    shoved.map((t) => `${t.label} at ${t.l}`).join(", ") || "row starts inside the panel");
  check("the row starts at scrollLeft 0",
    await page.evaluate(() => document.querySelector(".ptabs").scrollLeft) === 0);

  // Reachability, not blind visibility: a six-tab row in a 264px panel cannot
  // show every tab at once, and showing every tab at once is what wrapping used
  // to do badly. The claim is the weaker one the design actually makes - every
  // tab, on its own click, is brought fully inside the strip. Tabs scrolled past
  // are meant to be past.
  let unreachable = null;
  let leaked = null;
  const labels = g.tabs.map((t) => t.label);
  for (let i = 0; i < labels.length; i++) {
    await page.locator(".ptabs button").nth(i).click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(460);
    const gg = await geometry(page);
    const sel = gg.tabs.find((t) => t.on);
    if (!sel) { unreachable = `after clicking #${i} (${labels[i]}) nothing is selected`; break; }
    if (sel.l < gg.box.l - 1 || sel.r > gg.box.r + 1) {
      unreachable = `after clicking "${labels[i]}" the selected tab sits at ${sel.l}..${sel.r}, ` +
        `outside the strip ${Math.round(gg.box.l)}..${Math.round(gg.box.r)}`;
      break;
    }
    // And nothing may be left painted outside the container.
    //
    // Comparing rects would be wrong here, and this assertion got it wrong the
    // first time: a scroll container does not change a child's reported rect, so
    // a tab scrolled past the left edge still reports l < strip.l while being
    // clipped perfectly well. Verified against a screenshot at full scroll -
    // `Project` is cut mid-word at the panel edge, which is clipping, not
    // overflow. So the check is whether hiding is actually in effect, and
    // whether the strip's own box keeps its parent's bounds.
    const clip = await page.evaluate(() => {
      const s = document.querySelector(".ptabs");
      const cs = getComputedStyle(s);
      const sr = s.getBoundingClientRect();
      const pr = s.parentElement.getBoundingClientRect();
      return {
        clipsX: cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowX === "hidden",
        insideParent: sr.left >= pr.left - 1 && sr.right <= pr.right + 1,
        parent: { l: Math.round(pr.left), r: Math.round(pr.right) },
        strip: { l: Math.round(sr.left), r: Math.round(sr.right) },
      };
    });
    if (!clip.clipsX || !clip.insideParent) {
      leaked = `after clicking "${labels[i]}": clips=${clip.clipsX}, ` +
        `strip ${clip.strip.l}..${clip.strip.r} vs parent ${clip.parent.l}..${clip.parent.r}`;
    }
  }
  check("every tab scrolls fully into view when clicked", !unreachable, unreachable || `${labels.length} tabs reachable`);
  check("no tab is ever painted outside the panel", !leaked, leaked || "all within the strip box");

  // And the arrows themselves must move the row.
  if (overflow) {
    await page.locator(".ptabs button").first().click();
    await page.waitForTimeout(460);
    const before = await page.evaluate(() => document.querySelector(".ptabs").scrollLeft);
    await page.locator(".pscroll .tabnav").nth(1).click();
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.querySelector(".ptabs").scrollLeft);
    check("the right arrow scrolls the row", after > before, `${before} -> ${after}`);
    await page.locator(".pscroll .tabnav").nth(0).click();
    await page.waitForTimeout(600);
    const back = await page.evaluate(() => document.querySelector(".ptabs").scrollLeft);
    check("the left arrow scrolls back", back < after, `${after} -> ${back}`);
  }

  check("no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

// The core build must not contain the AI tabs at all - not hidden, absent.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((r) => {
    localStorage.setItem("datara.studio.root", r);
    localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
    localStorage.removeItem("datara.studio.settings");
    localStorage.removeItem("datara.studio.panelOrder");
  }, wsPosix);
  const page = await ctx.newPage();
  await page.goto(base + "?core=1", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2800);
  console.log("\ncore build (no companion)");
  const g = await geometry(page);
  const labels = g ? g.tabs.map((t) => t.label) : [];
  check("no AI tab in the strip", !labels.includes("AI"), labels.join(", "));
  check("no Generate tab in the strip", !labels.includes("Generate"), labels.join(", "));
  // Chat is the third AI tab, so it has to be stripped by the same list rather
  // than by a rule of its own - which is why AI_TABS is a list and not a flag.
  check("no Chat tab in the strip", !labels.includes("Chat"), labels.join(", "));
  check("the four compiler tabs are there",
    ["Issues", "Symbols", "Project", "Layout"].every((l) => labels.includes(l)), labels.join(", "));
  const plug = await page.locator(".aistat").count();
  check("the companion plug is not in the bar", plug === 0, `${plug} found`);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
