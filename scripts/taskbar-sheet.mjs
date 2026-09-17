// A taskbar-context preview: the icon at the sizes Windows actually uses, at
// 1x and at a magnified scale, on both surfaces, with the old drawing beside it
// for comparison.
//
// The user's complaint was "the logo is very blurry and bad, you can't see it"
// about the taskbar. Reviewing a 256px PNG would never have caught that, and
// neither would the contact sheet on its own - so this draws the thing in the
// context it failed in: a strip the height of a taskbar, light and dark.
import { writeFileSync } from "node:fs";
import { encodePng, renderMark, layoutFor, SMALL, MARK } from "./mark.mjs";

// The old layout, for the comparison. Reproduces the pre-fix renderer.
function oldRenderMark(size) {
  const SS = 4, s = MARK.box, lay = layoutFor(size), mid = s / 2;
  const fit = (v) => mid + (v - mid) * lay.scale;
  const scale = size / s;
  const px = Buffer.alloc(size * size * 4, 0);
  const segDist = (px_, py, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay, wx = px_ - ax, wy = py - ay;
    const l2 = vx * vx + vy * vy;
    let t = l2 > 0 ? (wx * vx + wy * vy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px_ - (ax + t * vx), dy = py - (ay + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  };
  const rr = (px_, py, cx, cy, hw, hh, r) => {
    const qx = Math.abs(px_ - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
    const ax = qx > 0 ? qx : 0, ay = qy > 0 ? qy : 0;
    const inner = Math.min(Math.max(qx, qy), 0);
    return Math.sqrt(ax * ax + ay * ay) + inner - r;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = (x + (sx + 0.5) / SS) / scale, uy = (y + (sy + 0.5) / SS) / scale;
      let cr = 0, cg = 0, cb = 0, ca = 0;
      const half = mid * lay.scale;
      const rad = Math.min(s * lay.radius * lay.scale, half);
      if (rr(ux, uy, mid, mid, half, half, rad) <= 0) { [cr, cg, cb, ca] = MARK.plate.fill; }
      const w = MARK.stroke.w * (lay.scale < 1 ? 0.94 : 1);
      let on = false;
      for (const poly of MARK.brackets) for (let i = 0; i + 1 < poly.length; i++) {
        if (segDist(ux, uy, fit(poly[i][0]), fit(poly[i][1]), fit(poly[i + 1][0]), fit(poly[i + 1][1])) <= w / 2) on = true;
      }
      if (on) { [cr, cg, cb, ca] = MARK.stroke.color; }
      if (Math.hypot(ux - mid, uy - mid) <= MARK.node.r * (lay.scale < 1 ? 0.92 : 1)) { [cr, cg, cb, ca] = MARK.node.color; }
      r += cr * (ca / 255); g += cg * (ca / 255); b += cb * (ca / 255); a += ca;
    }
    const n = SS * SS, o = (y * size + x) * 4, A = a / n;
    if (A > 0) { px[o] = Math.round(r / n * 255 / A); px[o + 1] = Math.round(g / n * 255 / A); px[o + 2] = Math.round(b / n * 255 / A); }
    px[o + 3] = Math.round(A);
  }
  return px;
}

// Compose a canvas.
function canvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255;
  }
  return px;
}
function blit(dst, dw, src, sw, sh, dx, dy, alphaScale = 1) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const so = (y * sw + x) * 4;
    const A = (src[so + 3] / 255) * alphaScale;
    if (A <= 0) continue;
    const dX = dx + x, dY = dy + y;
    if (dX < 0 || dY < 0 || dX >= dw) continue;
    const do_ = (dY * dw + dX) * 4;
    dst[do_] = Math.round(src[so] * A + dst[do_] * (1 - A));
    dst[do_ + 1] = Math.round(src[so + 1] * A + dst[do_ + 1] * (1 - A));
    dst[do_ + 2] = Math.round(src[so + 2] * A + dst[do_ + 2] * (1 - A));
  }
}

const SIZES = [16, 20, 24, 32, 48];
const TOP = 8, GAP = 14, CELL = 60;
const W = GAP + SIZES.length * (CELL + GAP);
const ROW = 74;
const H = TOP + ROW * 4 + TOP;

const lightBg = [242, 242, 245], darkBg = [28, 28, 32];
const px = canvas(W, H, [200, 200, 205]);

// rows: old light, new light, old dark, new dark
const rows = [
  { bg: lightBg, old: true, label: "old / light" },
  { bg: lightBg, old: false, label: "new / light" },
  { bg: darkBg, old: true, label: "old / dark" },
  { bg: darkBg, old: false, label: "new / dark" },
];
rows.forEach((row, ri) => {
  const y0 = TOP + ri * ROW;
  // the "taskbar" strip
  const strip = canvas(W - GAP * 2, 44, row.bg);
  blit(px, W, strip, strip.length / 4 / 44, 44, GAP, y0 + 8, 1);
  SIZES.forEach((s, i) => {
    const img = row.old ? oldRenderMark(s) : renderMark(s);
    blit(px, W, img, s, s, GAP + i * (CELL + GAP), y0 + 8 + Math.round((44 - s) / 2), 1);
  });
});
// a separator
writeFileSync(process.argv[2] || "shots/icons/taskbar.png", encodePng(px, W, H));
console.log(`wrote ${process.argv[2] || "shots/icons/taskbar.png"}  ${W}x${H}`);
console.log("rows: old/light, new/light, old/dark, new/dark at 16,20,24,32,48");
