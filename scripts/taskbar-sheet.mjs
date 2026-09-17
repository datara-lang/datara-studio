// A taskbar-context preview: the mark at the sizes Windows actually uses, on a
// strip the height of a taskbar, light and dark, plus the two smallest entries
// magnified so they can be judged rather than squinted at.
//
// Why this exists. The complaint that produced it was "the logo is very blurry
// and bad, you can't see it" about the taskbar. Reviewing a 256px PNG would
// never have caught that, and neither would the contact sheet on its own - so
// this draws the thing in the context it failed in.
//
// It used to also render the *old* drawing beside the new one, to make the fix
// legible. That comparison is history now, and keeping it meant keeping a second
// copy of the geometry here - which is the exact defect `scripts/mark.mjs` was
// created to remove. There is one renderer and this file calls it.
//
// Run:  node scripts/taskbar-sheet.mjs [out.png]
import { writeFileSync } from "node:fs";
import { encodePng, renderMark } from "./mark.mjs";

function canvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
  }
  return px;
}

/** Blit `src` (sw x sh) into `dst` at (dx,dy), nearest-neighbour scaled by `k`. */
function blit(dst, dw, dh, src, sw, sh, dx, dy, k = 1) {
  const ow = Math.round(sw * k), oh = Math.round(sh * k);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const so = (Math.floor(y / k) * sw + Math.floor(x / k)) * 4;
      const A = src[so + 3] / 255;
      if (A <= 0) continue;
      const dX = dx + x, dY = dy + y;
      if (dX < 0 || dY < 0 || dX >= dw || dY >= dh) continue;
      const d = (dY * dw + dX) * 4;
      dst[d] = Math.round(src[so] * A + dst[d] * (1 - A));
      dst[d + 1] = Math.round(src[so + 1] * A + dst[d + 1] * (1 - A));
      dst[d + 2] = Math.round(src[so + 2] * A + dst[d + 2] * (1 - A));
    }
  }
}

const STRIP_H = 44;                 // a taskbar
const BAR = [16, 20, 24, 32, 48];   // the sizes Windows draws in it
const MAG = [16, 24];               // judged magnified, because 16px is the point
const K = 6;
const PAD = 16, GAP = 16;

const barW = BAR.reduce((a, s) => a + s + GAP, 0);
const magW = MAG.reduce((a, s) => a + s * K + GAP, 0);
const W = PAD * 2 + Math.max(barW, magW);
const barRow = STRIP_H + PAD;
const magRow = 24 * K + PAD;
const H = PAD + barRow * 2 + magRow * 2;

const lightBg = [242, 242, 245], darkBg = [28, 28, 32];
const px = canvas(W, H, [200, 200, 205]);

function drawRow(bg, y0, magnified) {
  blit(px, W, H, canvas(W - PAD * 2, magnified ? 24 * K + 8 : STRIP_H, bg),
       W - PAD * 2, magnified ? 24 * K + 8 : STRIP_H, PAD, y0);
  const sizes = magnified ? MAG : BAR;
  let x = PAD + GAP / 2;
  for (const s of sizes) {
    const img = renderMark(s);
    const k = magnified ? K : 1;
    const top = magnified ? y0 + 4 : y0 + Math.round((STRIP_H - s) / 2);
    blit(px, W, H, img, s, s, x, top, k);
    x += s * k + GAP;
  }
}

drawRow(lightBg, PAD, false);
drawRow(darkBg, PAD + barRow, false);
drawRow(lightBg, PAD + barRow * 2, true);
drawRow(darkBg, PAD + barRow * 2 + magRow, true);

const out = process.argv[2] || "shots/icons/taskbar.png";
writeFileSync(out, encodePng(px, W, H));
console.log(`wrote ${out}  ${W}x${H}`);
console.log("rows: light 1x, dark 1x, light " + K + "x, dark " + K + "x");
console.log("1x sizes: " + BAR.join(", ") + "   magnified: " + MAG.join(", "));
