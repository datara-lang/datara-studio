// The Datara language logo, redrawn in the studio's own visual language.
//
// Why this exists.
//
// `assets/datara-logo.png` is the artwork the language project supplied: a
// bright yellow rounded square with an orange-and-yellow palm, 512x512, 82 KB.
// Two problems, and they are the same problem twice.
//
// It is the only saturated yellow in an interface that has none. The palette is
// five near-black neutrals, an ink ramp, and exactly one accent - `--live`,
// the mint `#7DD3C0` that is also the dot at the centre of the app mark. So the
// one element that did not belong was the one beside every `.dtr` file, which is
// the element that says "this is a Datara file".
//
// And it was 512 px for a 13-16 px box. Inlined as a data URI by
// `scripts/build-ui.mjs`, that is ~110 KB of base64 - about a sixth of the whole
// built page - to be downsampled by a factor of 32, at which point the yellow
// border is a muddy ring and the palm is three blobs. `scripts/mark.mjs` already
// learned this for the app mark: small icons are drawn for the pixel grid, not
// scaled onto it.
//
// So the shape stays and the styling changes. The palm is the language's
// identity and is recognisable at a glance; what it is drawn *in* was the part
// that fought the interface. It keeps the fan and the trunk, and it is redrawn
// in mint on a tile one step up the studio's surface ramp.
//
// The plate geometry is imported from `mark.mjs` rather than restated, so the
// two icons stay the same shape - same radius, same box - and cannot drift into
// being two designs. What differs is deliberate: the mark is the window (mint
// dot, ink brackets), the logo is the file type (mint palm).

import { MARK, encodePng } from "./mark.mjs";

// ---- palette ---------------------------------------------------------------
//
// Every value here is a token the interface already uses. Nothing new is
// introduced, which is the whole point: a colour that is not in the app cannot
// be in the app's style.
const PLATE = [29, 29, 35, 255];    // #1D1D23  --s3, one step above the mark's plate
const TRUNK = [154, 154, 164, 255]; // #9A9AA4  --ink2
const MINT = [125, 211, 192, 255];  // #7DD3C0  --live
const MINT_DIM = [78, 158, 146, 255]; // --live darkened, for the depth the original got from two oranges
const MINT_DEEP = [53, 119, 110, 255]; // and once more, for the blades that read as shadow

// ---- geometry, in the 64-unit space ui/icon.svg uses -----------------------

const HUB = [26, 33];

/**
 * One blade: a wedge from the hub.
 *
 * `a` is degrees from straight up, positive clockwise - the same convention the
 * contact sheet is read in. `len` runs from the hub. `base` and `tip` are half
 * widths, so a blade is a trapezoid: nearly a point at the hub, a flat end at
 * the tip, which is the shape the original artwork uses and the reason a fan of
 * ten of them still reads as a leaf rather than as ten lines.
 *
 * `hollow` draws the outline instead of the fill. The original used it on four
 * of its blades for the same reason - a fan of ten solid wedges is a blackberry.
 */
const BLADES = [
  { a: -70, len: 14.0, base: 0.7, tip: 2.2, c: MINT_DIM, hollow: false },
  { a: -52, len: 18.0, base: 0.7, tip: 2.4, c: MINT, hollow: false },
  { a: -34, len: 21.0, base: 0.8, tip: 2.4, c: MINT_DIM, hollow: false },
  { a: -14, len: 23.5, base: 0.8, tip: 2.3, c: MINT, hollow: false },
  { a: 6, len: 25.0, base: 0.8, tip: 2.2, c: MINT_DEEP, hollow: true },
  { a: 26, len: 24.5, base: 0.8, tip: 2.3, c: MINT, hollow: false },
  { a: 46, len: 22.0, base: 0.8, tip: 2.4, c: MINT_DIM, hollow: false },
  { a: 66, len: 18.5, base: 0.7, tip: 2.4, c: MINT, hollow: false },
  { a: 86, len: 14.5, base: 0.7, tip: 2.2, c: MINT_DEEP, hollow: true },
  { a: 108, len: 10.5, base: 0.6, tip: 2.0, c: MINT_DIM, hollow: false },
];

