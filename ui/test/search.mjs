// Does "find this name everywhere in the project" actually mean everywhere, and
// only this name?
//
// Run:  PLAYWRIGHT_ROOT=... node ui/test/search.mjs <base-url>
//
// Why this exists. The server has always been able to grep the workspace, but
// the only way in was Alt+F7 on the word under the caret, and the answer to
// "where is this variable used" was every line that *contains* those letters.
// Searching `store` and being handed `store_id` and `storehouse` is how a
// reference list stops being read: the two or three real hits are buried in
// near-misses that look right.
//
// So the fixture is built around exactly that confusion. `main.dtr` has `store`
// as a name of its own; `stock.dtr` has `store_id` and `storehouse`, which
// contain it and are not it. The whole-word switch has to separate them, and
// the counts on both sides are fixed and known - 2 with it on, 5 with it off -
// which is what makes this measurable rather than a matter of opinion.
//
// The geometry check is here for the same reason. `.field` is `width:100%` with
// its own margin because it is normally alone in its card; put it in a flex row
// next to a button and the button is pushed out of the panel. A layout that
// clips its own control still passes every assertion about behaviour.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  console.log("playwright is not importable - skipping the search drive.");
  process.exit(0);
}

const base = process.argv[2] || "http://127.0.0.1:7878";

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
};

// ---- a scratch workspace built so that substring and whole-name disagree
const ws = join(tmpdir(), "ds-search");
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });

// `store` on lines 2 and 3. Whole-name: 2 hits.
writeFileSync(join(ws, "main.dtr"),
  "fn main() -> Int {\n    let store = 7\n    return store\n}\n");

// `store_id` twice and `storehouse` once. None of them is the name `store`, so
// whole-name contributes 0 from this file and free text contributes 3.
writeFileSync(join(ws, "stock.dtr"),
  "pub fn stock_level( store_id: Int) -> Int {\n"
  + "    return store_id\n"
  + "}\n"
  + "\n"
  + "pub fn storehouse() -> Int {\n"
  + "    return 0\n"
  + "}\n");

// Filler in other languages, none of it containing "store".
//
// Two files and one language make a Project panel of ~430px, which never
// overflows the column - so the scroll-into-view check at the bottom of this
// file had nothing to prove. A real workspace shows several languages and a
// taller breakdown; these put the References card at ~276px into the content
// instead of ~180px, which is enough to push it past the fold at the height the
// check uses. They are also what makes the counts below meaningful: if any of
// them contained "store", the 2-vs-5 split would move.
writeFileSync(join(ws, "README.md"), "# a fixture\n\nnothing to see here.\n");
writeFileSync(join(ws, "notes.txt"), "plain notes.\n");
writeFileSync(join(ws, "package.json"), "{ \"name\": \"fixture\" }\n");
mkdirSync(join(ws, "tools"), { recursive: true });
writeFileSync(join(ws, "tools", "build.py"), "print('build')\n");
mkdirSync(join(ws, "docs"), { recursive: true });
writeFileSync(join(ws, "docs", "guide.md"), "# guide\n\nmore prose.\n");

const wsPosix = ws.replace(/\\/g, "/");
console.log("scratch workspace: " + wsPosix);

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
await ctx.addInitScript((r) => {
  // `lastRoot`, not `root`. The boot reads exactly one key for the workspace,
  // and `datara.studio.root` is not it - it is a key nothing reads, so a test
  // that sets it gets no tree, no `files`, and a Project panel stuck on
  // "Reading the workspace ...". Found here by a search box that would not
  // appear; the same mistake was already in generate.mjs.
  localStorage.setItem("datara.studio.lastRoot", r);
  localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
  localStorage.setItem("datara.studio.lastFile", r + "/main.dtr");
  localStorage.removeItem("datara.studio.settings");
}, wsPosix);
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2800);

// ---- the Project panel carries the box
await page.locator(".ptabs button", { hasText: "Project" }).first().click();
await page.waitForTimeout(600);

const box = page.locator("#psearch");
check("the Project panel has a search box", await box.count() === 1);

