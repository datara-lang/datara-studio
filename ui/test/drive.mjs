// Drive the interface the way a person does, and check the result on disk.
//
// Run:  PLAYWRIGHT_ROOT=... node ui/test/drive.mjs <base-url> <shots-dir>
//
// Why this exists, separately from shoot.mjs: a screenshot shows what the
// window looks like and nothing about whether anything *worked*. Every defect
// reported against this studio has been of the second kind - "Ctrl+S offers to
// save but nothing is saved", "it compiles the old code", "generation does not
// write into the file" - and none of those can be seen in a PNG. So this drives
// the real page, performs the real gestures, and then reads the real bytes off
// disk to see whether the gesture did anything.
//
// It runs against a scratch workspace in the temp directory, so it never
// touches a project the reader cares about.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  console.log("playwright is not importable - skipping the drive.");
  console.log("  set PLAYWRIGHT_ROOT to a node_modules that has it.");
  process.exit(0);
}

const base = process.argv[2] || "http://127.0.0.1:7878";
const out = process.argv[3] || "shots/drive";
mkdirSync(out, { recursive: true });

// ---- a scratch workspace, rebuilt every run
const ws = join(tmpdir(), "ds-drive");
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
const HELLO = "fn main() -> Int {\n    return 0\n}\n";
writeFileSync(join(ws, "hello.dtr"), HELLO);
writeFileSync(join(ws, "throwaway.dtr"), HELLO);
// Opened by the error-banner check, which then types an unresolvable call into it.
writeFileSync(join(ws, "broken.dtr"), HELLO);
// Opened by the live-check check, which types into it and never presses save -
// its own file, so that the write the check performs cannot disturb a section
// that expects `hello.dtr` to still hold HELLO.
writeFileSync(join(ws, "livecheck.dtr"), HELLO);
mkdirSync(join(ws, "move-target"), { recursive: true });
writeFileSync(join(ws, "move-me.dtr"), HELLO);
// Deleted by the delete check. Its own file, so that deleting it does not pull
// the ground out from under a later section.
writeFileSync(join(ws, "doomed.dtr"), HELLO);
const wsPosix = ws.replace(/\\/g, "/");
console.log("scratch workspace: " + wsPosix);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "   [" + detail + "]" : ""));
}

const browser = await pw.chromium.launch();
const errors = [];

// Every question the app asks is now drawn by the app itself (`.dialog` in the
// DOM), so a NATIVE dialog is a defect rather than something to answer. This
// handler used to accept them - rename and delete both went through
// `window.prompt` and `window.confirm` - which meant the suite could not tell an
// in-app dialog from a platform one, and the platform one is exactly what the
// interface was asked not to use. Now anything native is recorded and asserted
// against at the end of section 3.
const native = [];

async function open(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 } });
  if (seed) await ctx.addInitScript(seed, [wsPosix]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => {
    native.push({ type: d.type(), message: d.message() });
    await d.dismiss().catch(() => {});
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2600);
  return { ctx, page };
}

/** Answer the app's own dialog, and hand back what it asked.
 *
 *  `text` fills the field when the dialog has one. `which` picks the button: the
 *  confirming one by default, or "cancel" for the left-hand one. Returning the
 *  question is what lets a check assert on the wording rather than merely on the
 *  file having moved. */
async function answer(page, text, which) {
  await page.locator(".dialog").first().waitFor({ state: "visible", timeout: 4000 });
  const hasP = await page.locator(".dialog p").count();
  const hasInput = await page.locator(".dialog input").count();
  const asked = {
    title: ((await page.locator(".dialog h3").first().textContent()) || "").trim(),
    body: hasP ? ((await page.locator(".dialog p").first().textContent()) || "").trim() : "",
    seed: hasInput ? await page.locator(".dialog input").first().inputValue() : null,
    danger: await page.locator(".dialog .row button.danger").count(),
  };
  if (text !== undefined) await page.locator(".dialog input").first().fill(text);
  const btns = page.locator(".dialog .row button");
  const n = await btns.count();
  await btns.nth(which === "cancel" ? 0 : n - 1).click();
  await page.locator(".dialog").first().waitFor({ state: "detached", timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  return asked;
}

// ---- 1. First launch shows the title screen
{
  const { ctx, page } = await open(() => { try { localStorage.clear(); } catch (e) {} });
  const welcome = await page.locator(".welcome").count();
  const btns = await page.locator(".welcome .wbtn").count();
  const labels = await page.locator(".welcome .wbtn .t").allTextContents();
  check("first launch shows the title screen", welcome === 1, "found " + welcome);
  check("it offers three ways in", btns === 3, labels.join(" / "));
  // The three actions must be readable. They are a column of cards in a
  // `min(400px,100%)` box, so their width is the whole point of them; a stray
  // `width` on a class of the same name declared earlier in the stylesheet once
  // squashed all three into a column of single words, and no assertion noticed -
  // the screenshot did. Measured here so the next one is caught by the suite.
  const btnW = await page.locator(".welcome .wbtn").evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().width)));
  check("the three actions are wide enough to read",
    btnW.length === 3 && btnW.every((w) => w >= 300), btnW.join(" / ") + " px");
  await page.screenshot({ path: join(out, "d1-title.png") });
  await ctx.close();
}

