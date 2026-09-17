// Shoot a specific URL: node ui/test/shoot2.mjs <url> <out.png> [w] [h]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
async function load() {
  try { return await import("playwright"); } catch (e) {}
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const ad = process.env.APPDATA || join(home, "AppData", "Roaming");
  for (const root of [join(ad, "npm", "node_modules")]) {
    for (const e2 of ["index.mjs","index.js"]) {
      const f = join(root, "playwright", e2);
      try { return await import(pathToFileURL(f).href); } catch (e) {}
    }
  }
  return null;
}
const pw = await load();
const ws = join(tmpdir(), "ds-shoot2");
mkdirSync(join(ws, "src"), { recursive: true });
writeFileSync(join(ws, "src", "main.dtr"),
  'use cli\nuse io\n\n/// The entry point.\npub fn main() -> Int {\n    let greeting = "hello from Datara"\n    io_print(greeting)\n    return 0\n}\n\nstruct Point {\n    x: Float\n    y: Float\n}\n\nfn distance(a: Point, b: Point) -> Float {\n    let dx = a.x - b.x\n    let dy = a.y - b.y\n    return sqrt(dx * dx + dy * dy)\n}\n');
writeFileSync(join(ws, "src", "helper.dtr"), "pub fn twice(n: Int) -> Int {\n    return n + n\n}\n");
writeFileSync(join(ws, "datara.toml"), '[project]\nname = "demo"\n');
const wsPosix = ws.replace(/\\/g, "/");
const b = await pw.chromium.launch();
const ctx = await b.newContext({
  viewport: { width: +(process.argv[4] || 1440), height: +(process.argv[5] || 900) },
  deviceScaleFactor: 2,
});
await ctx.addInitScript((r) => {
  localStorage.setItem("datara.studio.root", r);
  localStorage.setItem("datara.studio.recent", JSON.stringify([r]));
  localStorage.removeItem("datara.studio.settings");
}, wsPosix);
const p = await ctx.newPage();
await p.goto(process.argv[2], { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
// open the first Datara file so the editor is real
const row = p.locator(".tree .row").filter({ hasText: "main.dtr" }).first();
if (await row.count()) { await row.click(); await p.waitForTimeout(1200); }
mkdirSync(dirname(process.argv[3]), { recursive: true });
await p.screenshot({ path: process.argv[3] });
console.log("wrote " + process.argv[3]);
await b.close();
