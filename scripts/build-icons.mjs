// scripts/build-icons.mjs
//
// Generate the desktop icon set from `assets/datara.ico`.
//
// This script used to *draw* the mark: a rounded square, two bracket strokes
// and a dot, evaluated as signed distances and rasterised by hand because the
// machine has no image library. That was the wrong source of truth. The window
// icon, the browser tab and the mark beside a `.dtr` file all have to be the
// same artwork, and three approximations of one design are three designs -
// which is exactly what the window ended up showing. The real icon is now the
// input, and this script only re-packages it into the names Tauri asks for.
//
// Output: src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico}
// Run:    node scripts/build-icons.mjs

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIco, pickIco } from "./icon-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = join(HERE, "..");
const SRC = join(STUDIO, "assets", "datara.ico");
const OUT = join(STUDIO, "src-tauri", "icons");

const entries = readIco(SRC);
mkdirSync(OUT, { recursive: true });

// The four PNG names tauri.conf.json lists, plus `icon.png` which the bundler
// picks up on its own.
const targets = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 256],
];

for (const [name, size] of targets) {
  const e = pickIco(entries, size);
  writeFileSync(join(OUT, name), e.data);
  console.log("  " + name.padEnd(16) + e.w + "x" + e.h + "  " + e.data.length + " B");
}

// Windows shows `icon.ico` in the taskbar and the Alt-Tab list, so it is copied
// whole rather than rebuilt from one size: the multi-resolution file is what
// lets the shell pick the right one per context.
copyFileSync(SRC, join(OUT, "icon.ico"));
console.log("  icon.ico         copied whole from assets/datara.ico");
console.log("datara icons written to src-tauri/icons");