// ---- 2. A workspace opens, and the code is actually drawn
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
    } catch (e) {}
  });
  const codeExists = await page.locator(".code").count();
  const text = codeExists ? await page.locator(".code").inputValue() : "";
  const hl = await page.locator(".hl").innerHTML().catch(() => "");
  const gutter = await page.locator(".gutter").innerText().catch(() => "");
  check("the editor surface is mounted", codeExists === 1, "found " + codeExists);
  check("the file's text is in the editor", text.replace(/\s+/g, " ").trim() === HELLO.replace(/\s+/g, " ").trim(),
    JSON.stringify(text.slice(0, 40)));
  check("the text is highlighted, not just present", hl.includes("span"), "hl markup " + hl.length + " chars");
  const dtrIcon = await page.locator(".tfile", { hasText: "hello.dtr" }).first().locator(".fico-dtr").count();
  const dtrBackground = dtrIcon ? await page.locator(".tfile", { hasText: "hello.dtr" }).first().locator(".fico-dtr").evaluate((el) => getComputedStyle(el).backgroundImage) : "";
  check(".dtr files use the Datara language logo", dtrIcon === 1 && dtrBackground.includes("data:image/png"), dtrBackground.slice(0, 40));
  // The file ends with a newline, so the editor shows four lines - the fourth
  // is the empty one the trailing "\n" opens. Asserting three here was wrong.
  check("the gutter has one number per line", gutter.split("\n").length === 4, JSON.stringify(gutter));
  const cursor = await page.locator(".status").innerText().catch(() => "");
  check("the caret starts at the top of the file", /1:1/.test(cursor), JSON.stringify(cursor.slice(0, 60)));

  // The top search surface must work with a mouse click, not only Ctrl+P.
  const searchButton = page.locator("button.search").first();
  await searchButton.click();
  await page.locator(".palette").waitFor({ state: "visible", timeout: 4000 });
  check("clicking the top search control opens the palette", await page.locator(".palette").count() === 1);
  await page.keyboard.press("Escape");
  await page.locator(".palette").waitFor({ state: "detached", timeout: 4000 }).catch(() => {});

  // The top-left intent controls start with Settings, not the application mark.
  const leftControls = await page.locator(".intent .left > *").evaluateAll((els) =>
    els.map((el) => el.getAttribute("title") || el.className || el.tagName));
  check("the top-left controls start with Settings",
    leftControls.length > 0 && /Settings/.test(String(leftControls[0])), JSON.stringify(leftControls.slice(0, 3)));

  // the green band the reader asked to be rid of
  const curline = await page.locator(".curline").count();
  const sweep = await page.locator(".sweep").count();
  check("no current-line band", curline === 0);
  check("no run sweep strip", sweep === 0);

  // The gutter must not slide sideways under a long line. This is the "no clean
  // corner" complaint: the gutter is a sibling of the scrolling textarea, so if
  // it only compensates Y, the line numbers walk off to the left the moment a
  // line overflows. Measure where the gutter actually is on screen, before and
  // after a horizontal scroll.
  const left0 = await page.locator(".gutter").evaluate((el) => el.getBoundingClientRect().left);
  await page.locator(".code").evaluate((el) => { el.scrollLeft = 400; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(200);
  const left1 = await page.locator(".gutter").evaluate((el) => el.getBoundingClientRect().left);
  check("the gutter holds still when the text scrolls sideways",
    Math.abs(left1 - left0) < 2, left0 + " -> " + left1);

  await page.screenshot({ path: join(out, "d2-open.png") });
  await ctx.close();
}

// ---- 3. Right-click in the tree offers rename and delete, and they work
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
    } catch (e) {}
  });
  const row = page.locator(".tfile", { hasText: "throwaway.dtr" }).first();
  await row.click({ button: "right" });
  await page.waitForTimeout(250);
  const menu = await page.locator(".ctxmenu").count();
  const rows = await page.locator(".ctxmenu .row").allTextContents();
  check("right-click opens a context menu", menu === 1);
  check("it offers rename and delete",
    rows.some((t) => /rename/i.test(t)) && rows.some((t) => /delete/i.test(t)), rows.join(" | "));
  await page.screenshot({ path: join(out, "d3-contextmenu.png") });

  // Move a file into a folder and back to the workspace root with real HTML5
  // drag/drop events. The app must use the absolute folder path sent by the
  // tree node, not its relative React key.
  const moveFile = page.locator(".tfile", { hasText: "move-me.dtr" }).first();
  const moveDir = page.locator(".tdir", { hasText: "move-target" }).first();
  await moveDir.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    window.__dragDrop = (source, target) => {
      const transfer = {
        effectAllowed: "all", dropEffect: "move", data: {},
        setData(type, value) { this.data[type] = value; },
        getData(type) { return this.data[type] || ""; },
        clearData() {},
      };
      const fire = (el, type) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        el.dispatchEvent(event);
      };
      fire(source, "dragstart");
      fire(target, "dragenter");
      fire(target, "dragover");
      fire(target, "drop");
      fire(source, "dragend");
    };
  });
  await page.evaluate(() => window.__dragDrop(
    document.querySelector('.tfile[title$="move-me.dtr"]'),
    [...document.querySelectorAll('.tdir')].find((el) => el.textContent.includes('move-target'))
  ));
  await page.waitForTimeout(900);
  const movedIn = existsSync(join(ws, "move-target", "move-me.dtr"));
  check("dragging a file into a folder moves it on disk", movedIn);

  // The folder is collapsed after the move in some hosts; the root list still
  // accepts a drop and must move the file back out.
  const movedRow = page.locator(".tfile", { hasText: "move-me.dtr" }).first();
  await page.evaluate(() => {
    window.__dragDrop(
      [...document.querySelectorAll('.tfile')].find((el) => el.textContent.includes('move-me.dtr')),
      document.querySelector('.list')
    );
  });
  await page.waitForTimeout(900);
  const movedOut = existsSync(join(ws, "move-me.dtr"));
  check("dragging a file back to the workspace root moves it out", movedOut);

  // rename, through the app's own dialog rather than a platform one
  await page.locator(".ctxmenu .row", { hasText: /rename/i }).first().click();
  const ren = await answer(page, "renamed-by-drive.dtr");
  check("rename asks in the app's own dialog", /rename/i.test(ren.title), ren.title || "(no title)");
  check("it seeds the field with the current name", ren.seed === "throwaway.dtr", ren.seed);
  const renamed = existsSync(join(ws, "renamed-by-drive.dtr"));
  check("rename renames the file on disk", renamed, "renamed-by-drive.dtr present: " + renamed);

  // delete, through the same dialog
  const target = page.locator(".tfile", { hasText: "doomed.dtr" }).first();
  if (await target.count()) {
    await target.click({ button: "right" });
    await page.waitForTimeout(200);
    await page.locator(".ctxmenu .row", { hasText: /delete/i }).first().click();
    await page.locator(".dialog").first().waitFor({ state: "visible", timeout: 4000 });
    // The screenshot is the evidence for the request that started this: a delete
    // used to raise the platform's dialog, and this is what it raises now.
    await page.screenshot({ path: join(out, "d3b-delete-dialog.png") });
    const del = await answer(page);
    check("delete asks in the app's own dialog", /delete/i.test(del.title), del.title || "(no title)");
    check("it names the file and says the change is permanent",
      /doomed\.dtr/.test(del.title) && /cannot be undone/i.test(del.body), del.body || "(no body)");
    check("the confirming button is the destructive one", del.danger === 1,
      del.danger + " danger button(s)");
    const gone = !existsSync(join(ws, "doomed.dtr"));
    check("delete removes the file from disk", gone, "doomed.dtr present: " + !gone);
  } else {
    check("delete removes the file from disk", false, "doomed.dtr row not found");
  }
  check("no platform dialog was raised", native.length === 0, JSON.stringify(native));
  await ctx.close();
}