const whole = page.locator(".ck input[type=checkbox]");
check("the whole-name switch exists", await whole.count() === 1);
check("whole-name is on by default", await whole.isChecked().catch(() => false));

// ---- geometry: the button must not be pushed out of the panel by the box
const geom = await page.evaluate(() => {
  const input = document.getElementById("psearch");
  const btn = input && input.parentElement.querySelector(".mini");
  if (!input || !btn) return null;
  const card = input.closest(".card");
  return {
    inputW: input.getBoundingClientRect().width,
    btnRight: btn.getBoundingClientRect().right,
    cardRight: card.getBoundingClientRect().right,
    cardW: card.getBoundingClientRect().width,
  };
});
check("the search button is inside its card",
  !!geom && geom.btnRight <= geom.cardRight + 0.5,
  geom ? "button right " + geom.btnRight.toFixed(1) + " vs card " + geom.cardRight.toFixed(1) : "not found");
check("the box does not take the whole row",
  !!geom && geom.inputW < geom.cardW - 40,
  geom ? "box " + geom.inputW.toFixed(1) + " of card " + geom.cardW.toFixed(1) : "not found");

// ---- whole-name on: 2 hits, and no near-misses
const runSearch = async (text, wholeName) => {
  await box.fill(text);
  const on = await whole.isChecked();
  if (on !== wholeName) await whole.click();
  await box.press("Enter");
  await page.waitForTimeout(1500);
};

await runSearch("store", true);
const cardText1 = await page.locator(".card", { has: page.locator("#psearch") }).innerText();
check("whole-name reports 2 places", /2 place\(s\) in the workspace/.test(cardText1),
  JSON.stringify(cardText1.replace(/\s+/g, " ").slice(0, 160)));
check("whole-name says which mode it ran in", /whole name/i.test(cardText1),
  JSON.stringify(cardText1.replace(/\s+/g, " ").slice(0, 160)));

const hits1 = await page.locator(".card pre").allInnerTexts();
const body1 = hits1.join("\n");
check("whole-name does not return store_id", !/store_id/.test(body1));
check("whole-name does not return storehouse", !/storehouse/.test(body1));
check("whole-name does return the real uses",
  (body1.match(/let store = 7/) || []).length === 1
  && (body1.match(/return store/) || []).length >= 1);

// ---- whole-name off: the same query, and now the near-misses are the point
await runSearch("store", false);
const cardText2 = await page.locator(".card", { has: page.locator("#psearch") }).innerText();
check("free text reports 5 places", /5 place\(s\) in the workspace/.test(cardText2),
  JSON.stringify(cardText2.replace(/\s+/g, " ").slice(0, 160)));
check("free text says which mode it ran in", /any text/i.test(cardText2),
  JSON.stringify(cardText2.replace(/\s+/g, " ").slice(0, 160)));

const hits2 = (await page.locator(".card pre").allInnerTexts()).join("\n");
check("free text does return store_id", /store_id/.test(hits2));
check("free text does return storehouse", /storehouse/.test(hits2));

// ---- the caret word is resolved from the source, not from the rendered markup
//
// This is the regression that made the whole feature look unreliable, and it was
// not in the search code. `wordAt` read `Editor.lines[line - 1]`, and the lexer
// fills `lines` with HTML - one `<span>` per token. On `    let store = 7` with
// the caret inside `store` it returned `span`, out of `<span class="k">let`. So
// Alt+F7 searched for "span", F12 asked the project where "span" is defined, and
// hover explained the `span` tag. Before the wasm core finished loading the field
// held plain text and all three worked, which is why it read as flakiness.
check("the caret word is the identifier, not a tag",
  await page.evaluate(() => window.__Studio.Editor.wordAt(2, 10)) === "store",
  JSON.stringify(await page.evaluate(() => window.__Studio.Editor.wordAt(2, 10))));
check("the rendered lines are still HTML",
  /^<span/.test(await page.evaluate(() => window.__Studio.Editor.lines[0] || "")),
  JSON.stringify((await page.evaluate(() => window.__Studio.Editor.lines[0] || "")).slice(0, 40)));

