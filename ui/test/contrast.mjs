// Contrast: does any text in the interface sit too close to the surface behind
// it?
//
// Why this is a browser test and not a CSS review: the failure it looks for is
// invisible in the stylesheet. Every panel here sets its own `color`, and the
// ones that forget inherit `var(--ink1)` from `html,body` - so a rule that is
// simply absent produces black text on a dark panel, and nothing in the source
// says so. It has to be measured off the rendered element, with the background
// resolved by walking up until something is actually painted.
//
// Run:  PLAYWRIGHT_ROOT=<dir> PLAYWRIGHT_BROWSERS_PATH=<dir> \
//         node ui/test/contrast.mjs <base-url>
//
// Exit: 0 nothing is unreadable, 1 something is.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) {}
  const roots = [];
  if (process.env.PLAYWRIGHT_ROOT) roots.push(process.env.PLAYWRIGHT_ROOT);
  const appdata = process.env.APPDATA || "";
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
  console.log("playwright is not importable - skipping the contrast check.");
  process.exit(0);
}

const BASE = process.argv[2] || "http://127.0.0.1:7878";
// Anything under this is reported. WCAG asks for 4.5 for body text and 3 for
// large text; the bar here is deliberately far lower - this is not a style
// opinion, it is the floor below which text cannot be read at all, and the bug
// it exists to catch lands around 1.1.
const FLOOR = 2.0;

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

/** Measure every visible text node, with its colour and its painted background.
 *
 * Done in the page, because only the page can resolve `getComputedStyle` and
 * walk the ancestors. Returns one row per element that has text of its own.
 */
const MEASURE = `(() => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(",").map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const painted = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return parseFloat(style.opacity) >= 0.1;
  };
  const rows = [];
  const push = (el, text) => {
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    if (!fg) return;
    // A fully transparent colour is not unreadable text, it is an input layer
    // that deliberately paints nothing. The editor's own textarea is exactly
    // that: it sits under the highlighting layer with a transparent colour, and
    // the layer above carries the visible glyphs. Reporting it would be
    // reporting the architecture, not a defect.
    if (fg.a < 0.05) return;
    const bg = painted(el);
    // Blend the text's own alpha over the background before comparing.
    const solid = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    rows.push({
      path: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : ""),
      text: text.slice(0, 40),
      color: style.color,
      background: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
      ratio: Math.round(ratio(solid, bg) * 100) / 100,
    });
  };

  for (const el of document.querySelectorAll("body *")) {
    // Only elements holding text directly, so a container is not reported for
    // its children's problem and the same string is not counted twice.
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (!own) continue;
    if (!visible(el)) continue;
    push(el, own);
  }

  // Form controls hold their text in a value rather than in a child node, so the
  // walk above cannot see them at all - and a textarea is the worst case: it does
  // not inherit its colour, its user-agent default is fieldtext, and with no
  // colour scheme declared that resolves to black. The chat box measured at
  // 1.05:1 against its own background, and this checker reported a clean bill of
  // health for it because it was never asked the question.
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (!visible(el)) continue;
    push(el, "value: " + (el.value || el.placeholder || ""));
  }

  return rows;
})()`;

const tabs = ["Chat", "Generate", "AI", "Problems", "Project"];
const all = [];

/** Click a panel tab by its label, the way a person does. */
const openTab = async (label) => page.evaluate((wanted) => {
  const hit = [...document.querySelectorAll(".ptabs button")]
    .find((el) => (el.childNodes[0] && el.childNodes[0].textContent || "").trim() === wanted);
  if (!hit) return false;
  hit.click();
  return true;
}, label);

/** Measure the panel currently on screen, tagged with its tab. */
const measure = async (label) => {
  const rows = await page.evaluate(MEASURE);
  for (const row of rows) all.push({ tab: label, ...row });
  return rows.length;
};

// A cold transcript, so what is measured is this run's messages and not a
// conversation left in localStorage by a previous one. Two passes because the
// transcript is read during the first render - clearing and reloading once still
// boots from the copy React already holds.
await page.goto(BASE + "/ui/studio.html", { waitUntil: "load" });
await page.evaluate(() => {
  try {
    localStorage.removeItem("datara.studio.chat");
    localStorage.removeItem("datara.studio.settings");
  } catch (e) {}
});
await page.reload({ waitUntil: "load" });
await page.evaluate(() => { try { localStorage.removeItem("datara.studio.chat"); } catch (e) {} });
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1200);

// The empty panels first: a tab that is wrong before anyone has said anything is
// a different bug from a message bubble that is wrong.
for (const tab of tabs) {
  if (await openTab(tab)) { await page.waitForTimeout(300); await measure(tab + " (empty)"); }
}

// Then with content, which is where the message classes exist at all.
//
// `.mtext` and `.ins` are only in the DOM once a message has rendered, and a
// contrast check that never sends one measures the empty state and reports a
// clean bill of health for a surface it never looked at. That is the failure
// mode this whole file is written against, so the conversation is part of the
// test and not a manual step.
const companion = process.env.COMPANION || "http://127.0.0.1:7890";
let companionUp = false;
try {
  const r = await fetch(companion + "/health");
  companionUp = r.ok;
} catch (e) { companionUp = false; }

if (companionUp) {
  if (await openTab("Chat")) {
    await page.waitForTimeout(400);
    await page.fill(".chatfield", "what does this project do?");
    await page.click(".chat .composer .mini");
    // No completion signal to await, so this is a fixed wait - the same one
    // ui/test/chat.mjs uses, and for the same reason.
    await page.waitForTimeout(6000);
    await measure("Chat (answered)");
  }
  if (await openTab("Generate")) {
    await page.waitForTimeout(400);
    const field = await page.$(".panel input, .panel textarea");
    if (field) {
      await field.fill("write a function that adds two numbers");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(6000);
      await measure("Generate (answered)");
    }
  }
} else {
  console.log("companion not reachable - measuring the empty panels only");
}

await browser.close();

const bad = all.filter((r) => r.ratio < FLOOR);
console.log(`contrast: ${all.length} text elements measured across ${tabs.length} panels, ${bad.length} below ${FLOOR}:1`);
for (const r of bad) {
  console.log(`  ${String(r.ratio).padStart(6)}:1  [${r.tab}] ${r.path}`);
  console.log(`            text "${r.text}"  ${r.color} on ${r.background}`);
}

// The lowest few are printed even when nothing fails, so a regression that
// stops just short of the floor is still visible in the output.
if (!bad.length) {
  const worst = all.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 5);
  console.log("lowest ratios:");
  for (const r of worst) console.log(`  ${String(r.ratio).padStart(6)}:1  [${r.tab}] ${r.path}  "${r.text}"`);
  console.log("contrast OK");
}
process.exit(bad.length ? 1 : 0);