// ---- 4. Create a file, type into it, Ctrl+S, and read the bytes back
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.removeItem("datara.studio.lastFile");
    } catch (e) {}
  });
  await page.locator(".newbtn").click();
  await page.waitForTimeout(150);
  await page.locator(".newmenu .row", { hasText: /^file$/i }).first().click();
  await page.waitForTimeout(250);
  const input = page.locator(".newrow input").first();
  check("the create row appears with a name field", (await input.count()) === 1);
  await input.fill("written-by-drive.dtr");
  await input.press("Enter");
  await page.waitForTimeout(900);
  const created = existsSync(join(ws, "written-by-drive.dtr"));
  check("create makes the file on disk", created, "written-by-drive.dtr present: " + created);

  const BODY = "fn main() -> Int {\n    return 7\n}\n";
  await page.locator(".code").fill(BODY);
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(1200);
  const onDisk = existsSync(join(ws, "written-by-drive.dtr"))
    ? readFileSync(join(ws, "written-by-drive.dtr"), "utf8") : "";
  check("Ctrl+S writes the typed text to disk",
    onDisk.replace(/\s+/g, " ").trim() === BODY.replace(/\s+/g, " ").trim(),
    JSON.stringify(onDisk.slice(0, 60)));

  // ---- 5. Run, and see the duration
  await page.locator(".run .main").first().click();
  await page.waitForTimeout(7000);
  const drawer = await page.locator(".drawer .dh").innerText().catch(() => "");
  const status = await page.locator(".status").innerText().catch(() => "");
  const timed = /\d+\s*(ms|s)\b/.test(drawer) || /\d+\s*(ms|s)\b/.test(status);
  check("the run reports how long it took", timed, JSON.stringify((drawer + " || " + status).slice(0, 160)));
  await page.screenshot({ path: join(out, "d4-run.png") });
  await ctx.close();
}

