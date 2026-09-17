// Draw the Datara mark into a PNG, with no image library.
//
// Why this exists, and why it came back.
//
// `scripts/build-icons.mjs` used to *draw* the icon: a rounded square, two
// bracket strokes and a dot, evaluated as signed distances. It was removed in
// favour of reading `assets/datara.ico` directly, with the argument that three
// approximations of one design are three designs. That argument was right and
// the conclusion was wrong: `assets/datara.ico` is a *fourth* design. It is an
// orange-and-yellow palm inside a yellow rounded square, while everything in the
// interface - `.fico-dtr`, the `Mark` component, the title screen - draws two
// light brackets with a MINT dot between them. Two marks were live in one
// window, and the one on the taskbar was the one that did not match.
//
// So the geometry moved here, where it can be one thing. `ui/icon.svg` and this
// file describe the same shape: brackets at x 13.5/23.5 and 40.5/50.5 in a 64
// unit box, stroke 5, round caps, node radius 5.5 at the centre, plate radius
// 15. If they ever disagree the icon is wrong, which is a bug that is visible
// immediately rather than one that hides for months.
//
// The rasteriser is a signed-distance evaluation per pixel with 4x4 supersampling
// for the edges. No dependency, no canvas, no sharp - the machine has none of
// them and an icon is a small enough problem to solve directly.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// ---- geometry, in the 64-unit space ui/icon.svg uses ------------------------
//
// The second design. The first was two angle brackets around a mint dot - "a
// node held between two brackets". It was replaced because it read as a
// *generic* developer mark: `<>` with a dot in it is the default shape of every
// code-adjacent logo, and at 16px its diagonals had to be fought onto the pixel
// grid (see the SMALL table for how much fighting).
//
// What is here now is square brackets around a mint caret - `[|]`, a text
// cursor inside structure. Three reasons, in order of how much they decided it:
//
//   1. It says what the program is. Datara Studio is an editor first; a caret
//      inside brackets is "editing, inside the language's structure", where a
//      dot was an abstraction that happened to be symmetrical.
//   2. Every stroke is axis-aligned. Nothing here is a diagonal, so a 1.5px
//      stroke is a whole number of pixels at every size instead of a staircase.
//      The old mark's chevrons were the reason the 16px entry needed its own
//      hand-fitted geometry at all.
//   3. The bracket corners are rounded joins, so the drawing still reads as
//      drawn rather than as a monospace glyph dropped on a tile.
//
// The palette is deliberately unchanged - the plate, the ink and the mint are
// the same three values the rest of the interface uses, so nothing in the CSS,
// the title screen or `verify-ico.mjs` had to move with it.
export const MARK = {
  box: 64,
  plate: { r: 15, fill: [15, 15, 18, 255] },              // #0F0F12
  stroke: { w: 5, color: [233, 233, 238, 255] },           // #E9E9EE
  // `[` and `]`: down the outside, with a short arm inward at each end. The
  // arms are 6 units, so the opening between them is 12 - wide enough that the
  // caret does not look boxed in at 32px and above.
  brackets: [
    [[25, 17], [19, 17], [19, 47], [25, 47]],
    [[39, 17], [45, 17], [45, 47], [39, 47]],
  ],
  // The caret. A stroked vertical segment with round caps, not a filled bar, so
  // it is drawn by the same code path as the brackets and cannot disagree with
  // them about width.
  caret: { x: 32, y0: 24, y1: 40, w: 5, color: [125, 211, 192, 255] }, // #7DD3C0
};

