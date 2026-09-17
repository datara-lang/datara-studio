// Generate every piece of icon artwork the studio uses, from one geometry.
//
// Run:  node scripts/build-icons.mjs
//
// History, because this file has been wrong twice.
//
// The first version *drew* the mark here - a rounded square, two brackets, a
// dot, evaluated as signed distances because the machine has no image library.
// It worked, but it was a hand-rolled approximation of a design that lived
// somewhere else.
//
// The second version deleted all of that and read `assets/datara.ico` directly,
// on the argument that three approximations of one design are three designs. The
// argument was right and the conclusion was wrong: `assets/datara.ico` turned out
// to be a *fourth* design. It is an orange-and-yellow palm inside a yellow
// rounded square, while the interface draws two light brackets around a MINT dot
// - so the window, the taskbar, the browser tab and the title screen showed one
// mark, and every `.dtr` file in the explorer showed another. The taskbar icon
// was the one that did not match.
//
// Now the geometry is in `scripts/mark.mjs`, which is the same shape
// `ui/icon.svg` describes, and this script only asks it for the artefacts. One
// design, five outputs, and `scripts/icon-sheet.mjs` renders them at their real
// sizes on both a light and a dark surface so a wrong one is visible rather than
// shipped.
//
// Outputs:
//   ui/mark.ico                     the source .ico, checked in beside the UI
//   src-tauri/icons/*.png           what Tauri's bundler asks for by name
//   src-tauri/icons/icon.ico        what Windows shows in the taskbar and Alt-Tab
//   assets/datara.ico               the historical path, kept for the favicon
//   assets/datara-mark.png          the 256px master the docs reference

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markPng, markIco, markPng as png } from "./mark.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = join(HERE, "..");

const ICONS = join(STUDIO, "src-tauri", "icons");
const ASSETS = join(STUDIO, "assets");
const UI = join(STUDIO, "ui");
for (const d of [ICONS, ASSETS, UI]) mkdirSync(d, { recursive: true });

// ---- src-tauri/icons --------------------------------------------------------
//
// The four names `tauri.conf.json` lists, plus `icon.png` and `icon.ico` which
// the bundler picks up on its own.
const TAURI_PNGS = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 256],
];
const written = [];
for (const [name, size] of TAURI_PNGS) {
  const bytes = markPng(size);
  writeFileSync(join(ICONS, name), bytes);
  written.push(["src-tauri/icons/" + name, size + "x" + size, bytes.length]);
}

// Windows reads the multi-resolution ICO for the taskbar, the Alt-Tab list and
// Explorer. Handing it seven real sizes is what stops it upsampling: a
// single-size ICO looks soft everywhere except the one size it was built at.
const ico = markIco();
writeFileSync(join(ICONS, "icon.ico"), ico);
written.push(["src-tauri/icons/icon.ico", "16..256", ico.length]);

// ---- the shared source ico --------------------------------------------------
//
// `scripts/build-ui.mjs` reads this one for the favicon and for `.fico-dtr`, so
// the browser tab and the mark beside a file are the same artwork as the window.
const srcIco = join(UI, "mark.ico");
writeFileSync(srcIco, ico);
writeFileSync(join(ASSETS, "datara.ico"), ico);
written.push(["ui/mark.ico", "16..256", ico.length]);
written.push(["assets/datara.ico", "16..256", ico.length]);

// ---- the 256px master, for docs and the title screen -----------------------
const master = markPng(256);
writeFileSync(join(ASSETS, "datara-mark.png"), master);
written.push(["assets/datara-mark.png", "256x256", master.length]);

// ---- `ui/icon.svg` and the rendered mark must agree -------------------------
//
// The SVG is documentation and a hand-reference, not a build input - but if the
// two ever diverge the icon is wrong, and the divergence is invisible until
// someone looks at both. So the colours are checked here.
const svg = (await import("node:fs")).readFileSync(join(UI, "icon.svg"), "utf8");
const HEX = { "bracket ink": "#E9E9EE", "node": "#7DD3C0", "plate": "#0F0F12" };
for (const [what, hex] of Object.entries(HEX)) {
  if (!svg.toLowerCase().includes(hex.toLowerCase())) {
    console.error("");
    console.error("  ui/icon.svg no longer contains " + hex + " (" + what + ").");
    console.error("  The SVG and scripts/mark.mjs describe one design; change both");
    console.error("  or the icon stops matching the interface.");
    process.exit(1);
  }
}

console.log("");
for (const [name, size, bytes] of written) {
  console.log("  " + name.padEnd(28) + size.padEnd(12) + String(bytes).padStart(7) + " B");
}
console.log("");
console.log("  one geometry, " + written.length + " artefacts.");
console.log("  to look at them:  node scripts/icon-sheet.mjs shots/icons");