await page.locator(".code").click();
await page.keyboard.press("Control+Home");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Home");
for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
await page.keyboard.press("Alt+F7");
await page.waitForTimeout(1500);
const altStatus = await page.locator(".status").innerText();
check("Alt+F7 searches the identifier under the caret", /matching store/.test(altStatus),
  JSON.stringify(altStatus.replace(/\s+/g, " ").slice(0, 120)));

// ---- Ctrl+Shift+F: the box takes focus, pre-filled from the caret word
//
// The caret is walked to `store` on line 2 with the keyboard rather than by
// clicking at coordinates: the editor reads the caret from the textarea's own
// selection, and a click lands wherever the glyphs happen to be.
await page.locator(".code").click();
await page.keyboard.press("Control+Home");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Home");
for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);

// ---- the results have to be on screen, not merely computed
//
// Ctrl+Shift+F used to scroll nothing. The Project panel is a scrolling column
// (`.pbody`, `overflow:auto`) and the References card is its last child - under
// the project summary, the git state and the language breakdown - so on a real
// workspace the shortcut moved the status bar to "13 place(s) in the workspace"
// and left every answer below the fold. That reads exactly like a shortcut that
// does nothing, which is the one failure mode a keyboard-only feature cannot
// afford.
//
// The viewport is shrunk here to force the overflow: at the normal 940px the
// whole column fits and the card is on screen whatever the shortcut does. 340px
// puts the panel's visible height at ~224px against ~522px of content. The first
// check is the guard that the second is not vacuous - if the card happened to be
// on screen anyway, the scroll assertion would pass without the feature.
await page.setViewportSize({ width: 1500, height: 340 });
await page.waitForTimeout(300);
await page.evaluate(() => { const b = document.querySelector(".pbody"); if (b) b.scrollTop = 0; });
await page.waitForTimeout(150);

const rects = () => page.evaluate(() => {
  const b = document.querySelector(".pbody");
  const c = document.getElementById("refcard");
  if (!b || !c) return null;
  const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
  return { bodyTop: br.top, bodyBottom: br.bottom, cardTop: cr.top, scrollTop: b.scrollTop };
});

const before = await rects();
check("the References card starts below the fold at this height",
  !!before && before.cardTop > before.bodyBottom,
  before ? "card top " + before.cardTop.toFixed(1) + " vs panel bottom " + before.bodyBottom.toFixed(1) : "no card");

await page.keyboard.press("Control+Shift+F");
await page.waitForTimeout(900);

const after = await rects();
check("Ctrl+Shift+F scrolls the results into view",
  !!after && after.scrollTop > 0
    && after.cardTop >= after.bodyTop - 1 && after.cardTop <= after.bodyBottom + 1,
  after ? "scrollTop " + after.scrollTop + ", card top " + after.cardTop.toFixed(1)
    + " in [" + after.bodyTop.toFixed(1) + ", " + after.bodyBottom.toFixed(1) + "]" : "no card");

// Run it, and the card has to end up at the *top* of the column.
//
// The card is not the result - it is the header of the result. Each hit is its
// own card rendered after it, so a scroll that leaves the References card at the
// bottom edge leaves every hit below the fold: the box and the count visible,
// the lines they are counting not. That is what `block: "nearest"` did here -
// measured, the card landed at y=143 in a panel ending at 312 and the first hit
// at y=267, off screen. The checks below are the two halves of the fix: the card
// goes to the top, and the first hit is then actually on screen.
await page.keyboard.press("Enter");
await page.waitForTimeout(1600);

const landed = await rects();
check("the results land at the top of the column, not the bottom edge",
  !!landed && landed.cardTop >= landed.bodyTop - 1 && landed.cardTop <= landed.bodyTop + 2,
  landed ? "card top " + landed.cardTop.toFixed(1) + " vs panel top " + landed.bodyTop.toFixed(1) : "no card");
check("the box is still on screen after the scroll",
  await page.evaluate(() => {
    const b = document.querySelector(".pbody"), i = document.getElementById("psearch");
    if (!b || !i) return false;
    const br = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
    return ir.top >= br.top - 1 && ir.bottom <= br.bottom + 1;
  }));