// How the drawing is laid out per size.
//
// This table exists because of a measured failure, and the failure is worth
// keeping in view even though the shape underneath it changed.
//
// At 16 and 24 with the plate on and everything scaled uniformly, the first
// design's corner radius landed on the edge of the pixel grid and the icon read
// as a blob with dirty corners. With the plate off, the light brackets vanished
// on a light surface and only the mint dot was left. And at 16px the mint node
// came out about as wide as the stroke, so the dot split the pale bracket into
// specks:
//
//     .++++MM++MM++++.     row 5
//     .++++#++++#++++.     row 6   <- bracket is ONE pixel
//     .+++#++MM++#+++.     row 7   <- node poking through it
//
// Shrinking everything together cannot fix that: at 16px one unit is a quarter
// of a pixel, so the stroke and the node are fighting over the same one-pixel
// budget. The fix is to stop scaling and start drawing for the grid - a 16px
// icon is a different drawing that resembles the 256px one, not the same drawing
// made smaller.
//
// The current numbers were derived from the grid rather than fitted by eye, and
// the derivation is the point. The strokes are drawn by distance, so a stroke of
// width `w` centred at `c` inks `c-w/2 .. c+w/2`; a 1.4px stroke is therefore
// grey on *both* sides of the boundary no matter where you put it. Measured with
// the ASCII dump (`ascii-mark.mjs`, a throwaway): at 16px a 1.4px spine centred
// on 4.9 inked column 4 at 80% and column 5 at 60%, which reads as a grey smudge
// and is exactly the "blurry, you can't see it" complaint in miniature.
//
// So at 16 the layout is solved as a sum of whole columns:
//
//     margin 2 | spine 2 | arm 2 | gap 1 | caret 2 | gap 1 | arm 2 | spine 2 | margin 2
//
// which is 16 exactly, and lands the spine on columns 2-3, the arm on 4-5, the
// caret on 7-8 and the mirror on 10-13. Every stroke is 2px and covers its
// columns completely, so nothing is half-lit. 24 is the same drawing at 1.5x.
//
// A 1px stroke was tried first and rejected, for a reason worth writing down:
// the caret has to sit on the mark's centreline, and in a 16px tile the
// centreline is x=8.0 - so a 1px caret spans 7.5..8.5 and is grey on both sides,
// which is the same failure as before with a thinner line. A 1px stroke can be
// grid-aligned or centred, not both; a 2px stroke is the smallest one that can be
// both. That is why the small drawing is chunkier than the large one, and it is
// the whole reason this table is not a scale factor.
//
// Positions are given in PIXELS at that size, unlike the 64-unit drawing above,
// because the whole point of this table is to land on the pixel grid and pixels
// are the only unit where that means anything. `renderMark` converts to 64-space
// once, on the way into the sampler. The `Px` suffix is load-bearing.
export const SMALL = {
  16: {
    strokePx: 2.0,
    spinePx: 3.0,        // bracket spine centre, from the box edge
    armPx: 2.0,          // arm tip, measured the same way
    topPx: 4.0,          // bracket top, from the top edge
    botPx: 12.0,         // bracket bottom, from the top edge
    caretTopPx: 7.0,     // caret, likewise
    caretBotPx: 9.0,
    insetPx: 0.5,        // plate margin
    radiusPx: 3.0,       // plate corner radius
  },
  24: {
    strokePx: 3.0,
    spinePx: 4.5,
    armPx: 3.0,
    topPx: 6.0,
    botPx: 18.0,
    caretTopPx: 10.5,
    caretBotPx: 13.5,
    insetPx: 0.75,
    radiusPx: 4.5,
  },
};

export function layoutFor(size) {
  if (size <= 16) return { scale: 0.80, plate: true, radius: 0.20 };
  if (size <= 24) return { scale: 0.86, plate: true, radius: 0.20 };
  return { scale: 1, plate: true, radius: 0.234 };
}

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

/**
 * Render the mark at `size` px into straight (non-premultiplied) RGBA.
 *
 * Supersampled 4x4: the brackets are 5 units of 64, so at 32px a stroke is
 * 2.5px - jagged by eye without it. 16 samples per pixel is enough that the
 * 16px entry still reads as a bracket and not as a blob, which the old
 * hand-rolled version did not manage.
 *
 * At 16 and 24 the drawing switches to the `SMALL` numbers - see the comment
 * there for why a uniformly scaled drawing cannot work at that size.
 */