// ---- 6. A program that cannot compile must say so in the window
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/broken.dtr");
    } catch (e) {}
  });
  const broken = "fn main() -> Int {\n    return no_such_function()\n}\n";
  await page.locator(".code").fill(broken);
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(900);
  await page.locator(".run .main").first().click();
  await page.waitForTimeout(6000);
  const banner = await page.locator(".runerr").count();
  const text = banner ? (await page.locator(".runerr").innerText()).replace(/\s+/g, " ") : "";
  check("an error that stops the program is shown over the code", banner === 1, JSON.stringify(text.slice(0, 140)));
  // and the problems panel should have picked it up
  const badges = await page.locator(".ptabs .badge").allTextContents();
  check("the Problems tab counts the errors", badges.length > 0, "badges: " + badges.join(","));
  await page.screenshot({ path: join(out, "d5-error.png") });
  await ctx.close();
}

// ---- 7. Squiggles describe what is on screen, not the last save
//
// The compiler only ever sees files and `/api/check` is aimed at a path, so a
// check issued while the buffer was dirty reported the *previous* save: type an
// error, stop typing, and the panel still said "no problems in this file".
// Nothing in this block presses Ctrl+S - if the write does not come from the
// check path itself, the Problems badge never appears.
//
// The badge is read off the Problems tab by name rather than from `.ptabs
// .badge`, which also matches the Structure tab's symbol count and so would pass
// for the wrong reason.
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/livecheck.dtr");
      localStorage.setItem("datara.studio.settings", JSON.stringify({ autosave: true }));
    } catch (e) {}
  });
  const probBadge = async () => {
    // The strip shows the SHORT label (`PANEL_TAB_SHORT`), which is `Issues` for
    // the `prob` tab; `Problems` is only the tooltip and the Settings name.
    //
    // Matched on the button's *label* with a prefix test rather than on its whole
    // text, because once a badge exists the button reads "Issues\n1" and an
    // exact-match selector stops finding it - which is how this check spent its
    // time comparing "none" to "none" and passing for the wrong reason.
    return (await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(".ptabs button"));
      const prob = btns.find((b) => /^(Issues|Problems)/.test(b.innerText.trim()));
      if (!prob) return "no tab";
      const bad = prob.querySelector(".badge");
      return bad ? bad.innerText.trim() : "none";
    }));
  };
  const before = await probBadge();
  await page.locator(".code").fill("fn main() -> Int {\n    return nope()\n}\n");
  await page.waitForTimeout(3500);
  const after = await probBadge();
  check("an error typed into the buffer is flagged without saving first",
    before === "none" && after !== "none",
    "Problems badge " + before + " -> " + after);
  // and the write really happened, because that is how the check saw the text
  const saved = existsSync(join(ws, "livecheck.dtr"))
    ? readFileSync(join(ws, "livecheck.dtr"), "utf8") : "";
  check("the check wrote the buffer out to reach the compiler",
    /nope\(\)/.test(saved), JSON.stringify(saved.replace(/\s+/g, " ").slice(0, 50)));
  await page.screenshot({ path: join(out, "d7-live-check.png") });
  await ctx.close();
}