const TRUNK_W = 2.6;
const TRUNK_BOTTOM = 52.5;

/** The outline stroke for a hollow blade, in 64-units. */
const HOLLOW_W = 1.15;

// How the drawing is laid out per size.
//
// Ten blades need about 11 units of width each to separate; at 16 px the whole
// tile is 16 px, so a scaled-down ten-blade fan is a solid mint blob with a
// trunk. This is the same conclusion `mark.mjs` reached for the brackets, and it
// gets the same answer: the small sizes are a separate drawing, expressed in
// *pixels* because "does this land on the grid" is only meaningful in pixels.
// The field names carry the unit.
//
// 16 gets five blades, wider and shorter, over a smaller sweep. 24 gets six.
// Both drop the hollow outlines: at that size a 1 px outline next to a 1 px gap
// is not a style, it is noise.
const SMALL = {
  16: {
    hubPx: [7.6, 6.4],
    trunkPx: { w: 1.4, bottom: 12.4 },
    radiusPx: 3.2,
    strokePx: 0,
    blades: [
      { a: -62, len: 6.2, base: 0.6, tip: 1.9, c: MINT_DIM },
      { a: -30, len: 7.4, base: 0.6, tip: 2.0, c: MINT },
      { a: 2, len: 8.0, base: 0.6, tip: 2.0, c: MINT },
      { a: 34, len: 7.4, base: 0.6, tip: 2.0, c: MINT_DIM },
      { a: 68, len: 6.0, base: 0.5, tip: 1.8, c: MINT },
    ],
  },
  24: {
    hubPx: [11.4, 9.6],
    trunkPx: { w: 2.0, bottom: 18.6 },
    radiusPx: 4.8,
    strokePx: 0,
    blades: [
      { a: -66, len: 9.2, base: 0.7, tip: 2.2, c: MINT_DIM },
      { a: -40, len: 10.8, base: 0.7, tip: 2.3, c: MINT },
      { a: -12, len: 11.8, base: 0.7, tip: 2.3, c: MINT },
      { a: 16, len: 12.2, base: 0.7, tip: 2.3, c: MINT_DIM },
      { a: 46, len: 10.8, base: 0.7, tip: 2.3, c: MINT },
      { a: 78, len: 8.4, base: 0.6, tip: 2.1, c: MINT_DIM },
    ],
  },
};

export function logoLayoutFor(size) {
  if (SMALL[size]) return { plate: true, radius: 0.20, small: SMALL[size] };
  return { plate: true, radius: 0.234, small: null };
}

// ---- the samplers ----------------------------------------------------------

/** Distance from p to the segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Rounded-rectangle signed distance: negative inside. */
function roundRectDist(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = qx > 0 ? qx : 0, ay = qy > 0 ? qy : 0;
  const inner = Math.min(Math.max(qx, qy), 0);
  return Math.sqrt(ax * ax + ay * ay) + inner - r;
}

/** The four corners of one blade, as a trapezoid in the space given. */
function bladeQuad(bl, hub) {
  const rad = (bl.a * Math.PI) / 180;
  // direction: 0 = up, positive clockwise
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const px = -dy, py = dx;                       // perpendicular
  const [hx, hy] = hub;
  const [tx, ty] = [hx + dx * bl.len, hy + dy * bl.len];
  return [
    [hx + px * bl.base, hy + py * bl.base],
    [tx + px * bl.tip, ty + py * bl.tip],
    [tx - px * bl.tip, ty - py * bl.tip],
    [hx - px * bl.base, hy - py * bl.base],
  ];
}

/** Is p inside the convex quad? All cross products the same sign. */
function inQuad(q, px, py) {
  let neg = 0, pos = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross < 0) neg++; else if (cross > 0) pos++;
  }
  return neg === 0 || pos === 0;
}

