// Screenshot Zen mode, so it can be looked at rather than asserted about.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
async function lp() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
  for (const root of [appdata && join(appdata, "npm", "node_modules")].filter(Boolean)) {
    for (const e of ["index.mjs", "index.js"]) {
      const f = join(root, "playwright", e);
      if (existsSync(f)) { try { return await import(pathToFileURL(f).href); } catch (x) {} }
    }
  }
  return null;
}
const pw = await lp();
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2 });
await page.goto(process.argv[2] || "http://127.0.0.1:7878", { waitUntil: "networkidle" });
const root = process.argv[4] || "D:/IDE datara/datara-studio/src";
await page.evaluate((r) => { try { localStorage.setItem("datara.studio.lastRoot", r); } catch (e) {} }, root);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll(".tfile"))
    .find((e) => (e.getAttribute("title") || "").endsWith(".dtr"));
  if (row) row.click();
});
await page.waitForTimeout(1000);
const out = process.argv[3] || "shots/zen";
await page.screenshot({ path: out + "-normal.png" });

await page.keyboard.press("Control+Shift+KeyZ");
await page.waitForTimeout(600);
await page.screenshot({ path: out + "-zen.png" });

// and the focused-column variant
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("datara.studio.settings") || "{}");
  raw.zenWidth = 760; localStorage.setItem("datara.studio.settings", JSON.stringify(raw));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll(".tfile"))
    .find((e) => (e.getAttribute("title") || "").endsWith(".dtr"));
  if (row) row.click();
});
await page.waitForTimeout(700);
await page.keyboard.press("Control+Shift+KeyZ");
await page.waitForTimeout(600);
await page.screenshot({ path: out + "-column.png" });
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("datara.studio.settings") || "{}");
  raw.zenWidth = 0; localStorage.setItem("datara.studio.settings", JSON.stringify(raw));
});
await browser.close();
console.log(`wrote ${out}-normal.png, ${out}-zen.png, ${out}-column.png`);