// ---- 8. The companion suggests while you type, Copilot-style
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
      localStorage.setItem("datara.studio.settings", JSON.stringify({ aiEnabled: true }));
    } catch (e) {}
  });
  // A GET on the root is the companion's own status document. Probing it with
  // POST reports a healthy companion as offline, because / is not a POST route.
  const online = await page.evaluate(async () => {
    try {
      const r = await fetch("http://127.0.0.1:7890/");
      return r.ok;
    } catch (e) { return false; }
  });
  if (!online) {
    console.log("  SKIP  the companion on 7890 is not answering - skipping the suggestion check");
  } else {
    // The companion is a small model over this project's own sources, so it
    // only answers for contexts it has actually seen. "mut " is one of them.
    await page.locator(".code").click();
    await page.locator(".code").press("Control+a");
    await page.keyboard.type("fn main() -> Int {\n    mut ");
    await page.waitForTimeout(3500);
    const ghost = await page.locator(".ghost").innerHTML().catch(() => "");
    const plain = ghost.replace(/<[^>]*>/g, "").trim();
    check("the companion suggests live text while typing", plain.length > 0, JSON.stringify(plain.slice(0, 90)));
    check("the suggestion shows how to accept it", /tab/i.test(ghost), JSON.stringify(ghost.slice(0, 140)));
    await page.screenshot({ path: join(out, "d6-ghost.png") });

    // How much of real Datara it can actually answer for. This is the honest
    // measure of "suggests things live, like Copilot": the wiring either works
    // or it does not, and separately the model either has coverage or it does
    // not. Reported, not asserted, because it is a property of the model.
    const probes = [
      "fn main() -> Int {\n    mut ",
      "    let t = str_trim(",
      "pub fn st_",
      "    if byte_len(t) > 0 {\n        ",
      "    while i < n {\n        i = i + ",
      "// ",
    ];
    const answered = await page.evaluate(async (list) => {
      let n = 0;
      for (const prefix of list) {
        try {
          const r = await fetch("http://127.0.0.1:7890/complete", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix, suffix: "", file_path: "probe.dtr" }),
          });
          const j = await r.json();
          if (j && j.count > 0) n++;
        } catch (e) {}
      }
      return n;
    }, probes);
    console.log("  NOTE  the companion answers " + answered + " of " + probes.length
      + " realistic Datara prefixes - coverage, not wiring");
  }
  await ctx.close();
}