export function renderMark(size, opts = {}) {
  const SS = 4;                       // supersample factor per axis
  const s = MARK.box;
  const small = SMALL[size] || null;
  const lay = layoutFor(size);
  const plate = opts.plate !== undefined ? opts.plate : lay.plate;
  const mid = s / 2;
  const scale = size / s;
  const px = Buffer.alloc(size * size * 4, 0);

  // Geometry, in the 64-unit space. Either the scaled general drawing or the
  // grid-tuned small one; both are expressed here so the loop below is blind to
  // which is in use.
  //
  // Everything handed to the sampler must be in 64-space. The `SMALL` table is
  // in *pixels*, because that is the only unit in which "does this land on the
  // grid" is a meaningful question - so it is converted here, once, and the
  // field names carry the unit to stop the two being confused again. (They were
  // confused: the first version fed pixel offsets straight into the sampler and
  // the brackets came out half a pixel wide and invisible.)
  let strokeW, brackets, caret, plateHalf, plateR;
  if (small) {
    const u = s / size;                 // pixels -> 64-space
    strokeW = small.strokePx * u;
    const spine = small.spinePx * u;
    const arm = small.armPx * u;
    const top = small.topPx * u;
    const bot = small.botPx * u;
    // `[` and its mirror: down the spine, with an arm at each end.
    brackets = [
      [[spine + arm, top], [spine, top], [spine, bot], [spine + arm, bot]],
      [[s - spine - arm, top], [s - spine, top], [s - spine, bot], [s - spine - arm, bot]],
    ];
    caret = {
      x: mid,
      y0: small.caretTopPx * u,
      y1: small.caretBotPx * u,
      w: strokeW,
      color: MARK.caret.color,
    };
    plateHalf = mid - small.insetPx * u;
    plateR = Math.min(small.radiusPx * u, plateHalf);
  } else {
    strokeW = MARK.stroke.w;
    const fit = (v) => mid + (v - mid) * lay.scale;
    brackets = MARK.brackets.map((poly) => poly.map(([x, y]) => [fit(x), fit(y)]));
    // The caret is drawn by the same segment-distance test the brackets use, so
    // it cannot disagree with them about width - and `fit` is the identity at
    // every size above 24, which is why only the small path needs its own copy.
    caret = {
      x: fit(MARK.caret.x),
      y0: fit(MARK.caret.y0),
      y1: fit(MARK.caret.y1),
      w: MARK.caret.w * lay.scale,
      color: MARK.caret.color,
    };
    plateHalf = mid * lay.scale;
    plateR = Math.min(s * lay.radius * lay.scale, plateHalf);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // sample in the 64-unit space
          const ux = (x + (sx + 0.5) / SS) / scale;
          const uy = (y + (sy + 0.5) / SS) / scale;
          let cr = 0, cg = 0, cb = 0, ca = 0;

          // plate first: everything else composites over it
          if (plate) {
            const d = roundRectDist(ux, uy, mid, mid, plateHalf, plateHalf, plateR);
            if (d <= 0) { [cr, cg, cb, ca] = MARK.plate.fill; }
          }
          // brackets: stroke = distance to the polyline <= half the width
          let onStroke = false;
          for (const poly of brackets) {
            for (let i = 0; i + 1 < poly.length; i++) {
              const [ax, ay] = poly[i], [bx, by] = poly[i + 1];
              if (segDist(ux, uy, ax, ay, bx, by) <= strokeW / 2) { onStroke = true; break; }
            }
            if (onStroke) break;
          }
          if (onStroke) { [cr, cg, cb, ca] = MARK.stroke.color; }
          // the caret last: it sits on top of the brackets, as in the SVG
          if (segDist(ux, uy, caret.x, caret.y0, caret.x, caret.y1) <= caret.w / 2) {
            [cr, cg, cb, ca] = caret.color;
          }

          r += cr * (ca / 255); g += cg * (ca / 255); b += cb * (ca / 255);
          a += ca;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const A = a / n;
      // un-premultiply so the PNG carries straight alpha
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

// ---- a minimal PNG encoder ------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/**
 * RGBA buffer -> PNG bytes.
 *
 * `w`/`h` are explicit rather than one `size`: the icon is always square, but
 * the contact sheet this module is used to build for review is not, and an
 * encoder that silently assumes a square produces a truncated file instead of an
 * error. (It did - `ERR_OUT_OF_RANGE` from a buffer copy, three screens in.)
 */
export function encodePng(rgba, w, h = w) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One-size PNG, ready to write. */
export function markPng(size, opts) {
  return encodePng(renderMark(size, opts), size);
}

// ---- an .ico, so Windows has the multi-resolution file it wants ------------
//
// Windows picks per context - 16 in the taskbar's small mode, 32 in the Alt-Tab
// list, 256 in the Explorer's extra-large view. A single-size ICO is upsampled
// for every one of those, which is why the old set was soft everywhere except
// the size it happened to be.

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function markIco() {
  const images = ICO_SIZES.map((s) => ({ size: s, png: markPng(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((im, i) => {
    const o = i * 16;
    dir[o] = im.size >= 256 ? 0 : im.size;         // 256 is encoded as 0
    dir[o + 1] = im.size >= 256 ? 0 : im.size;
    dir[o + 2] = 0;                                // palette
    dir[o + 3] = 0;                                // reserved
    dir.writeUInt16LE(1, o + 4);                   // colour planes
    dir.writeUInt16LE(32, o + 6);                  // bits per pixel
    dir.writeUInt32LE(im.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

/** Write every artefact the studio needs from the one geometry. */
export function writeAll({ icoPath, pngPaths }) {
  writeFileSync(icoPath, markIco());
  for (const [path, size] of pngPaths) writeFileSync(path, markPng(size));
}