function quadDist(q, px, py) {
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    d = Math.min(d, segDist(px, py, ax, ay, bx, by));
  }
  return d;
}

/**
 * Render the logo at `size` px into straight (non-premultiplied) RGBA.
 *
 * Supersampled 4x4, the same as the mark and for the same reason: a blade is
 * about 2.4 units of 64 at its tip, which is 1.2 px at 32 - jagged by eye
 * without it, and at 16 the difference between "a leaf" and "a smudge".
 *
 * The unit conversion happens once, at the top. Mixing pixel offsets into a
 * 64-space sampler is the mistake `mark.mjs` records having made, and it produced
 * strokes half a pixel wide and invisible.
 */
export function renderLogo(size, opts = {}) {
  const SS = 4;
  const s = MARK.box;
  const lay = logoLayoutFor(size);
  const plate = opts.plate !== undefined ? opts.plate : lay.plate;
  const mid = s / 2;
  const scale = size / s;
  const px = Buffer.alloc(size * size * 4, 0);

  let hub, blades, trunkW, trunkBottom, plateHalf, plateR, hollowW;
  if (lay.small) {
    const u = s / size;                        // pixels -> 64-space
    const sm = lay.small;
    hub = [sm.hubPx[0] * u, sm.hubPx[1] * u];
    trunkW = sm.trunkPx.w * u;
    trunkBottom = sm.trunkPx.bottom * u;
    hollowW = sm.strokePx * u;
    blades = sm.blades.map((b) => ({
      a: b.a, len: b.len * u, base: b.base * u, tip: b.tip * u, c: b.c, hollow: false,
    }));
    plateHalf = mid;
    plateR = sm.radiusPx * u;
  } else {
    hub = HUB;
    trunkW = TRUNK_W;
    trunkBottom = TRUNK_BOTTOM;
    hollowW = HOLLOW_W;
    blades = BLADES;
    plateHalf = mid;
    plateR = s * lay.radius;
  }

  const quads = blades.map((b) => ({ ...b, q: bladeQuad(b, hub) }));
  const trunkTop = hub[1];
  const trunkHalf = trunkW / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / scale;
          const uy = (y + (sy + 0.5) / SS) / scale;
          let cr = 0, cg = 0, cb = 0, ca = 0;

          if (plate) {
            const d = roundRectDist(ux, uy, mid, mid, plateHalf, plateHalf, plateR);
            if (d <= 0) { [cr, cg, cb, ca] = PLATE; }
          }
          // trunk first: the blades converge over its top, as in the artwork
          if (Math.abs(ux - hub[0]) <= trunkHalf && uy >= trunkTop && uy <= trunkBottom) {
            [cr, cg, cb, ca] = TRUNK;
          }
          for (const bl of quads) {
            const inside = inQuad(bl.q, ux, uy);
            if (bl.hollow) {
              if (inside && quadDist(bl.q, ux, uy) <= hollowW / 2) { [cr, cg, cb, ca] = bl.c; }
            } else if (inside) {
              [cr, cg, cb, ca] = bl.c;
            }
          }

          r += cr * (ca / 255); g += cg * (ca / 255); b += cb * (ca / 255);
          a += ca;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const A = a / n;
      if (A > 0) {
        px[o] = Math.round((r / n) * 255 / A);
        px[o + 1] = Math.round((g / n) * 255 / A);
        px[o + 2] = Math.round((b / n) * 255 / A);
      }
      px[o + 3] = Math.round(A);
    }
  }
  return px;
}

/** One-size PNG, ready to write. */
export function logoPng(size, opts) {
  return encodePng(renderLogo(size, opts), size);
}

/** The colours the artwork is allowed to contain, for the verifier. */
export const LOGO_COLORS = { PLATE, TRUNK, MINT, MINT_DIM, MINT_DEEP };