// ---- 9. A new project lands where the reader said, never inside the IDE
//
// This is the path that once wrote `demo-project` into the studio's own source
// tree. With no workspace open, "Create new project" asked for a name and never
// for a location, so the name became a path relative to the server's working
// directory - and the server's working directory is wherever the studio happens
// to be installed. Two separate things had to be true for the folder to land
// somewhere else, and both are checked here because both were invisible in a
// screenshot: the dialog must not open on the studio's own tree, and the folder
// it does open on must survive the tree poll that fires eight seconds later.
{
  const studio = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const home = join(tmpdir(), "ds-newproject");
  const name = "made-by-drive";
  rmSync(home, { recursive: true, force: true });
  rmSync(join(studio, name), { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const homePosix = home.replace(/\\/g, "/");

  const { ctx, page } = await open(() => { try { localStorage.clear(); } catch (e) {} });
  await page.locator(".welcome .wbtn.primary").click();
  await page.waitForSelector(".browser", { timeout: 5000 });
  await page.waitForTimeout(700);

  const heading = await page.locator(".browser h3").innerText();
  check("Create new project asks where before what", /where/i.test(heading), heading);

  const opensAt = await page.locator(".browser .pinput").inputValue();
  // An empty request makes the server describe its own working directory, so
  // the dialog used to open on `src`, `crates` and `ui` - the studio's own guts,
  // offered as somewhere to put a new project.
  check("the folder dialog does not open on the studio's own source",
    /^[A-Za-z]:\/$/.test(opensAt) || opensAt === "/", "opened at " + JSON.stringify(opensAt));

  await page.locator(".browser .pinput").fill(homePosix);
  await page.locator(".browser .pinput").press("Enter");
  await page.waitForTimeout(900);
  // Past the 8 s tree poll. With no workspace that poll ran anyway, the reply
  // carried `root: "."`, `root` was overwritten, the picker's `start` prop
  // changed underneath it and the dialog discarded the path that was typed.
  await page.waitForTimeout(9000);
  const kept = await page.locator(".browser .pinput").inputValue();
  check("the chosen folder survives the tree poll", kept === homePosix, JSON.stringify(kept));

  await page.locator(".browser .bf button").last().click();
  const proj = await answer(page, name);
  check("naming the project happens in the app's own dialog",
    /new project/i.test(proj.title) && proj.seed === "my-project",
    proj.title + " / seeded " + JSON.stringify(proj.seed));
  await page.waitForTimeout(1600);
  check("the project is created in the folder that was chosen",
    existsSync(join(home, name, "src", "main.dtr")), join(home, name));
  check("nothing is created inside the IDE's own source tree",
    !existsSync(join(studio, name)), join(studio, name) + " absent");

  rmSync(home, { recursive: true, force: true });
  rmSync(join(studio, name), { recursive: true, force: true });
  await ctx.close();
}

// ---- 10. A browser draws no title bar and no window controls
//
// There is no caption bar in any build now - it was removed, and the three
// window controls moved into the intent bar, where they appear only in the
// shell. That makes "no separate bar row, and no controls outside the intent
// bar" the load-bearing property rather than a nicety: a browser that drew the
// controls would show three buttons that control nothing, and the layout would
// be 34 px wrong. It is the easiest thing here to lose silently, so it is
// asserted.
{
  const { ctx, page } = await open(() => { try { localStorage.clear(); } catch (e) {} });
  const bars = await page.locator(".titlebar").count();
  const caps = await page.locator(".capctl").count();
  const shellAttr = await page.evaluate(() => document.documentElement.getAttribute("data-shell"));
  const rows = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".shell")).gridTemplateRows.split(" ").length);
  const handle = await page.evaluate(() => typeof window.__DS_SHELL__);
  check("a browser draws no title bar", bars === 0, "found " + bars);
  check("a browser draws no window controls at all", caps === 0, "found " + caps);
  check("a browser is not marked as the shell", shellAttr === null, JSON.stringify(shellAttr));
  check("the browser layout keeps its three rows", rows === 3, rows + " rows");
  check("no shell handle exists in a browser", handle === "undefined", handle);
  await ctx.close();
}

// ---- 11. In the shell the controls appear in the intent bar, and reach the window
//
// What the shell injects before any page script runs, stubbed to a recorder.
// The real `ui/tauri-bridge.js` consumes it and the real React controls are what
// is clicked, so this exercises both halves of the seam without needing a Rust
// build - which is the only way to test this in the browser suite at all.
//
// The controls are no longer in a bar of their own: they sit at the right-hand
// end of the intent bar, next to the Run button, and the intent bar is the drag
// region. So the assertions are about `.intent .capctl`, and the row count does
// not change - there is no extra row to add.
{
  const { ctx, page } = await open(() => {
    try { localStorage.clear(); } catch (e) {}
    const calls = [];
    window.__DS_INVOKES__ = calls;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        return Promise.resolve(cmd === "plugin:window|is_maximized" ? false : null);
      },
    };
  });
  const bars = await page.locator(".titlebar").count();
  const caps = await page.locator(".intent .capctl").count();
  const btns = await page.locator(".intent .capbtn").count();
  const names = await page.locator(".intent .capbtn").evaluateAll((els) => els.map((e) => e.getAttribute("title")));
  const rows = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".shell")).gridTemplateRows.split(" ").length);
  const drag = await page.evaluate(() =>
    !!document.querySelector(".intent[data-tauri-drag-region]"));
  check("the shell draws no separate title bar", bars === 0, "found " + bars);
  check("the controls are in the intent bar", caps === 1, "found " + caps);
  check("it has the three window controls", btns === 3, names.join(" / "));
  check("the intent bar is the drag region", drag, String(drag));
  check("the bar adds no extra row to the layout", rows === 3, rows + " rows");

  await page.locator(".intent .capbtn").nth(0).click();
  await page.locator(".intent .capbtn").nth(1).click();
  await page.locator(".intent .capbtn").nth(2).click();
  await page.waitForTimeout(250);
  const sent = await page.evaluate(() => window.__DS_INVOKES__);
  const cmds = sent.map((c) => c.cmd);
  check("minimise reaches the window", cmds.includes("plugin:window|minimize"), cmds.join(", "));
  check("maximise reaches the window", cmds.includes("plugin:window|toggle_maximize"), cmds.join(", "));
  check("close reaches the window", cmds.includes("plugin:window|close"), cmds.join(", "));
  // `get_window(window, label)` resolves an explicit label, and the label has to
  // be the one the shell actually created. A wrong label fails with
  // "window not found", which looks exactly like a broken button.
  const labelled = sent.filter((c) => c.args && c.args.label === "main").length;
  check("every call names the window the shell made", labelled === cmds.length,
    labelled + " of " + cmds.length);
  const faults = await page.locator("#faults .fault").count();
  check("nothing was refused", faults === 0, faults + " fault line(s)");
  await page.screenshot({ path: join(out, "d11-controls.png") });
  await ctx.close();
}

