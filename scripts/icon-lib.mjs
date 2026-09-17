// scripts/icon-lib.mjs
//
// Read the Datara mark out of its .ico container.
//
// This module only *reads* ICO files - it does not know what the mark looks
// like. For years it read `assets/datara.ico` on the assumption that the file
// was the single source of the artwork, and it was not: that file held an
// orange palm in a yellow square, while the interface drew light brackets
// around a mint dot. Two marks were live at once and the taskbar showed the
// wrong one.
//
// The geometry now lives in `scripts/mark.mjs` (the same shape as
// `ui/icon.svg`), `scripts/build-icons.mjs` writes it to `ui/mark.ico`, and
// this module reads that back for the data URIs. So the chain is one shape ->
// one generated .ico -> everything else, and the reading half stays as simple
// as it was.
//
// The ICO format is a small directory of images. Each entry carries a width, a
// height, a byte size and an offset, and the modern entries are PNG files
// stored whole - which is why reading this needs no rasteriser and no image
// library. Header: 6 bytes. Each directory entry: 16 bytes.

import { readFileSync } from "node:fs";

/** The entries in an ICO file. */
export function readIco(file) {
  const b = readFileSync(file);
  if (b.length < 6 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) {
    throw new Error(file + " is not an ICO file");
  }
  const count = b.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    // a stored 0 means 256, which is the only reason this is not a plain read
    const w = b[e] || 256;
    const h = b[e + 1] || 256;
    const size = b.readUInt32LE(e + 8);
    const at = b.readUInt32LE(e + 12);
    if (at + size > b.length) {
      throw new Error(file + ": entry " + i + " runs past the end of the file");
    }
    const data = b.subarray(at, at + size);
    // PNG magic. An older ICO may hold a bare DIB instead, which this refuses
    // to guess at rather than emitting a file no browser can read.
    const png = data.length > 8 && data.readUInt32BE(0) === 0x89504e47;
    out.push({ w, h, data, png });
  }
  return out;
}

/** The PNG entry closest to `size` without going under it, else the largest. */
export function pickIco(entries, size) {
  const png = entries.filter((e) => e.png);
  const pool = png.length ? png : entries;
  const over = pool.filter((e) => e.w >= size).sort((a, b) => a.w - b.w);
  if (over.length) return over[0];
  return pool.slice().sort((a, b) => b.w - a.w)[0];
}

/** A PNG entry as a data URI, for CSS and for the favicon. */
export function dataUri(entry) {
  if (!entry.png) {
    throw new Error("entry " + entry.w + "x" + entry.h + " is a raw bitmap, not a PNG");
  }
  return "data:image/png;base64," + entry.data.toString("base64");
}
