// Boot test: load the REAL built interface in a DOM and see whether it mounts.
//
// Run:  node ui/test/boot.test.mjs
//
// The render test renders the component tree from source. This one loads
// `ui/studio.html` - the actual artifact the browser receives, scripts and all -
// into a DOM and executes it. That is the difference between "the components are
// correct" and "the page comes up".
//
// It exists because the page came up black in a real browser and nothing in the
// test suite noticed. The lesson was not to write more assertions about the
// source; it was to test the thing that ships.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createContext, runInContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const studio = join(here, "..", "..");

let linkedom;
try {
  linkedom = await import("linkedom");
} catch (e) {
  console.log("linkedom is not installed - run: npm install --no-save linkedom");
  process.exit(2);
}

const html = readFileSync(join(studio, "ui", "studio.html"), "utf8");
const { window, document } = linkedom.parseHTML(html);

// linkedom does not implement everything react-dom touches; supply the gaps
// rather than pretending they are not needed. `self` and `globalThis` matter
// most: the UMD bundles resolve their global as `this || self`, so without them
// React fails with "Cannot set properties of undefined (setting 'React')" -
// which is a harness artefact, not a page bug, and cost a round trip to notice.
window.self = window;
window.globalThis = window;
window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
if (!window.MutationObserver) {
  window.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
window.WebAssembly = WebAssembly;
window.TextEncoder = TextEncoder;
window.TextDecoder = TextDecoder;
window.performance = performance;
window.AbortController = AbortController;
window.atob = (s) => Buffer.from(s, "base64").toString("binary");
window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
window.fetch = () => Promise.reject(new Error("no network in the boot test"));

// Collect anything the page reports.
const errors = [];
const logs = [];
window.addEventListener("error", (e) => errors.push("window.onerror: " + (e.message || e.error)));
window.addEventListener("unhandledrejection", (e) => errors.push("unhandled rejection: " + e.reason));
const origError = console.error;
console.error = (...a) => { logs.push(a.join(" ")); };
window.console = console;

const scripts = [...document.querySelectorAll("script")];
console.log("boot test on the built artifact");
console.log("  html          " + html.length + " bytes");
console.log("  script blocks " + scripts.length);

let threw = null;
const ctx = createContext(window);
for (let i = 0; i < scripts.length; i++) {
  const code = scripts[i].textContent;
  if (!code || !code.trim()) continue;
  try {
    runInContext(code, ctx, { filename: "studio.html#script" + (i + 1) });
  } catch (e) {
    threw = "script " + (i + 1) + " (" + code.length + " bytes): " + e.message;
    break;
  }
}
console.error = origError;

// React 18 schedules the initial render rather than doing it synchronously, so
// checking #root immediately after the scripts run always finds it empty. Let
// the scheduler and any pending microtasks run first.
await new Promise((r) => setTimeout(r, 250));

console.log("");
if (threw) {
  console.log("  FAIL  a script threw: " + threw);
} else {
  console.log("  PASS  all " + scripts.length + " script blocks executed");
}
if (errors.length) {
  for (const e of errors) console.log("  FAIL  " + e);
} else {
  console.log("  PASS  no window errors, no unhandled rejections");
}

// did anything land in #root?
const root = document.getElementById("root");
const inner = root ? root.innerHTML : "";
console.log("");
console.log("  #root children " + (root ? root.childElementCount : -1));
console.log("  #root bytes    " + inner.length);
// A cold boot has to show the TITLE SCREEN, not the editor. The editor is
// deliberately not mounted until a file is open, so looking for `edscroll` here
// was asserting a state that no longer exists - and `class="rail"` had not been
// in the markup at all, so that assertion could never have passed either. The
// editor surface is covered by ui/test/editor.test.mjs, which mounts it.
const mounted = inner.includes('class="shell"');
const hasIntent = inner.includes('class="intent"');
// the search affordance is a hint span, not a placeholder: it opens the palette
// rather than filtering inline
const hasSearch = inner.includes('class="searchhint"');
const hasTitle = inner.includes('class="welcome"');
const hasProject = inner.includes("Create new project");
const hasFolder = inner.includes("Open folder");
const hasFile = inner.includes("Open file");
const editorDeferred = !inner.includes("edscroll");
const say = (good, name) => console.log((good ? "  PASS  " : "  FAIL  ") + name);

say(mounted, "the shell mounted into #root");
say(hasIntent, "the intent bar mounted");
say(hasSearch, "the search affordance is there, centred, saying just search");
say(hasTitle, "the title screen is what a cold boot shows");
say(hasProject && hasFolder && hasFile,
    "it offers Create new project, Open folder and Open file");
say(editorDeferred, "the editor stays unmounted until a file is open");
if (!mounted && inner.length) {
  console.log("  first 300 chars: " + inner.slice(0, 300));
}

console.log("");
const ok = !threw && errors.length === 0 && mounted && hasIntent && hasSearch
        && hasTitle && hasProject && hasFolder && hasFile && editorDeferred;
console.log(ok ? "boot OK" : "boot FAILED");
process.exit(ok ? 0 : 1);