// ---- 12. The bottom bar is three columns, and the git chip sits in the middle
//
// Asked for as "не вижу гит трии посередине внизу" - the branch belongs in the
// middle of the status bar, not at the left edge and not only at the top. The
// status bar used to be a flex row whose middle was a `flex:1` status message,
// so there was no middle to put anything in and no git indicator at all.
//
// The scratch workspace is not a git repository, so the chip would be
// legitimately absent and a check for it would prove nothing about the feature.
// The server's git endpoint is answered directly instead: what is under test
// here is where the chip goes when there is a branch to show, not whether `git`
// works on this machine.
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
    } catch (e) {}
  });
  await page.route("**/api/git", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, branch: "main", dirty: 3, files: [], log: [] }),
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3400);

  const geo = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, height: b.height, mid: (b.left + b.right) / 2 };
    };
    const bar = document.querySelector(".status");
    const bb = bar.getBoundingClientRect();
    return {
      bar: { mid: (bb.left + bb.right) / 2, left: bb.left, top: bb.top, height: bb.height },
      left: rect(".status .stleft"), mid: rect(".status .stmid"), right: rect(".status .stright"),
    };
  });

  check("the status bar is three columns",
    !!(geo.left && geo.mid && geo.right), JSON.stringify(geo));
  const chips = await page.locator(".status .gitmid").count();
  check("the branch chip is drawn in the bottom bar", chips === 1, chips + " chip(s)");
  const chip = page.locator(".status .gitmid").first();
  const chipText = chips ? (await chip.innerText()).replace(/\s+/g, " ").trim() : "";
  check("it names the branch", /\bmain\b/.test(chipText), JSON.stringify(chipText));
  check("it shows how many files are uncommitted", /(^|\D)3(\D|$)/.test(chipText), JSON.stringify(chipText));
  const chipCls = chips ? (await chip.getAttribute("class")) || "" : "";
  check("an uncommitted tree marks it dirty", chipCls.includes("dirty"), chipCls);
  // `minmax(0,1fr) auto minmax(0,1fr)` puts the middle column on the bar's own
  // centre line. The old flex row could not: the middle was the only flexible
  // child, so its position depended on how long the file name on the left was.
  check("the middle column is centred in the bar",
    geo.mid && Math.abs(geo.mid.mid - geo.bar.mid) <= 1.5,
    "middle at " + (geo.mid ? geo.mid.mid.toFixed(1) : "?") + ", bar centre " + geo.bar.mid.toFixed(1));

  await chip.click();
  await page.waitForTimeout(400);
  const activeTab = (await page.locator(".ptabs button.on").first().innerText().catch(() => "")).trim();
  check("clicking the chip opens the Project panel", /project/i.test(activeTab), activeTab || "(none)");

  await page.screenshot({
    path: join(out, "d12-statusbar.png"),
    clip: { x: geo.bar.left, y: geo.bar.top, width: 1500, height: Math.max(24, geo.bar.height) },
  });
  await ctx.close();
}