// The hits are not inside the References card, so the count being on screen says
// nothing about whether any result is. This checks the first hit card itself,
// which is the thing the user was looking for.
const firstHit = await page.evaluate(() => {
  const b = document.querySelector(".pbody");
  const cards = [...document.querySelectorAll(".pbody > .card")];
  const hit = cards[cards.indexOf(document.getElementById("refcard")) + 1];
  if (!b || !hit) return null;
  const br = b.getBoundingClientRect(), hr = hit.getBoundingClientRect();
  return { text: hit.innerText.replace(/\s+/g, " ").slice(0, 60), top: hr.top,
           visible: hr.top < br.bottom && hr.bottom > br.top };
});
check("the first hit is on screen, not just the count",
  !!firstHit && firstHit.visible && /let store = 7/.test(firstHit.text),
  firstHit ? JSON.stringify(firstHit.text) + " at y " + firstHit.top.toFixed(1) : "no hit card");

await page.setViewportSize({ width: 1500, height: 940 });
await page.waitForTimeout(300);

// Fold the panel first, so that the shortcut has to undo it. Asking to search
// and getting nothing because the column is folded is the failure this guards.
await page.locator('.intent button[title="Show or hide the right panel"]').click();
await page.waitForTimeout(400);
check("the panel is folded before the shortcut",
  await page.locator("#psearch").count() === 0);

await page.keyboard.press("Control+Shift+F");
await page.waitForTimeout(900);

check("Ctrl+Shift+F unfolds the panel and shows the box",
  await page.locator("#psearch").count() === 1);
check("Ctrl+Shift+F puts the caret word in the box",
  (await page.locator("#psearch").inputValue().catch(() => "")) === "store",
  JSON.stringify(await page.locator("#psearch").inputValue().catch(() => "")));
check("Ctrl+Shift+F leaves the box focused",
  await page.evaluate(() => document.activeElement && document.activeElement.id === "psearch"),
  await page.evaluate(() => (document.activeElement && document.activeElement.id) || "none"));

// Enter runs what is in the box, without touching the mouse.
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
const cardText3 = await page.locator(".card", { has: page.locator("#psearch") }).innerText();
check("Enter in the box runs the search", /place\(s\) in the workspace/.test(cardText3),
  JSON.stringify(cardText3.replace(/\s+/g, " ").slice(0, 160)));

// ---- Alt+F7 has to survive a folded panel too
//
// It had the same hole Ctrl+Shift+F had, and it was the older of the two
// gestures: `findRefs` searched, set the tab to Project, and displayed nothing
// at all when the column happened to be folded - a search that had run with no
// way to tell. It goes through `revealProjectPanel` now.
await page.locator('.intent button[title="Show or hide the right panel"]').click();
await page.waitForTimeout(400);
check("the panel is folded before Alt+F7",
  await page.locator("#psearch").count() === 0);

await page.locator(".code").click();
await page.keyboard.press("Control+Home");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Home");
for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
await page.keyboard.press("Alt+F7");
await page.waitForTimeout(1600);

check("Alt+F7 unfolds the panel and shows the box",
  await page.locator("#psearch").count() === 1);
const altBox = await page.locator("#psearch").inputValue().catch(() => "");
check("Alt+F7 leaves the searched name in the box", altBox === "store", JSON.stringify(altBox));
const altStatus2 = await page.locator(".status").innerText();
check("Alt+F7 reports the hits it found", /matching store/.test(altStatus2),
  JSON.stringify(altStatus2.replace(/\s+/g, " ").slice(0, 120)));
const altCard = await page.locator(".card", { has: page.locator("#psearch") }).innerText();
check("Alt+F7's hits are in the card, not just the status bar",
  /2 place\(s\) in the workspace/.test(altCard),
  JSON.stringify(altCard.replace(/\s+/g, " ").slice(0, 160)));

// ---- no page errors from any of it
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));

await browser.close();

const bad = results.filter((r) => !r).length;
console.log("\n" + (results.length - bad) + "/" + results.length + " checks passed");
process.exit(bad ? 1 : 0);
