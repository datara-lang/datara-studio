// Read an .ico back and report what is actually inside it.
//
// The point is that "the build said OK" is not evidence the file is right. This
// parses the real bytes on disk: the directory, the declared sizes, and whether
// each payload is a PNG with a sane IHDR. It also decodes a couple of entries
// far enough to confirm the mint caret is present and the old yellow palm is not -
// the two failure modes this icon has actually had.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const path = process.argv[2] || "assets/datara.ico";
const buf = readFileSync(path);

const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);
console.log(`${path}: ${buf.length} B, reserved=${reserved} type=${type} entries=${count}`);
if (reserved !== 0 || type !== 1) throw new Error("not an icon file");

const entries = [];
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = buf[o] === 0 ? 256 : buf[o];
  const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
  const bpp = buf.readUInt16LE(o + 6);
  const size = buf.readUInt32LE(o + 8);
  const off = buf.readUInt32LE(o + 12);
  const payload = buf.subarray(off, off + size);
  const isPng = payload[0] === 0x89 && payload.toString("ascii", 1, 4) === "PNG";
  let ihdr = null;
  if (isPng) {
    // IHDR data starts at byte 16 (8 sig + 4 len + 4 type)
    ihdr = {
      w: payload.readUInt32BE(16),
      h: payload.readUInt32BE(20),
      depth: payload[24],
      color: payload[25],
    };
  }
  // in-bounds check: this is the bug that produced a truncated file before
  const endOk = off + size <= buf.length;
  entries.push({ w, h, bpp, size, off, isPng, ihdr, endOk });
  console.log(
    `  ${String(w).padStart(3)}x${String(h).padEnd(3)} bpp=${bpp} ` +
    `${String(size).padStart(5)} B @${String(off).padStart(5)} ` +
    `${isPng ? "png" : "BMP"} ${ihdr ? `${ihdr.w}x${ihdr.h} d${ihdr.depth} c${ihdr.color}` : ""} ` +
    `${endOk ? "" : "OUT OF BOUNDS"}`
  );
}

// Decode the largest entry and look for the brand colours.
const biggest = entries.reduce((a, b) => (b.w > a.w ? b : a));
const payload = buf.subarray(biggest.off, biggest.off + biggest.size);
// walk chunks to find IDAT
let p = 8, idat = [];
while (p < payload.length) {
  const len = payload.readUInt32BE(p);
  const typ = payload.toString("ascii", p + 4, p + 8);
  if (typ === "IDAT") idat.push(payload.subarray(p + 8, p + 8 + len));
  p += 12 + len;
}
const raw = inflateSync(Buffer.concat(idat));
const w = biggest.ihdr.w, h = biggest.ihdr.h;
// un-filter (all rows are filter 0 in our encoder, but read the tag and verify)
const stride = w * 4 + 1;
const counts = new Map();
for (let y = 0; y < h; y++) {
  const f = raw[y * stride];
  if (f !== 0) throw new Error(`row ${y} uses filter ${f}, expected none`);
  for (let x = 0; x < w; x++) {
    const o = y * stride + 1 + x * 4;
    const a = raw[o + 3];
    if (a < 200) continue;
    const key = `${raw[o]},${raw[o + 1]},${raw[o + 2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(`\n  opaques in the ${w}x${h} entry, by colour:`);
for (const [c, n] of top) {
  const [r, g, b2] = c.split(",").map(Number);
  const hex = "#" + [r, g, b2].map((v) => v.toString(16).padStart(2, "0")).join("");
  let what = "";
  if (hex === "#7dd3c0") what = "<- the mint caret";
  else if (hex === "#e9e9ee") what = "<- the bracket ink";
  else if (hex === "#0f0f12") what = "<- the plate";
  else if (r > 150 && g > 140 && b2 < 120) what = "<- YELLOW, the old palm?";
  console.log(`    ${hex}  ${String(n).padStart(5)} px  ${what}`);
}

// ---- the assertions --------------------------------------------------------
//
// A report that always succeeds is a report nobody reads. Each of these encodes
// a failure this icon has actually had.
const problems = [];
const want = [16, 24, 32, 48, 64, 128, 256];
const got = entries.map((e) => e.w);
for (const s of want) if (!got.includes(s)) problems.push(`no ${s}x${s} entry`);
for (const e of entries) {
  if (e.w !== e.h) problems.push(`${e.w}x${e.h} is not square`);
  if (!e.isPng) problems.push(`${e.w} is not a PNG`);
  if (!e.endOk) problems.push(`${e.w} payload runs past the end of the file`);
  if (e.ihdr && (e.ihdr.w !== e.w || e.ihdr.h !== e.h)) {
    problems.push(`${e.w} declares ${e.w} but encodes ${e.ihdr.w}x${e.ihdr.h}`);
  }
  if (e.ihdr && e.ihdr.color !== 6) problems.push(`${e.w} is not RGBA`);
}
const has = (hex) => counts.has(
  hex.slice(1).match(/../g).map((h) => parseInt(h, 16)).join(",")
);
if (!has("#7dd3c0")) problems.push("the mint caret is missing");
if (!has("#e9e9ee")) problems.push("the bracket ink is missing");
if (!has("#0f0f12")) problems.push("the plate is missing");
for (const [c] of counts) {
  const [r, g, b2] = c.split(",").map(Number);
  if (r > 150 && g > 140 && b2 < 120) problems.push(`yellow survived: ${c}`);
}

if (problems.length) {
  console.log(`\n  ${problems.length} problem(s):`);
  for (const p of problems) console.log(`    FAIL  ${p}`);
  process.exit(1);
}
console.log(`\n  ${entries.length} sizes, all square RGBA PNGs, all in bounds.`);
console.log("  the mark is the bracket pair and the mint caret; no yellow.");
