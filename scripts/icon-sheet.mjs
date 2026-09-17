// Draw the icon set and a magnified contact sheet, so a human can judge it.
//
// Run:  node scripts/icon-sheet.mjs [out-dir]
//
// Why this exists. An icon is judged at 16-48px, and a 256px render tells you
// nothing about whether the 16px entry is legible - which is the size the
// taskbar's small mode and the Explorer's list view actually use. This upscales
// each entry with nearest-neighbour onto a light and a dark strip, at the size
// it is really drawn, so the small ones can be looked at directly.
//
// It is a development tool. It does not ship and nothing depends on it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMark, encodePng, markPng, markIco } from "./mark.mjs";

const out = process.argv[2] || "shots/icons";
mkdirSync(out, { recursive: true });

// ---- the real artefacts -----------------------------------------------------
const written = [];
for (const size of [32, 128, 256]) {
  const name = "mark-" + size + ".png";
  writeFileSync(join(out, name), markPng(size));
  written.push([name, size]);
}
writeFileSync(join(out, "mark.ico"), markIco());
written.push(["mark.ico", "16,24,32,48,64,128,256"]);

// ---- a contact sheet: every entry, at 8x, on both surfaces -----------------
const SIZES = [16, 24, 32, 48, 64, 128];
const ZOOM = 8;
const GAP = 12;
const TILE = 128 * ZOOM / 8;                 // widest entry, scaled by ZOOM/8
const cell = Math.max(TILE, 128) + GAP;

function sheet(bg) {
  const W = cell * SIZES.length + GAP;
  const H = 128 + GAP * 2;
  const buf = Buffer.alloc(W * H * 4, 0);
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
  }
  SIZES.forEach((sz, idx) => {
    const src = renderMark(sz);
    // nearest-neighbour: an icon is meant to be looked at, not smoothed, and
    // interpolation here would hide exactly the aliasing being checked for
    const z = Math.round(128 / sz) || 1;
    const draw = 128;
    const ox = GAP + idx * cell + Math.floor((cell - GAP - draw) / 2);
    for (let y = 0; y < draw; y++) {
      for (let x = 0; x < draw; x++) {
        const sx = Math.min(sz - 1, Math.floor(x * sz / draw));
        const sy = Math.min(sz - 1, Math.floor(y * sz / draw));
        const so = (sy * sz + sx) * 4;
        const o = ((y + GAP) * W + (x + ox)) * 4;
        const a = src[so + 3] / 255;
        buf[o]     = Math.round(src[so]     * a + bg[0] * (1 - a));
        buf[o + 1] = Math.round(src[so + 1] * a + bg[1] * (1 - a));
        buf[o + 2] = Math.round(src[so + 2] * a + bg[2] * (1 - a));
        buf[o + 3] = 255;
      }
    }
    void z;
  });
  return { buf, W, H };
}

for (const [name, bg] of [["sheet-light.png", [232, 232, 236]], ["sheet-dark.png", [22, 22, 27]]]) {
  const { buf, W, H } = sheet(bg);
  writeFileSync(join(out, name), encodePng(buf, W, H));
  written.push([name, "16,24,32,48,64,128 at 8x"]);
}

console.log("");
for (const [name, size] of written) console.log("  " + name.padEnd(18) + size);
console.log("  written to " + out);
console.log("  sheet-light.png and sheet-dark.png are the review images:");
console.log("  the entries at their real sizes, magnified 8x, on both surfaces.");