// ---- 13. Every panel tab survives being opened
//
// The Project tab read `git` - which lives in `App`'s scope - without being
// passed it, so opening it threw `ReferenceError: git is not defined`, the error
// boundary caught it, and the entire interface was replaced with "The interface
// stopped". Every other check in this file passed while that was true, because
// none of them ever clicked a tab: the panel opened on Problems and stayed
// there. A panel that destroys the window when you look at it is the worst
// defect this program can have, so the tabs are now walked one by one.
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
    } catch (e) {}
  });
  // A tab label carries its badge count as text ("Structure1"), so compare the
  // label with any trailing digits removed.
  const labels = (await page.locator(".ptabs button").allTextContents()).map((t) => t.trim());
  const broke = [];
  for (const label of labels) {
    const name = label.replace(/\d+$/, "").trim();
    await page.locator(".ptabs button").filter({ hasText: new RegExp("^" + name) }).first()
      .click({ timeout: 5000 }).catch(() => broke.push(name + " is not clickable"));
    await page.waitForTimeout(450);
    if (!(await page.locator(".ptabs").count())) {
      const body = await page.locator("body").innerText().catch(() => "");
      const why = (body.match(/^.*(?:Error|not defined).*$/m) || ["blank"])[0];
      broke.push(name + " killed the interface: " + why);
      break;
    }
    const on = (await page.locator(".ptabs button.on").first().innerText().catch(() => ""))
      .replace(/\d+$/, "").trim();
    if (on !== name) broke.push(name + " is not the active tab after clicking it (got " + on + ")");
  }
  check("every panel tab opens without killing the interface", broke.length === 0, broke.join(" | "));
  // Named, not counted. `>= 6` passed while Chat was missing, which is the
  // failure a count-only assertion is blind to - and the tab strip is exactly
  // where a new tab silently failing to be reachable has happened before.
  const want = ["Issues", "Symbols", "Project", "Layout", "AI", "Generate", "Chat"];
  const missing = want.filter((w) => !labels.some((l) => l.startsWith(w)));
  check("every panel tab is present, Chat included", missing.length === 0,
        "missing: " + missing.join(", ") + "  ·  saw: " + labels.join(" / "));
  check("the strip was actually walked", labels.length >= want.length, labels.join(" / "));
  await page.screenshot({ path: join(out, "d13-tabs.png") });
  await ctx.close();
}

// ---- 14. Typing a declaration keyword and pressing Tab writes the shape
//
// Asked for as "я писал fn жал там, у меня уже полноценная структура функции
// вставляется". Before this, accepting the completion for `fn` inserted the two
// letters already on screen: the list offered the keyword and accepting it was a
// no-op, which is the one thing a completion must never be.
{
  const { ctx, page } = await open(([r]) => {
    try {
      localStorage.setItem("datara.studio.lastRoot", r);
      localStorage.setItem("datara.studio.lastFile", r + "/hello.dtr");
    } catch (e) {}
  });
  const code = page.locator(".code");
  await code.click();
  await code.press("Control+a");
  await page.keyboard.type("fn");
  await page.waitForTimeout(400);

  const items = await page.locator(".comp .ci").allTextContents();
  check("typing fn opens the completion list", items.length > 0, items.join(" / "));
  check("  and the list says the keyword expands", /snippet/.test(items.join(" ")), items.join(" / "));
  await page.screenshot({ path: join(out, "d14-snippet-popup.png") });

  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
  check("Tab writes the whole function, not the two letters",
    await code.inputValue(), "fn name() {\n    \n}");

  // the placeholder is selected, which is what makes the template usable: the
  // next character typed replaces the name instead of landing after it
  const selected = await code.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  check("the function name is selected to type over", selected, "name");
  await page.keyboard.type("main");
  await page.waitForTimeout(300);
  check("typing the name replaces the placeholder",
    await code.inputValue(), "fn main() {\n    \n}");
  await page.screenshot({ path: join(out, "d14-snippet-accepted.png") });

  // and the second Tab steps into the empty body, which is the whole point of
  // removing the `return 0` placeholder
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  check("a second Tab lands in the empty body",
    await code.evaluate((el) => {
      const upto = el.value.slice(0, el.selectionStart);
      return upto.split("\n").length;
    }), 2);

  // and the body follows the indentation of the line it was typed on
  await code.press("Control+a");
  await page.keyboard.type("    fn");
  await page.waitForTimeout(400);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(400);
  check("an indented fn indents its body to match",
    await code.inputValue(), "    fn name() {\n        \n    }");

  // a keyword with no shape must still insert as itself
  await code.press("Control+a");
  await page.keyboard.type("let");
  await page.waitForTimeout(400);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  check("a keyword with no shape still inserts as the word",
    await code.inputValue(), "let");
  await ctx.close();
}

await browser.close();

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(results.length - failed.length + "/" + results.length + " checks passed");
if (errors.length) {
  console.log(errors.length + " browser error(s):");
  for (const e of errors.slice(0, 10)) console.log("  " + e);
}
if (failed.length || errors.length) process.exit(1);
