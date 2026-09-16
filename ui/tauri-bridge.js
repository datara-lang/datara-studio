// The seam between the interface and the desktop shell.
//
// The interface draws its own title bar, because the native one is a Windows
// caption bar drawn over an editor that has its own idea of what dark grey is.
// The bar itself lives in `ui/app.js`; this file is the only place that knows a
// shell exists, and it is deliberately the smallest possible surface:
//
//     window.__DS_SHELL__ = { minimize, toggleMaximize, close, onMaximizeChange }
//
// Everything else in the interface asks `if (window.__DS_SHELL__)`. In a browser
// that object is never created, so the title bar is never drawn and the page is
// byte-for-byte the page it was before this file existed. `ui/test/drive.mjs`
// asserts exactly that, because "the browser build still works" is the property
// that is easiest to lose silently.
//
// ---------------------------------------------------------------------------
// Why this calls `__TAURI_INTERNALS__.invoke` instead of using `window.__TAURI__`
//
// Tauri can bundle its whole JavaScript API into the page (`withGlobalTauri`).
// Measured: that bundle is 40,695 bytes, and it is injected into *every* page
// load. This interface was built as one self-contained request on purpose - the
// Datara runtime cannot time out a socket, so every extra subresource is a
// connection that can wedge the single-threaded accept loop (see the long note
// in `scripts/build-ui.mjs`). Adding 40 KB of JavaScript to reach four functions
// runs against that, so it is off, and this file calls the same function the API
// bundle would have called: `@tauri-apps/api`'s `invoke` is a thin wrapper over
// exactly this. `window.isTauri` - which the shell's own first initialisation
// script defines, on every page, before any page script runs - is the documented
// way to detect the shell and is what the check below uses.
//
// ---------------------------------------------------------------------------
// Why the failure is visible rather than silent
//
// An invoke from a page the shell did not serve is refused by the access-control
// list with "not allowed on origin", and the promise rejects. A title bar whose
// buttons quietly do nothing is the worst outcome available: it looks like the
// buttons are broken rather than like a permission is missing, and it is the
// exact complaint ("чтобы все кнопки работали") this bar exists to answer. So
// every rejected call is written into `#faults`, the same place the interface
// writes its own caught errors - the reason is then one click away instead of in
// a devtools console that a release build does not open.

(function () {
  "use strict";

  // Set by Tauri's first initialisation script on every page of the webview.
  // Absent in a browser, which is the whole point of testing for it.
  if (!window.isTauri) return;

  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") return;

  // Which window. The shell creates exactly one, labelled "main", and the window
  // plugin resolves an explicit label through `get_window(window, label)`. The
  // label is read from the metadata the shell injects, which is what
  // `@tauri-apps/api`'s `getCurrentWindow()` does.
  var label = "";
  try {
    label = internals.metadata.currentWindow.label;
  } catch (e) {
    label = "";
  }

  var lastError = "";

  function fault(what) {
    if (typeof document === "undefined") return;
    var host = document.getElementById("faults");
    if (!host) return;
    var line = document.createElement("div");
    line.className = "fault";
    line.textContent = "window control (" + what + ") was refused: " + lastError;
    line.title = "click to dismiss";
    line.onclick = function () { line.remove(); };
    host.appendChild(line);
  }

  function call(cmd, extra) {
    var args = { label: label };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) args[k] = extra[k];
    return internals.invoke("plugin:window|" + cmd, args).catch(function (e) {
      lastError = (e && (e.message || e)) + "";
      fault(cmd);
      throw e;
    });
  }

  // The maximise/restore glyph. There is no "window state changed" event wired up
  // here on purpose: the webview resizes with its window, so the DOM's own
  // `resize` event is the signal, and it arrives whether the change came from the
  // bar's button, a double-click on the drag region, Win+Up, or a snap. One
  // listener instead of an event subscription through the event plugin, which
  // would need another permission and another template of callback plumbing.
  var maximized = false;
  var watchers = [];

  function refresh() {
    return api.isMaximized().then(function (m) {
      if (m === maximized) return;
      maximized = m;
      for (var i = 0; i < watchers.length; i++) {
        try { watchers[i](m); } catch (e) { /* a watcher must not break the bar */ }
      }
    }).catch(function () { /* already reported by call() */ });
  }

  var api = {
    /** True, so `if (window.__DS_SHELL__)` is the whole test. */
    present: true,
    label: label,
    minimize: function () { return call("minimize"); },
    toggleMaximize: function () { return call("toggle_maximize").then(refresh); },
    close: function () { return call("close"); },
    isMaximized: function () { return call("is_maximized"); },
    /**
     * Called with `true` when the window becomes maximised and `false` when it
     * goes back. Returns an unsubscribe function.
     */
    onMaximizeChange: function (fn) {
      watchers.push(fn);
      return function () {
        var i = watchers.indexOf(fn);
        if (i >= 0) watchers.splice(i, 1);
      };
    },
    /** The last refusal, for the diagnostic line in Settings. */
    lastError: function () { return lastError; },
  };

  window.__DS_SHELL__ = api;

  // Drives the `.shell` grid: the title bar's 34 px row exists only when there is
  // a title bar. Set here rather than from the interface so the layout is correct
  // on the first paint - the interface would set it from an effect, which runs
  // after the first render, and the first frame would then be laid out for a bar
  // that is about to appear.
  document.documentElement.setAttribute("data-shell", "tauri");

  window.addEventListener("resize", refresh);
  refresh();
})();
