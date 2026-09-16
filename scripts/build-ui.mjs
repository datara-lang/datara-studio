// Assemble the interface into ONE self-contained HTML file.
//
// Run:  node scripts/build-ui.mjs
//
// Why this is not just an optimisation.
//
// The Datara runtime gives a socket no timeout, no non-blocking mode and no
// poll: `socket_recv` blocks until data arrives. A connection that connects and
// then sends nothing therefore blocks the server forever, because the accept
// loop is single-threaded. Measured, not theorised:
//
//     $ curl -s .../api/health                    -> 200
//     $ exec 3<>/dev/tcp/127.0.0.1/7878           # connect, send nothing
//     $ curl -s --max-time 5 .../api/health       -> times out
//     $ exec 3<&-                                 # close the idle socket
//     $ curl -s .../api/health                    -> 200 again
//
// A browser opens exactly those connections - preconnect sockets, sockets for a
// request it cancels - so the interface loaded to a blank page. `socket_recv(fd, 0)`
// was tried as a way to poll and it blocks too, so there is no receive timeout to
// be had (see .probe3).
//
// The fix is to remove the reason to open extra connections at all: if the page
// has no subresources, the browser opens one socket, sends one request, and gets
// everything. So React, htm, app.js and the wasm core are all inlined here, and
// the favicon is a data URI so the browser does not ask for it either.
//
// Consequence: this file is generated, and the sources in ui/ are the real
// sources. `ui/index.html` keeps the script tags for development; this build
// replaces them with the file contents.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readIco, pickIco, dataUri } from "./icon-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const studio = join(here, "..");
const ui = join(studio, "ui");

const index = readFileSync(join(ui, "index.html"), "utf8");

// The Datara mark, as data URIs. `index.html` carries the tokens rather than
// the bytes so that the artwork has one source - `assets/datara.ico` - and so
// that the file stays readable.
//
// Two sizes, and each is measured rather than assumed.
//
// 32 px backs everything small: the mark beside a `.dtr` file in the explorer,
// the mark in the title bar, and the browser tab. It is deliberately NOT the
// 16 px entry, which is what a 13-16 px drawing would suggest - a 16 px CSS box
// is up to 32 device px on a 200% display, so the 16 px entry was being
// upsampled 3x there. Measured, it is the worst of the seven entries at every
// display scaling; the numbers are in `ui/index.html` beside `.fico-dtr`.
//
// 128 px is for the title screen, where the mark is drawn at 56 px - which the
// 32 px entry used to be stretched up to, at 1.75x, and it showed. Also checked:
// this entry is a genuine downscale of the 256 px master, not an upscale of the
// 64 px one - it differs from a proper 256 -> 128 resample by a mean of 1.77 of
// 255 per channel, against 7.62 for a 64 -> 128 upscale.
const mark = readIco(join(studio, "assets", "datara.ico"));
const uri32 = dataUri(pickIco(mark, 32));
const uri128 = dataUri(pickIco(mark, 128));

// A literal `</script` inside a string would end the block early.
const guard = (js) => js.replace(/<\/script/gi, "<\\/script");

let inlined = 0;
const out = index
  .replace(/<script src="([^"]+)"><\/script>/g, (whole, src) => {
    // /ui/app.js -> ui/app.js, /vendor/x.js -> ui/vendor/x.js
    const rel = src.startsWith("/vendor/")
      ? "ui/vendor/" + src.slice("/vendor/".length)
      : src.replace(/^\//, "");
    const file = join(studio, rel);
    let body;
    try {
      body = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error("cannot inline " + src + " (looked for " + file + ")");
    }
    inlined++;
    return "<script>\n" + guard(body) + "\n</script>";
  })
  // the favicon is a data URI too: a real icon, but still no second request,
  // which is the whole point of the single-file build (see the note above)
  .replace(/__DATARA_FAVICON__/g, uri32)
  .replace(/__DATARA_ICON_32__/g, uri32)
  .replace(/__DATARA_ICON_128__/g, uri128);

if (inlined === 0) throw new Error("no script tags were inlined - did index.html change?");
if (out.includes("__DATARA_")) throw new Error("an icon token was left unsubstituted in index.html");

// The mark beside a .dtr file is drawn at 13-16 px CSS, so it needs at least
// 32 px of source: a 200% display asks for 32 device pixels and the browser
// upsamples anything smaller. This is a guard rather than a comment because
// backing it with the 16 px entry was a reasonable-looking choice that measured
// worst of the seven entries at every scaling, and cost 6.4x the crispness at
// 150% - a regression nothing else here would have caught.
const widthOf = (uri) => {
  const b = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) throw new Error("icon is not a PNG");
  return b.readUInt32BE(16);
};
const used = /\.fico-dtr\{background-image:url\((data:image\/png;base64,[^)]+)\)/.exec(out);
if (!used) throw new Error("no .fico-dtr background image in the built stylesheet");
const dtrIcon = widthOf(used[1]);
if (dtrIcon < 32) {
  throw new Error(".fico-dtr is backed by a " + dtrIcon + "px icon; it is drawn at up to " +
    "16px CSS and needs >= 32px for a 200% display");
}

const target = join(ui, "studio.html");
writeFileSync(target, out, "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log("");
console.log("  inlined   " + inlined + " script blocks");
console.log("  icon      .fico-dtr backed by the " + dtrIcon + "px entry");
console.log("  output    " + kb(statSync(target).size) + "   " + target);
console.log("  requests  the browser needs exactly 1 to load the interface");
