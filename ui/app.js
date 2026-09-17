// Datara Studio - interface
//
// Architecture, and why it is split this way:
//
//   * **Rust / WASM** owns the document and the lexer. Offset arithmetic,
//     line indexing and tokenising are the three things that are genuinely
//     faster there, and they are the three things the editor does on every
//     keystroke. See crates/textcore.
//   * **React** owns the chrome: title bar, rail, file tree, panels, status bar,
//     command palette. These change rarely and benefit from declarative
//     rendering.
//   * **Direct DOM** owns the text surface. React must not re-render a 20k-line
//     highlighted document - that is the one place where the declarative model
//     is the wrong tool. The editor is therefore mounted imperatively into a
//     div that React renders once and never touches again.
//
// The rule of thumb: React renders things a person clicks; the text surface is
// rendered by whoever can do it fastest, and that is not React.

const { useState, useEffect, useRef, useCallback, useMemo, memo } = React;
const html = htm.bind(React.createElement);

// The desktop shell, when this page is running inside one.
//
// `ui/tauri-bridge.js` creates this object and is loaded before this file, so the
// value is settled by the time this line runs. In a browser it is never created
// and this is `null` - which is how the window controls know whether there is a
// window to control. `CapControls` is the only component that reads it.
const SHELL = (typeof window !== "undefined" && window.__DS_SHELL__) || null;

// --------------------------------------------------------------- core build

// Datara Studio, Core: the same interface with the companion taken out.
//
// Not a second page and not a stripped bundle. `scripts/build-ui.mjs` sets
// `window.__DS_CORE__` when it is asked for the core variant, and everything
// that follows from that is in this file: two tabs are not drawn, the start-the-
// companion action is not offered, and the plug in the bar is not rendered. The
// compiler, the editor, the tree, the explorer, Layout, Project, git and search
// are untouched and identical, because none of them were ever AI features.
//
// The reason it is a flag rather than a second build of the source: the studio
// has exactly one interface, and a fork is how the two get to disagree. A
// conditional that is read in four places can be audited; two copies of a
// 4000-line file cannot.
const CORE = (typeof window !== "undefined" && window.__DS_CORE__) === true;
const core = CORE;

// ---------------------------------------------------------------- wasm core

let TC = null;              // textcore exports
let docHandle = 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

// Indexed by the token kinds in crates/textcore/src/lib.rs, in that order.
// The last entry is a `{...}` hole in an `fmt"..."` literal.
const TOKEN_CLASS = ["", "k", "t", "s", "c", "n", "f", "p", "v"];

// The module is embedded as base64 by scripts/build-wasm.mjs rather than
// fetched, so that the whole interface is ONE file with no subresources.
//
// That used to be forced twice over: the server could not serve a binary at all
// (`file_read` returns zero bytes on non-UTF-8 content), and a browser fetching
// a subresource opens a connection that can wedge the single-threaded server.
// forgen 1.4.0 added `file_read_bytes`, so the first obstacle is gone - but the
// second one is not (see SEAM-6), and the single file is what makes the
// interface immune to it. So it stays, now for one reason instead of two.
async function loadTextCore() {
  const b64 = window.__TEXTCORE_B64;
  if (!b64) throw new Error("vendor/textcore.js not built - run: node scripts/build-wasm.mjs");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  TC = instance.exports;
  docHandle = TC.doc_new();
  return TC.textcore_version();
}

function wasmBytes(s) {
  const b = enc.encode(s);
  const p = TC.alloc(b.length || 1);
  new Uint8Array(TC.memory.buffer).set(b, p);
  return [p, b.length];
}

function coreSet(text) {
  const [p, n] = wasmBytes(text);
  TC.doc_set(docHandle, p, n);
  TC.dealloc(p, n);
}

/** Tokenise the document and return per-line HTML. */
function coreHighlight(text) {
  coreSet(text);
  const count = TC.lex(docHandle);
  const view = new Uint32Array(TC.memory.buffer, TC.lex_ptr(), count * 3);
  const lines = [[]];
  for (let i = 0; i < count; i++) {
    const start = view[i * 3], len = view[i * 3 + 1], kind = view[i * 3 + 2];
    const cls = TOKEN_CLASS[kind] || "";
    const raw = text.slice(start, start + len);
    const parts = raw.split("\n");
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) lines.push([]);
      if (parts[k]) {
        const esc = parts[k].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        lines[lines.length - 1].push(cls ? '<span class="' + cls + '">' + esc + "</span>" : esc);
      }
    }
  }
  return { lines: lines.map((a) => a.join("")), tokens: count };
}

// ---------------------------------------------------------------- editor surface
//
// Imperative on purpose. React renders the container; everything inside is
// managed here, because a per-keystroke React render of a large document is the
// single biggest performance mistake an editor can make.

const Editor = {
  el: null, ta: null, hl: null, gut: null, ghost: null, squig: null, tip: null,
  // `lines` is what gets rendered - the highlighter returns HTML, with each
  // token wrapped in a span. `srcLines` is the same document as plain text, and
  // it exists because the two were the same field until now: `wordAt` read
  // `this.lines[line - 1]` to find the identifier under the caret, so after the
  // lexer loaded it was reading markup. Measured on `    let store = 7`, with the
  // caret inside `store`: `wordAt(2, 10)` returned **`span`**, taken out of
  // `<span class="k">let</span>`. F12, hover help and Alt+F7 all resolve through
  // it, so all three were answering about HTML tags. Before the wasm core
  // arrived, `paintPlain` set plain text and everything worked - which is why it
  // looked like a feature that sometimes misbehaves rather than a broken one.
  lines: [], srcLines: [], marks: {}, ranges: [], symbols: [], ghostText: "", pendingText: null,
  sel: { line: 1, col: 1 },
  comp: null, completer: null, highlighter: coreHighlight, lh: 21, cw: 9.1, fontSize: 13.5,
  onCursor: null, onInput: null, onLex: null, onZoom: null, onHoverAsk: null,
  // Set by `acceptComplete` for a snippet that has a body to step into, and
  // consumed by `takeStop` on the next plain Tab. Declared here so the field
  // exists before the first snippet is inserted.
  pendingStop: null,

  mount(container, handlers) {
    this.onCursor = handlers.onCursor;
    this.onInput = handlers.onInput;
    this.onLex = handlers.onLex;
    this.onZoom = handlers.onZoom;
    this.onHoverAsk = handlers.onHoverAsk;

    container.innerHTML = "";
    const scroll = document.createElement("div");
    scroll.className = "edscroll";
    // There is no current-line band. There used to be one - a full-width strip
    // that jumped to the caret's line on every keystroke and every arrow key -
    // and it read as a highlight that slid around the document rather than as a
    // position indicator. The line *number* is still highlighted in the gutter
    // (`.gutter div.cur`), which says where the caret is without painting a bar
    // across the code, and the gutter does not move.
    scroll.innerHTML =
      '<div class="gutterback"></div>' +
      '<div class="gutter"></div>' +
      '<pre class="hl"></pre>' +
      '<div class="squig"></div>' +
      '<textarea class="code" spellcheck="false" wrap="off"></textarea>' +
      '<div class="ghost"></div>' +
      '<div class="comp"></div>' +
      '<div class="tip"></div>';
    container.appendChild(scroll);
    this.el = scroll;
    this.ta = scroll.querySelector(".code");
    this.hl = scroll.querySelector(".hl");
    this.gut = scroll.querySelector(".gutter");
    this.gback = scroll.querySelector(".gutterback");
    this.ghost = scroll.querySelector(".ghost");
    this.squig = scroll.querySelector(".squig");
    this.tip = scroll.querySelector(".tip");

    this.ta.addEventListener("input", () => {
      this.repaint();
      this.updateComplete();
      this.onInput && this.onInput(this.ta.value);
    });
    // A click elsewhere in the buffer means the snippet is no longer what the
    // person is working on, so the pending Tab stop is dropped. Same for the
    // caret being moved by anything other than Tab.
    this.ta.addEventListener("click", () => { this.updateCursor(); this.setComplete(null); this.pendingStop = null; });
    // Ctrl+click goes to the declaration, which is what every editor does and
    // what a hand reaches for before remembering there is a key for it.
    this.ta.addEventListener("click", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const { line, col } = this.posFromEvent(e);
      const word = this.wordAt(line, col);
      if (!word) return;
      this.hideTip();
      this.onGotoDef && this.onGotoDef(word);
    });
    this.ta.addEventListener("keyup", () => this.updateCursor());
    this.ta.addEventListener("keydown", (e) => this.onKey && this.onKey(e));
    this.ta.addEventListener("scroll", () => {
      // The gutter is a sibling of the textarea inside the scroller, so it has
      // to be pinned in BOTH axes: vertically (so it never scrolls with the
      // text) and horizontally (so long lines never slide under it). The first
      // version only translated Y, which made the left edge a moving target
      // the moment a line overflowed - "no clean corner", as it was reported.
      this.gut.style.transform = "translate(" + -this.ta.scrollLeft + "px," + -this.ta.scrollTop + "px)";
      this.gback.style.transform = "translate(" + -this.ta.scrollLeft + "px," + -this.ta.scrollTop + "px)";
      // The highlight, ghost, squiggle and current-line layers share the
      // textarea's own scroll, so the gutter transform is the only one that
      // needs compensating.
      this.hideTip();
    });

    // Ctrl+wheel zooms the code, which is what every editor does and what a
    // reader of a dense file reaches for without thinking. Plain wheel still
    // scrolls, so this never steals the ordinary gesture.
    scroll.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = Math.max(9, Math.min(28, this.fontSize + (e.deltaY < 0 ? 0.5 : -0.5)));
      const rounded = Math.round(next * 2) / 2;
      if (rounded !== this.fontSize) {
        this.setType(rounded);
        this.onZoom && this.onZoom(rounded);
      }
    }, { passive: false });

    this.ta.addEventListener("mousemove", (e) => this.hoverAt(e));
    this.ta.addEventListener("mouseleave", () => this.hideTip());

    // Paint anything that arrived before the surface existed. The title screen
    // holds this space until a file is open, so a file opened during boot - the
    // common case - lands here with its text already waiting. Goes through
    // `setText` so the caret and the type scale are set the same way.
    if (this.pendingText !== null) this.setText(this.pendingText);
  },

  /** Drop the surface. The DOM it pointed at is gone.
   *
   * Without this, `live()` keeps answering "yes, I can paint" while pointing at
   * detached nodes, and every guard in this file becomes decorative.
   */
  unmount() {
    this.el = null;
    this.ta = null;
    this.hl = null;
    this.gut = null;
    this.gback = null;
    this.ghost = null;
    this.squig = null;
    this.tip = null;
  },

  /** Whether the surface exists in the document right now.
   *
   * The editor is only mounted once a file is open - the title screen occupies
   * that space until then - so every entry point below can be reached while
   * there is nothing to draw on. `setMarks` in particular is called from an
   * effect that runs on the very first render, which made the whole app throw
   * before it had drawn anything at all: a blank window on first launch, and no
   * error the user could see. State is still recorded while unmounted, so the
   * first `mount` paints everything that arrived in the meantime.
   */
  live() { return !!(this.ta && this.el); },

  setText(text) {
    // Recorded even when there is no surface yet. The editor is only mounted
    // once something is open, and on a cold boot the file arrives from the
    // server *before* React has rendered the surface for it. Dropping the text
    // at that point is exactly how "the file is open, the breadcrumb says so,
    // and the code area is empty" happens. `mount` paints whatever landed here.
    this.pendingText = text;
    if (!this.live()) return;
    this.ta.value = text;
    // A freshly loaded document starts at the top. Assigning `.value` parks the
    // caret at the end of the file, which put the cursor on the last line of
    // every file you opened - visible in the status bar as "26:1" on a file you
    // had just double-clicked.
    this.ta.selectionStart = 0;
    this.ta.selectionEnd = 0;
    this.repaint();
  },
  getText() { return this.live() ? this.ta.value : ""; },
  focus() { if (this.live()) this.ta.focus(); },

  setMarks(marks) { this.marks = marks || {}; if (this.live()) this.repaint(); },

  /** Exact problem ranges, for the red squiggles.
   *
   * `marks` is line-level and paints a band across the whole line. That is right
   * for "this line has a problem" and wrong for "this argument is the problem",
   * which is what the compiler actually tells us: it prints a caret span under
   * the offending text. So ranges are drawn on their own layer, positioned from
   * line/column like the ghost text, rather than by rewriting the highlighted
   * markup - slicing HTML around a span boundary is how you corrupt it.
   */
  setRanges(ranges) { this.ranges = ranges || []; this.paintSquiggles(); },

  /** Font size drives every geometry constant, so they all move together. */
  setType(fontSize, wrap) {
    if (!this.live()) return;
    this.fontSize = fontSize;
    this.lh = Math.round(fontSize * 1.55);
    this.cw = Math.round(fontSize * 0.674 * 100) / 100;
    this.el.style.setProperty("--lh", this.lh + "px");
    for (const n of this.el.querySelectorAll(".hl,.code,.ghost,.gutter")) {
      n.style.fontSize = fontSize + "px";
      n.style.lineHeight = this.lh + "px";
    }
    if (wrap !== undefined) this.ta.style.whiteSpace = wrap ? "pre-wrap" : "pre";
    this.repaint();
  },

  /** Completion. Local-first on purpose: keywords, types and this file's own
   * symbols come from data the editor already holds, so the list is instant and
   * never waits on the network. Companion suggestions fold in when they arrive. */
  updateComplete() {
    if (!this.completer) return;
    const src = this.ta.value;
    const pos = this.ta.selectionStart;
    const before = src.slice(0, pos);
    // `obj.` and `obj.pa` are the same question, and its answer is the
    // receiver's members - not the file's whole vocabulary. The receiver is
    // what the completer has to be asked about, so it is captured here instead
    // of being thrown away with the dot.
    const member = before.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
    const receiver = member ? member[1] : null;
    // A capitalised prefix has to open the list too. `Task` and `Task {` are how
    // a type is written, and the old pattern needed a lowercase word boundary,
    // so the first letter of every type name produced no list at all.
    const m = before.match(/[A-Za-z_]\w*$/);
    const word = m ? m[0] : "";
    // Two letters is the threshold for a name. After a dot there is nothing to
    // type before the list is useful, so the threshold does not apply there.
    if (!receiver && word.length < 2) { this.setComplete(null); return; }
    const items = this.completer(word, { src, pos, receiver });
    // The cap is applied after ranking. Cutting to nine first would keep
    // whichever nine happened to be built first, which is not the same nine.
    this.setComplete(items.length ? { items: items.slice(0, 9), sel: 0, word } : null);
  },

  setComplete(v) {
    this.comp = v;
    const box = this.el.querySelector(".comp");
    if (!box) return;
    if (!v) { box.style.display = "none"; box.innerHTML = ""; return; }
    const { line, col } = this.sel;
    box.style.display = "block";
    box.style.left = 18 + (col - 1) * this.cw + "px";
    box.style.top = 12 + line * this.lh + "px";
    box.innerHTML = v.items
      .map((it, i) => '<div class="ci' + (i === v.sel ? " on" : "") + '">'
        + "<span>" + it.label.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</span>"
        + (it.hint ? '<span class="hint">' + it.hint + "</span>" : "") + "</div>")
      .join("");
  },

  acceptComplete() {
    if (!this.comp) return false;
    const it = this.comp.items[this.comp.sel];
    if (!it) return false;
    const ta = this.ta, pos = ta.selectionStart, w = this.comp.word;
    const from = pos - w.length;
    // A snippet is written relative to the line it starts on, so the line's own
    // indentation is prefixed to every continuation line here. That is what
    // makes `fn` expand correctly at column 0 and nested inside a `behavior`.
    let text = it.insert;
    if (it.caret !== undefined && text.indexOf("\n") >= 0) {
      const [a] = this.lineBounds(from);
      const indent = (ta.value.slice(a, from).match(/^[ \t]*/) || [""])[0];
      if (indent) text = text.split("\n").join("\n" + indent);
    }
    // The placeholder is always on the first line, which is why indenting the
    // continuation lines above cannot move it.
    const at = from + (it.caret === undefined ? text.length : it.caret);
    ta.value = ta.value.slice(0, from) + text + ta.value.slice(pos);
    ta.selectionStart = at;
    // Selecting the placeholder is what makes the template usable: the next
    // character typed replaces the name rather than landing after it.
    ta.selectionEnd = it.select ? Math.min(at + it.select, from + text.length) : at;
    // The second stop, for the shapes that have somewhere to go afterwards: the
    // empty body. Recorded as a LINE and a COLUMN rather than a buffer offset,
    // because the placeholder name is meant to be replaced: `name` is four
    // characters and `probe` is five, so after the rename every offset below the
    // name has shifted by one - including the one that was supposed to point at
    // the body. A line-and-column stop does not move when the name changes
    // length, which is the whole reason it is stored this way.
    if (it.stop !== undefined) {
      // Where the stop sits inside the snippet itself.
      const before = text.slice(0, it.stop).split("\n");
      const linesBefore = before.length - 1;
      const col = before[before.length - 1].length;
      // And where the snippet starts, in whole lines. `from` is the buffer
      // offset the snippet was inserted at, so the number of newlines between
      // the top of the buffer and there is the snippet's starting line.
      const firstLine = ta.value.slice(0, from).split("\n").length;
      this.pendingStop = { line: firstLine + linesBefore, col };
    } else {
      this.pendingStop = null;
    }
    this.setComplete(null);
    this.repaint();
    this.onInput && this.onInput(ta.value);
    return true;
  },

  moveComplete(d) {
    if (!this.comp) return false;
    this.comp.sel = (this.comp.sel + d + this.comp.items.length) % this.comp.items.length;
    this.setComplete(this.comp);
    return true;
  },

  /** The second stop of a snippet: the caret goes to the body.
   *
   * Returns true when it moved, so the caller can stop before inserting an
   * indent. The offer is dropped the moment anything else happens - a keystroke
   * that is not Tab, a click, a file switch - because a stray Tab ten lines
   * later jumping the caret back into a `fn` would be worse than no stop at all.
   *
   * The stored line/column is turned back into an offset here, against the
   * buffer as it stands now. Typing a longer name than the placeholder does not
   * move the target, and neither does typing a shorter one. If the buffer no
   * longer has that line at all (a file switch, or the snippet was deleted),
   * the stop is refused and Tab falls through to ordinary indentation, which is
   * what the key means everywhere else.
   */
  takeStop() {
    const s = this.pendingStop;
    this.pendingStop = null;
    if (!s || !this.ta) return false;
    const lines = this.ta.value.split("\n");
    if (s.line < 1 || s.line > lines.length) return false;
    let at = 0;
    for (let i = 0; i < s.line - 1; i++) at += lines[i].length + 1;
    // Never past the end of the target line: an empty body line is shorter than
    // the column the snippet asked for, and the caret has to land in it either
    // way rather than at the start of the next line.
    at += Math.min(s.col, lines[s.line - 1].length);
    this.ta.focus();
    this.ta.selectionStart = at;
    this.ta.selectionEnd = at;
    this.repaint();
    return true;
  },
  setSymbols(syms) { this.symbols = syms || []; },
  setGhost(g) { this.ghostText = g || ""; this.paintGhost(); },
  onKey: null,

  repaint() {
    if (!this.live()) return;
    const text = this.ta.value;

    // The wasm core loads asynchronously. Effects run before it arrives, and an
    // exception thrown from an effect makes React unmount the whole tree - which
    // is a black screen, not a degraded editor. So until the core is here, paint
    // plain text: no highlighting, but a working editor that cannot throw.
    if (!TC) {
      this.paintPlain(text);
      return;
    }

    const t0 = performance.now();
    const { lines, tokens } = (this.highlighter || coreHighlight)(text);
    this.lines = lines;
    // The plain document, kept alongside the rendered one. See the note on the
    // field: anything that wants to *read* the code rather than draw it must use
    // this, not `lines`.
    this.srcLines = text.split("\n");
    this.onLex && this.onLex(performance.now() - t0, tokens, text.length);

    const marks = this.marks;
    this.hl.innerHTML = lines
      .map((l, i) => {
        const m = marks[i];
        return m ? '<span class="' + m + '">' + (l || " ") + "</span>" : l;
      })
      .join("\n");

    this.paintGutter(lines.length);
    this.ta.style.height = lines.length * this.lh + 28 + "px";
    this.paintGhost();
    this.paintSquiggles();
    this.updateCursor();
  },

  /** Fallback rendering with no lexer: escaped plain text only. */
  paintPlain(text) {
    if (!this.live()) return;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = text.split("\n");
    this.lines = lines;
    this.srcLines = lines;
    this.hl.innerHTML = lines.map((l) => esc(l) || " ").join("\n");
    this.paintGutter(lines.length);
    this.ta.style.height = lines.length * this.lh + 28 + "px";
    this.paintGhost();
    this.paintSquiggles();
    this.updateCursor();
  },

  paintGutter(count) {
    if (!this.live()) return;
    const marks = this.marks;
    this.gut.innerHTML = new Array(count)
      .fill(0)
      .map((_, i) => {
        const m = marks[i];
        const c = m === "errline" ? ' class="err"' : m === "warnline" ? ' class="warn"' : "";
        return "<div" + c + ">" + (i + 1) + "</div>";
      })
      .join("");
  },

  updateCursor() {
    if (!this.live()) return;
    const ta = this.ta;
    const upto = ta.value.slice(0, ta.selectionStart);
    const line = upto.split("\n").length;
    const col = upto.length - upto.lastIndexOf("\n");
    this.sel = { line, col };
    // the caret's line is marked by its number, not by a band across the code
    const kids = this.gut.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.remove("cur");
    if (kids[line - 1]) kids[line - 1].classList.add("cur");
    this.paintGhost();
    this.onCursor && this.onCursor(line, col);
  },

  /** The companion's suggestion, drawn inline at the caret.
   *
   * It carries a "Tab" chip. An inline suggestion with no visible way to accept
   * it is indistinguishable from text that is already in the file - which is
   * the difference between a completion you can take and a typo you cannot
   * explain. Copilot solved this the same way and for the same reason.
   */
  paintGhost() {
    if (!this.live()) return;
    if (!this.ghostText) { this.ghost.innerHTML = ""; return; }
    const { line, col } = this.sel;
    const x = 18 + (col - 1) * this.cw;
    const y = 12 + (line - 1) * this.lh;
    this.ghost.innerHTML =
      '<span style="position:absolute;left:' + x + "px;top:" + y + 'px">' +
      this.ghostText.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
      '<i class="ghostkey">Tab</i></span>';
  },

  /** One underline per problem, at the exact column the compiler reported. */
  paintSquiggles() {
    if (!this.squig) return;
    if (!this.ranges.length) { this.squig.innerHTML = ""; return; }
    let html = "";
    for (const r of this.ranges) {
      const x = 18 + (r.col - 1) * this.cw;
      const y = 12 + (r.line - 1) * this.lh + this.lh - 3;
      const w = Math.max(this.cw * 1.5, (r.len || 1) * this.cw);
      html += '<i class="' + (r.severity === "warning" ? "w" : "e")
            + '" style="left:' + x + "px;top:" + y + "px;width:" + w + 'px"></i>';
    }
    this.squig.innerHTML = html;
  },

  /** Character position from a mouse event, using the monospace grid.
   *
   * The textarea has no per-character hit testing, but a monospace grid means
   * the position is arithmetic - the same arithmetic the ghost text and the
   * completion popup already use, so all three agree about where column N is.
   */
  posFromEvent(e) {
    const rect = this.ta.getBoundingClientRect();
    const x = e.clientX - rect.left + this.ta.scrollLeft;
    const y = e.clientY - rect.top + this.ta.scrollTop;
    const line = Math.max(1, Math.floor((y - 12) / this.lh) + 1);
    const col = Math.max(1, Math.floor((x - 18) / this.cw) + 1);
    return { line, col };
  },

  wordAt(line, col) {
    // `srcLines`, not `lines`: the rendered lines are HTML. See the note on the
    // field - this single word was the whole of the defect.
    const text = this.srcLines[line - 1];
    if (text === undefined) return "";
    let a = col - 1;
    if (a > text.length) a = text.length;
    // step back to the start of the identifier under the pointer
    let s = a, e = a;
    while (s > 0 && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
    while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
    const w = text.slice(s, e);
    return /^[A-Za-z_]/.test(w) ? w : "";
  },

  /** Hover help, from data the IDE already has.
   *
   * Deliberately not an AI feature: `onHoverAsk` resolves a word against this
   * file's own declarations and the language's keyword and type tables, so it
   * answers instantly, works offline, and cannot be wrong about what it found.
   * The companion can enrich it later, but nothing here waits for it.
   */
  hoverAt(e) {
    if (this.comp) return;
    const { line, col } = this.posFromEvent(e);
    const word = this.wordAt(line, col);
    if (!word) { this.hideTip(); return; }
    if (word === this.tipWord) return;
    const info = this.onHoverAsk && this.onHoverAsk(word);
    if (!info) { this.hideTip(); return; }
    this.tipWord = word;
    const x = 18 + (col - 1) * this.cw;
    const y = 12 + (line - 1) * this.lh + this.lh;
    this.tip.innerHTML =
      '<div class="trow"><span class="tkind">' + info.kind + "</span>"
      + '<b>' + info.title.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</b></div>"
      + (info.detail ? '<pre>' + info.detail.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>" : "");
    this.tip.style.display = "block";
    // keep it inside the editor rather than letting it hang off the right edge
    const maxX = this.el.clientWidth - this.tip.offsetWidth - 20;
    this.tip.style.left = Math.max(8, Math.min(x, maxX)) + "px";
    this.tip.style.top = y + "px";
  },

  hideTip() {
    if (this.tip) { this.tip.style.display = "none"; this.tip.innerHTML = ""; }
    this.tipWord = "";
  },

  acceptGhost() {
    if (!this.ghostText) return false;
    const ta = this.ta, pos = ta.selectionStart;
    ta.value = ta.value.slice(0, pos) + this.ghostText + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + this.ghostText.length;
    this.ghostText = "";
    this.repaint();
    this.onInput && this.onInput(ta.value);
    return true;
  },

  insert(text) {
    const ta = this.ta, pos = ta.selectionStart;
    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + text.length;
    this.repaint();
    this.onInput && this.onInput(ta.value);
    ta.focus();
  },

  /** Add text at the END of the document, not at the caret.
   *
   *  The difference is the whole point of the Generate panel. A freshly opened
   *  file has its caret at 0 - `setText` puts it there on purpose, so that
   *  double-clicking a file does not leave the cursor on the last line - which
   *  means "insert at the caret" wrote generated code *above* `fn main`. A
   *  request to finish the program arrived as a prologue to it.
   *
   *  Focus is deliberately not taken. The generated code goes in, and the caret
   *  stays in the request field, so a second request can be typed straight away;
   *  that chaining is the feature. The view scrolls to the new code instead, so
   *  the arrival is visible without moving the keyboard. */
  append(text) {
    if (!text) return;
    if (!this.live()) { this.pendingText = (this.pendingText || "") + text; return; }
    const ta = this.ta;
    const sep = ta.value && !ta.value.endsWith("\n") ? "\n" : "";
    ta.value = ta.value + sep + text;
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.scrollTop = ta.scrollHeight;
    this.repaint();
    this.onInput && this.onInput(ta.value);
  },

  // ---- editing aids
  //
  // These are the things a person notices missing within the first hour, and
  // none of them need a parser: they are all local text edits with a caret to
  // place. They are behind settings so anyone who dislikes auto-close can turn
  // it off, and they go through `replaceRange` so every one of them leaves the
  // document, the highlight layer and the caret in agreement.

  /** Replace a range and put the caret somewhere sensible. */
  replaceRange(start, end, text, caret) {
    const ta = this.ta;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    const p = caret === undefined ? start + text.length : caret;
    ta.selectionStart = ta.selectionEnd = p;
    this.repaint();
    this.onInput && this.onInput(ta.value);
  },

  /** The start and end offsets of the line containing `pos`. */
  lineBounds(pos) {
    const v = this.ta.value;
    const a = v.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
    let b = v.indexOf("\n", pos);
    if (b < 0) b = v.length;
    return [a, b];
  },

  /** Enter, with the current line's indentation carried over.
   *
   * A line that ends in an opening brace gets one level more, which is the whole
   * of what "auto-indent" means in a braces language and removes the most
   * repeated keystroke in the editor.
   */
  newlineWithIndent(unit) {
    const ta = this.ta, pos = ta.selectionStart;
    const [a] = this.lineBounds(pos);
    const line = ta.value.slice(a, pos);
    const indent = (line.match(/^[ \t]*/) || [""])[0];
    const opens = /[{([]\s*$/.test(line);
    const extra = opens ? (unit || "    ") : "";
    const text = "\n" + indent + extra;
    this.replaceRange(pos, ta.selectionEnd, text, pos + text.length);
    return true;
  },

  /** Type an opener, get the closer, with the caret between them.
   *
   * Three rules, each one a thing that makes the naive version annoying:
   * typing over an existing closer steps past it instead of doubling it,
   * a selection is wrapped rather than replaced, and backspace between an empty
   * pair removes both.
   */
  autoClose(open, close) {
    const ta = this.ta, pos = ta.selectionStart, end = ta.selectionEnd;
    const sel = ta.value.slice(pos, end);
    if (sel) {
      this.replaceRange(pos, end, open + sel + close, pos + open.length + sel.length);
      return true;
    }
    const nextCh = ta.value.slice(pos, pos + 1);
    if (nextCh === close) {
      ta.selectionStart = ta.selectionEnd = pos + 1;
      return true;
    }
    // not before a word: closing a bracket in the middle of an identifier is
    // never what was meant
    if (/[A-Za-z0-9_]/.test(nextCh)) return false;
    this.replaceRange(pos, pos, open + close, pos + open.length);
    return true;
  },

  /** Backspace between an empty pair removes both characters. */
  backspacePair(open, close) {
    const ta = this.ta, pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return false;
    if (ta.value.slice(pos - 1, pos) !== open) return false;
    if (ta.value.slice(pos, pos + 1) !== close) return false;
    this.replaceRange(pos - 1, pos + 1, "", pos - 1);
    return true;
  },

  /** Comment or uncomment every line the selection touches.
   *
   * The prefix comes from the language provider, so a file whose language has no
   * comment syntax does nothing instead of having `//` inserted into it.
   */
  toggleComment(prefix) {
    if (!prefix) {
      this.onStatus && this.onStatus("this language has no comment syntax");
      return false;
    }
    const ta = this.ta;
    const [a] = this.lineBounds(ta.selectionStart);
    const [, b] = this.lineBounds(ta.selectionEnd);
    const lines = ta.value.slice(a, b).split("\n");
    const all = lines.every((l) => l.trim() === "" || l.trimStart().startsWith(prefix));
    const next = lines.map((l) => {
      if (l.trim() === "") return l;
      if (all) {
        const i = l.indexOf(prefix);
        let rest = l.slice(i + prefix.length);
        if (rest.startsWith(" ")) rest = rest.slice(1);
        return l.slice(0, i) + rest;
      }
      const indent = (l.match(/^\s*/) || [""])[0];
      return indent + prefix + " " + l.slice(indent.length);
    }).join("\n");
    this.replaceRange(a, b, next, a + next.length);
    ta.selectionStart = a;
    ta.selectionEnd = a + next.length;
    return true;
  },

  /** Indent or outdent every line the selection touches. */
  indentSelection(dir, unit) {
    const ta = this.ta;
    const u = unit || "    ";
    const [a] = this.lineBounds(ta.selectionStart);
    const [, b] = this.lineBounds(ta.selectionEnd);
    const lines = ta.value.slice(a, b).split("\n");
    const next = lines.map((l) => {
      if (dir > 0) return l.trim() === "" ? l : u + l;
      if (l.startsWith(u)) return l.slice(u.length);
      const m = l.match(/^[ \t]+/);
      return m ? l.slice(Math.min(m[0].length, u.length)) : l;
    }).join("\n");
    this.replaceRange(a, b, next, a + next.length);
    ta.selectionStart = a;
    ta.selectionEnd = a + next.length;
    return true;
  },

  gotoLine(n, col) {
    const ta = this.ta, ls = ta.value.split("\n");
    let pos = 0;
    const line = Math.max(1, Math.min(n || 1, ls.length));
    for (let i = 0; i < line - 1 && i < ls.length; i++) pos += ls[i].length + 1;
    // the compiler reports a column, so honour it - landing on the line but not
    // the problem is half an answer
    if (col && col > 1) pos += Math.min(col - 1, (ls[line - 1] || "").length);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = pos;
    this.el.scrollTop = Math.max(0, (line - 8) * this.lh);
    this.updateCursor();
  },
};

// ---------------------------------------------------------------- server

// Server ports, tried in order.
//
// The Datara runtime gives a socket no timeout, so one connection that connects
// and sends nothing blocks that server's accept loop forever - a browser opens
// such connections on its own. The launcher runs two servers and a watchdog;
// this side simply uses whichever answers, which is the difference between the
// IDE looking broken and it recovering on its own.
//
// Four, not two, for a reason found the hard way: a killed server can leave its
// listening socket registered, and Windows then keeps delivering connections to
// the dead socket. With two ports that is a fifty-fifty coin toss; with four the
// interface almost always finds a live one.
const PORTS = ["", ":7879", ":7880", ":7881"];

// The port that last answered, remembered across reloads.
//
// Without this, every load tries 7878 first, and if that one happens to be
// wedged the user waits out the whole timeout before the interface appears -
// six seconds of nothing on a machine where the server answers in two
// milliseconds. Remembering the port that worked makes a reload instant, and
// the list is still there for when it stops working.
let livePort = (() => {
  try { return localStorage.getItem("datara.studio.port") || ""; } catch (e) { return ""; }
})();

// `post` lives outside React, so it cannot call a state setter directly. App
// installs this on mount. Without it the port-switch branch below referenced an
// undefined `setStatus`, threw a ReferenceError *inside the try*, and the retry
// loop swallowed it - so a successful reconnect on the second port still ended
// as "no server answered".
let notify = () => {};

async function post(path, body) {
  const order = [livePort].concat(PORTS.filter((p) => p !== livePort));
  let lastError = null;
  let foreign = "";
  for (const port of order) {
    try {
      const ctl = new AbortController();
      // Short: a healthy server answers in about two milliseconds, so anything
      // slower than this is a port that is not coming back and the next one in
      // the list should have its turn.
      const t = setTimeout(() => ctl.abort(), 3500);
      const r = await fetch(port + path, { method: "POST", body: body || "", signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      // A reply that is not this build of the studio must not be adopted.
      //
      // This used to take any parseable JSON as a success and then lock
      // `livePort` onto that port - and persist it - so a single server on one
      // of the four ports that was not the studio this window came from became
      // permanent. Every call after it came back `no such endpoint` and the
      // window reported the workspace as unreadable, on a workspace that was
      // fine. Skipping it costs one more round trip and turns a mystery into a
      // sentence.
      if (j && typeof j === "object" && j.ok === false && j.error === "no such endpoint") {
        if (!foreign) foreign = port || "7878";
        continue;
      }
      if (!j || typeof j !== "object") {
        if (!foreign) foreign = port || "7878";
        continue;
      }
      if (port !== livePort) {
        livePort = port;
        try { localStorage.setItem("datara.studio.port", port); } catch (e) {}
        notify("reconnected on port " + (port || "7878"));
      }
      return j;
    } catch (e) { lastError = e; /* try the next port */ }
  }
  if (foreign) {
    throw new Error("port " + foreign + " answered, but it is not the studio this window was "
      + "built from - it does not know " + path + ". Another Datara server is holding that port.");
  }
  throw new Error("no server answered on " + PORTS.map((p) => p || ":7878").join(", ")
    + (lastError ? " (" + lastError.message + ")" : ""));
}

/** The language's own vocabulary, for completion and hover.
 *
 * These were referenced by `completerFor` from the start and never defined, so
 * every keystroke threw `ReferenceError: KEYWORDS is not defined` inside the
 * input handler and completion never appeared at all. The tables are data, so
 * they are also the honest place to keep the language's surface: adding a
 * builtin to forgen means adding one line here.
 *
 * Sources: `src/lexer/mod.rs` for the reserved words, `src/types/prelude.rs`
 * for the builtins.
 */
/** The words the language reserves.
 *
 *  Two sources, and neither is complete on its own, so the rule is: the
 *  official grammar's keyword list, corrected by the compiler.
 *
 *  The grammar is the TextMate file the compiler ships for VS Code
 *  (`editors/vscode/syntaxes/datara.tmLanguage.json`). It is the editor-side
 *  authority and it is broad. The compiler is the final one, so anything it
 *  rejects in its own form is out, and anything it accepts that the grammar
 *  forgot is in.
 *
 *  Corrections, each from a probe project run through `forgen check`:
 *    removed  defer, static      - in neither the grammar nor the compiler
 *    removed  self               - the receiver is `this`; `self.v` is rejected
 *    removed  try, catch         - rejected in the only form they have
 *    added    at, justification, module
 *                                - these compile and the grammar omits them
 *
 *  The list this replaces was wrong in both directions and that is the whole of
 *  the "the suggestions are useless" complaint. It offered `view`, `own` and
 *  `shared` as declarations (they are parameter modifiers - `fn f(view r: R)`,
 *  which does compile), it offered `impl` nowhere while `impl T for C` is real,
 *  and it withheld `out` and `then`, which are in nearly every shipped example.
 */
const KEYWORDS = [
  // declarations
  "fn", "struct", "class", "entity", "record", "behavior", "role", "component",
  "process", "packet", "trait", "impl", "enum", "type", "extern", "register",
  "module", "pub", "use", "const",
  // modifiers and clauses
  "with", "at", "bits", "then", "require", "ensure", "view", "own", "shared",
  "where", "as",
  // statements and control flow
  "let", "mut", "val", "if", "else", "while", "for", "in", "return", "match",
  "out", "loop", "break", "continue", "unsafe", "justification", "comptime",
  "async", "await",
  // literals
  "true", "false", "this",
];

/** Membership test for the table above. A declaration scan has to tell a
 *  method from a call, and `if (cond) {` has the same shape as `bump() {`. */
const KEYWORD_SET = new Set(KEYWORDS);

/** What a keyword expands into when you accept it.
 *
 * Typing `fn` and pressing Tab used to insert the two characters just typed -
 * the completion list offered the keyword, and accepting it was a no-op, which
 * is the one thing a completion must never be. Now the keywords that are always
 * followed by structure expand into that structure.
 *
 * `body` is written relative to the line the keyword sits on: continuation
 * lines carry only the indentation the snippet wants *beyond* that line, and
 * the editor prefixes them with the line's own indent. So a `fn` typed at
 * column 0 and a `fn` typed inside a `behavior` both come out right.
 *
 * `caret` is an offset into `body` and `select` is how many characters from
 * there to select. A declaration selects its name, so typing replaces it: `fn`
 * Tab `main` gives `fn main() -> Int {`. `if` and `while` have no name to offer,
 * so they put the caret in the condition instead.
 *
 * Two rules the table follows, so that adding to it stays obvious:
 *
 *   - The placeholder is always on the FIRST line. That is why indenting the
 *     continuation lines cannot move the caret, and it is worth keeping.
 *   - Only keywords with real structure are here. `let`, `return`, `pub`,
 *     `true` and the rest are still inserted as the plain word they are - a
 *     skeleton on `true` would be noise, and a one-placeholder template is
 *     wrong for `let`, where the name comes first and the value after it.
 *
 * And one rule that is not about style at all: **every body here has been run
 * through the compiler**. `scripts/check-snippets.mjs` feeds each one to
 * `forgen check` and fails if the only complaint is not an unresolved
 * placeholder. That is not ceremony - the first version of this table offered
 * `impl` and `mod`, neither of which is a Datara construct, so accepting them
 * wrote a syntax error into the file. A snippet that does not compile is worse
 * than no snippet: it teaches a shape the language does not have.
 *
 *   impl  measured, forgen 1.4.1: `impl Name { fn }` is E-SYNTAX-001, and
 *         `impl Name { field: Int }` passes `check` with "Verified 100% OK"
 *         while declaring nothing - the type stays unknown. Methods are attached
 *         with `behavior`, so that is what this table offers.
 *   mod   not a keyword at all: `mod name` is E-SYNTAX-001, and `let mod = 1`
 *         compiles, which a reserved word could not.
 */
const SNIPPETS = {
  // The body of a new `fn` is empty, with the caret on the blank line.
  //
  // It used to arrive as `return 0`. That is a placeholder that has to be
  // deleted before the function can be written, and it is wrong for the common
  // case: the value a function returns is the one thing you have not decided yet
  // when you type its name. An empty body is the honest starting point.
  //
  // There is no `-> Int` either, and that is what `forgen` insists on rather
  // than a stylistic choice: `fn name() -> Int { }` is E-TYPE-003, because not
  // every code path returns a value. A body with no return clause does not
  // compile with a declared return type - not `Int`, and not `Void` either,
  // which is rejected the same way. The only empty body the language accepts is
  // a function with no arrow at all, so the snippet writes one, and adding the
  // return type is part of writing the function.
  //
  // `stop` is where Tab takes you *after* the name has been typed: offset 3
  // names the function, and the second Tab lands inside the empty body. Without
  // it, typing `fn` then a name left the caret after the name with three keys
  // (End, Down, End) still to press before the first line of the function could
  // be written - which is the friction "пиши код комфортно" was about.
  fn:        { body: "fn name() {\n    \n}", caret: 3, select: 4, stop: 16 },
  struct:    { body: "struct Name {\n    name_field: Int\n}", caret: 7, select: 4 },
  class:     { body: "class Name {\n    name_field: Int\n}", caret: 6, select: 4, note: "snippet - deprecated, use struct + behavior" },
  entity:    { body: "entity Name {\n    name_field: Int\n}", caret: 7, select: 4 },
  record:    { body: "record Name {\n    name_field: Int\n}", caret: 7, select: 4 },
  component: { body: "component Name {\n    name_field: Int\n}", caret: 10, select: 4 },
  behavior:  { body: "behavior Name {\n    name_method() -> Int {\n        \n    }\n}", caret: 9, select: 4 },
  trait:     { body: "trait Name {\n    name_method() -> Int\n}", caret: 6, select: 4 },
  enum:      { body: "enum Name {\n    NameA\n    NameB\n}", caret: 5, select: 4 },
  type:      { body: "type Name = Int", caret: 5, select: 4 },
  extern:    { body: "extern fn name() -> Int", caret: 10, select: 4 },
  if:        { body: "if cond {\n    \n}", caret: 3, select: 4, stop: 14 },
  while:     { body: "while cond {\n    \n}", caret: 6, select: 4, stop: 17 },
  for:       { body: "for item in items {\n    \n}", caret: 4, select: 4, stop: 24 },
  match:     { body: "match value {\n    \n}", caret: 6, select: 5, stop: 18 },
  // the capability scope is required around exec / file_* / socket_* / env_get,
  // and the justification string is not optional, so the caret goes between the
  // quotes rather than at the end of the line. 23, not 22: offset 22 is the
  // first quote, and the caret has to be past it to be inside.
  unsafe:    { body: "unsafe(justification: \"\") {\n    \n}", caret: 23, select: 0 },
  comptime:  { body: "comptime expr", caret: 9, select: 4 },
  defer:     { body: "defer action()", caret: 6, select: 8 },
  use:       { body: "use module_name", caret: 4, select: 11 },
  // The forms the examples actually use and the list never offered. `out` and
  // `then` are the two that show up in almost every shipped program, so their
  // absence was the most visible half of the complaint.
  //
  // There is no `with` snippet, and that is deliberate rather than an omission.
  // `with` is a clause on a declaration header - `entity U with C` - so there is
  // no line you can type it on by itself. A snippet would have inserted a
  // fragment that is a syntax error standing alone, which is exactly what the
  // build's snippet check is there to catch. The keyword is still offered; it
  // just inserts its own four letters.
  out:       { body: "out expr", caret: 4, select: 4 },
  then:      { body: "then step()", caret: 5, select: 4 },
  module:    { body: "module name.sub", caret: 7, select: 8 },
  role:      { body: "role Name {\n    name_method() -> Int\n}", caret: 5, select: 4 },
  process:   { body: "process name(x: Int) -> Int {\n    x\n}", caret: 8, select: 4 },
  // A packet field is a NAME AND A BIT COUNT, not a name and a type:
  // `name_field: Int` is E-SYNTAX-001, "Expected bit count for packet field".
  // The snippet carried the type form until the build's snippet check failed it.
  packet:    { body: "packet Name {\n    name_field: 8\n}", caret: 7, select: 4 },
};

const TYPES = [
  "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "Byte", "Bool", "Str",
  "Float", "Float32", "Float64", "List", "Map", "Set", "Option", "Outcome",
  "Result", "Rope", "Box", "Ptr", "Unit", "Char", "Any", "Void",
];

const BUILTINS = [
  "println", "print", "int_to_str", "str_to_int", "str_to_float", "bool_to_int",
  "str_len", "byte_len", "char_len", "str_chars", "str_byte_at", "str_scalar_at",
  "str_next_offset", "str_substring", "str_char_at", "str_trim", "str_repeat",
  "str_pad_left", "str_pad_right", "str_replace", "str_to_upper", "str_to_lower",
  "str_split", "str_join", "str_contains", "str_starts_with", "str_ends_with",
  "str_index_of", "format_percent", "format_int_with_commas",
  "file_read", "file_write", "file_append", "file_exists", "path_join",
  "fs_open", "fs_read", "fs_write", "read_all", "read_line",
  "exec", "system", "process_output", "env_get", "args_count",
  "socket_create", "socket_bind", "socket_listen", "socket_accept",
  "socket_connect", "socket_recv", "socket_send", "socket_close",
  "math_abs", "math_min", "math_max", "math_clamp", "math_pow", "math_sqrt",
  "math_ceil", "math_floor", "math_round", "math_shl", "math_shr", "math_and",
  "math_or", "math_xor", "math_not", "math_clz", "math_ctz", "math_popcnt",
];

/** Hover help. `word -> [kind, title, detail]`.
 *
 * The `detail` is the part worth having: the traps in this language are not
 * guessable from the name. `str_len` counting bytes and `view` going before the
 * parameter are exactly the things a person gets wrong on their first afternoon,
 * and a tooltip is where they will look.
 */
const DATARA_DOCS = {
  fn: ["keyword", "fn", "Declares a function.\n\n  fn name(a: Int) -> Int { ... }\n  fn name(a: Int) -> Int => a + 1\n\nA one-line body uses `=>` and no braces."],
  let: ["keyword", "let", "Binds an immutable name.\n\n  let n = 5\n\nUse `mut n = 5` when it will be reassigned."],
  mut: ["keyword", "mut", "Makes a binding assignable.\n\n  mut i = 0\n  i = i + 1"],
  struct: ["keyword", "struct", "Declares a value type.\n\n  pub struct Rope {\n      rope_len: Int\n  }\n\nField names must be globally unique across every struct in the program - see PORTING.md."],
  behavior: ["keyword", "behavior", "Declares a set of methods. `class` is deprecated in favour of `struct` + `behavior`."],
  trait: ["keyword", "trait", "Declares an interface."],
  view: ["keyword", "view", "A borrowed parameter. It goes BEFORE the name.\n\n  fn rope_len(view r: Rope) -> Int\n\n`r: view Rope` is rejected."],
  pub: ["keyword", "pub", "Exports a declaration from its module.\n\nA plain `fn` is private to its file; reaching for it elsewhere is E0042.\nNot allowed on struct fields or on a top-level `let`."],
  unsafe: ["keyword", "unsafe", "Opens a capability scope.\n\n  unsafe(justification: \"why this is needed\") { ... }\n\nRequired around exec, file_*, socket_* and env_get, or the type check fails with E0940."],
  comptime: ["keyword", "comptime", "Evaluated during compilation rather than at run time."],
  match: ["keyword", "match", "Pattern matching. Note there are no if-expressions in this language."],
  // This entry used to say there is no `break` and no `continue`. Both compile.
  // The note was wrong, and wrong in the direction that costs the most: it sent
  // people to a flag variable to do what a keyword already does. Every line in
  // this table is the editor making a claim on the compiler's behalf, so it has
  // to be a claim the compiler backs.
  while: ["keyword", "while", "A loop.\n\n  mut i = 0\n  while i < 10 {\n      i = i + 1\n  }\n\n`break` and `continue` both work inside it."],
  loop: ["keyword", "loop", "A loop with no condition. Leave it with `break`."],
  break: ["keyword", "break", "Leaves the enclosing `while`, `for` or `loop`."],
  continue: ["keyword", "continue", "Skips to the next turn of the enclosing loop."],
  return: ["keyword", "return", "Returns from a function."],
  use: ["keyword", "use", "Imports a module. Everything lands in one flat namespace, so public names carry their module prefix."],
  // The words the examples are written in and the table never explained.
  out: ["keyword", "out", "Writes a line to standard output. A statement, not a function: no parentheses, and it cannot be used as a value.\n\n  out \"paid {amount}\"\n\n`println(\"...\")` is the call form and does the same thing."],
  then: ["keyword", "then", "Chains the stages of a `process`, reading top to bottom.\n\n  store\n  then find_product()\n  then report()\n\nIt lowers to the same IR as `|>`."],
  module: ["keyword", "module", "Names the module a file belongs to, on the first line.\n\n  module embedded.mmio\n\nRequired before `register`."],
  impl: ["keyword", "impl", "Implements a trait for a type.\n\n  impl Payable for User {\n      pay(amount: Int) -> Int => this.balance - amount\n  }\n\nA type with no trait to satisfy uses `behavior` instead."],
  class: ["keyword", "class", "Declares a type together with its methods.\n\n`class` still compiles, but forgen emits W0100 for every one: the language has moved to `struct` plus a separate `behavior` block."],
  entity: ["keyword", "entity", "A data-bearing type, and an alias of `class`. Compose in shared state with `with`."],
  role: ["keyword", "role", "A method contract the compiler verifies. A type satisfies it by declaring the same method in a `behavior`."],
  process: ["keyword", "process", "A named workflow, chained with `then`."],
  require: ["keyword", "require", "A precondition, written between the signature and the body.\n\n  fn t(x: Int) -> Int\n      require x > 0\n  {\n      return x\n  }"],
  ensure: ["keyword", "ensure", "A postcondition. Pairs with `require` and may name `result`.\n\n  fn t(x: Int) -> Int\n      require x > 0\n      ensure result >= x\n  {\n      return x\n  }"],
  Int: ["type", "Int", "The default integer, 64-bit."],
  Str: ["type", "Str", "A UTF-8 string.\n\n`str_len` counts BYTES, not characters: str_len(\"Шахматная школа\") is 24.\nUse `char_len` for characters."],
  Bool: ["type", "Bool", "true or false. Note that str_contains / str_starts_with / str_ends_with return `Int`, not `Bool` - compare `== 1`."],
  List: ["type", "List<T>", "A growable sequence.\n\nReading an element of a LOCAL List<Str> inline returns a pointer, not the string - route it through a helper function."],
  Outcome: ["type", "Outcome<T>", "Success or failure. This is what a module self-test returns."],
  Rope: ["type", "Rope", "The kernel's text type: a sequence of chunks."],
  println: ["builtin", "println(s)", "Writes a line to standard output."],
  str_len: ["builtin", "str_len(s) -> Int", "Byte length, not character length.\n\n  str_len(\"Шахматная школа\") -> 24\n  char_len(\"Шахматная школа\") -> 15"],
  str_substring: ["builtin", "str_substring(s, start, len) -> Str", "start is a BYTE offset and len is a byte count.\n`str_substr` is an alias of this."],
  str_split: ["builtin", "str_split(s, sep) -> List<Str>", "Read the result through a helper function, not inline - see List."],
  str_contains: ["builtin", "str_contains(s, needle) -> Int", "Returns Int, not Bool. Compare with `== 1`.\n`str_starts_with` and `str_ends_with` are the same."],
  file_read: ["builtin", "file_read(path) -> Str", "Reads a text file.\n\nOn non-UTF-8 content it returns an EMPTY STRING with no error - there is no way to tell that from an empty file."],
  file_exists: ["builtin", "file_exists(path) -> Bool", "True for a file. It is FALSE for a directory - use a shell `cd` to test a folder."],
  exec: ["builtin", "exec(cmd) -> Str", "Runs a command through the shell and returns its output.\n\nOn Windows the output is in the console codepage (cp866 here), not UTF-8. Convert it before showing it. There is no exit code - use `system` for that, which discards the output."],
  env_get: ["builtin", "env_get(name) -> Str", "Reads an environment variable.\n\nThe runtime's own OS, ComSpec and SHELL are empty; detect Windows with SystemRoot."],
  int_to_str: ["builtin", "int_to_str(n) -> Str", "Formats an integer as decimal text."],
  str_to_int: ["builtin", "str_to_int(s) -> Int", "Parses decimal text. Returns 0 on anything it cannot read, so validate the range yourself."],
};

/** Where a completion came from, which is the only ranking signal available
 *  without a type checker.
 *
 * This used to be `a.label.length - b.label.length` - not a ranking at all. It
 * put `str_len` above `str_split` because it is shorter, and it let a stdlib
 * builtin outrank a function declared in the file the reader is looking at.
 * Order is now by provenance, then by length so the closest completion of what
 * was typed wins, then alphabetically so the list does not reshuffle.
 */
const COMPLETE_RANK = { symbol: 0, field: 0, method: 1, snippet: 2, type: 3, keyword: 4, builtin: 5, ai: 6 };

function byRank(a, b) {
  const d = (a.rank || 0) - (b.rank || 0);
  if (d) return d;
  if (a.label.length !== b.label.length) return a.label.length - b.label.length;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** The declaration keywords that open a braced body, and the one place their
 *  pattern is written down.
 *
 *  `class` was missing from this list while being the keyword the shipped
 *  stdlib declares 102 times, so `user.` on a class instance had nothing to
 *  answer with. `entity`, `record`, `role` and `packet` were missing too. Two
 *  functions used to carry their own copy of the pattern and this is why they
 *  disagreed; now there is one, and both read it.
 *
 *  `process` is deliberately absent. `process purchase(user: User, ...)` has a
 *  parameter list where a body would be, and a scan that treated it as a
 *  declaration would file `user: User, store: Store, amount: Int` as one field.
 */
const DECL_RE = /^\s*(?:pub\s+)?(struct|class|entity|record|behavior|role|component|packet|trait|register)\s+([A-Za-z_]\w*)\s*(?:with\s+([A-Za-z_][\w,\s]*?))?\s*(?:at\s+\S+)?\s*\{/;

/** The struct and behavior declarations in a file, with their insides.
 *
 * `symbols()` finds top-level names, which is all the outline panel needs.
 * Completion needs more: a `behavior` is the only place its methods exist, and
 * a class's fields are the only thing a literal can be given. This is a brace
 * scan, not a parser, and it will miss anything unusual - the real answer is
 * the Datara provider reusing forgen's own parser, and this is what is honest
 * until then.
 */
function declaredTypes(src) {
  const out = {};
  const lines = String(src || "").split("\n");
  let current = null, depth = 0;
  for (const line of lines) {
    if (!current) {
      const m = line.match(DECL_RE);
      if (!m) continue;
      // A type and its behavior are written as two blocks with the same name -
      // that is the idiom forgen's own W0100 tells people to move to, and it is
      // what `03_split_behavior.dtr` does. Overwriting on the second block is
      // what made `user.` list nothing: `behavior User` replaced `class User`
      // and took its fields with it.
      current = out[m[2]] || (out[m[2]] = { kind: m[1], name: m[2], fields: [], methods: [], with: [] });
      if (m[3]) {
        for (const w of m[3].split(",")) {
          const t = w.trim();
          if (t && current.with.indexOf(t) < 0) current.with.push(t);
        }
      }
      depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) current = null;
      continue;
    }
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    // Depth 1 is the body of the declaration itself. Anything deeper belongs to
    // a method, and a `name: Type` down there is a local, not a field.
    if (depth === 1) {
      const field = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w<>,\s[\]]*?)\s*(?:in\s+bits\s+[\d.=.]+|at\s+0x[\dA-Fa-f_]+)?\s*$/);
      if (field) {
        current.fields.push({ name: field[1], type: field[2].trim() });
      } else {
        // Three shapes reach here and the old pattern matched one of them:
        // `fn bump() -> Void {`, `greet() -> Str => "..."` and `pay(n: Int) -> Int`.
        // Both the `fn` prefix and the `=>` body are in the shipped examples, and
        // a scanner that misses them reports a class with no methods - which is
        // what `user.` showed.
        const method = line.match(/^\s*(?:pub\s+)?(?:fn\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_][\w<>,\s[\]]*?))?\s*(?:\{|=>|$)/);
        // A call has the same shape as a method, so the name is checked against
        // the keyword table. `if (cond) {` is not a method.
        if (method && !KEYWORD_SET.has(method[1])) {
          current.methods.push({
            name: method[1],
            signature: (method[3] || "Unit").trim() + "(" + method[2].trim() + ")",
          });
        }
      }
    }
    depth += open - close;
    if (depth <= 0) current = null;
  }
  return out;
}

/** Which declaration the caret is inside, so `this.` can answer.
 *
 * `this.field` is real Datara, not a convention borrowed from elsewhere - it is
 * in `03_post_oop_class.dtr` and throughout the stdlib. The receiver is whatever
 * block encloses the caret, including a `behavior User` written separately from
 * its `class User`, which is the shape the compiler steers people towards.
 */
function enclosingType(src, pos) {
  const before = String(src || "").slice(0, pos);
  let depth = 0, current = null;
  for (const line of before.split("\n")) {
    const m = line.match(DECL_RE);
    if (m && depth === 0) current = m[2];
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    depth += open - close;
    if (current && depth <= 0) current = null;
  }
  return current;
}

/** The declared type of a local or a parameter, when the file writes one down.
 *
 * Handles the shapes Datara uses in practice: `let t = Task { ... }` and
 * `let t: Task = ...` for locals, and `fn f(store: Store)` for parameters. The
 * parameter case is not an afterthought - `store.stock` and `user.pay(amount)`
 * in `07_entity_process_model.dtr` are exactly it, and a scanner that only knew
 * about `let` answered those with nothing.
 *
 * Parameters are looked for anywhere earlier in the file rather than only in the
 * enclosing signature. This is a scan, not a scope analysis, and a parameter
 * name that repeats across two functions is the exception.
 *
 * A receiver this cannot resolve returns null, and the caller then offers
 * nothing rather than guessing at the whole vocabulary.
 */
function localType(src, pos, name) {
  const before = String(src || "").slice(0, pos);
  const re = new RegExp(
    "\\b(?:let|mut|val|const)\\s+" + name + "\\s*(?::\\s*([^\\s=;]+))?\\s*=\\s*([^\\s{=(;]+)"
    + "|[(,]\\s*" + name + "\\s*:\\s*([A-Za-z_][\\w<>\\[\\]]*)",
    "g");
  let match, letNamed = null, letInferred = null, param = null;
  while ((match = re.exec(before))) {
    if (match[3]) { param = match[3]; continue; }
    letNamed = match[1] || null;
    letInferred = match[2] || null;
  }
  // A binding beats a parameter: if both are in scope under one name, the inner
  // `let` is the one the caret is looking at.
  const t = letNamed || letInferred || param;
  return String(t || "").replace(/[^A-Za-z0-9_]/g, "") || null;
}

/** What is reachable through `receiver` - and nothing else.
 *
 * Member access is a different question from "what names exist", and it has a
 * different answer. Answering `obj.` with the keyword list would be worse than
 * answering it with nothing, which is what happened before: the word before the
 * caret was empty, so the list did not open at all.
 *
 * Fields composed in through `with` are members too - `entity User with
 * Timestamped` really does have `created_at` - so they are merged in, ahead of
 * the type's own, and de-duplicated because an entity may redeclare one.
 */
function memberCompletions(src, pos, receiver) {
  const types = declaredTypes(src);
  const typeName = receiver === "this" ? enclosingType(src, pos) : localType(src, pos, receiver);
  if (!typeName) return [];
  const decl = types[typeName];
  if (!decl) return [];
  const out = [], seen = new Set();
  const fields = (list) => {
    for (const f of list) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ name: f.name, hint: f.type, rank: COMPLETE_RANK.field });
    }
  };
  for (const comp of decl.with || []) if (types[comp]) fields(types[comp].fields);
  fields(decl.fields);
  for (const m of decl.methods) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    out.push({ name: m.name, hint: m.signature, rank: COMPLETE_RANK.method });
  }
  return out;
}

/** The verb a project's name implies, when it implies one.
 *
 * Typing `fn` inserts `fn name()`, and `name` is a placeholder that has to be
 * deleted before the function can be written. In a project called `calculator`
 * the useful default is `calculate`, which is what "the completion should know
 * what I am writing" means in practice.
 *
 * This is a table rather than a rule because the rule does not exist in English.
 * `sorter` drops the suffix, `calculator` needs its silent `e` back, and
 * `handler` needs one added - three different transformations, and a stem-plus-
 * suffix heuristic gets two of them wrong. A table is predictable, and the cost
 * of a miss is one word retyped, so the table is the honest shape.
 *
 * Only agent nouns are here. A word that is already a verb (`sort`, `parse`)
 * needs no entry, and one that is not a verb at all (`sparks`, `studio`) is
 * deliberately absent: guessing a name for those would be invention, and the
 * neutral `name` is better than a confident wrong one.
 */
const PROJECT_VERBS = {
  calculator: "calculate", adder: "add", subtractor: "subtract", multiplier: "multiply",
  divider: "divide", counter: "count", summer: "sum", averager: "average",
  parser: "parse", lexer: "lex", tokenizer: "tokenize", compiler: "compile",
  interpreter: "interpret", evaluator: "evaluate", checker: "check", validator: "validate",
  sorter: "sort", searcher: "search", finder: "find", matcher: "match", filterer: "filter",
  reader: "read", writer: "write", loader: "load", saver: "save", fetcher: "fetch",
  builder: "build", creator: "create", generator: "generate", maker: "make",
  renderer: "render", formatter: "format", printer: "print", drawer: "draw",
  converter: "convert", encoder: "encode", decoder: "decode", mapper: "map",
  scanner: "scan", splitter: "split", joiner: "join", merger: "merge",
  runner: "run", tester: "test", dispatcher: "dispatch", handler: "handle",
  sender: "send", receiver: "receive", updater: "update", deleter: "delete",
  tracker: "track", recorder: "record", comparer: "compare", crawler: "crawl",
};

/** The name to put in a new function, from the file and folder it is written in.
 *
 * The file's own stem wins over the folder, because `calculator.dtr` inside
 * `src/` is about the calculator and not about `src`. `main` is skipped: a
 * project whose file is called `main` has said nothing about what it does.
 *
 * When nothing matches, this answers `name` - the same placeholder as before -
 * rather than inventing something. A completion that guesses wrong is worse
 * than one that offers an obvious blank, because the wrong name looks like
 * advice.
 */
function contextFunctionName(ctx) {
  const sources = [];
  const stemOf = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";

  const file = stemOf(ctx && ctx.file).replace(/\.dtr$/i, "").toLowerCase();
  if (file && file !== "main") sources.push(file);

  const folder = stemOf(ctx && ctx.root).toLowerCase();
  if (folder) sources.push(folder);

  for (const s of sources) {
    if (PROJECT_VERBS[s]) return PROJECT_VERBS[s];
  }
  return "name";
}

function completerFor(word, outline, suggestions, ctx) {
  const out = [], seen = new Set();
  // `stop` is carried through explicitly. It was silently dropped when it was
  // added, because this helper builds the item from a fixed list of fields and
  // an unknown one simply does not survive the trip - the snippet table had the
  // offset, the completion list did not, and the second Tab did nothing. A field
  // that reaches `acceptComplete` has to be named here or it does not exist.
  const add = (label, insert, hint, caret, select, stop, rank) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, insert, hint, caret, select, stop, rank });
  };

  // After a dot the only correct answers are the receiver's own members.
  if (ctx && ctx.receiver) {
    for (const m of memberCompletions(ctx.src, ctx.pos, ctx.receiver)) {
      if (m.name.startsWith(word)) add(m.name, m.name, m.hint, undefined, undefined, undefined, m.rank);
    }
    return out.sort(byRank);
  }

  for (const s of outline) {
    if (s.name.startsWith(word)) add(s.name, s.name, s.kind, undefined, undefined, undefined, COMPLETE_RANK.symbol);
  }
  // Every snippet is reachable. The loop used to run over KEYWORDS alone, so a
  // snippet whose word was not also in that table could never be offered -
  // `class`, `entity` and `record` sat in the snippet table and were dead code.
  const words = KEYWORDS.slice();
  for (const k of Object.keys(SNIPPETS)) if (!KEYWORD_SET.has(k)) words.push(k);
  for (const k of words) {
    if (!k.startsWith(word)) continue;
    const snip = SNIPPETS[k];
    // A keyword that opens a shape inserts the shape. The hint says "snippet"
    // rather than "keyword", because Tab doing something other than inserting
    // the two letters already on screen has to be visible before it is pressed.
    // A snippet may sharpen that hint further - `class` says it is deprecated -
    // and that note has to reach the list or the advice arrives after the fact.
    // `fn` is the one snippet whose placeholder is worth deriving from the
    // project, because it is typed constantly and its name is the first thing
    // written. The offsets are the table's, shifted by the name's length: with
    // the default `name` they are 3, 4 and 16, and `stop` is where the body
    // begins - `fn ` + name + `() {` + newline + indent.
    if (k === "fn") {
      const name = contextFunctionName(ctx);
      add(k, "fn " + name + "() {\n    \n}",
        name === "name" ? "snippet" : "snippet - " + name,
        3, name.length, 12 + name.length, COMPLETE_RANK.snippet);
      continue;
    }
    if (snip) add(k, snip.body, snip.note || "snippet", snip.caret, snip.select, snip.stop, COMPLETE_RANK.snippet);
    else add(k, k, "keyword", undefined, undefined, undefined, COMPLETE_RANK.keyword);
  }
  for (const t of TYPES) {
    if (t.startsWith(word)) add(t, t, "type", undefined, undefined, undefined, COMPLETE_RANK.type);
  }
  for (const b of BUILTINS) {
    if (b.startsWith(word)) add(b, b, "builtin", undefined, undefined, undefined, COMPLETE_RANK.builtin);
  }
  for (const c of suggestions) {
    const it = (c.insert_text || "").split("\n")[0];
    if (it.startsWith(word)) add(it, it, "ai", undefined, undefined, undefined, COMPLETE_RANK.ai);
  }
  return out.sort(byRank);
}

/** What to show when the pointer rests on a word.
 *
 * Local first and only local: a declaration in this file wins, then the
 * language tables. No network, no AI, so it answers at once and works with the
 * companion switched off - which is the point, because hover help is a writing
 * tool, not an AI feature.
 */
function hoverInfo(word, outline, lines, docs) {
  if (!word) return null;
  const decl = (outline || []).find((s) => s.name === word);
  if (decl) {
    const src = (lines && lines[decl.line - 1]) || "";
    return { kind: decl.kind, title: word, detail: "line " + decl.line + "\n" + src.trim() };
  }
  const d = (docs || DATARA_DOCS)[word];
  if (d) return { kind: d[0], title: d[1], detail: d[2] };
  return null;
}

/** The directory part of a path, in the forward-slash form the server uses. */
function dirOf(p) {
  const s = String(p == null ? "" : p).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  if (i < 0) return "";
  const head = s.slice(0, i);
  // `D:` is not a directory, it is *the current directory on drive D* - the
  // trap that made the explorer's Up button look dead.
  if (head.length === 2 && head[1] === ":") return head + "/";
  return head;
}

/** What a project-wide check should be aimed at.
 *
 * The directory holding the open file, when there is one - not the file, and not
 * the workspace root. `forgen check` finds the project by walking up to the
 * nearest `datara.toml`, and the workspace root is usually *above* the project
 * rather than inside it, so aiming there makes every `use` in the project
 * resolve as a missing package: a false error, for a project that compiles
 * clean. Aiming at the open file's own directory puts the walk inside the right
 * project, and the server reports what it actually checked so the panel can say
 * so rather than imply it.
 */
function checkTarget(openFile, root) {
  return dirOf(openFile) || root || "";
}

/** The two-line body `/api/check` takes: where to start, and how far up to go.
 *
 * The second line is the workspace root and it is what keeps a project check
 * inside the workspace. Without it the server walks up to the first
 * `datara.toml` it finds. That used to be a real failure: the studio lived at
 * `D:/ryan/IDE datara`, and `D:/ryan` holds the forgen_ai project's own
 * `datara.toml`, so "check the whole project" answered with ten errors from a
 * different project - worse than answering nothing. The studio now sits at
 * `D:/IDE datara` with no project file above it at all, but the bound stays:
 * it is what makes the answer independent of where the folder happens to live.
 */
function checkBody(openFile, root) {
  return checkTarget(openFile, root) + "\n" + (root || "");
}

/** One line saying what a project check actually did.
 *
 * The case worth the words is the third one: no project file was found, so the
 * directory was checked as it stands. `forgen check` then treats every file it
 * collected as one namespace, so two sibling projects under one folder collide -
 * measured on 1.4.0, a directory holding two small projects reports
 * `E-RESOLVE-002: Duplicate function definition` for every name they share, two
 * `helper` files and two `main` files, for code that compiles clean one level
 * down. Saying "23 problems in the project" would be a lie with a number
 * attached; naming what was checked is the true statement, and it points at the
 * fix (open a file inside the project, or add a `datara.toml`).
 *
 * Note what is deliberately *not* claimed: that the absent manifest is the cause.
 * Measured, a directory with no manifest checks clean when it holds one project.
 * The variable is how many projects it holds.
 */
function checkNote(project, asked, count) {
  if (!project) {
    return "no datara.toml at or below " + (asked || "the workspace")
      + " - checked as one flat directory, so sibling projects collide";
  }
  return count ? count + " problem(s) in " + project : "clean: " + project;
}

/** Remove ANSI escape sequences.
 *
 * forgen colourises its diagnostics **even when its output is a pipe**, so every
 * `forgen check` result arrives with `ESC [ 1 ; 3 1 m` wrapped around the parts
 * that matter. The server strips them at the boundary (`st_strip_ansi` in
 * `src/http.dtr`), and this strips them again on the client. The duplication is
 * deliberate: the parse below anchors on column-0 shapes like
 * `--> file:line:col`, so a single ESC byte in front of the arrow makes every
 * diagnostic in the file invisible - and an editor that silently shows no
 * problems is worse than one that shows the wrong ones.
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) {
  return String(s == null ? "" : s).replace(ANSI_RE, "");
}

/** Compiler output into editor ranges.
 *
 * forgen already prints exactly what an editor needs, so this is a translation
 * and not an analysis:
 *
 *   error[E-TYPE-001]: Type mismatch for argument 1: expected 'Int', got 'Str'
 *     --> \\?\D:\...\bad.dtr:7:12
 *        |
 *      7 |     return helper("not an int")
 *        |            ^^^^^^^^^^^^^^^^^^^^
 *
 * The caret row gives the span length, which is why the underline covers the
 * argument rather than the whole line.
 *
 * The `\\?\` prefix is the Windows extended-length path marker; it has to come
 * off or the file will never compare equal to the one the IDE has open.
 */
function parseForgenDiagnostics(output, wantedPath) {
  const norm = (p) => String(p || "").replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
  const want = norm(wantedPath);
  const lines = stripAnsi(output).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*(error|warning)\[([^\]]+)\]\s*:\s*(.*)$/.exec(lines[i]);
    if (!head) continue;
    let file = "", line = 0, col = 1, len = 1, help = "";
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const loc = /^\s*-->+\s*(.+?):(\d+):(\d+)\s*$/.exec(lines[j]);
      if (!loc) continue;
      file = norm(loc[1]);
      line = Number(loc[2]);
      col = Number(loc[3]);
      for (let k = j + 1; k < Math.min(j + 6, lines.length); k++) {
        const caret = /^\s*\|\s*(\^+)/.exec(lines[k]);
        if (caret && len === 1) { len = caret[1].length; }
        // `= help: ...` is the compiler telling you what to type instead, which
        // is the single most useful line it emits and was being thrown away
        const h = /^\s*=\s*help:\s*(.*)$/.exec(lines[k]);
        if (h) { help = h[1].trim(); break; }
      }
      break;
    }
    if (!line) continue;
    out.push({
      severity: head[1] === "warning" ? "warning" : "error",
      code: head[2],
      message: head[3].trim(),
      help,
      file, line, col, len,
      // a problem in another file still matters, but it is not this file's squiggle
      here: !want || file === want,
    });
  }
  return out;
}

/** Which glyph and colour a file gets in the tree.
 *
 * Shape carries the meaning and colour reinforces it, so the tree stays legible
 * if the colours are hard to tell apart - which they are at 13px for anyone with
 * a colour vision deficiency, and #D9705F against #D6A461 is not a safe pair to
 * rely on alone.
 */
const FILE_KINDS = {
  // .dtr shows the real Datara mark, so it carries no tint of its own - the
  // artwork is coloured already and a colour on top of it would only muddy it
  dtr: ["dtr-mark", "var(--ink2)"],
  py: ["file-py", "#7FB0E0"],
  js: ["file-js", "#D6C46A"],
  mjs: ["file-js", "#D6C46A"],
  ts: ["file-ts", "#8FA9E8"],
  rs: ["file-rs", "#D9A06A"],
  c: ["file-cpp", "#9FB3E8"],
  h: ["file-cpp", "#9FB3E8"],
  cpp: ["file-cpp", "#9FB3E8"],
  hpp: ["file-cpp", "#9FB3E8"],
  json: ["file-json", "#C9A86A"],
  md: ["file-md", "#9AA0AD"],
  toml: ["file-toml", "#C98FD4"],
  yml: ["file-toml", "#C98FD4"],
  yaml: ["file-toml", "#C98FD4"],
  html: ["file-html", "#D9705F"],
  css: ["file-css", "#7FB069"],
  sh: ["file-sh", "#8FC7A8"],
  txt: ["file-txt", "var(--ink3)"],
  gitignore: ["file-txt", "var(--ink3)"],
};

function fileIcon(name) {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    const k = FILE_KINDS[base.slice(1).toLowerCase()];
    if (k) return k;
  }
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return FILE_KINDS[ext] || ["file", "var(--ink3)"];
}

// ---------------------------------------------------------------- languages
//
// The boundary the IDE is built around: **the editor must not know what Datara
// is.** Everything language-specific sits behind this object, and there are two
// implementations of it - Datara, and a plain-text one that claims nothing.
//
// The plain-text provider is not decoration. It exists so the seam is *proved*
// rather than described: open a `.py` file and the editor still works, with no
// Datara keywords offered, no Datara symbols in the outline, and no compiler
// asked to check a file it cannot read. A seam with one implementation is an
// abstraction nobody has tested.
//
// Adding a language is one object. Adding one that has a compiler is one object
// with a real `check`. That is the whole extension story, and it is the reason
// the kernel can be extracted from this IDE rather than designed up front.

/** A language that claims nothing: every file the editor cannot really analyse. */
const PLAIN_LANG = {
  id: "plain",
  label: "Plain text",
  extensions: [],
  indent: "    ",
  comment: "",
  keywords: [], types: [], builtins: [], docs: {},
  symbols: () => [],
  // An honest empty answer. Guessing here would put squiggles in a file this IDE
  // has no business having an opinion about.
  highlight: plainHighlight,
  check: async () => [],
  complete: () => [],
};

/** Keep non-Datara files readable without feeding them to the Datara lexer. */
function plainHighlight(text) {
  const lines = String(text || "").split("\n");
  return { lines: lines.map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), tokens: 0 };
}

function genericSymbols(src) {
  const out = [];
  String(src || "").split("\n").forEach((line, i) => {
    const m = line.match(/^\s*(?:export\s+|pub\s+|async\s+|def\s+|fn\s+|function\s+|class\s+|struct\s+|interface\s+|enum\s+|trait\s+)?(function|def|fn|class|struct|interface|enum|trait)\s+([A-Za-z_$][\w$]*)/);
    if (m) out.push({ kind: m[1], name: m[2], line: i + 1 });
  });
  return out;
}

function textLang(id, label, extensions, comment, words) {
  const vocabulary = words || [];
  return {
    id, label, extensions, indent: "    ", comment,
    keywords: vocabulary, types: [], builtins: [], docs: {},
    symbols: genericSymbols, highlight: plainHighlight,
    check: async () => [],
    complete: (word) => vocabulary.filter((x) => x.startsWith(word)).slice(0, 9).map((label) => ({ label, insert: label, hint: "keyword" })),
  };
}

/** Safe providers for common files. They offer comment toggling, symbols and
 * local completions, but never pretend that forgen can diagnose another language.
 */
const PYTHON_LANG = textLang("python", "Python", ["py", "pyw"], "#", ["def", "class", "import", "from", "return", "if", "elif", "else", "for", "while", "async", "await", "try", "except", "with", "True", "False", "None"]);
const JAVASCRIPT_LANG = textLang("javascript", "JavaScript / TypeScript", ["js", "jsx", "mjs", "cjs", "ts", "tsx"], "//", ["const", "let", "var", "function", "class", "return", "import", "export", "from", "if", "else", "for", "while", "async", "await", "true", "false", "null"]);
const RUST_LANG = textLang("rust", "Rust", ["rs"], "//", ["fn", "let", "mut", "pub", "struct", "enum", "trait", "impl", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "true", "false"]);
const C_LIKE_LANG = textLang("c-like", "C / C++ / Java / Go", ["c", "h", "cc", "cpp", "hpp", "java", "go"], "//", ["int", "void", "char", "bool", "class", "struct", "enum", "interface", "fn", "func", "return", "if", "else", "for", "while", "package", "import", "public", "private", "true", "false"]);
const DATA_LANG = textLang("data", "Data / markup", ["json", "jsonl", "toml", "yaml", "yml", "xml", "html", "htm", "css", "scss", "md", "markdown"], "#", ["true", "false", "null", "name", "version", "import"]);

/** Datara, as forgen defines it.
 *
 * The vocabulary comes from `src/lexer/mod.rs` and `src/types/prelude.rs`, and
 * `check` is the compiler itself - which is the whole point of this IDE: the
 * diagnostics are not a reimplementation, they are forgen's own output.
 */
const DATARA_LANG = {
  id: "datara",
  label: "Datara",
  extensions: ["dtr"],
  indent: "    ",
  comment: "//",
  keywords: KEYWORDS,
  types: TYPES,
  builtins: BUILTINS,
  docs: DATARA_DOCS,
  symbols: symbols,
  highlight: coreHighlight,
  check: async (path, post) => {
    const r = await post("/api/check", path);
    if (!r || !r.ok || !r.result) return [];
    return parseForgenDiagnostics(r.result.output, path);
  },
  complete: completerFor,
};

const PROVIDERS = [
  DATARA_LANG, PYTHON_LANG, JAVASCRIPT_LANG, RUST_LANG, C_LIKE_LANG, DATA_LANG,
  PLAIN_LANG,
];

/** Which language owns this file. */
function providerFor(path) {
  const base = String(path || "").split(/[\\/]/).pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return PROVIDERS.find((p) => p.extensions.includes(ext)) || PLAIN_LANG;
}

/** Top-level declarations in a source file, for the outline panel.
 *
 * A regex scan, not a parse. It is honest about that: it finds declarations at
 * the start of a line and will miss anything nested or unusual. The real fix is
 * the Datara provider reusing forgen's own parser; until then this is a useful
 * approximation and nothing depends on it being complete.
 *
 * The kind list is the compiler's own, taken from the E-SYNTAX-001 message it
 * prints when it meets something it cannot place. `impl` was in this pattern and
 * does not exist in the language - the outline offered a shape the compiler
 * rejects - while `entity`, `record`, `component`, `process` and `role` were
 * missing, so a file written in the domain model showed an empty outline.
 */
function symbols(src) {
  const out = [];
  src.split("\n").forEach((l, i) => {
    const m = l.match(/^\s*(?:pub\s+)?(fn|struct|class|entity|record|behavior|role|component|process|packet|trait|enum|type|const|extern|register|module)\s+([A-Za-z_]\w*)/);
    if (m) out.push({ kind: m[1], name: m[2], line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------- small components

// The caret in the brackets is the mark now, not a dot. Kept in step with
// `scripts/mark.mjs` and `ui/icon.svg` by hand - three descriptions of one
// shape - which is why the geometry here is a copy of theirs and not an
// approximation of it. `scripts/build-icons.mjs` fails the build if the SVG
// stops carrying the brand colours, and `scripts/verify-ico.mjs` fails it if the
// rasterised file stops carrying them, so the trio cannot drift silently.
const Mark = () => html`<svg width="17" height="17" viewBox="0 0 64 64" aria-hidden="true">
  <rect width="64" height="64" rx="15" fill="#0F0F12"></rect>
  <path d="M25 17 L19 17 L19 47 L25 47" fill="none" stroke="#E9E9EE" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"></path>
  <path d="M39 17 L45 17 L45 47 L39 47" fill="none" stroke="#E9E9EE" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"></path>
  <path d="M32 24 L32 40" fill="none" stroke="#7DD3C0" strokeWidth="5" strokeLinecap="round"></path>
</svg>`;

const Ico = ({ k, size }) => {
  const s = size || 15;
  const st = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };
  // The Datara mark is the project's own artwork, not a glyph drawn from
  // primitives. A language's file icon is identity, and an approximation of it
  // is a different icon - so `.dtr` gets the real thing, the same image the
  // window and the browser tab use, served from CSS as a data URI.
  if (k === "dtr-mark") {
    return html`<i class="fico fico-dtr" style=${{ width: s + "px", height: s + "px" }}
      aria-hidden="true"></i>`;
  }
  // Language glyphs are distinguished by SILHOUETTE first and colour second, so
  // the tree still reads for anyone who cannot separate #D9705F from #D6A461 -
  // which, at 13px, is most people.
  const shapes = {
    file: html`<g ...${st}><path d="M4 1.8h4.4L11 4.4v7.8H4z"></path><path d="M8.4 1.8v2.6H11"></path></g>`,
    folder: html`<g ...${st}><path d="M1.8 4.2h4l1.2 1.6h6.2v6H1.8z"></path></g>`,
    save: html`<g ...${st}><path d="M2.4 2.4h8l1.2 1.2v8H2.4z"></path><path d="M5 2.4v3.2h4V2.4M5 11.6V8.4h4v3.2"></path></g>`,
    search: html`<g ...${st}><circle cx="6.6" cy="6.6" r="4"></circle><path d="M9.6 9.6L12.4 12.4"></path></g>`,
    chevron: html`<g ...${st}><path d="M4.5 3L7.5 6L4.5 9"></path></g>`,
    chevL: html`<g ...${st}><path d="M8.4 3.4L5.4 6.4L8.4 9.4"></path></g>`,
    chevR: html`<g ...${st}><path d="M5.6 3.4L8.6 6.4L5.6 9.4"></path></g>`,
    gear: html`<g ...${st}><circle cx="7" cy="7" r="2.2"></circle><path d="M7 1.4v1.7M7 10.9v1.7M1.4 7h1.7M10.9 7h1.7M3.05 3.05l1.2 1.2M9.75 9.75l1.2 1.2M10.95 3.05l-1.2 1.2M4.25 9.75l-1.2 1.2"></path></g>`,
    plus: html`<g ...${st}><path d="M7 3v8M3 7h8"></path></g>`,
    close: html`<g ...${st}><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8"></path></g>`,
    edit: html`<g ...${st}><path d="M2.4 11.6L9.6 4.4M2.4 11.6l1-3.2 6.2-6.2 2.2 2.2-6.2 6.2-3.2 1z"></path><path d="M2.4 11.6h9.2"></path></g>`,
    trash: html`<g ...${st}><path d="M2.6 3.6h8.8M5 3.6V2.6h4v1M4 3.6v7.2c0 .9.7 1.6 1.6 1.6h2.8c.9 0 1.6-.7 1.6-1.6V3.6"></path></g>`,
    panel: html`<g ...${st}><rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1.4"></rect><path d="M9 2.6v8.8"></path></g>`,
    // The same frame with the divider near the left edge, so the narrow strip
    // reads as the panel on the left.
    //
    // This exists because the left toggle used to borrow `panel`, and `panel`
    // puts the strip on the right - which is correct for the button that hides
    // the right panel and backwards for the one that hides the explorer. Two
    // buttons, two panels, two opposite sides: one glyph cannot be right for
    // both, and the eye reads the strip as "the panel is that side" long before
    // it reads the tooltip. The divider sits 2 units from the centre in both, so
    // the two icons are exact mirrors rather than two drawings that nearly agree.
    panelL: html`<g ...${st}><rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1.4"></rect><path d="M5 2.6v8.8"></path></g>`,
    // Datara: the app mark, reduced to two brackets and the node between them
    "file-dtr": html`<g ...${st}><path d="M4.9 3.1L2.3 7l2.6 3.9"></path><path d="M9.1 3.1L11.7 7l-2.6 3.9"></path><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"></circle></g>`,
    // Python: the two interlocking plates of the logo silhouette
    "file-py": html`<g ...${st}><rect x="2.3" y="2.3" width="5.4" height="5.4" rx="2.7"></rect><rect x="6.3" y="6.3" width="5.4" height="5.4" rx="2.7"></rect></g>`,
    // JS: a plate with a script bar; TS adds the type dot above it
    "file-js": html`<g ...${st}><rect x="2.3" y="2.3" width="9.4" height="9.4" rx="2"></rect><path d="M5.4 8.6h3.2"></path></g>`,
    "file-ts": html`<g ...${st}><rect x="2.3" y="2.3" width="9.4" height="9.4" rx="2"></rect><path d="M5.4 9.4h3.2"></path><circle cx="7" cy="6" r=".9" fill="currentColor" stroke="none"></circle></g>`,
    // Rust: a gear-ish ring with an off-centre boss
    "file-rs": html`<g ...${st}><circle cx="7" cy="7" r="4.6"></circle><circle cx="7" cy="7" r="1.7"></circle><path d="M7 2.4v2.9M7 8.7v2.9"></path></g>`,
    "file-cpp": html`<g ...${st}><path d="M3.4 4.6v4.8M1 7h4.8"></path><path d="M10.6 4.6v4.8M8.2 7H13"></path></g>`,
    "file-json": html`<g ...${st}><path d="M5.4 2.6c-1.4 0-1.6.9-1.6 2s.2 2.4-1.6 2.4c1.8 0 1.6 1.3 1.6 2.4s.2 2 1.6 2"></path><path d="M8.6 2.6c1.4 0 1.6.9 1.6 2s-.2 2.4 1.6 2.4c-1.8 0-1.6 1.3-1.6 2.4s-.2 2-1.6 2"></path></g>`,
    "file-md": html`<g ...${st}><rect x="2.2" y="2.2" width="9.6" height="9.6" rx="2"></rect><path d="M4.6 6.2l2.4 2.6 2.4-2.6"></path></g>`,
    "file-toml": html`<g ...${st}><path d="M2.6 5.2h8.8M2.6 8.8h5.6"></path></g>`,
    "file-html": html`<g ...${st}><path d="M4.4 3.4L1.8 7l2.6 3.6"></path><path d="M9.6 3.4L12.2 7l-2.6 3.6"></path></g>`,
    "file-css": html`<g ...${st}><path d="M5.4 2.2L4.2 11.8M9.8 2.2L8.6 11.8M2.6 5.2h9M2.2 8.8h9"></path></g>`,
    "file-sh": html`<g ...${st}><path d="M3 4.4L5.4 7L3 9.6"></path><path d="M7.4 9.6h3.6"></path></g>`,
    "file-txt": html`<g ...${st}><path d="M2.6 4.2h8.8M2.6 7h8.8M2.6 9.8h5.4"></path></g>`,
    // Zen: a frame with the four corners pulled outward, i.e. "the chrome
    // recedes". Drawn as four bent corner marks rather than a plain rectangle
    // with arrows, because at 15px arrows on a rectangle read as "fullscreen"
    // next to the panel toggle, which is already in this bar.
    zen: html`<g ...${st}><path d="M2.2 5V2.2H5"></path><path d="M9 2.2h2.8V5"></path><path d="M11.8 9v2.8H9"></path><path d="M5 11.8H2.2V9"></path></g>`,
  };
  return html`<svg width=${s} height=${s} viewBox="0 0 14 14" aria-hidden="true">${shapes[k] || shapes.file}</svg>`;
};

const MIco = ({ k }) => {
  const shapes = {
    run: html`<path d="M4.2 2.6v8.8l6.6-4.4-6.6-4.4z" fill="#7DD3C0"></path>`,
    build: html`<g fill="none" stroke="#5C5C66" strokeWidth="1.4"><circle cx="7" cy="7" r="4.4"></circle><path d="M7 4.6v2.6l1.8 1.1"></path></g>`,
    check: html`<path d="M3 7.2l2.6 2.6L11 4.4" fill="none" stroke="#5C5C66" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"></path>`,
    profile: html`<path d="M4 11V4.4M7 11V3M10 11V6" fill="none" stroke="#5C5C66" strokeWidth="1.4" strokeLinecap="round"></path>`,
  };
  return html`<svg width="14" height="14" viewBox="0 0 14 14">${shapes[k] || null}</svg>`;
};

const ACTIONS = [
  ["run", "Run", "Ctrl+Enter"],
  ["build", "Build", "Ctrl+B"],
  ["check", "Check", "Ctrl+Shift+B"],
  ["profile", "Profile", ""],
];

/** The caption glyphs, drawn as hairlines the way the system draws them.
 *
 * 1 px strokes on a 10 px grid with `crispEdges`, because at this size an
 * anti-aliased 1.2 px stroke is a grey smudge and the system's own glyphs are
 * not. `restore` is two offset squares - the same figure Windows uses, so the
 * button reads as "put it back" without a tooltip.
 */
/** The three caption glyphs: minimise, maximise/restore, close.
 *
 * Drawn at their real size in a 10px box, with the half-pixel offsets that make
 * a 1px stroke land on a pixel boundary instead of straddling two. That is not
 * fussiness - it is the whole difference between a crisp line and a grey smear,
 * and this is a 10px glyph where a smear is most of what you see.
 *
 * The earlier version was the same geometry but `strokeWidth: 1` on a `0 0 10 10`
 * box rendered into a button, with the buttons inheriting `--ink2` (#9A9AA4 at
 * rest). Against a #0B0B0E bar that is a mid-grey hairline, and Windows' own
 * caption buttons are essentially white. Measured against the real window: the
 * controls read as faint scratches you had to hunt for. The colour moved to the
 * CSS (`--ink1` at rest) and the stroke is now 1.25 with `crispEdges`, which is
 * what makes it legible without making it clunky.
 *
 * `shapeRendering: crispEdges` is what keeps the horizontal/vertical strokes
 * from being anti-aliased into two half-intensity rows. It is deliberately NOT
 * applied to the restore diagonal-free shapes only - none of these glyphs have
 * diagonals except the close cross, which is left smooth on purpose, because
 * crispEdges on a diagonal produces visible stair-stepping.
 */
const WinGlyph = ({ k }) => {
  const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.25 };
  const crisp = { ...line, shapeRendering: "crispEdges" };
  if (k === "min") {
    // a 1px rule on the exact pixel row the eye expects
    return html`<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" ...${crisp} /></svg>`;
  }
  if (k === "max") {
    return html`<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" ...${crisp} /></svg>`;
  }
  if (k === "restore") {
    return html`<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 0.5h7v7" ...${crisp} /><rect x="0.5" y="2.5" width="7" height="7" ...${crisp} /></svg>`;
  }
  return html`<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" ...${line} /></svg>`;
};

/** The three window controls, for the right end of the intent bar.
 *
 * The window is undecorated (`src-tauri/src/main.rs`), so without these there is
 * no way to minimise, maximise or close except the taskbar and Alt+F4.
 *
 * They used to sit in a caption bar of their own above the intent bar. That is
 * where Windows puts them and it looked right, but it cost a whole row of
 * vertical space, and a row of chrome in an editor is expensive. They are now
 * the last group in the intent bar, behind their own vertical rule so they do
 * not read as another toolbar button.
 *
 * Dragging is `data-tauri-drag-region="deep"` on the bar itself rather than a
 * mousedown handler calling `startDragging()`. Tauri's injected script walks up
 * from the clicked element and stops at anything clickable, so these three stay
 * clickable while the rest of the bar moves the window, and a double-click on
 * the empty part maximises. Hand-rolling that would mean reimplementing the
 * clickable-element test, and getting it wrong means a button that drags the
 * window instead of pressing.
 *
 * Renders nothing without a shell, so the browser build is unchanged.
 */
const CapControls = memo(function CapControls({ shell }) {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!shell) return undefined;
    return shell.onMaximizeChange(setMax);
  }, [shell]);
  if (!shell) return null;
  // Every control returns a promise that rejects when the ACL refuses it. The
  // bridge has already written the reason into `#faults`; swallowing the
  // rejection here stops it also arriving as an unhandled rejection, which would
  // print the same fact twice.
  const press = (p) => { if (p && p.catch) p.catch(() => {}); };
  return html`<div class="capctl">
    <button class="capbtn" title="Minimise" aria-label="Minimise"
      onClick=${() => press(shell.minimize())}><${WinGlyph} k="min" /></button>
    <button class="capbtn" title=${max ? "Restore" : "Maximise"} aria-label=${max ? "Restore" : "Maximise"}
      onClick=${() => press(shell.toggleMaximize())}><${WinGlyph} k=${max ? "restore" : "max"} /></button>
    <button class="capbtn danger" title="Close" aria-label="Close"
      onClick=${() => press(shell.close())}><${WinGlyph} k="close" /></button>
  </div>`;
});

/** Identity, one input, the run control. There is no toolbar on purpose.
 *
 * The AI status is a single dot. It used to spell out "ai off" next to it, which
 * is a sentence about a feature nobody asked about sitting permanently in the
 * most valuable strip of the window. A dot says everything the sentence did, and
 * a tooltip says the rest if you want it.
 */
/** The one line of chrome Zen keeps.
 *
 * Zen is a mode whose entire promise is "just the code", so the failure mode is
 * being too generous with what it keeps, not too strict. Every part here is off
 * by default except the two that answer a question a writer actually asks mid-
 * sentence - where am I, and is this file broken - and each can be turned off
 * individually in Settings. With all of them off the bar collapses entirely
 * (`html[data-zen="1"] .zenbar.empty`), so "just code" really is just code.
 *
 * It is a bar rather than an overlay in the corner on purpose: an overlay sits
 * on top of the code, and in a mode about removing distraction, adding something
 * that covers line 40 is the wrong trade.
 */
const ZenBar = memo(function ZenBar({ values, onExit, onOpenProblems,
                                      fileName, cursor, lang, dirty, counts, running }) {
  const parts = [];
  if (values.zenFile) {
    parts.push(html`<span class="z" key="f"><b>${fileName || "no file"}</b>${dirty ? html`<i class="dotd" />` : null}</span>`);
  }
  if (values.zenStatus) {
    parts.push(html`<span class="z" key="c"><b>${cursor.line}</b>:${cursor.col}</span>`);
    if (lang) parts.push(html`<span class="z" key="l">${lang}</span>`);
    if (running) parts.push(html`<span class="z" key="r"><b>running</b></span>`);
  }
  // The problems ticker is the whole reason this bar exists rather than nothing.
  // It is the one piece of the right panel that is worth interrupting for, and
  // it is clickable: pressing it leaves Zen and opens the panel on Problems,
  // because knowing there are three warnings is only useful if you can get to
  // them without first working out how to get out of the mode you are in.
  const nErr = counts ? counts.error : 0;
  const nWarn = counts ? counts.warn : 0;
  if (values.zenProblems && (nErr || nWarn)) {
    parts.push(html`<span class="z act" key="p" onClick=${onOpenProblems}
      title="Leave Zen and open Problems">
      ${nErr ? html`<span style=${{ color: "var(--err, #D9705F)" }}>${nErr} error${nErr === 1 ? "" : "s"}</span>` : null}
      ${nErr && nWarn ? html`<span>·</span>` : null}
      ${nWarn ? html`<span>${nWarn} warning${nWarn === 1 ? "" : "s"}</span>` : null}
    </span>`);
  } else if (values.zenProblems) {
    parts.push(html`<span class="z" key="p0">no problems</span>`);
  }
  parts.push(html`<span class="space" key="s"></span>`);
  parts.push(html`<span class="z zesc" key="e" onClick=${onExit} style=${{ cursor: "pointer" }}
    title="Leave Zen mode">Esc</span>`);
  const empty = !(values.zenFile || values.zenStatus || values.zenProblems);
  return html`<div class=${"zenbar" + (empty ? " empty" : "")}>${parts}</div>`;
});

const IntentBar = memo(function IntentBar({ root, wsName, coreVersion, aiOnline, aiLabel, running,
                                            onAction, onPalette, onOpenFolder, onSave, onSettings,
                                            onToggleMode, readMode,
                                            treeFold, panelFold,
                                            onFoldTree, onFoldPanel, gitBranch, gitDirty,
                                            onZen }) {
  const [menu, setMenu] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  useEffect(() => {
    if (!menu && !aiMenu) return;
    const close = () => { setMenu(false); setAiMenu(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu, aiMenu]);
  return html`<div class="intent" data-tauri-drag-region="deep">
    <div class="left">
      <button class="iconbtn" title="Settings   Ctrl+," onClick=${onSettings}><${Ico} k="gear" /></button>
      <button class=${"iconbtn" + (treeFold ? " off" : "")} title="Show or hide the explorer"
        onClick=${onFoldTree}><${Ico} k="panelL" /></button>
      <span class="vrule"></span>
      <button class="iconbtn" title="Open file   Ctrl+P" onClick=${() => onPalette()}><${Ico} k="file" /></button>
      <button class="iconbtn" title="Open folder" onClick=${onOpenFolder}><${Ico} k="folder" /></button>
      <button class="iconbtn" title="Save   Ctrl+S" onClick=${onSave}><${Ico} k="save" /></button>
      <span class="vrule"></span>
      <span class="ws" title=${root}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1.8 4.2h4l1.2 1.6h6.2v6H1.8z"></path></svg>
        <span>${wsName}</span>
      </span>
      ${coreVersion ? html`<span class="chip" title=${"wasm text core v" + coreVersion + " - lexer and document model, compiled from Rust"}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M8 1.6l5.4 3.1v6.6L8 14.4 2.6 11.3V4.7z"></path>
          <path d="M8 8l5.4-3.1M8 8v6.4M8 8L2.6 4.9" strokeLinecap="round"></path>
        </svg></span>` : null}
    </div>
    <button class="search" type="button" title="Search and open files   Ctrl+P"
      onMouseDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); onPalette(); }}>
      <${Ico} k="search" size=${13} />
      <span class="searchhint">search</span>
    </button>
    <div class="right">
      ${CORE ? null : html`<${React.Fragment}>
      <button class=${"aistat" + (aiOnline ? " on" : "")}
        title=${aiOnline
          ? "The companion is running - suggestions and a second opinion on diagnostics"
          : "The companion is off. Everything except suggestions works without it. Click to start it."}
        onClick=${(e) => { e.stopPropagation(); setAiMenu(!aiMenu); }}>
        <span class="led" />
      </button>
      ${aiMenu ? html`<div class="menu aimenu" onClick=${(e) => e.stopPropagation()}>
        <div class="row on"><span>${aiOnline ? "companion: on" : "companion: off"}</span></div>
        <div class="sep"></div>
        <div class="row" onClick=${() => { setAiMenu(false); onToggleAI(); }}>
          <span>${aiOnline ? "Turn it off" : "Turn it on"}</span></div>
      </div>` : null}
      </${React.Fragment}>`}
      <button class=${"iconbtn" + (panelFold ? " off" : "")} title="Show or hide the right panel"
        onClick=${onFoldPanel}><${Ico} k="panel" /></button>
      <button class="iconbtn" title="Zen mode - just the code   Ctrl+Shift+Z"
        onClick=${onZen}><${Ico} k="zen" /></button>
      <${CapControls} shell=${SHELL} />
      <div class="runwrap">
      <div class=${"run" + (running ? " busy" : "")}>
        <button class="main" onClick=${() => onAction("run")} title="Run  Ctrl+Enter">
          ${running
            ? html`<svg width="11" height="11" viewBox="0 0 12 12"><rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.3" fill="#E9E9EE"></rect></svg>`
            : html`<svg width="11" height="11" viewBox="0 0 12 12"><path d="M3.6 2.2v7.6l5.8-3.8-5.8-3.8z" fill="#E9E9EE"></path></svg>`}
          <span>${running ? "Stop" : "Run"}</span>
        </button>
        <span class="div"></span>
        <button class="chev" title="More actions" onClick=${(e) => { e.stopPropagation(); setMenu(!menu); }}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="#9A9AA4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5L6 7.5L9 4.5"></path></svg>
        </button>
      </div>
      ${menu ? html`<div class="menu" onClick=${(e) => e.stopPropagation()}>
        ${ACTIONS.map(([k, label, key], i) => html`<div key=${k} class=${"row" + (i === 0 ? " on" : "")}
            onClick=${() => { setMenu(false); onAction(k); }}>
          <${MIco} k=${k} /><span>${label}</span>${key ? html`<span class="k">${key}</span>` : null}
        </div>`)}
        <div class="sep"></div>
        <div class="row" onClick=${() => { setMenu(false); onToggleMode(); }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#5C5C66" strokeWidth="1.4"><rect x="1.8" y="3" width="10.4" height="8" rx="1.4"></rect><path d="M1.8 5.6h10.4"></path></svg>
          <span>${readMode ? "Programming mode" : "Reading mode"}</span>
        </div>
      </div>` : null}
      </div>
    </div>
  </div>`;
});

/** Flat paths into a nested structure.
 *
 * The server sends a flat list because a flat list is also what a file picker
 * wants; the nesting belongs here.
 *
 * Folders are inserted first and from their own list, not inferred from the
 * file paths. That is what makes an *empty* folder visible: inferred from files
 * alone, a folder with nothing in it does not exist, so creating one looked
 * like it had done nothing.
 */
function buildTree(paths, dirs, root) {
  // the root carries an empty key so "create at the top level" is addressable
  // the same way as "create inside src/" - one comparison, no special case
  const top = { name: "", key: "", dirs: {}, files: [] };
  const strip = (p) => {
    if (root && root !== "." && p.startsWith(root)) {
      return p.slice(root.length).replace(/^[\\/]+/, "");
    }
    return p;
  };
  const descend = (rel) => {
    const parts = String(rel).split(/[\\/]/).filter(Boolean);
    let node = top, prefix = "";
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? prefix + "/" + parts[i] : parts[i];
      if (!node.dirs[parts[i]]) {
        // `key` is relative and only identifies the row in React state;
        // `path` is absolute and is what the filesystem move endpoint needs.
        // Without this distinction a folder row dropped onto another folder
        // sent the relative key (or an empty string) to `/api/move`, so the
        // visual drag appeared to do nothing.
        const absolute = root && root !== "."
          ? root.replace(/[\\/]+$/, "") + "/" + prefix
          : prefix;
        node.dirs[parts[i]] = { name: parts[i], key: prefix, path: absolute, dirs: {}, files: [] };
      }
      node = node.dirs[parts[i]];
    }
    return { node, parts };
  };
  for (const d of dirs || []) descend(strip(d));
  for (const p of paths || []) {
    const parts = strip(p).split(/[\\/]/).filter(Boolean);
    if (!parts.length) continue;
    const { node } = descend(parts.slice(0, -1).join("/"));
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return top;
}

/** The extension rule, in one place so the preview and the commit agree.
 *
 * An empty extension becomes `.txt` and anything the user actually types is
 * kept: `notes` makes `notes.txt`, `datara.dtr` makes a Datara source file, and
 * `tools/check.dtr` makes both the folder and the file. Guessing a language
 * from the name would be wrong more often than it was right.
 */
function resolveName(name, isDir) {
  const v = String(name || "").trim().replace(/[\\/]+$/, "");
  if (!v || isDir) return v;
  const parts = v.split(/[\\/]/);
  const base = parts[parts.length - 1];
  if (base.includes(".") && !base.endsWith(".")) return v;
  parts[parts.length - 1] = base.replace(/\.+$/, "") + ".txt";
  return parts.join("/");
}

// A right-pointing chevron that rotates 90deg to "open" the folder. The first
// version's closed state pointed left ("M4.5 3L7.5 6L4.5 9"), which reads as
// collapsed-but-backwards - the chevron that points the wrong way. Collapsed
// folders point right and rotate to point down when open, the convention every
// file manager on the planet settled on.
const Chevron = ({ open }) => html`<svg width="9" height="9" viewBox="0 0 12 12" fill="none"
  stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
  style=${{ transform: open ? "rotate(90deg)" : "none" }}><path d="M3 4.5L6 7.5L9 4.5"></path></svg>`;

/** One row of the tree.
 *
 * Everything sits in fixed-width slots - chevron, icon, name - so folder names
 * and file names line up on the same axis instead of each row inventing its own
 * indentation. The chevron slot is kept for files too (empty), which is what
 * makes the two align rather than being two pixels out.
 */
const TreeNode = memo(function TreeNode({ node, depth, closed, toggle, current, onOpen, dirty,
                                          drag, setDrag, over, setOver, onDropInto,
                                          creating, createKey, onCommit, onCancelCreate, onCtx }) {
  const dirNames = Object.keys(node.dirs).sort((a, b) => a.localeCompare(b));
  const fileList = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
  const pad = { paddingLeft: (8 + depth * 13) + "px" };
  const rowDepth = node.key === "" ? 0 : depth + 1;

  const dragPath = (e) => {
    try { return e.dataTransfer.getData("text/plain") || drag; }
    catch (err) { return drag; }
  };
  const dropTarget = (key, path) => ({
    onDragEnter: (e) => { e.preventDefault(); e.stopPropagation(); setOver(key); },
    onDragOver: (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      setOver(key);
    },
    onDragLeave: (e) => {
      // A folder row contains several children; only clear when the pointer
      // really leaves the row, not when it crosses its icon or label.
      if (!e.currentTarget.contains(e.relatedTarget)) {
        setOver((o) => (o === key ? null : o));
      }
    },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation();
      const src = dragPath(e);
      setOver(null); setDrag(null);
      if (src) onDropInto(src, path);
    },
  });

  return html`<${React.Fragment}>
    ${createKey === node.key && creating
      ? html`<${NewRow} kind=${creating} depth=${rowDepth}
          onCommit=${onCommit} onCancel=${onCancelCreate} />`
      : null}
    ${dirNames.map((d) => {
      const child = node.dirs[d];
      const isOpen = !closed[child.key];
      const isOver = over === child.key;
      return html`<${React.Fragment} key=${"d:" + child.key}>
        <div class=${"tdir" + (isOver ? " over" : "")} style=${pad}
          draggable=${true}
          onDragStart=${(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", child.path || child.key);
            e.dataTransfer.effectAllowed = "move";
            setDrag(child.path || child.key);
          }}
          onDragEnd=${() => { setDrag(null); setOver(null); }}
          onClick=${() => toggle(child.key)}
          onContextMenu=${(e) => onCtx && onCtx(e, "dir", child.path || child.key)}
          ...${dropTarget(child.key, child.path || "")}>
          <span class="slot"><${Chevron} open=${isOpen} /></span>
          <span class="slot"><${Ico} k="folder" size=${15} /></span>
          <span class="nm">${d}</span>
        </div>
        ${isOpen ? html`<${TreeNode} node=${child} depth=${depth + 1} closed=${closed}
          toggle=${toggle} current=${current} onOpen=${onOpen} dirty=${dirty}
          drag=${drag} setDrag=${setDrag} over=${over} setOver=${setOver}
          onDropInto=${onDropInto} creating=${creating} createKey=${createKey}
          onCommit=${onCommit} onCancelCreate=${onCancelCreate} onCtx=${onCtx} />` : null}
      <//>`;
    })}
    ${fileList.map((f) => {
      const [glyph, colour] = fileIcon(f.name);
      const on = f.path === current;
      return html`<div key=${"f:" + f.path}
        class=${"tfile" + (on ? " on" : "") + (drag === f.path ? " dragging" : "")}
        style=${{ ...pad, color: on ? "var(--ink1)" : undefined }}
        title=${f.path}
        draggable=${true}
        onDragStart=${(e) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", f.path);
          e.dataTransfer.effectAllowed = "move";
          setDrag(f.path);
        }}
        onDragEnd=${() => { setDrag(null); setOver(null); }}
        onClick=${() => onOpen(f.path)}
        onContextMenu=${(e) => onCtx && onCtx(e, "file", f.path)}>
        <span class="slot"></span>
        <span class="slot" style=${{ color: colour }}><${Ico} k=${glyph} size=${15} /></span>
        <span class="nm">${f.name}${on && dirty ? html`<i class="d">●</i>` : null}</span>
      </div>`;
    })}
  <//>`;
});

/** The create row.
 *
 * Inline in the tree rather than in a modal, because the point is that the
 * thing appears where it will live and can be named immediately. Enter commits,
 * Escape abandons it, and blur commits too - clicking away from a half-typed
 * name and losing it is worse than creating it.
 *
 * The name it will actually get is shown underneath whenever that differs from
 * what was typed. The extension rule is invisible otherwise, and a `.txt`
 * appearing by surprise is worse than one that is announced.
 */
const NewRow = ({ kind, depth, onCommit, onCancel }) => {
  const isDir = kind === "folder";
  const [name, setName] = useState(isDir ? "new-folder" : "untitled.txt");
  const ref = useRef(null);
  // Enter commits and unmounts this row, and removing a focused element fires
  // blur - which would commit a second time and create the item twice. The
  // guard has to be a ref and not state, because it must be readable in the
  // same tick the commit happens.
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // select the stem so typing replaces the name and keeps the extension
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }, []);
  const resolved = resolveName(name, isDir);
  const go = () => {
    if (done.current) return;
    done.current = true;
    if (resolved) onCommit(resolved, isDir);
    else onCancel();
  };
  const [glyph, colour] = isDir ? ["folder", "var(--ink3)"] : fileIcon(resolved || name);
  return html`<${React.Fragment}>
    <div class="newrow" style=${{ paddingLeft: (8 + depth * 13) + "px" }}>
      <span class="slot"></span>
      <span class="slot" style=${{ color: colour }}><${Ico} k=${glyph} size=${15} /></span>
      <input ref=${ref} value=${name} spellcheck="false"
        placeholder=${isDir ? "folder name" : "name, or a path"}
        onInput=${(e) => setName(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Enter") { e.preventDefault(); go(); }
          if (e.key === "Escape") { e.preventDefault(); done.current = true; onCancel(); }
        }}
        onBlur=${go} />
    </div>
    ${resolved && resolved !== name.trim()
      ? html`<div class="newhint" style=${{ paddingLeft: (8 + depth * 13 + 33) + "px" }}>
          will be ${resolved}</div>`
      : null}
  <//>`;
};

const Tree = memo(function Tree({ files, dirs, current, filter, setFilter, onOpen, dirty,
                                   root, creating, createKey, onCreate, onCommit, onCancelCreate,
                                   error, note, onPickFolder, onDropInto, onRename, onDelete }) {
  const [closed, setClosed] = useState({});
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const [ctx, setCtx] = useState(null); // { kind: "file"|"dir", path, x, y }
  useEffect(() => {
    if (!menu && !ctx) return;
    const close = () => { setMenu(false); setCtx(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu, ctx]);
  const tree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const keep = (p) => !q || p.toLowerCase().includes(q);
    return buildTree(q ? files.filter(keep) : files, q ? dirs.filter(keep) : dirs, root);
  }, [files, dirs, filter, root]);
  const toggle = useCallback((key) => setClosed((c) => ({ ...c, [key]: !c[key] })), []);
  // the folder being written into is forced open, or the row would be invisible
  const closedEff = creating ? { ...closed, [createKey]: false } : closed;
  const empty = !error && !creating && files.length === 0 && dirs.length === 0;
  const onCtx = (e, kind, path) => {
    e.preventDefault(); e.stopPropagation();
    setCtx({ kind, path, x: e.clientX, y: e.clientY });
  };
  return html`<div class="tree">
    <div class="hd">
      <span class="lbl">explorer</span>
      <div class="newwrap">
        <button class="newbtn" title="Create a file or a folder  Ctrl+N"
          onClick=${(e) => { e.stopPropagation(); setMenu(!menu); }}>
          <${Ico} k="plus" size=${12} />create</button>
        ${menu ? html`<div class="newmenu" onClick=${(e) => e.stopPropagation()}>
          <div class="row" onClick=${() => { setMenu(false); onCreate("file"); }}>
            <${Ico} k="file" size=${14} /><span>File</span></div>
          <div class="row" onClick=${() => { setMenu(false); onCreate("folder"); }}>
            <${Ico} k="folder" size=${14} /><span>Folder</span></div>
        </div>` : null}
      </div>
    </div>
    <div class="fieldwrap">
      <${Ico} k="search" size=${13} />
      <input class="filter" placeholder="filter files" value=${filter}
        onInput=${(e) => setFilter(e.target.value)} />
    </div>
    <div class=${"list" + (over === "__root__" ? " over" : "")}
      onDragOver=${(e) => { e.preventDefault(); if (drag) setOver("__root__"); }}
      onDragLeave=${() => setOver((o) => (o === "__root__" ? null : o))}
      onDrop=${(e) => {
        e.preventDefault();
        const src = e.dataTransfer.getData("text/plain") || drag;
        setOver(null); setDrag(null);
        if (src) onDropInto(src, root);
      }}>
      <${TreeNode} node=${tree} depth=${0} closed=${closedEff} toggle=${toggle}
        current=${current} onOpen=${onOpen} dirty=${dirty}
        drag=${drag} setDrag=${setDrag} over=${over} setOver=${setOver}
        onDropInto=${onDropInto} creating=${creating} createKey=${createKey}
        onCommit=${onCommit} onCancelCreate=${onCancelCreate} onCtx=${onCtx} />
      ${error ? html`<div class="note bad" style=${{ padding: "12px" }}>
        <div>${error}</div>
        ${onPickFolder ? html`<button class="mini" style=${{ marginTop: "8px" }}
          onClick=${onPickFolder}>choose a folder</button>` : null}
      </div>` : null}
      ${note ? html`<div class="note" style=${{ padding: "8px 12px" }}>${note}</div>` : null}
      ${empty ? html`<div class="note" style=${{ padding: "12px" }}>
        Nothing here yet. <b>create</b> adds a file or a folder.</div>` : null}
    </div>
    ${ctx ? html`<div class="ctxmenu" style=${{ left: ctx.x, top: ctx.y }}
        onClick=${(e) => e.stopPropagation()}>
      <div class="row" onClick=${() => { const p = ctx; setCtx(null); onRename && onRename(p.kind, p.path); }}>
        <${Ico} k="edit" size=${13} /><span>Rename</span><span class="k">F2</span></div>
      <div class="row" onClick=${() => { const p = ctx; setCtx(null); onDelete && onDelete(p.kind, p.path); }}>
        <${Ico} k="trash" size=${13} /><span>Delete</span><span class="k">Del</span></div>
    </div>` : null}
  </div>`;
});

/** The right panel.
 *
 * Ordered offline-first, because that is the honest priority for an editor: the
 * compiler's own problems, then the structure of what you are writing, then the
 * project, then the layout inspector - and only then the companion's
 * suggestions. A person who never starts the AI still gets a useful panel, which
 * is the point: the AI is a guest here, not the host.
 */
// The panel's tabs, as data. `Panel` draws them and `Settings` lists them, so
// what a tab is called and the order they come in live here rather than inside
// either one - otherwise the Settings list and the strip could disagree about
// what a tab is, which is the kind of drift that makes a settings screen lie.
const PANEL_TAB_IDS = ["prob", "struct", "proj", "lay", "ai", "gen", "chat"];
const PANEL_TAB_LABELS = {
  prob: "Problems", struct: "Structure", proj: "Project",
  lay: "Layout", ai: "AI", gen: "Generate", chat: "Chat",
};
// The tabs that are AI rather than the language.
//
// `core` is the studio with the companion removed - not a stripped build and not
// a second interface, the same page with these tabs absent and the plug behind
// them taken out of the bar. It is a list rather than a flag on each tab because
// the answer is needed in exactly two places (which tabs to draw, and whether to
// offer to start the companion at all) and both of them want the same set.
// Adding a third AI tab means adding it here and nowhere else.
const AI_TABS = ["ai", "gen", "chat"];
// Short labels for the tab strip.
//
// "Problems" is 72px and "Structure" 70px, so six of them want 380px in a panel
// that is 264px wide by default - 116px of the strip was unreachable, and the
// auto-scroll that keeps the selected tab visible was pushing the first tab out
// the LEFT edge where nothing says it exists. Abbreviating the four long names
// costs nothing (the full name is in the tooltip, and the Settings list already
// says what each one is) and brings the row to 268px, which fits a default panel
// almost exactly. A wider panel shows the abbreviations with room to spare,
// which is the right failure: too short a label is a nicety, an unreachable tab
// is a bug.
const PANEL_TAB_SHORT = {
  prob: "Issues", struct: "Symbols", proj: "Project",
  lay: "Layout", ai: "AI", gen: "Generate", chat: "Chat",
};

/**
 * One line describing the companion's generator, for the Generate header.
 *
 * This exists because the obvious version was wrong in public. The header used
 * to read `${genModel.order}-gram · ${genModel.total_tokens} tokens`, and the
 * companion sets `total_tokens` from the model object it holds, which is `null`
 * for the pure-Python n-gram model - so every user of the full build saw
 * "3-gram · null tokens" as the first thing on the panel. The honest badge is
 * whatever the companion actually reported: a corpus size it knows, or nothing
 * about size at all.
 *
 * The count arrives under two different keys depending on the verb - `GET
 * /model` sends `trained_on`, `POST /model` sends `trained_on_files` - and the
 * IDE only ever uses the POST, but reading both costs one `||` and means a
 * change on either side cannot silently empty the badge again.
 *
 * `retriever` and `verifier` are the two capabilities the panel's own prose
 * promises ("exemplar retrieval", "verification through forgen"), so they are
 * shown as present or absent rather than assumed. A generator without them is
 * still usable - it just warrants less trust, which is exactly what the reader
 * needs to know before pressing the button.
 */
function describeModel(m) {
  const bits = [];
  if (m.order != null) bits.push(m.order + "-gram");
  const files = m.trained_on_files != null ? m.trained_on_files : m.trained_on;
  if (files != null) bits.push(files + " files");
  if (m.total_tokens != null) bits.push(m.total_tokens + " tokens");
  const caps = [];
  if (m.retriever) caps.push("retrieval");
  if (m.verifier) caps.push("verified");
  const head = bits.length ? bits.join(" · ") : "model loaded";
  return caps.length ? head + " · " + caps.join(" · ") : head;
}

/**
 * A character count as a size a person reads at a glance.
 *
 * The chat context readout is the only place the interface shows "how much is
 * being carried", and "1705" is a number nobody has an intuition for while
 * "1.7 KB" reads instantly. Kept separate from the file-size display elsewhere
 * because that one says "bytes" literally and is compared against a limit.
 */
function fmtBytes(n) {
  if (n == null) return "0";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

/** How much of the open file is sent to the companion as context.
 *
 *  Module scope, not panel scope, because two different components need the same
 *  number: `runGenerate` slices the file with it, and the Generate panel reports
 *  it back to the reader. Declared inside the panel it was simply not defined
 *  where it was used, which threw inside the request handler and left the
 *  button saying "generating ..." forever - the fetch never happened, and the
 *  only clue was a page error nobody was reading.
 *
 *  Measured against the daemon: it echoes the context back at the head of its
 *  answer and the panel subtracts that echo, so this number is also how much of
 *  the file the companion can be said to have read. */
const GEN_CONTEXT_CHARS = 4000;

const Panel = memo(function Panel({ tab, setTab, order, hidden, onReorder,
                                     suggestions, diagnostics, aiOnline, aiLabel,
                                     layout, layoutBusy, onScan, onInsert, onGoto, outline,
                                     genReq, genRes, genErr, genBusy, genModel, onGenReq, onGenerate,
                                     genWhere, genCtx,
                                     chatMsgs, chatReq, chatBusy, chatErr, chatCtx, chatClearing,
                                     onChatReq, onChatSend, onChatClear, onChatUndo, onChatProject,
                                     fmtBytes,
                                     onStartAI, aiStarting, project, git, refs, refWord, refBusy,
                                     searchQ, onSearchQ, searchFocus, refWhole, onRefWhole, onRunSearch,
                                     refScroll,
                                     current, onOpen, projDiag, projBusy, projWhere, onCheckProject, onGotoProblem }) {
  const sev = (s) => (s === "warning" ? "w" : "e");

  // Take focus in the project search box when asked.
  //
  // Keyed on the counter rather than on a boolean, so pressing Ctrl+Shift+F
  // twice focuses twice. `select()` rather than a bare `focus()` because the box
  // is usually pre-filled with the word at the caret, and the next thing anyone
  // does is type a different one - without the select, they type into the middle
  // of the old query and search for something that exists only by accident.
  useEffect(() => {
    if (!searchFocus) return;
    const el = document.getElementById("psearch");
    if (!el) return;
    el.focus();
    el.select();
  }, [searchFocus]);

  // Bring the search results into view when a search was started from a
  // shortcut.
  //
  // The panel is a scrolling column (`.pbody`, `overflow:auto`) and the
  // References card sits under the project summary, the git state and the
  // language breakdown. Measured on this repo with a real workspace open: 1394px
  // of content against 824px of panel, card at 1212. So after Ctrl+Shift+F the
  // only thing on screen was the status bar reading "13 place(s) in the
  // workspace" - which is exactly what a shortcut that does nothing looks like.
  //
  // Focus alone does not fix it. The browser scrolls a focused element into view
  // minimally, which puts the box at the bottom edge of the panel, and nothing
  // re-scrolls when the hits arrive.
  //
  // The target is the *card*, and it goes to the *top* of the column, because
  // the card is not the result - it is the header of the result. Each hit is its
  // own card, rendered after it, so anything that leaves the References card at
  // the bottom edge leaves every hit below the fold: the box and the count are
  // visible, the thirteen lines they are counting are not. Aligning the top puts
  // the query, the mode, the count and as much of the list as the column holds
  // in one screenful.
  //
  // `block: "start"` and not `"nearest"`. With two hits on a 340px panel the
  // References card is shorter than the panel, so "nearest" resolves to aligning
  // its *bottom* edge - measured, that put the card at y=143 in a panel ending at
  // 312 and the first hit at y=267, off screen. "start" puts the card at 88 and
  // the first hit at 256.
  //
  // The first bump, before the hits exist, is clamped: the card is the last
  // child until the results render, so there is nothing below it to scroll
  // against and it stops at the maximum scroll. That is why `runProjectSearch`
  // bumps a second time once the hits are in.
  //
  // No `behavior: "smooth"`. The distance is a few hundred pixels in a 264px
  // column, so the animation buys nothing, and it makes the result unmeasurable
  // for the second or so it runs - the test that checks the results ended up on
  // screen would have to sleep and hope.
  useEffect(() => {
    if (!refScroll) return;
    const card = document.getElementById("refcard");
    if (card) card.scrollIntoView({ block: "start" });
  }, [refScroll]);

  const problems = () => {
    const fromCompiler = diagnostics.filter((d) => d.source === "compiler");
    const fromAI = diagnostics.filter((d) => d.source !== "compiler");
    const errors = diagnostics.filter((d) => d.severity !== "warning").length;
    const head = html`<div class="card">
      <div class="ch"><b>${diagnostics.length
        ? diagnostics.length + (diagnostics.length === 1 ? " problem" : " problems")
        : "No problems in this file"}</b>
        ${errors ? html`<span class="tag e">${errors} error${errors === 1 ? "" : "s"}</span>` : null}
        ${fromCompiler.length ? html`<span class="tag">forgen</span>` : null}
        ${fromAI.length ? html`<span class="tag">${aiLabel || "companion"}</span>` : null}</div>
      <pre>${diagnostics.length
        ? "Errors come from the compiler itself, so they appear while you type and need no AI."
        : "The compiler reports nothing for this file."}</pre>
      <button class="mini" style=${{ marginTop: "9px" }} onClick=${onCheckProject}>
        ${projBusy ? "checking ..." : "check the whole project"}</button>
    </div>`;

    // A project check answers a different question from the file check, so it
    // gets its own section rather than being merged into it.
    const projSection = () => {
      if (projDiag === null) return [];
      if (!projDiag.length) {
        return [html`<div class="card" key="p0">
          <div class="ch"><span class="tag a">clean</span><b>the whole project</b></div>
          <pre>forgen compiled every module and reported nothing.</pre>
          ${projWhere ? html`<pre class="muted">${projWhere}</pre>` : null}</div>`];
      }
      const byFile = {};
      for (const d of projDiag) (byFile[d.file] = byFile[d.file] || []).push(d);
      const files = Object.keys(byFile).sort();
      const head = html`<div class="card" key="ph">
        <div class="ch"><b>${projDiag.length} in the project</b>
          <span class="tag">${files.length} file${files.length === 1 ? "" : "s"}</span></div>
        <pre>Across every module. Click one to open the file at the line.</pre>
        ${projWhere ? html`<pre class="muted">${projWhere}</pre>` : null}</div>`;
      return [head].concat(files.map((f) => html`<div class="card" key=${f}>
        <div class="ch"><b>${f.split(/[\\/]/).pop()}</b>
          <span class="tag">${byFile[f].length}</span></div>
        <pre class="muted">${f}</pre>
        ${byFile[f].map((d, i) => html`<div class="sym" key=${i} onClick=${() => onGotoProblem(d)}>
          <span class=${"tag " + sev(d.severity)}>${d.code || d.severity}</span>
          <span class="mono" style=${{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
            ${d.line}:${d.col} ${d.message}</span>
        </div>`)}
      </div>`));
    };

    const fileSection = () => {
      if (!diagnostics.length) return [];
      return diagnostics.map((d, i) => html`<div class="card" key=${i}>
        <div class="ch"><span class=${"tag " + sev(d.severity)}>${d.code || d.severity}</span>
          <b>${(d.file || "").split(/[\\/]/).pop() || "this file"}:${d.line}</b></div>
        <pre>${d.message}</pre>
        ${d.help ? html`<div class="ins">${d.help}</div>` : null}
        <button class="mini" style=${{ marginTop: "7px" }}
          onClick=${() => onGoto(d.line, d.col)}>go to line</button></div>`);
    };

    return [head].concat(projSection(), fileSection());
  };

  const structure = () => {
    if (!current) return html`<div class="note">No file open.</div>`;
    const lang = providerFor(current);
    if (lang.id !== "datara") return html`<div class="note">
      <b>${current.split(/[\\/]/).pop()}</b> is not a Datara file, so this IDE has
      no structure to show for it.<br /><br />
      The editor, the file tree, search and the project view all work normally -
      but symbol extraction, hover help and compiler diagnostics are Datara
      features and are switched off rather than guessed at.</div>`;
    if (!outline.length) return html`<div class="note">
      No top-level declarations found in this file.<br /><br />
      The scan is a regex over line starts, not a parse - nested declarations and
      one-line structs are not found. Reusing forgen's own parser is the fix.</div>`;
    const groups = {};
    for (const s of outline) (groups[s.kind] = groups[s.kind] || []).push(s);
    return Object.keys(groups).map((k) => html`<div class="card" key=${k}>
      <div class="ch"><span class="tag">${k}</span><b>${groups[k].length}</b></div>
      ${groups[k].map((s, i) => html`<div class="sym" key=${i} onClick=${() => onGoto(s.line)}>
        <span class="mono">${s.name}</span><span class="tag" style=${{ marginLeft: "auto" }}>${s.line}</span>
      </div>`)}
    </div>`);
  };

  const proj = () => {
    if (!project) return html`<div class="note">Reading the workspace ...</div>`;
    const langs = project.langs || [];
    const top = langs.length ? langs[0][1] : 1;
    return html`<${React.Fragment}>
      <div class="card">
        <div class="ch"><b>${project.name}</b>
          <span class="tag">${project.files} files</span>
          <span class="tag">${project.dirs} folders</span></div>
        <pre>${project.root}</pre>
      </div>
      ${git.branch ? html`<div class="card">
        <div class="ch"><b>git</b><span class="tag">${git.branch}</span>
          ${git.dirty ? html`<span class="tag w">${git.dirty} changed</span>` : html`<span class="tag a">clean</span>`}</div>
        ${(git.files || []).length ? html`<div class="gitfiles">${git.files.slice(0, 40).map((f) =>
          html`<div class=${"gitf " + (f.status || "M")}><span class="gits">${f.status || "M"}</span>
            <span class="mono">${f.path}</span></div>`)}</div>` : null}
        ${(git.log || []).length ? html`<pre class="gitlog">${git.log.map((l) => l.shorthand + " " + l.subject).join("\n")}</pre>` : null}
      </div>` : null}
      <div class="card">
        <div class="ch"><b>By language</b></div>
        ${langs.map(([ext, n]) => html`<div class="langrow" key=${ext}>
          <span class="mono">.${ext}</span>
          <span class="bar"><i style=${{ width: Math.round((n / top) * 100) + "%" }}></i></span>
          <span class="tag">${n}</span>
        </div>`)}
      </div>
      <div class="card" id="refcard">
        <div class="ch"><b>References</b>
          ${refWord ? html`<span class="tag">${refWord}</span>` : null}
          ${refWord ? html`<span class="tag ${refWhole ? "" : "w"}">${refWhole ? "whole name" : "any text"}</span>` : null}</div>
        <div class="findrow">
          <input class="field" id="psearch" value=${searchQ} spellCheck=${false}
            placeholder="a name, or any text"
            onInput=${(e) => onSearchQ(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === "Enter") { e.preventDefault(); onRunSearch(searchQ, refWhole); }
              if (e.key === "Escape") { e.preventDefault(); e.target.blur(); }
            }} />
          <button class="mini" title="Search the workspace   Ctrl+Shift+F"
            onClick=${() => onRunSearch(searchQ, refWhole)}>${refBusy ? "..." : "search"}</button>
        </div>
        <label class="ck">
          <input type="checkbox" checked=${refWhole}
            onChange=${(e) => onRefWhole(e.target.checked)} />
          <span>whole name only</span>
          <span class="ckhint">off, it also matches inside longer names</span>
        </label>
        <pre>${refWord
          ? (refBusy ? "searching ..." : refs.length + " place(s) in the workspace")
          : "Ctrl+Shift+F searches from anywhere, with the name at the caret already in the box. Alt+F7 searches it without the box."}</pre>
      </div>
      ${refs.length ? refs.slice(0, 40).map((r, i) => html`<div class="card" key=${i}
          style=${{ cursor: "pointer" }} onClick=${() => onOpen(r.file)}>
        <div class="ch"><b>${r.file.split(/[\\/]/).pop()}:${r.line}</b></div>
        <pre>${r.text}</pre></div>`) : null}
    <//>`;
  };

  const aiBody = () => {
    if (!aiOnline) return html`<div class="note">
      The companion is not running.<br /><br />
      It is optional - the editor, the compiler, the problems panel and the tree
      all work without it. Starting it adds suggestions and a second opinion on
      diagnostics.
      <div style=${{ marginTop: "10px" }}>
        <button class="mini" onClick=${onStartAI}>${aiStarting ? "starting ..." : "start it"}</button>
      </div></div>`;
    if (!suggestions.length) return html`<div class="note">No suggestion for this position.</div>`;
    return suggestions.map((s, i) => html`<div class="card" key=${i}>
      <div class="ch"><b>${s.display_text || "suggestion"}</b>
        ${i === 0 ? html`<span class="tag a">Tab</span>` : null}</div>
      <pre>${s.documentation || ""}</pre>
      <div class="ins">${s.insert_text}</div>
      <button class="mini" style=${{ marginTop: "7px" }}
        onClick=${() => onInsert(s.insert_text)}>insert</button></div>`);
  };

  const layoutBody = () => {
    const head = html`<div class="card">
      <div class="ch"><b>layout inspector</b></div>
      <pre>Mirrors forgen 1.4.0: fields are sorted by descending type rank then
alphabetically, offsets are index*8, and alignment is 16/32/64. Reordering
only happens when every field is an 8-byte scalar - a struct with mixed
sizes keeps its source order and the compiler warns (E-OPT-001). Each
struct below says which of the two applies.</pre>
      <input class="field" id="layroot" defaultValue="." />
      <button class="mini" onClick=${() => onScan(document.getElementById("layroot").value)}>
        scan</button></div>`;
    if (layoutBusy) return [head, html`<div class="note" key="b">scanning ...</div>`];
    if (!layout) return [head, html`<div class="note" key="n">Not scanned yet.</div>`];
    const parts = [head, html`<div class="card" key="s">
      <div class="ch"><b>${layout.structs.length} structs</b>
        <span class="tag">${layout.files} files</span></div>
      <pre>${layout.collisions.length
        ? layout.collisions.length + " field name(s) shared between structs - a readability signal, not a hazard. The field-offset miscompile that made this an alarm is fixed in 1.4.0."
        : "No shared field names."}</pre></div>`];
    layout.collisions.forEach((c, i) => {
      const seen = {};
      let conflict = false;
      c.x.forEach((v) => { if (seen[v]) conflict = true; seen[v] = 1; });
      parts.push(html`<div class="card" key=${"c" + i}>
        <div class="ch"><span class=${"tag " + (conflict ? "w" : "a")}>
          ${conflict ? "different offsets" : "same offset"}</span><b>${c.f}</b></div>
        <pre>${c.o.map((o, k) => o + "  offset " + c.x[k]).join("\n")}</pre>
        ${conflict ? html`<div class="ins">One name, several offsets. This used to
          read the wrong field silently; 1.4.0 resolves the owner properly, so it
          is safe now - but a name that means different things in different
          structs still costs the next reader time.</div>` : null}
      </div>`);
    });
    layout.structs.slice(0, 80).forEach((s, i) => {
      parts.push(html`<div class="card" key=${"t" + i}>
        <div class="ch"><b>${s.n}</b><span class="tag">align ${s.al}</span>
          <span class="tag">size ${s.sz}</span><span class="tag">${s.cnt} fields</span>
          <span class=${"tag " + (s.gate === "reorder" ? "a" : "w")}>
            ${s.gate === "reorder" ? "reorderable" : "order kept"}</span>
          ${s.soa ? html`<span class="tag w">SoA</span>`
            : s.soamaybe ? html`<span class="tag">SoA if sparse</span>` : null}</div>
        <pre>${s.f.map((f) => f[0] + " : " + f[1] + "  @" + f[2]).join("\n")}</pre></div>`);
    });
    return parts;
  };

  // Where the classifier stops having matched.
  //
  // `confidence` is the only field that reveals a miss. 0.15 is the floor the
  // companion assigns when a request falls through every shape to `generic`,
  // and `verified: true` only means forgen compiled the result - it says nothing
  // about whether the code answers the question. Read together, those two let a
  // skeleton be inserted as though it were an answer, which is exactly what
  // happened. Below the floor the insert asks first.
  const CONFIDENCE_FLOOR = 0.5;
  const weakGen = !!(genRes && genRes.confidence != null && genRes.confidence < CONFIDENCE_FLOOR);
  async function insertWeak() {
    const yes = await askUser({
      title: "Insert a skeleton?",
      body: "The companion matched this request at " + genRes.confidence
        + " confidence, so it fell through to a generic shape. The code compiles,"
        + " but nothing in it was derived from what you asked.",
      ok: "Insert anyway",
      danger: true,
    });
    if (yes) onInsert(genRes.code);
  }

  const genBody = () => html`<div>
    <div class="card">
      <div class="ch"><b>Generate Datara</b>
        ${genModel ? html`<span class="tag">${describeModel(genModel)}</span>` : null}</div>
      <pre>The in-context generator: a trained n-gram model over this project plus
exemplar retrieval, structural shapes and verification through forgen. Pure
Python, so it needs no ML runtime. The open file is sent as context, and what
comes back is added to it - so a second request continues the program rather
than starting again.</pre>
      ${genCtx ? html`<div class="genctx">
        <span>context sent</span>
        <span class="mono">${genCtx.chars} char${genCtx.chars === 1 ? "" : "s"} of the open file</span>
        ${genCtx.used === null ? null
          : html`<span class=${genCtx.used ? "ok" : "warn"}>${genCtx.used ? "the companion read it" : "the companion did not use it"}</span>`}
      </div>` : null}
      ${!aiOnline ? html`<div style=${{ marginTop: "10px" }}>
        <button class="mini" onClick=${onStartAI}>${aiStarting ? "starting ..." : "start the companion"}</button>
      </div>` : null}
      <input class="field" value=${genReq} placeholder=${genCtx && genCtx.chars ? "what should it do next?" : "what should it do?"}
        onInput=${(e) => onGenReq(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") onGenerate(); }} />
      <button class="mini" onClick=${onGenerate}>${genBusy ? "generating ..." : "generate"}</button>
    </div>
    ${genErr ? html`<div class="card"><div class="ch"><span class="tag e">error</span></div>
      <pre>${genErr}</pre></div>` : null}
    ${genRes ? html`<div class="card">
      <div class="ch"><b>${genRes.title || genRes.task}</b>
        <span class="tag">${genRes.task}</span>
        ${genRes.confidence != null ? html`<span class="tag">${genRes.confidence}</span>` : null}
        <span class=${"tag " + (genRes.verified ? "a" : "w")}>${genRes.verified ? "verified" : "unverified"}</span></div>
      <pre class="muted">${(genRes.fragments || []).join(" + ")}${(genRes.exemplars || []).length ? "  ·  exemplars: " + genRes.exemplars.join(", ") : ""}</pre>
      ${genWhere ? html`<div class="genwhere">
        <span class="ok">appended to the file</span>
        <span class="mono">${genWhere}</span>
        <span class="hint">at the end, after what was already there - Ctrl+S to save it</span>
      </div>` : null}
      ${weakGen ? html`<div class="genweak">
        <b>This is a skeleton, not an answer.</b>
        <span>The companion matched your request at ${genRes.confidence} confidence, which
is the floor it assigns when nothing in its shape table fits. The code compiles
- it is verified - but none of it came from your question.</span>
      </div>` : null}
      <div class="ins">${genRes.code}</div>
      ${genWhere || !genRes.code ? null : html`<button class="mini" style=${{ marginTop: "9px" }}
        onClick=${() => (weakGen ? insertWeak() : onInsert(genRes.code))}>insert at caret</button>`}
    </div>` : null}
  </div>`;

  // The chat tab.
  //
  // Chat rather than the plain Generate box because the two answer different
  // questions. Generate is a one-shot "write me a function"; a chat carries the
  // previous turn, so "а теперь по убыванию" and "почему main не оптимизировали"
  // have a referent at all. The companion has had a /chat endpoint all along - it
  // simply had no surface in the IDE, and the only path it did have ran through
  // the torch transformer, which is not installed here.
  //
  // The context strip is not decoration. The whole feature is that the model knows
  // what was said before, and the only way to trust that is to see it: how many
  // turns are being carried, where the context came from, and a button that
  // destroys it. Without the readout, "I cleared it" is unverifiable.
  const chatBody = () => {
    if (!aiOnline) return html`<div class="note">
      The companion is not running.<br /><br />
      Chat needs it - everything the editor does on its own works without it.
      <div style=${{ marginTop: "10px" }}>
        <button class="mini" onClick=${onStartAI}>${aiStarting ? "starting ..." : "start it"}</button>
      </div></div>`;

    const ctx = chatCtx || {};
    const source = ctx.context_source || "empty";
    const turns = ctx.turns || 0;
    // The card prints the source as it comes from the daemon (lowercase), and the
    // tag styling upper-cases it - so the test matches case-insensitively rather
    // than the label being restyled to suit a test.
    const srcTag = source === "compiler" ? "a" : (source === "manual" ? "" : "w");
    return html`<div class="chat">
      <div class="card ctxcard">
        <div class="ch"><b>Context</b>
          <span class=${"tag " + srcTag}>${source}</span>
          ${ctx.topic ? html`<span class="tag">${ctx.topic}</span>` : null}</div>
        <pre class="muted">${turns
          ? turns + (turns === 1 ? " message" : " messages") + " carried between turns"
            + (ctx.context_chars ? "  ·  " + fmtBytes(ctx.context_chars) + " of project context" : "")
          : "Nothing carried yet" + (ctx.context_chars
              ? "  ·  " + fmtBytes(ctx.context_chars) + " of project context is still attached"
              : "")}
${source === "compiler"
  ? "The context is this project, gathered from forgen - symbols, effects, dependencies."
  : source === "manual" ? "The context was set by hand."
  : "No context. A follow-up question will not know what came before."}</pre>
        <div class="ctxbtns">
          <button class="mini" disabled=${!turns && !ctx.context_chars}
            title="Delete every message and the attached context. This is final."
            onClick=${onChatClear}>${chatClearing ? "clearing ..." : "clear context"}</button>
          <button class="mini" disabled=${!turns} title="Remove the last exchange"
            onClick=${onChatUndo}>undo</button>
          ${source === "empty" ? html`<button class="mini" title="Attach the project context again"
            onClick=${onChatProject}>use the project</button>` : null}
        </div>
      </div>
      ${chatErr ? html`<div class="card"><div class="ch"><span class="tag e">error</span></div>
        <pre>${chatErr}</pre></div>` : null}
      ${(chatMsgs || []).map((m, i) => html`<div class=${"msg " + m.role} key=${"m" + i}>
        <div class="who">${m.role === "user" ? "you" : (aiLabel || "companion")}</div>
        ${m.kind === "code" && m.code
          ? html`<div class="mtext">${String(m.content || "").split("```")[0].trim()}</div>
              <div class="ins">${m.code}</div>
              <button class="mini" style=${{ marginTop: "7px" }}
                onClick=${() => onInsert(m.code)}>insert at caret</button>`
          : html`<div class="mtext">${m.content}</div>`}
      </div>`)}
      ${chatBusy ? html`<div class="note">thinking ...</div>` : null}
      <div class="composer">
        <textarea class="field chatfield" rows=${2} value=${chatReq}
          placeholder=${turns ? "ask a follow-up ..." : "ask about this project, or ask for code ..."}
          onInput=${(e) => onChatReq(e.target.value)}
          onKeyDown=${(e) => {
            // Enter sends; Shift+Enter is a newline. A chat box where Enter
            // inserts a line break is not a chat box.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onChatSend(); }
          }}></textarea>
        <button class="mini" disabled=${chatBusy || !chatReq.trim()}
          onClick=${onChatSend}>${chatBusy ? "..." : "send"}</button>
      </div>
    </div>`;
  };

  const counts = { prob: diagnostics.length, struct: outline.length };  // In the core build the AI tabs are not part of the studio at all, so they are
  // filtered out before anything else looks at the list. Doing it here rather
  // than at the render means the reorder logic, the count badges and the empty
  // state all agree that there are four tabs.
  const AVAILABLE = core ? PANEL_TAB_IDS.filter((k) => !AI_TABS.includes(k)) : PANEL_TAB_IDS;
  const TABLES = AVAILABLE.map((k) => [k, PANEL_TAB_LABELS[k], counts[k] || 0]);
  // The order and the hidden set live in settings, so the strip can be arranged
  // the way the person reading it wants. Anything in `TABLES` that the stored
  // order does not mention is appended, so a tab added to this file cannot be
  // lost by an order that was saved before it existed.
  const byId = new Map(TABLES.map((t) => [t[0], t]));
  const wanted = (order || []).filter((k) => byId.has(k));
  const rest = TABLES.map((t) => t[0]).filter((k) => !wanted.includes(k));
  const shown = wanted.concat(rest).filter((k) => !(hidden || []).includes(k));

  // Is the row wider than the panel?
  //
  // Measured after paint rather than predicted from the label widths, because
  // the font is the user's and the panel is draggable - any arithmetic here
  // would be a guess about text metrics. A ResizeObserver as well as the tab
  // list, because dragging the handle changes the answer without changing the
  // tabs. Only ever set to true on overflow: the arrows stay once they appear
  // until the row genuinely fits again, so they do not flicker in and out
  // during a drag.
  const stripRef = useRef(null);
  // Is the row wider than the panel?
  //
  // Measured after paint rather than predicted from the label widths, because
  // the font is the user's and the panel is draggable - any arithmetic here
  // would be a guess about text metrics, and the guess is the thing that was
  // wrong before. A ResizeObserver as well as the tab list, because dragging the
  // handle changes the answer without changing the tabs.
  //
  // Both start TRUE, and that initial value is not a guess: four abbreviated
  // tabs want ~268px and the panel's smallest useful width is 200px, so on any
  // real panel the row overflows until something measures it as fitting. Starting
  // at false made the arrows appear one frame late, which is invisible in a
  // browser and fatal under static rendering - where no effect runs at all, the
  // arrows never appeared, and the affordance that the whole fix exists to
  // provide was absent from the markup. `measureStrip` corrects it immediately
  // after the first paint when the row does fit.
  const [crowded, setCrowded] = useState(true);
  const [edge, setEdge] = useState({ left: false, right: true });
  const measureStrip = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    setCrowded(over > 1);
    setEdge({ left: el.scrollLeft > 1, right: el.scrollLeft < over - 1 });
  }, []);

  // Scroll a strip element, without assuming the API is there.
  //
  // `scrollTo` is not universal - linkedom does not implement it - and a `Panel`
  // that throws while rendering takes the whole interface down with it, because
  // the throw happens inside React's commit and the crash boundary is the only
  // thing left to catch it. Measured: calling it directly produced "el.scrollTo
  // is not a function" and a page that showed the crash screen instead of the
  // IDE. Setting `scrollLeft` is the older API and is implemented everywhere the
  // studio runs; the behaviour difference is only that it cannot be smooth.
  const scrollStrip = (el, left) => {
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      try { el.scrollTo({ left, behavior: "smooth" }); return; } catch (e) {}
    }
    el.scrollLeft = left;
  };

  // Keep the selected tab on screen. This is the whole reason an off-screen tab
  // is acceptable: with the strip scrolling past the edge, a tab you cannot see
  // is a tab you cannot reach - which is what the old wrap-into-rows version was
  // working around.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const on = el.querySelector("button.on");
    if (!on) return;
    // Clamped at both ends. The unclamped version scrolled to `on.offsetLeft - 6`
    // whenever the tab was outside the view, so selecting the LAST tab pushed
    // the first one off the left edge - measured at 1440x900 the strip reads
    // `Problems` at x 1066 with its own left edge at 1176, i.e. 110px of the row
    // sitting outside the panel's box, past the code column, invisible and
    // unreachable while a scrollbar height of 0px says there is nothing there.
    const max = el.scrollWidth - el.clientWidth;
    const want = Math.min(Math.max(0, on.offsetLeft - 6), Math.max(0, max));
    // Not `!== el.scrollLeft`: a smooth scroll in flight reports a fractional
    // offset, so an equality test on a moving value re-issues the scroll every
    // frame. A one-pixel tolerance settles instead.
    if (Math.abs(want - el.scrollLeft) > 1) scrollStrip(el, want);
    measureStrip();
  }, [tab, shown.join(","), measureStrip]);

  // The row can start fitting again without the tabs changing - when the handle
  // is dragged, or the window resized.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureStrip());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureStrip]);

  const nudge = (dir) => {
    const el = stripRef.current;
    if (!el) return;
    scrollStrip(el, Math.max(0, el.scrollLeft + dir * Math.max(96, el.clientWidth * 0.7)));
    // the scroll event fires before the smooth scroll finishes, so re-measure
    // once it settles as well
    setTimeout(measureStrip, 260);
  };

  const dragFrom = useRef(null);
  const [overTab, setOverTab] = useState(null);
  const reorder = (from, to) => {
    if (!from || from === to || !onReorder) return;
    const next = shown.filter((k) => k !== from);
    const at = next.indexOf(to);
    next.splice(at < 0 ? next.length : at, 0, from);
    // hidden tabs keep their place at the end rather than being forgotten
    onReorder(next.concat(TABLES.map((t) => t[0]).filter((k) => !next.includes(k))));
  };

  const body = () => {
    if (tab === "prob") return problems();
    if (tab === "struct") return structure();
    if (tab === "proj") return proj();
    if (tab === "ai") return aiBody();
    if (tab === "gen") return genBody();
    if (tab === "chat") return chatBody();
    return layoutBody();
  };

  return html`<div class="panel">
    <div class=${"phead" + (crowded ? " crowded" : "")}>
      <div class="ptabs" ref=${stripRef} onScroll=${measureStrip}>
        ${shown.map((k) => {
          const [, label, n] = byId.get(k);
          return html`<button key=${k}
            class=${(tab === k ? "on" : "") + (dragFrom.current === k ? " dragging" : "")
              + (overTab === k && dragFrom.current && dragFrom.current !== k ? " dropzone" : "")}
            draggable=${true}
            title=${label + " - drag to reorder, hide tabs in Settings, View."}
            onClick=${() => setTab(k)}
            onDragStart=${(e) => { dragFrom.current = k; e.dataTransfer.effectAllowed = "move"; }}
            onDragOver=${(e) => { e.preventDefault(); if (overTab !== k) setOverTab(k); }}
            onDragEnd=${() => { dragFrom.current = null; setOverTab(null); }}
            onDrop=${(e) => { e.preventDefault(); reorder(dragFrom.current, k); dragFrom.current = null; setOverTab(null); }}
            >${PANEL_TAB_SHORT[k] || label}${n ? html`<i class="badge">${n}</i>` : null}</button>`;
        })}
      </div>
      ${crowded ? html`<div class="pscroll">
        <button class="tabnav" title="Earlier tabs" disabled=${!edge.left}
          onClick=${() => nudge(-1)}><${Ico} k="chevL" size=${12} /></button>
        <button class="tabnav" title="Later tabs" disabled=${!edge.right}
          onClick=${() => nudge(1)}><${Ico} k="chevR" size=${12} /></button>
      </div>` : null}
    </div>
    <div class="pbody">${body()}</div>
  </div>`;
});

const Palette = memo(function Palette({ items, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const shown = useMemo(() => {
    const s = q.toLowerCase();
    return items.filter((i) => !s || i.name.toLowerCase().includes(s) || (i.hint || "").toLowerCase().includes(s))
      .slice(0, 200);
  }, [q, items]);
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const key = (e) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") { setSel((s) => Math.min(s + 1, shown.length - 1)); e.preventDefault(); }
    if (e.key === "ArrowUp") { setSel((s) => Math.max(s - 1, 0)); e.preventDefault(); }
    if (e.key === "Enter" && shown[sel]) { onPick(shown[sel]); onClose(); }
  };
  return html`<div class="overlay" onClick=${onClose}>
    <div class="palette" onClick=${(e) => e.stopPropagation()}>
      <input ref=${ref} value=${q} onInput=${(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown=${key} placeholder="type a file name or a command" />
      <div class="pl">
        ${shown.map((it, i) => html`<div key=${i} class=${"pitem" + (i === sel ? " sel" : "")}
            onMouseEnter=${() => setSel(i)}
            onClick=${() => { onPick(it); onClose(); }}>
          <span class="nm">${it.name}</span>
          ${it.hint ? html`<span class="hint">${it.hint}</span>` : null}</div>`)}
        ${shown.length === 0 ? html`<div class="pempty">no match</div>` : null}
      </div>
    </div>
  </div>`;
});

/** The one place the interface asks a yes/no question.
 *
 * This replaces the browser's own `confirm()`, which is what a delete used to
 * be confirmed with. That dialog is drawn by the platform rather than by this
 * program: under the desktop shell it is WebView2's, it does not follow the
 * interface's theme, it cannot be styled, and it was the only surface in the
 * window that looked like a different application. Same question, the
 * interface's own material.
 *
 * Escape and a click on the backdrop both mean no, as they do natively. Enter
 * confirms, which is the one thing that differs from the native dialog - there
 * Enter confirms too, but so does Space on whichever button took focus, and
 * which button that is depends on the platform. Here the confirming button is
 * focused explicitly and only Enter fires it.
 *
 * `danger` tints the confirming button. It never moves it: the safe answer
 * keeps the left-hand position and the default key. */
const Confirm = memo(function Confirm({ title, body, ok, danger, onYes, onNo }) {
  const ref = useRef(null);
  useEffect(() => { ref.current && ref.current.focus(); }, []);
  const key = (e) => {
    // Stop the editor's own window-level shortcuts from firing under the
    // dialog: Ctrl+S while a question is open would save the file the question
    // is about.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onNo(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onYes(); }
  };
  return html`<div class="overlay" onClick=${onNo}>
    <div class="dialog" role="alertdialog" aria-label=${title}
      style=${{ width: "min(400px,92vw)" }}
      onClick=${(e) => e.stopPropagation()} onKeyDown=${key}>
      <h3>${title}</h3>
      <p>${body}</p>
      <div class="row">
        <button class="mini" onClick=${onNo}>Cancel</button>
        <button ref=${ref} class=${"mini" + (danger ? " danger" : "")}
          onClick=${onYes}>${ok}</button>
      </div>
    </div>
  </div>`;
});

/** The text-entry sibling of `Confirm`, for the same reason: `window.prompt` is
 *  the platform's dialog and not this program's, and there were three of them
 *  left - renaming in the explorer, Save As, and naming a new project.
 *
 *  `select` is the range to preselect, or nothing for a caret at the end. A
 *  rename wants the stem selected so that typing replaces the name and leaves
 *  the extension; a new name wants appending to. The effect runs once on mount
 *  rather than on every render, so typing does not keep re-selecting. */
const Prompt = memo(function Prompt({ title, body, ok, value, select, onOk, onNo }) {
  const [text, setText] = useState(value || "");
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (Array.isArray(select)) el.setSelectionRange(select[0], select[1]);
    else el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onNo(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onOk(text); }
  };
  return html`<div class="overlay" onClick=${onNo}>
    <div class="dialog" role="dialog" aria-label=${title}
      style=${{ width: "min(440px,92vw)" }}
      onClick=${(e) => e.stopPropagation()} onKeyDown=${key}>
      <h3>${title}</h3>
      <p>${body}</p>
      <input ref=${ref} value=${text} spellcheck="false"
        onInput=${(e) => setText(e.target.value)} />
      <div class="row">
        <button class="mini" onClick=${onNo}>Cancel</button>
        <button class="mini" onClick=${() => onOk(text)}>${ok}</button>
      </div>
    </div>
  </div>`;
});

// ---------------------------------------------------------------- app

/** A friendly workspace label: the deepest folder every file shares.
 *
 * The server reports its root as ".", which is meaningless on screen. Deriving
 * the name from the files themselves costs no extra request and stays right when
 * the root moves.
 */
function wsNameOf(files, root) {
  if (root && root !== ".") return root.split(/[\\/]/).filter(Boolean).pop() || root;
  if (!files.length) return "no workspace";
  let common = files[0].split(/[\\/]/).slice(0, -1);
  for (const f of files) {
    const parts = f.split(/[\\/]/);
    let i = 0;
    while (i < common.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common[common.length - 1] || "workspace";
}

/** Settings that actually do something, kept in localStorage.
 *
 * Each one is wired to a live effect rather than stored and ignored: a settings
 * screen full of switches that change nothing is worse than no settings screen. */
const DEFAULTS = {
  autosave: true,
  autosaveDelay: 900,
  fontSize: 13.5,
  tabSize: 4,
  // on by default, but the whole interface works with it off - see the Panel.
  // In the core build there is no companion to turn on, so the default is off and
  // the switch that would turn it on is not drawn: `aiEnabled` still exists, so
  // the two builds store the same shape of settings and a settings object can be
  // carried between them without a migration.
  aiEnabled: !CORE,
  // Where the companion's own project lives - the directory holding
  // `python/forgen_ai/ide_daemon.py`. This was a string literal inside
  // `startAI`, which meant the IDE carried a hardcoded absolute path to a
  // project that is not the IDE, and a move would have broken the companion
  // silently: the server answers "ide_daemon.py not found in that directory" and
  // that arrived as a status line nobody reads. The server still validates it,
  // so a wrong value says so instead of failing quietly.
  aiDir: "D:/ryan",
  wrap: false,
  checkOnType: true,
  autoIndent: true,
  autoClose: true,
  panelTab: "prob",
  // The right panel's tabs, in the order they are drawn, and the ones that are
  // not drawn at all. Six tabs do not fit in a 250px panel, so the strip runs off
  // the edge - which is what he asked for, and it is only workable if the two
  // things that make an off-screen tab acceptable exist: the selected tab is
  // always scrolled into view, and a tab you never open can be removed.
  panelOrder: CORE ? ["prob", "struct", "proj", "lay"] : ["prob", "struct", "proj", "lay", "chat", "ai", "gen"],
  panelHidden: [],
  // ---- zen
  //
  // Zen is a mode, not a theme: everything that is not the code goes, and the
  // few things worth keeping are opt-in one at a time. It is stored like the
  // rest so it survives a reload, but the *mode* is off on boot - a setting that
  // hides the entire chrome is not something to restore silently, because the
  // first thing a person does when they cannot find the interface is assume it
  // is broken. The preferences below are what Zen restores; the mode itself
  // starts off.
  zenStatus: true,        // the one line at the bottom: position, language, dirty
  zenProblems: true,      // "3 problems" ticker, clickable back into the panel
  zenFile: true,          // the current file name, top left
  zenWrap: false,         // soft wrap, independent of the editor setting
  zenWidth: 0,            // 0 = full width; otherwise the column is centred at this px
  zenFontDelta: 1,        // extra px on top of the editor size - Zen is for reading
  zenSurround: true,      // a little breathing room at the top and bottom of the code
};

const Settings = ({ values, onChange, onClose, root, onRoot, aiOnline, onStartAI, aiStarting }) => {
  const [tab, setTab] = useState("editor");
  const row = (label, hint, control) => html`<div class="setrow">
    <div class="lab">${label}${hint ? html`<i>${hint}</i>` : null}</div>${control}</div>`;
  const sw = (key) => html`<div class=${"sw" + (values[key] ? " on" : "")}
    onClick=${() => onChange({ [key]: !values[key] })}><i></i></div>`;

  // ---- View: the panel's tab order and visibility
  //
  // A stored order that predates a tab must not lose that tab, so anything the
  // order does not mention is appended rather than dropped.
  const order = (values.panelOrder && values.panelOrder.length ? values.panelOrder : PANEL_TAB_IDS)
    .filter((k) => PANEL_TAB_IDS.includes(k))
    .concat(PANEL_TAB_IDS.filter((k) => !(values.panelOrder || []).includes(k)));
  const hiddenNow = (k) => (values.panelHidden || []).includes(k);
  const moveTab = (k, d) => {
    const next = order.slice();
    const i = next.indexOf(k);
    const j = i + d;
    if (i < 0 || j < 0 || j >= next.length) return;
    next[i] = next[j];
    next[j] = k;
    onChange({ panelOrder: next });
  };
  const toggleTab = (k) => {
    const h = values.panelHidden || [];
    const next = h.includes(k) ? h.filter((x) => x !== k) : h.concat([k]);
    // never hide the last one: a panel with no tabs in it is not a view
    if (!order.filter((x) => !next.includes(x)).length) return;
    onChange({ panelHidden: next });
  };
  return html`<div class="overlay" onClick=${onClose}>
    <div class="dialog" style=${{ width: "min(620px,94vw)" }} onClick=${(e) => e.stopPropagation()}>
      <h3>Settings</h3>
      <p>Saved on this machine and applied immediately.</p>
      <div class="tabs2">
        ${[["editor", "Editor"], ["view", "View"], ["zen", "Zen"], ["files", "Files"], ["ai", "Companion"], ["ws", "Workspace"]]
          .map(([k, l]) => html`<button key=${k} class=${tab === k ? "on" : ""}
            onClick=${() => setTab(k)}>${l}</button>`)}
      </div>
      ${tab === "editor" ? html`<div>
        ${row("Font size", "the editor's monospace size. Ctrl+wheel also changes this",
          html`<input type="number" min="10" max="28" step="0.5" value=${values.fontSize}
            onChange=${(e) => onChange({ fontSize: Number(e.target.value) })} />`)}
        ${row("Tab size", "spaces inserted by Tab", html`<input type="number" min="1" max="8" value=${values.tabSize}
            onChange=${(e) => onChange({ tabSize: Number(e.target.value) })} />`)}
        ${row("Soft wrap", "wrap long lines instead of scrolling sideways", sw("wrap"))}
        ${row("Auto-indent", "carry the indentation to the next line, plus one level after an opening brace",
          sw("autoIndent"))}
        ${row("Auto-close brackets", "typing { ( [ or a quote inserts the pair and puts the caret inside",
          sw("autoClose"))}
        ${row("Check while typing", "run forgen check a moment after you stop typing, and underline what it reports",
          sw("checkOnType"))}
      </div>` : null}
      ${tab === "files" ? html`<div>
        ${row("Autosave", "write the file shortly after you stop typing", sw("autosave"))}
        ${row("Autosave delay", "milliseconds of quiet before writing",
          html`<input type="number" min="200" max="5000" step="100" value=${values.autosaveDelay}
            onChange=${(e) => onChange({ autosaveDelay: Number(e.target.value) })} />`)}
      </div>` : null}
      ${tab === "view" ? html`<div>
        ${row("Open on", "which panel tab the window starts on",
          html`<select value=${values.panelTab}
            onChange=${(e) => onChange({ panelTab: e.target.value })}>
            ${order.map((k) => html`<option key=${k} value=${k}>${PANEL_TAB_LABELS[k]}</option>`)}
          </select>`)}
        <div class="setnote" style=${{ marginTop: "16px" }}>The right panel's tabs,
        in the order they are drawn. Drag them in the panel itself to rearrange
        them, or use the arrows here. A tab that is off is not drawn at all - which
        is what makes a strip that runs off the edge of a 250px panel workable
        rather than annoying.</div>
        <div class="tablist">
          ${order.map((k, i) => html`<div class="tabrow" key=${k}>
            <span class="nm">${PANEL_TAB_LABELS[k] || k}</span>
            <button class="mini" disabled=${i === 0}
              onClick=${() => moveTab(k, -1)} title="Move left">up</button>
            <button class="mini" disabled=${i === order.length - 1}
              onClick=${() => moveTab(k, 1)} title="Move right">down</button>
            <div class=${"sw" + (hiddenNow(k) ? "" : " on")}
              onClick=${() => toggleTab(k)}
              title=${hiddenNow(k) ? "hidden - click to show" : "shown - click to hide"}><i></i></div>
          </div>`)}
        </div>
        <div class="setnote">Problems and Structure come from the compiler and from
        this file, so they work with the companion switched off. Only the AI and
        Generate tabs need it.</div>
      </div>` : null}
      ${tab === "zen" ? html`<div>
        <div class="setnote" style=${{ marginTop: 0 }}>Zen mode hides the title bar,
        the toolbar, the explorer, the right panel and the status bar, and leaves
        the code. Press <b>Ctrl+Shift+Z</b> - or the button beside the panel
        toggle - to enter, <b>Esc</b> to leave. What follows is what stays.</div>
        ${row("File name", "the open file, top left of the one line Zen keeps", sw("zenFile"))}
        ${row("Position", "line and column, the language, and a running marker", sw("zenStatus"))}
        ${row("Problems", "an error and warning count that opens the panel when clicked. Zen says nothing when a file is clean unless you turn this off, because a count of zero is still a sentence.", sw("zenProblems"))}
        ${row("Soft wrap", "wrap long lines while Zen is on, whatever the editor setting is", sw("zenWrap"))}
        ${row("Breathing room", "leave a margin above and below the code", sw("zenSurround"))}
        ${row("Extra size", "added to the editor's font size, for reading",
          html`<input type="number" min="0" max="6" step="0.5" value=${values.zenFontDelta}
            onChange=${(e) => onChange({ zenFontDelta: Number(e.target.value) })} />`)}
        ${row("Column width", "0 fills the window; anything else centres the code at that width",
          html`<input type="number" min="0" max="2400" step="20" value=${values.zenWidth}
            onChange=${(e) => onChange({ zenWidth: Number(e.target.value) })} />`)}
        <div class="setnote">A centred column is set by insetting the text
        surface, not by narrowing the editor: a max-width on the text alone would
        leave the line numbers outside it and put the caret in the wrong place.</div>
      </div>` : null}
      ${tab === "ai" && !CORE ? html`<div>
        ${row("Companion", "suggestions, ghost text and a second opinion on diagnostics", sw("aiEnabled"))}
        ${row("Status", aiOnline ? "running on 127.0.0.1:7890" : "not running",
          html`<button class="mini" onClick=${onStartAI}>${aiStarting ? "starting ..." : "start it"}</button>`)}
        ${row("Its project", "the folder holding python/forgen_ai/ide_daemon.py. It is a separate project, so it cannot be found relative to this one - which is why it is a setting rather than a guess.",
          html`<input class="dirin" value=${values.aiDir || ""} spellcheck="false"
            onChange=${(e) => onChange({ aiDir: e.target.value })} />`)}
        <div class="setnote">The companion is optional by design. The editor, the
        compiler, the problems panel, the file tree and the layout inspector all
        work without it - nothing here is a stub that needs it to function.</div>
      </div>` : null}
      ${tab === "ws" ? html`<div>
        ${row("Workspace root", root, html`<button class="mini" onClick=${onRoot}>change</button>`)}
      </div>` : null}
      <div class="row"><button class="mini" onClick=${onClose}>Done</button></div>
    </div>
  </div>`;
};

function applySettings(v) {
  try { localStorage.setItem("datara.studio.settings", JSON.stringify(v)); } catch (e) {}
  if (Editor.el) Editor.setType(v.fontSize, v.wrap);
}

/** Recompute the editor's type and wrap, honouring Zen.
 *
 * Zen overrides two editor settings on purpose, and only while it is on: soft
 * wrap (a centred narrow column is pointless if long lines still run off it) and
 * a slightly larger face (Zen is used for reading as much as writing). Both are
 * stored, so they survive leaving and re-entering, and neither touches the
 * values the normal editor uses - turning Zen off restores the editor exactly as
 * it was, which is what makes the mode safe to press by accident.
 */
function applyEditorType(values, zen) {
  const size = values.fontSize + (zen ? (values.zenFontDelta || 0) : 0);
  const wrap = zen ? values.zenWrap : values.wrap;
  if (Editor.el) Editor.setType(size, wrap);
}

/** The built-in explorer. It lists directories through the Datara server, which
 * is the point: browsing the filesystem is the one platform-specific job the IDE
 * has, and it is written in the kernel's own language so one implementation
 * serves Windows, Linux and macOS.
 *
 * Three things here exist because the first version could not reach a folder:
 *
 *   * an **editable path box**. Clicking up and down a tree cannot reach a
 *     folder on another drive at all, and pasting a path is how anyone actually
 *     opens a project they already know the location of.
 *   * a **drive row**, so `C:` is one click away from `D:`.
 *   * **failure that says so**. The server used to answer a missing folder with
 *     a fabricated entry named after the shell's own error message, and the
 *     dialog showed it as a folder you could click into.
 */
const Browser = ({ start, mode, onClose, onOpen, onPickFile, purpose }) => {
  // The same dialog answers two questions: "which folder do you want to work
  // in" and "where should a new project live". Only the words differ, and the
  // words matter - clicking "Create new project" and being asked to open a
  // folder is the kind of small wrongness that makes an interface feel careless.
  const forProject = purpose === "project";
  const [dir, setDir] = useState(null);
  const [draft, setDraft] = useState(start || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState("");
  const [tried, setTried] = useState("");
  const [newName, setNewName] = useState(null);
  const [showFiles, setShowFiles] = useState(mode === "file");
  // In file mode the dialog lists files as well as folders, so a file anywhere
  // on the machine can be opened - not only the ones inside the workspace. The
  // server returns both lists from one call.
  const filesWanted = showFiles || mode === "file";

  const go = useCallback(async (p) => {
    const want = p || "";
    setBusy(true); setErr(""); setDetail(""); setTried(want);
    try {
      let r = await post("/api/list", want);
      // "Nowhere in particular" is not a place. The server answers an empty
      // request by describing its own working directory - which is where the IDE
      // happens to be installed, so the dialog used to open on the studio's own
      // source tree and offer `src`, `crates` and `ui` as somewhere to put a new
      // project. Start at a drive instead. `roots` comes back even when a listing
      // fails, so this also works on a cold launch with nothing remembered.
      if (r && !want && r.roots && r.roots.length) r = await post("/api/list", r.roots[0]);
      if (r) {
        // `parent` and `roots` come back even on failure, so a wrong path still
        // leaves somewhere to go instead of dead-ending the dialog
        setDir(r);
        setDraft(r.path || "");
        if (!r.ok) { setErr(r.error || "could not open that folder"); setDetail(r.detail || ""); }
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }, []);

  useEffect(() => { go(start); }, [go, start]);

  const makeFolder = async () => {
    const name = (newName || "").trim();
    if (!name || !dir) return;
    const sep = dir.path.endsWith("/") ? "" : "/";
    const r = await post("/api/mkdir", dir.path + sep + name);
    if (r && r.ok) { setNewName(null); go(dir.path); }
    else { setErr((r && (r.detail || r.error)) || "could not create the folder"); }
  };

  const join = dir ? (dir.path.endsWith("/") ? dir.path : dir.path + "/") : "";

  return html`<div class="overlay" onClick=${onClose}>
    <div class="browser" onClick=${(e) => e.stopPropagation()}>
      <div class="bh">
        <h3>${forProject ? "Where should the project go?"
          : filesWanted ? "Open a file or a folder" : "Open folder"}</h3>
        <p>${busy ? "reading ..." : dir
          ? dir.count + (dir.count === 1 ? " folder" : " folders")
            + (filesWanted && dir.files ? "  ·  " + dir.files.length + " files" : "")
            + " inside"
          : "reading ..."}</p>
      </div>
      <div class="path">
        <button class="up" title="Up one level" onClick=${() => dir && go(dir.parent)}>
          <${Ico} k="chevron" size=${12} /></button>
        <input class="pinput" value=${draft} spellcheck="false" placeholder="type or paste a path"
          onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") go(draft);
            if (e.key === "Escape") onClose();
          }} />
        <button class="mini" onClick=${() => go(draft)}>go</button>
        <button class=${"mini" + (filesWanted ? " on" : "")} title="Also list files, so any file on the machine can be opened"
          onClick=${() => setShowFiles((v) => !v)}>files</button>
      </div>
      ${dir && dir.roots && dir.roots.length > 1 ? html`<div class="roots">
        ${dir.roots.map((r) => html`<button key=${r} class=${"root" + (r === dir.path ? " on" : "")}
          onClick=${() => go(r)}>${r}</button>`)}
      </div>` : null}
      ${err ? html`<div class="note bad" style=${{ padding: "4px 16px 10px" }}>
        ${err}${detail ? html`<i class="det">${detail}</i>` : null}</div>` : null}
      <div class="dlist">
        ${newName !== null ? html`<div class="newfolder">
          <${Ico} k="folder" size=${14} />
          <input autoFocus value=${newName} spellcheck="false" placeholder="new folder name"
            onInput=${(e) => setNewName(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === "Enter") makeFolder();
              if (e.key === "Escape") setNewName(null);
            }} />
        </div>` : null}
        ${dir && !dir.dirs.length && !(filesWanted && dir.files && dir.files.length) && !busy && !err
          ? html`<div class="note" style=${{ padding: "12px" }}>Nothing inside.</div>` : null}
        ${dir ? dir.dirs.map((d) => html`<div class="d" key=${d.path}
            onClick=${() => go(d.path)} onDoubleClick=${() => onOpen(d.path)}>
          <${Ico} k="folder" size=${14} /><span>${d.name}</span></div>`) : null}
        ${dir && filesWanted && dir.files
          ? dir.files.map((f) => {
              const [glyph, colour] = fileIcon(f.name);
              return html`<div class="d file" key=${f.path} onClick=${() => onPickFile(f.path)}>
                <span style=${{ color: colour, display: "flex" }}><${Ico} k=${glyph} size=${14} /></span>
                <span>${f.name}</span></div>`;
            })
          : null}
      </div>
      <div class="bf">
        <button class="mini" onClick=${() => setNewName("")}>new folder</button>
        <span class="grow">${dir && dir.windows ? "Windows" : "Unix"} paths</span>
        <button class="mini" onClick=${onClose}>Cancel</button>
        <button class="mini" onClick=${() => dir && onOpen(dir.path)}>${forProject ? "Create it here" : "Open this folder"}</button>
      </div>
    </div>
  </div>`;
};

function App() {
  const [files, setFiles] = useState([]);
  const [dirs, setDirs] = useState([]);
  const [treeError, setTreeError] = useState("");
  const [treeNote, setTreeNote] = useState("");
  // No workspace yet. This used to default to ".", which is the server's own
  // working directory: truthy, so the title screen could never show, and a
  // workspace that the reader never chose. Empty means "nothing chosen", and
  // the title screen is what occupies that space.
  const [root, setRoot] = useState("");
  const [current, setCurrent] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem("datara.studio.settings") || "{}");
      return s.panelTab || "prob";
    } catch (e) { return "prob"; }
  });
  const [mode, setMode] = useState("programming");
  // Zen is deliberately NOT persisted, unlike the `zen*` preferences above.
  // Restoring it would mean opening the IDE to a window with no interface and no
  // obvious way back - the preferences are what come back, the mode is a thing
  // you turn on. It is a separate state from `mode` ("programming"/"reading")
  // because they answer different questions: reading mode says *what* the
  // editor is for, zen says *how much of the window is the editor*.
  const [zen, setZen] = useState(false);
  const [zenHint, setZenHint] = useState(false);
  const [aiOnline, setAiOnline] = useState(false);
  const [aiLabel, setAiLabel] = useState("ai off");
  const [suggestions, setSuggestions] = useState([]);
  const [aiDiag, setAiDiag] = useState([]);
  const [layout, setLayout] = useState(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [outline, setOutline] = useState([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  // The last run/build that the compiler refused, shown as a banner over the
  // code. A failure that only appears inside a drawer nobody opened is a
  // failure the user finds out about by wondering why nothing happened.
  const [runError, setRunError] = useState(null);
  // Recently opened workspaces, for the title screen. Kept in localStorage
  // beside the last root, which is what makes the first launch after a restart
  // land where the last session left off.
  const [recents, setRecents] = useState(() => {
    try { return JSON.parse(localStorage.getItem("datara.studio.recent") || "[]"); } catch (e) { return []; }
  });
  const [stats, setStats] = useState({ lines: 0, chars: 0, lexMs: 0, tokens: 0 });
  const [drawer, setDrawer] = useState({ open: false, title: "", text: "", cls: "" });
  const [palette, setPalette] = useState(false);
  const [status, setStatus] = useState("starting ...");
  const [coreVersion, setCoreVersion] = useState(null);
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState(() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("datara.studio.settings") || "{}") }; }
    catch (e) { return { ...DEFAULTS }; }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The one question dialog. `removeEntry` and `openFile` are ordinary async
  // functions, so neither can suspend a render waiting for an answer - the
  // answer comes back through a promise whose resolver is parked in the ref.
  const [ask, setAsk] = useState(null);
  const askRef = useRef(null);
  // "file" | "folder" | null - which kind of row the explorer is showing
  const [creating, setCreating] = useState(null);
  // where that row goes: "" is the workspace root, otherwise a relative folder
  const [createKey, setCreateKey] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserMode, setBrowserMode] = useState("folder");
  // True while the folder dialog is open to choose where a new project should
  // live, rather than to open a workspace. The two want opposite things done
  // with the answer - open it, or create inside it - so the intent is kept.
  const [pendingProject, setPendingProject] = useState(false);
  const [aiStarting, setAiStarting] = useState(false);
  const [compDiag, setCompDiag] = useState([]);
  const [projDiag, setProjDiag] = useState(null);
  const [projWhere, setProjWhere] = useState("");
  const [projBusy, setProjBusy] = useState(false);
  const [refs, setRefs] = useState([]);
  const [refWord, setRefWord] = useState("");
  const [refBusy, setRefBusy] = useState(false);
  // The project search box. `searchQ` is the editable text in the box, which is
  // not the same thing as `refWord` (what the last run actually searched for):
  // the box keeps whatever was typed while the list below still describes the
  // previous query, and a result list labelled with text that was never run is
  // how you end up reading the wrong hits.
  const [searchQ, setSearchQ] = useState("");
  // Bumped to ask the box to take focus and select itself. A counter rather than
  // a boolean because the gesture can repeat - Ctrl+Shift+F twice in a row has
  // to focus twice - and because an effect keyed on a boolean would not re-fire.
  const [searchFocus, setSearchFocus] = useState(0);
  // Whole-name matching. On for "find this variable everywhere" (the Alt+F7
  // case, where a substring answer is noise); off for "find this text".
  const [refWhole, setRefWhole] = useState(true);
  // Bumped to ask the panel to bring the search results into view. A counter,
  // like `searchFocus`, because the gesture repeats and an effect keyed on a
  // boolean would not re-fire.
  //
  // Bumped in two places on purpose. `openProjectSearch` and `findRefs` bump on
  // the way in, so the card is on screen while it still says "searching ...".
  // `runProjectSearch` bumps again once the hits land, because the first scroll
  // is clamped - until the results render there is nothing below the card to
  // scroll against - and without the second one the panel ends up showing the
  // count and none of the lines it counts.
  const [refScroll, setRefScroll] = useState(0);
  // layout of the three columns: widths in px, and whether each side is folded
  const [treeW, setTreeW] = useState(() => Number(localStorage.getItem("datara.studio.treeW")) || 232);
  const [panelW, setPanelW] = useState(() => Number(localStorage.getItem("datara.studio.panelW")) || 264);
  const [treeFold, setTreeFold] = useState(false);
  const [panelFold, setPanelFold] = useState(false);
  const dragRef = useRef(null);
  const checkTimer = useRef(null);
  // Set once when the server turns out to predate /api/git. A poll that is
  // guaranteed to 404 is console noise, and the answer cannot change without a
  // server restart.
  const gitMissing = useRef(false);
  const [genReq, setGenReq] = useState("");
  const [genRes, setGenRes] = useState(null);
  const [genErr, setGenErr] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  // Which file the generated code was written into. Empty means it has not been
  // placed yet, which is a different thing from "generation failed".
  const [genWhere, setGenWhere] = useState("");
  const [genModel, setGenModel] = useState(null);
  // What the companion was given to read, and whether it says it read it.
  // Reported rather than assumed: "it should understand what was written before"
  // is a claim about the request, and a claim about a request that is never
  // shown is a claim nobody can check.
  const [genCtx, setGenCtx] = useState(null);
  // ---- chat
  //
  // The transcript lives here and is mirrored into localStorage, because the
  // companion's session is keyed by id and the IDE is the thing that owns the
  // conversation. A reload therefore resumes rather than starting over - and a
  // clear button that only emptied the React state while the daemon kept its own
  // copy would be the same lie as the autosave bug earlier in this file.
  const [chatMsgs, setChatMsgs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("datara.studio.chat") || "[]"); }
    catch (e) { return []; }
  });
  const [chatReq, setChatReq] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErr, setChatErr] = useState("");
  const [chatCtx, setChatCtx] = useState(null);
  const [chatClearing, setChatClearing] = useState(false);
  // A stable id per workspace, so two folders do not share one conversation.
  const chatSessionRef = useRef(null);
  const chatMsgsRef = useRef(chatMsgs);
  chatMsgsRef.current = chatMsgs;
  const [git, setGit] = useState({ branch: null, dirty: 0, files: [], log: [] });
  const [renaming, setRenaming] = useState(null); // { kind, path }

  const edRef = useRef(null);
  // Whether the code surface is in the document. The surface only renders once
  // there is something to show - a file, or a tree - and on a cold boot neither
  // exists on the first render. This has to be state rather than a plain ref,
  // because the mount effect below has to re-run when the surface appears.
  const [surface, setSurface] = useState(0);
  const surfaceRef = useCallback((n) => {
    edRef.current = n;
    // Called with null and then the node whenever the div comes or goes. Bail
    // out when the answer has not changed, or this re-renders forever.
    setSurface((s) => (s === (n ? 1 : 0) ? s : n ? 1 : 0));
  }, []);
  const outlineRef = useRef([]);
  // the language of the open file, read by the editor callbacks, which are
  // installed once and must not close over a stale provider
  const langRef = useRef(DATARA_LANG);
  // same reason: the key handler is installed once, so it cannot read `settings`
  // from the closure or a settings change would not take effect until reload
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // And the same for the companion's state, which is the one that actually bit.
  // `Editor.onInput` is installed once, by the mount effect below, and it closes
  // over `scheduleAI` -> `runAI` from the render in which the code surface first
  // appeared. On an ordinary boot that render happens before the first /health
  // answer, so `aiOnline` was frozen at `false` inside that closure for the life
  // of the page: the indicator still read "companion: on", because the indicator
  // renders from state rather than from the closure, but not one /complete
  // request was ever sent. Measured both ways on identical keystrokes - opening
  // the workspace after the health poll fires produces a suggestion, opening it
  // during boot produced nothing - so the gate was here and it was not the
  // model. Reading the flag through a ref makes the closure's age irrelevant.
  const aiOnlineRef = useRef(false);
  aiOnlineRef.current = aiOnline;
  // `runCheck` and the autosave effect both need to know whether the buffer has
  // unwritten changes, and `runCheck` is reached through that same
  // installed-once handler, so the state variable would be stale there.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // `startAI` is called from the boot effect, so it cannot read `aiStarting` -
  // see the note on `aiOnlineRef` above.
  const aiStartingRef = useRef(false);
  const suggestionsRef = useRef([]);
  const saveTimer = useRef(null);
  // A counter, bumped on every keystroke, that exists only to give the autosave
  // effect something to depend on.
  //
  // `dirty` is a boolean, so it goes false->true on the first keystroke of an
  // edit and then stays true for every keystroke after it. An effect that
  // depends on it therefore runs *once* per edit and never again, which made the
  // delay a countdown from the first character typed rather than from the last:
  // type for longer than 900 ms without pausing and the timer fired mid-word,
  // and the write that "shortly after you stop typing" promises was never
  // scheduled at all. Depending on the counter makes each keystroke re-arm the
  // timer, which is what a debounce is, and it is also why autosave now actually
  // keeps up - the stale write was what left `dirty` set and produced the
  // "Discard unsaved changes?" prompt when opening the next file.
  const [editRev, setEditRev] = useState(0);
  const ghostRef = useRef("");
  const aiTimer = useRef(null);
  const currentRef = useRef(null);
  currentRef.current = current;
  const rootRef = useRef(".");
  rootRef.current = root;
  // Zen is read from the editor key handler, which is installed once and
  // therefore cannot close over a render value - the same reason every other
  // long-lived handler in this file reads a ref. `zen` is also mirrored onto
  // <html> as `data-zen`, which is what the CSS keys off; the attribute is the
  // interface between the mode and the stylesheet, so it is set in one effect
  // and never toggled from CSS alone.
  const zenRef = useRef(false);
  zenRef.current = zen;

  /** Compiler problems and companion problems, in one list.
   *
   * Declared here, above every effect and every child that reads it, because a
   * `const` is in the temporal dead zone until its own line runs - and a
   * dependency array is evaluated during render, not after it. Put below the
   * effect that consumes it, this throws "Cannot access 'diagnostics' before
   * initialization" and the whole interface renders as nothing.
   *
   * Compiler first: it is authoritative, and when the two disagree about the
   * same line the compiler is the one to believe.
   */
  const diagnostics = useMemo(() => {
    const comp = compDiag.map((d) => ({ ...d, source: "compiler" }));
    const ai = aiDiag.map((d) => ({ ...d, source: "companion", code: d.rule || d.severity }));
    // a companion diagnostic on a line the compiler already flagged is noise
    const seen = new Set(comp.map((d) => d.line));
    return comp.concat(ai.filter((d) => !seen.has(d.line)));
  }, [compDiag, aiDiag]);

  /** How many problems, by severity, for the places that only need the number.
   *
   * The Problems tab wants the list; the Zen bar and the status line want a
   * count, and counting in the render would mean walking the array on every
   * keystroke. `source === "compiler"` is deliberately not filtered out here -
   * a companion suggestion is still something the reader may want to know about
   * while writing, and the Problems list already dedupes them against the
   * compiler's own findings.
   */
  const diagCounts = useMemo(() => {
    let error = 0, warn = 0;
    for (const d of diagnostics) {
      if (d.severity === "warning") warn++;
      else error++;
    }
    return { error, warn };
  }, [diagnostics]);

  // A tab hidden while it was the open one would leave the panel blank with no
  // tab lit, which reads as a broken panel rather than as a hidden tab.
  //
  // The stored `panelOrder` is a *preference*, not the whole list: anyone who
  // used the studio before a tab existed has an order that does not mention it,
  // and treating that order as authoritative sent them back to the first tab the
  // moment they opened the new one. The panel's own render already reconciles
  // ("anything in TABLES the stored order does not mention is appended"), so this
  // guard has to reconcile the same way or the two disagree about what exists.
  useEffect(() => {
    const stored = (settings.panelOrder && settings.panelOrder.length
      ? settings.panelOrder : []).filter((k) => PANEL_TAB_IDS.includes(k));
    const rest = PANEL_TAB_IDS.filter((k) => !stored.includes(k));
    const all = stored.concat(rest);
    const vis = all.filter((k) => !(settings.panelHidden || []).includes(k));
    if (vis.length && !vis.includes(tab)) setTab(vis[0]);
  }, [settings.panelOrder, settings.panelHidden, tab]);

  // ---- zen
  //
  // The mode lives on <html> as `data-zen`, not on a class in React, because the
  // rules it drives are about the shell's own grid - and a grid track cannot be
  // removed by a rule inside the grid's subtree. Setting it in an effect (rather
  // than during render) keeps a re-render from touching the DOM at all when Zen
  // has not changed.
  useEffect(() => {
    const el = document.documentElement;
    if (zen) el.setAttribute("data-zen", "1"); else el.removeAttribute("data-zen");
    // the wrap and size Zen overrides are applied and un-applied with the mode
    applyEditorType(settingsRef.current, zen);
    // Zen hides the surface's neighbours, so the editor has to re-measure: the
    // line-number gutter and the ghost layer are positioned from the surface's
    // own box, and that box just changed size.
    if (Editor.el) requestAnimationFrame(() => Editor.repaint());
  }, [zen]);

  // A short hint on entry, then it fades. Zen removes the button that turned it
  // on, so for a moment there is nothing on screen that says how to leave - and
  // "how do I get out of this" is the only thing a person thinks in that moment.
  useEffect(() => {
    if (!zen) { setZenHint(false); return undefined; }
    setZenHint(true);
    const t = setTimeout(() => setZenHint(false), 2200);
    return () => clearTimeout(t);
  }, [zen]);

  const toggleZen = useCallback(() => {
    setZen((v) => {
      const next = !v;
      // Leaving Zen from the keyboard leaves the caret in the editor; entering it
      // should too, so typing works immediately without a click.
      if (next) requestAnimationFrame(() => { if (Editor.ta) Editor.ta.focus(); });
      return next;
    });
  }, []);
  const leaveZen = useCallback(() => setZen(false), []);

  // ---- boot
  useEffect(() => {
    notify = (m) => setStatus(m);
    (async () => {
      try {
        setCoreVersion(await loadTextCore());
      } catch (e) {
        // The editor stays usable: repaint() falls back to plain text when the
        // core is missing, so this degrades instead of blanking the page.
        setStatus("wasm core failed to load, editing without highlighting: " + e.message);
        return;
      }
      // repaint now that the lexer exists, in case a file was opened meanwhile
      if (Editor.ta) { Editor.repaint(); applySettings(settings); }
      const last = localStorage.getItem("datara.studio.lastRoot");
      if (last) { setRoot(last); await refreshTree(last); }
      // No remembered workspace means this is a first launch. Do not adopt the
      // server's own working directory: that filled the explorer immediately,
      // which in turn meant the "create a project / open a folder" screen could
      // never appear - it is gated on having no workspace, and a workspace was
      // always manufactured here. Leave the tree empty and let the title screen
      // do its job.
      // Reopen what was open. Landing on an empty editor every morning is the
      // kind of small friction that adds up to "this IDE is annoying".
      const lastFile = localStorage.getItem("datara.studio.lastFile");
      if (lastFile) {
        const r = await post("/api/read", lastFile);
        if (r && r.ok) await openFile(lastFile, true);
        else localStorage.removeItem("datara.studio.lastFile");
      }
      checkAI();
      setInterval(checkAI, 5000);
      // The companion is meant to start itself and stay out of the way. Asking
      // the server to launch it is the difference between "optional" and "you
      // have to open a terminal", and it is silent when it is already running.
      if (settings.aiEnabled) setTimeout(() => startAI(true), 1200);
      // The core build has no companion, so it does not ask one for its model -
      // a request to a port nothing is listening on is a console error for no
      // reason, and the Generate panel that would have used the answer is not
      // part of this build.
      if (!CORE) fetch("http://127.0.0.1:7890/model", { method: "POST" })
        .then((r) => r.json()).then((m) => { if (m && m.success) setGenModel(m); })
        .catch(() => {});
      // The chat's context readout is the only visible evidence that the
      // companion is carrying anything, so it is fetched rather than assumed.
      // Silent on failure: the companion is optional and a refused connection is
      // the normal state when it has not been started.
      if (!CORE) refreshChatCtx();
      setStatus("ready");
    })();
  }, []);

  // ---- Zen's own keys
  //
  // These are installed here, at window level, rather than inside the editor
  // mount below - and that is the whole point of the block. The editor effect
  // starts with `if (!edRef.current) return;`, so anything registered inside it
  // exists only while a file is open. Zen registered there did nothing at all on
  // a cold start with no file: the key arrived, the handler was not there to
  // hear it, and the mode looked broken rather than unavailable. A shortcut that
  // switches the *window's* layout must not depend on the window's contents.
  //
  // Escape is deliberately handled here too, not left to the editor, because in
  // Zen the editor is frequently not focused - the chrome that held the focus
  // has been removed - and a mode you cannot leave from the keyboard is a trap.
  // The editor's own Escape (closing the completion list) still runs first when
  // the editor has focus, because its handler sees the event before this one and
  // this one then finds `defaultPrevented` set.
  useEffect(() => {
    const win = (e) => {
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!e.shiftKey) return;
      if (e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      toggleZen();
    };
    const esc = (e) => {
      if (e.defaultPrevented || e.key !== "Escape") return;
      if (!zenRef.current) return;
      if (Editor.comp) return;            // the completion list closes first
      e.preventDefault();
      leaveZen();
    };
    window.addEventListener("keydown", win);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", win);
      window.removeEventListener("keydown", esc);
    };
  }, [toggleZen, leaveZen]);

  // ---- find in the project, at window level
  //
  // Same reasoning as Zen's keys above, and the same trap. The editor's own
  // handler only hears a key while the code surface has focus, and the gesture
  // this shortcut serves is usually made *after* touching the chrome: fold the
  // panel, click a tab, then reach for Ctrl+Shift+F. Registered on the editor
  // alone, it did nothing in exactly those moments - which is when the results
  // are wanted, because the panel is where they appear.
  //
  // `defaultPrevented` keeps this from double-firing when the editor does have
  // focus: the editor's handler runs first, calls preventDefault, and this one
  // then stands down. One gesture, one search.
  //
  // The function is reached through a ref rather than closed over, because the
  // listener is created once. Closing over it directly would pin the first
  // render's version for the life of the window - harmless today, since every
  // capture inside it is a stable setter, and a silent bug the first time
  // somebody reads a piece of state in there.
  const openSearchRef = useRef(null);
  useEffect(() => {
    const find = (e) => {
      if (e.defaultPrevented) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      if (openSearchRef.current) openSearchRef.current();
    };
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, []);

  // ---- editor mount
  //
  // Re-runs whenever the surface comes or goes. It used to run once with `[]`
  // dependencies, which was wrong in a way that made the whole product look
  // broken: on a cold boot the first render has no file and no tree, so the
  // title screen occupied this space, `edRef.current` was null, the effect
  // returned - and never ran again. The editor was therefore never mounted, and
  // the code was never drawn, while the breadcrumb and the status bar both
  // cheerfully reported the file as open.
  useEffect(() => {
    if (!edRef.current) return;
    Editor.mount(edRef.current, {
      onCursor: (line, col) => setCursor({ line, col }),
      onInput: () => { setDirty(true); scheduleAI(); scheduleCheck(); },
      onLex: (lexMs, tokens, chars) => {
        // completion and hover both ask the language, not this module.
        // `ctx` carries the receiver and the caret, because member access is a
        // different question from "what names exist" and needs different data.
        Editor.completer = (w, ctx) => langRef.current.complete(w, outlineRef.current, suggestionsRef.current, {
          ...ctx,
          // Where the code is being written, so a new `fn` can be named for the
          // project instead of `name`. Read from refs, because this handler is
          // installed once and cannot close over a render value.
          file: currentRef.current,
          root: rootRef.current,
        });
        const lines = Editor.lines.length;
        setStats({ lines, chars, lexMs, tokens });
      },
      // Ctrl+wheel writes straight through to the setting, so the zoom survives
      // a reload like every other preference instead of resetting each session.
      onZoom: (size) => setSettings((s) => {
        const n = { ...s, fontSize: size };
        try { localStorage.setItem("datara.studio.settings", JSON.stringify(n)); } catch (e) {}
        return n;
      }),
      // `srcLines`: `hoverInfo` scans these for declarations, and the rendered
      // lines are HTML - a declaration search over markup finds spans, not
      // functions. See the note on the field.
      onHoverAsk: (word) => hoverInfo(word, outlineRef.current, Editor.srcLines, langRef.current.docs),
      onGotoDef: (word) => gotoDefinition(word),
    });
    // A fresh surface starts at the built-in type scale. If the reader has
    // zoomed, that preference has to be pushed again or the code comes back at
    // the wrong size every time the surface is re-created.
    applySettings(settingsRef.current);
    Editor.onKey = (e) => {
      const s = settingsRef.current;
      const unit = langRef.current.indent;

      // A pending snippet stop is checked before everything else on Tab.
      //
      // It has to be, because after the snippet is accepted the completion list
      // is still eligible: typing the function name re-opens it, and Tab would
      // then be read as "accept this completion" and re-insert the template
      // around the name just typed - which is how `fn probe    () -> Int` came
      // out of a normal `fn` + name + Tab. A pending stop means the person is
      // inside a template they just expanded, so nothing else can claim Tab.
      if (e.key === "Tab" && !e.shiftKey && Editor.pendingStop) {
        e.preventDefault();
        if (Editor.takeStop()) return;
      }

      if (Editor.comp) {
        if (e.key === "ArrowDown") { e.preventDefault(); Editor.moveComplete(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); Editor.moveComplete(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); Editor.acceptComplete(); return; }
        if (e.key === "Escape") { e.preventDefault(); Editor.setComplete(null); return; }
      }
      if (e.key === "Tab" && ghostRef.current) { e.preventDefault(); Editor.acceptGhost(); return; }

      // indentation
      if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); Editor.indentSelection(-1, unit); return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = Editor.ta;
        // a selection means "indent these lines", not "insert spaces here"
        if (ta.selectionStart !== ta.selectionEnd) Editor.indentSelection(1, unit);
        else Editor.insert(unit);
        return;
      }

      // typing aids, each one switchable
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        Editor.toggleComment(langRef.current.comment);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (s.autoIndent) { e.preventDefault(); Editor.newlineWithIndent(unit); return; }
      }
      if (s.autoClose && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const pairs = { "{": "}", "(": ")", "[": "]", '"': '"' };
        const close = pairs[e.key];
        if (close) { if (Editor.autoClose(e.key, close)) e.preventDefault(); return; }
      }
      if (e.key === "Backspace" && s.autoClose && !e.ctrlKey && !e.metaKey) {
        const pairs = { "{": "}", "(": ")", "[": "]", '"': '"' };
        for (const open of Object.keys(pairs)) {
          if (Editor.backspacePair(open, pairs[open])) { e.preventDefault(); return; }
        }
      }

      if (e.key === "F12") { e.preventDefault(); gotoDefinition(); return; }
      if (e.altKey && e.key === "F7") { e.preventDefault(); findRefs(); return; }
      // Find in the project. Ctrl+Shift+F is the gesture every editor uses for
      // "search the files, not this file"; Ctrl+F is bound to the same thing on
      // purpose. This editor has no in-file find, and an unbound Ctrl+F in a
      // browser opens the *browser's* find bar, which searches the interface's
      // own DOM and can never find the word in the code. Doing something useful
      // beats leaving the most obvious search key to do something misleading.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openProjectSearch();
        return;
      }
      // Escape leaves Zen; see the window-level handler above for why it is not
      // only here. The completion list has first claim when it is open.
      if (e.key === "Escape" && zenRef.current && !Editor.comp) { e.preventDefault(); leaveZen(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); act("run"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.shiftKey) checkProject(); else act("build");
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setPalette(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); beginCreate("file"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setSettings((s2) => { const n = { ...s2, fontSize: 13.5 }; applySettings(n); return n; });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); setSettingsOpen(true); return; }
      if (e.key === "F2" && currentRef.current) { e.preventDefault(); beginRename("file", currentRef.current); return; }
      if (e.key === "Delete" && currentRef.current) { e.preventDefault(); removeEntry("file", currentRef.current); return; }
      if (e.key === "Escape" && ghostRef.current) { ghostRef.current = ""; Editor.setGhost(""); }
    };
    // The editor's own handler only fires while the textarea has focus, which
    // left the browser's native Save-Page dialog to steal Ctrl+S the moment
    // focus left the editor - after clicking the tree, a panel, or right after
    // launch. A window-level handler catches it everywhere, and bails out the
    // instant the editor already handled it (e.defaultPrevented).
    const win = (e) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); act("run"); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener("keydown", win);
    return () => {
      window.removeEventListener("keydown", win);
      // The surface is going away. `unmount` first, so the paint paths stop
      // claiming they can draw into a detached tree.
      Editor.unmount();
    };
  }, [surface]);

  // ---- autosave: write shortly after typing stops
  //
  // `editRev` is in the dependency list on purpose - see the note where it is
  // declared. Without it this effect ran once per edit and the timer was armed
  // from the first keystroke, so a steady typist outran the deadline and the
  // buffer stayed dirty. It also re-arms on `current`, because switching files
  // while dirty has to schedule a write for the file being left, not the one
  // just opened.
  useEffect(() => {
    if (!dirty || !current || !settings.autosave) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { save(); }, settings.autosaveDelay);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [dirty, editRev, current, settings.autosave, settings.autosaveDelay]);

  // ---- the tree keeps itself current, so files created outside appear
  //
  // Every poll costs two shell listings on the server - measured at 487 ms on
  // this machine, because process creation here is slow - and the server is
  // single-threaded, so that is 487 ms during which nothing else can be served.
  // So: poll less often, and not at all when nobody is looking. A hidden window
  // refreshing a tree nobody can see is pure waste.
  useEffect(() => {
    // No workspace, nothing to keep current. Polling anyway cost a full tree
    // walk of the server's own directory every 8 s for a tree nobody had, and
    // it was what clobbered `root` while the folder picker was open.
    if (!root) return;
    const t = setInterval(() => {
      if (dirty) return;
      if (typeof document !== "undefined" && document.hidden) return;
      refreshTree(root);
    }, 8000);
    return () => clearInterval(t);
  }, [root, dirty]);

  // ---- git: branch + dirty count, polled rarely. It costs two process launches
  // on the server (git rev-parse, git status), so 12 s is the cadence, and it is
  // skipped entirely when there is no workspace yet.
  useEffect(() => {
    if (!root || root === ".") return;
    refreshGit();
    const t = setInterval(refreshGit, 12000);
    return () => clearInterval(t);
  }, [root]);

  // ---- remember the workspace, wherever it was opened from
  //
  // One effect rather than a call at each of the four places a root is set (the
  // boot restore, the folder browser, the title screen, a new project). Four
  // call sites is four chances to forget one, and the symptom would be a title
  // screen that silently loses the folder you use every day.
  useEffect(() => { rememberRoot(root); }, [root]);

  // ---- push diagnostics into the editor
  //
  // Two sources, one view. The compiler's own problems are the primary one
  // because they are authoritative and need no AI; the companion's linter folds
  // in as a second opinion. Both land on the same lines, gutter marks.
  useEffect(() => {
    const marks = {};
    for (const d of diagnostics) {
      const i = (d.line || 1) - 1;
      if (i < 0) continue;
      const want = d.severity === "warning" ? "warnline" : "errline";
      if (marks[i] !== "errline") marks[i] = want;
    }
    Editor.setMarks(marks);
    Editor.setRanges(diagnostics
      .filter((d) => d.here !== false && d.line)
      .map((d) => ({ line: d.line, col: d.col || 1, len: d.len || 1, severity: d.severity })));
  }, [diagnostics]);

  // ---- server calls
  async function refreshTree(r) {
    try {
      const t = await post("/api/tree", r);
      if (!t.ok) {
        // An unreachable folder and an empty project used to render identically
        // in the explorer, which is exactly how a stuck server passed for an
        // empty workspace. Say which one it is.
        setTreeError((t.error || "cannot read the workspace")
          + (t.detail ? " - " + t.detail : ""));
        setTreeNote("");
        setFiles([]); setDirs([]);
        setStatus("workspace unreadable");
        return;
      }
      setTreeError("");
      // The walk is native now and checks its budget before every descent, so
      // `shallow` no longer means "this is a drive root and we refused to look".
      // It means the workspace is larger than the walk's budget and what you
      // see is the first part of it. A recursive shell listing of `D:/` once
      // grew the server to 3.9 GB and stopped it answering; that cannot happen
      // any more, but the honest label still matters.
      setTreeNote(t.shallow
        ? "large workspace - showing the first " + (t.file_count + t.dir_count)
          + " entries. Narrow the workspace to see the rest."
        : "");
      setFiles(t.files || []);
      setDirs(t.dirs || []);
      // Only adopt a root that was actually asked for. An empty `r` means
      // "nobody has chosen a workspace", and the server answers such a request
      // by describing its own working directory - so the old `|| "."` fallback
      // handed the studio a workspace it was never given. Measured: the 8 s tree
      // poll ran with no workspace, this line set `root` to ".", the folder
      // picker's `start` prop changed underneath it, the picker's effect re-ran
      // and the dialog threw away the folder the reader had just typed.
      if (r) setRoot(t.root || r);
    } catch (e) {
      setTreeError(e.message);
      setTreeNote("");
      setFiles([]); setDirs([]);
      setStatus("cannot reach the Datara server");
    }
  }

  /** Compile the open file and turn the output into editor problems.
   *
   * This is the feature that makes the IDE usable with the companion switched
   * off, and it was missing: diagnostics used to come only from the AI, so with
   * no AI there were no red marks anywhere and the editor looked like it was not
   * paying attention. forgen was sitting right there the whole time.
   *
   * Debounced rather than run per keystroke: a check costs about 130 ms, which is
   * nothing once you have stopped typing and far too much while you have not.
   */
  function scheduleCheck() {
    if (!settingsRef.current.checkOnType) return;
    if (checkTimer.current) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(runCheck, 650);
  }

  async function runCheck() {
    const file = currentRef.current;
    if (!file) { setCompDiag([]); return; }
    try {
      // Write first when the buffer has changes, because the compiler only ever
      // sees files: `/api/check` is aimed at a path and forgen reads that path.
      // Without this the squiggles describe the previous save. Measured: type a
      // syntax error and stop, and the panel still reads "no problems in this
      // file" - the diagnostics lag one save behind the code, which reads as the
      // checker being broken rather than late.
      //
      // It costs nothing when autosave is on, which is the default: it only
      // moves the write autosave was about to make from 900 ms to 650 ms, and
      // the autosave effect's cleanup drops its now-redundant timer. With
      // autosave off the file is left alone, because not writing until asked is
      // the entire meaning of that setting - so there the check does report the
      // last save, and that is the honest thing for it to report.
      if (dirtyRef.current && settingsRef.current.autosave) await save();
      // through the provider, so a file this IDE cannot compile is simply not
      // checked instead of being checked and reported wrong
      setCompDiag(await langRef.current.check(file, post));
    } catch (e) {
      setCompDiag([]);
    }
  }

  /** Jump to where a name is declared.
   *
   * No new endpoint and no symbol index to keep in sync: a declaration in Datara
   * is a line that starts with a declaration keyword, so one workspace search
   * for the name, filtered for declaration-shaped lines, is the whole algorithm.
   * That works across the project rather than only within the open file, and it
   * costs one `findstr` - the same call the references view already makes.
   *
   * When nothing matches, the answer is not "not found" but "this is not
   * declared in your workspace" - which for `str_len` or `Int` is the true and
   * more useful statement.
   */
  async function gotoDefinition(atWord) {
    const word = atWord || Editor.wordAt(Editor.sel.line, Editor.sel.col);
    if (!word) { setStatus("put the caret on a name first"); return; }
    setStatus("looking for the declaration of " + word + " ...");
    let hits = [];
    try {
      // Whole word: a declaration search for `store` must not be answered with
      // `storehouse`. See the note on `st_find`.
      const r = await post("/api/find", root + "\n" + word + "\n1");
      hits = r && r.ok ? r.hits : [];
    } catch (e) {
      setStatus("search failed: " + e.message);
      return;
    }
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const decl = new RegExp(
      "^\\s*(?:pub\\s+)?(?:fn|struct|trait|behavior|impl|type|enum|mod|const)\\s+" + safe + "\\b");
    const def = hits.find((h) => decl.test(h.text));
    if (!def) {
      const info = hoverInfo(word, outlineRef.current, Editor.srcLines);
      setStatus(info
        ? word + " is a " + info.kind + " - not declared anywhere in this workspace"
        : "no declaration of " + word + " in this workspace");
      return;
    }
    if (def.file !== currentRef.current) await openFile(def.file, false);
    Editor.gotoLine(def.line);
    setStatus("definition: " + def.file.split(/[\\/]/).pop() + ":" + def.line + "  ·  " + def.text.trim());
  }

  /** Check the whole project, not just the open file.
   *
   * `forgen check <dir>` compiles every module and reports every error with a
   * full path - 301 ms over the whole workspace, the same as checking one file,
   * because the cost is the compiler's process start and not the volume of code.
   * That is the difference between "this file is clean" and "the project
   * builds", and it is the view a person wants before they run anything.
   *
   * **The target is the open file, not the workspace root**, and that is the
   * whole correctness of this feature. forgen resolves `use` statements relative
   * to the nearest `datara.toml`, so a check aimed at a folder that is not
   * itself a project reports every import as a missing *package* - a false error
   * for a workspace that compiles clean, and exactly what the first version of
   * this did. Aimed at the open file, the server walks up to the project that
   * governs it and checks that.
   *
   * The results are kept separately from the open file's, because they answer a
   * different question and mixing them would make the squiggles in the editor
   * depend on files the editor is not showing.
   */
  async function checkProject() {
    setProjBusy(true);
    setTab("prob");
    try {
      const r = await post("/api/check", checkBody(currentRef.current, root));
      if (!r || !r.ok || !r.result) {
        setProjDiag([]);
        setProjWhere("");
        setStatus("could not check the project");
      } else {
        const all = parseForgenDiagnostics(r.result.output, null);
        setProjDiag(all);
        setProjWhere(r.project || r.asked || "");
        setStatus(checkNote(r.project, r.asked, all.length));
      }
    } catch (e) {
      setProjDiag([]);
      setProjWhere("");
      setStatus("project check failed: " + e.message);
    }
    setProjBusy(false);
  }

  /** Open the file a project problem lives in, at its line. */
  async function gotoProblem(d) {
    if (!d.file) return;
    if (d.file !== currentRef.current) {
      // force, because a project check is not the user asking to discard work -
      // but if the buffer is dirty, save first so nothing is lost
      if (dirty) await save();
      await openFile(d.file, true);
    }
    Editor.gotoLine(d.line, d.col);
    setTab("prob");
  }

  /** Search the workspace, and put the result in the Project panel.   *
   *  One entry point for every way in - the search box, Alt+F7, the intent bar -
   *  because they all mean the same thing and used to be three copies of it.
   *
   *  `whole` asks the server to keep only lines where the query is a complete
   *  name. That is the difference between "find this variable everywhere" and
   *  "find everything that contains these letters": searching `stock` and being
   *  shown `release_stock` is how a reference list stops being read. */
  async function runProjectSearch(q, whole) {
    const query = String(q || "").trim();
    if (!query) { setStatus("type something to search for"); return; }
    const word = whole !== false;
    setTab("proj");
    setRefWord(query);
    setRefWhole(word);
    setRefBusy(true);
    try {
      const r = await post("/api/find", root + "\n" + query + "\n" + (word ? "1" : "0"));
      setRefs(r && r.ok ? r.hits : []);
      setStatus((r && r.ok ? r.hits.length : 0) + (word ? " name(s) matching " : " hit(s) for ") + query);
    } catch (e) {
      setRefs([]);
      setStatus("search failed: " + e.message);
    }
    setRefBusy(false);
    // And again now that the card has grown.
    //
    // The bump on the way in cannot finish the job, and the reason is
    // structural: until the hits render, the References card is the last child
    // of the panel column, so there is nothing below it to scroll against and
    // `scrollIntoView` stops at the maximum scroll. Measured on this repo:
    // content 1394px against an 824px panel, card at 1212 - the scroll stops at
    // 570 and leaves the card's top edge on the panel's bottom edge, showing the
    // header, the box and one line of the first hit, with the other twelve below
    // the fold and nothing to re-scroll them. With the hits in, the content is
    // 2775px, there is room to move, and the card's top reaches the top of the
    // panel.
    setRefScroll((n) => n + 1);
  }

  /** Unfold the panel column and make sure the Project tab is in it.
   *
   *  Asking to search the project and getting nothing at all - because the panel
   *  column is folded, or because the Project tab was hidden in Settings - is
   *  indistinguishable from a broken shortcut. Both are reversible one-click
   *  states, so undoing them is the whole of "show me the results". Shared by
   *  Ctrl+Shift+F and Alt+F7, which had the same hole: Alt+F7 searched, set the
   *  tab, and showed nothing at all when the column happened to be folded. */
  function revealProjectPanel() {
    setPanelFold(false);
    setSettings((s) => {
      if (!(s.panelHidden || []).includes("proj")) return s;
      const n = { ...s, panelHidden: s.panelHidden.filter((k) => k !== "proj") };
      applySettings(n);
      return n;
    });
    setTab("proj");
  }

  /** Find every use of the word at the caret, across the workspace. */
  async function findRefs() {
    const word = Editor.wordAt(Editor.sel.line, Editor.sel.col);
    if (!word) { setStatus("put the caret on a name first"); return; }
    revealProjectPanel();
    setSearchQ(word);
    // Before the await, so the card is already on screen while it says
    // "searching ..." - the wait is the part where a blank panel is most
    // confusing. `runProjectSearch` bumps again once the hits land, because this
    // one clamps: see the note there.
    setRefScroll((n) => n + 1);
    await runProjectSearch(word, true);
  }

  /** Open the project search on the word at the caret, ready to be edited.
   *
   *  Deliberately does not search. The caret word is a starting point, not the
   *  query - "find `stock` everywhere" usually becomes "find `stock`, no wait,
   *  `stock_level`" the moment the results appear, and a box that has already
   *  run and that you can type over is the gesture that survives that. Enter
   *  runs it. Alt+F7 is still the one that searches immediately.
   *
   *  It does have to make the box *visible* first, though: `revealProjectPanel`
   *  undoes a folded column and an un-hidden Project tab, because a shortcut
   *  that appears to do nothing is worse than no shortcut. */
  function openProjectSearch() {
    // Prefill from the caret word, but never over what is already typed in the
    // box. The shortcut is registered at window level, so it also fires while
    // the box itself has focus - and reaching for Ctrl+F again after typing half
    // a name must not replace it with whatever word the caret is sitting on in
    // the editor. In that case the gesture means "select the query", which is
    // what the focus effect below does anyway.
    const el = document.getElementById("psearch");
    const inBox = !!el && document.activeElement === el;
    const word = Editor.wordAt(Editor.sel.line, Editor.sel.col);
    revealProjectPanel();
    if (word && !inBox) setSearchQ(word);
    setSearchFocus((n) => n + 1);
    setRefScroll((n) => n + 1);
    setStatus(word && !inBox
      ? "searching the project - Enter to run, or edit the name first"
      : "searching the project - type a name or any text");
  }
  // Hand the window-level listener the current version. Assigned during render
  // on purpose, the same way `settingsRef` is kept up to date; the listener
  // itself is created once and would otherwise hold the first render's closure.
  openSearchRef.current = openProjectSearch;

  /** Start the companion, quietly, if it is not already up.
   *
   * The "if it is not already up" is the entire job, and it was missing. This is
   * called once per page load, and the daemon it starts is detached and lives
   * until the machine restarts - so every reload left another one behind.
   * Measured on this machine: **115 python processes, 2.64 GB resident**, about
   * thirty of them bound to port 7890 at the same moment. The Datara runtime
   * does not refuse a second bind on a port, so all thirty "started
   * successfully" and every request then went to whichever one Windows happened
   * to hand the connection to. That is why the companion's suggestions looked
   * random: they were coming from thirty different processes, some of them
   * started days apart.
   *
   * `aiOnlineRef`, not `aiOnline`: the boot call comes from an effect that runs
   * once, so reading render state here would read whatever it was at that
   * moment - the same trap that killed the ghost text.
   */
  async function startAI(quiet) {
    if (aiStartingRef.current) return;
    if (aiOnlineRef.current) {
      if (!quiet) setStatus("the companion is already running");
      return;
    }
    aiStartingRef.current = true;
    setAiStarting(true);
    try {
      const r = await post("/api/ai/start", settingsRef.current.aiDir || "");
      if (!quiet) setStatus(r && r.ok
        ? (r.already ? "the companion was already running" : "starting the companion ...")
        : (r && r.error) || "could not start it");
      // give it a moment, then let the normal poll notice it
      setTimeout(checkAI, 1500);
      setTimeout(checkAI, 4000);
    } catch (e) {
      if (!quiet) setStatus("could not start the companion: " + e.message);
    }
    aiStartingRef.current = false;
    setAiStarting(false);
  }

  /** Stop the companion, and stop claiming it is running.
   *
   * The switch in the bar used to clear `settings.aiEnabled` and nothing else,
   * which stopped the health poll and dimmed the lamp while the process went on
   * holding 7890. Two consequences, both reported as "the switch does not work":
   * turning it back on appeared to succeed because the same process was still
   * there, and a companion that had never been started could not be turned on at
   * all, because nothing on that path ever called `startAI`.
   *
   * So this is the other half - it asks the server to end the process. The server
   * confirms by asking the port rather than by trusting `taskkill`, so the status
   * line reports what is true rather than what was requested.
   */
  async function stopAI() {
    try {
      const r = await post("/api/ai/stop");
      setAiOnline(false);
      setAiLabel("off");
      setStatus(r && r.ok
        ? (r.already ? "the companion was not running" : "the companion is stopped")
        : (r && r.error) || "could not stop it");
    } catch (e) {
      setStatus("could not stop the companion: " + e.message);
    }
  }

  /** The one place that turns the companion on or off.
   *
   * Both switches - the plug in the bar and the row in Settings - go through
   * here, because they had the same defect: each wrote the flag and stopped
   * there. See `stopAI` for what that looked like from the outside.
   */
  function setAiEnabled(on) {
    setSettings((s) => { const n = { ...s, aiEnabled: on }; applySettings(n); return n; });
    if (on) startAI(false);
    else stopAI();
  }

  /** Move a dragged tree entry into a folder. */
  async function dropInto(src, dstDir) {
    if (!src || !dstDir) return;
    const name = src.split(/[\\/]/).pop();
    const to = dstDir.replace(/[\\/]+$/, "") + "/" + name;
    if (to === src) return;
    const r = await post("/api/move", src + "\n" + to);
    if (r && r.ok) {
      await refreshTree(root);
      if (current === src) { setCurrent(to); try { localStorage.setItem("datara.studio.lastFile", to); } catch (e) {} }
      setStatus("moved " + name);
    } else {
      setStatus((r && (r.detail || r.error)) || "could not move it");
    }
  }

  /** Rename a file or folder in place: a move inside the same parent with a new
   *  name. The explorer's create-row UI is reused for an inline rename field. */
  async function beginRename(kind, path) {
    if (!path) return;
    setRenaming({ kind, path });
    setCreateKey("");
    setCreating(null);
    const base = path.split(/[\\/]/).pop();
    const dot = base.lastIndexOf(".");
    // a file opens with its stem selected, so typing replaces the name and
    // leaves the extension alone; a folder has no extension to keep
    const select = kind === "dir" ? [0, base.length] : (dot > 0 ? [0, dot] : [0, base.length]);
    const next = await askUser({
      kind: "prompt",
      title: "Rename " + (kind === "dir" ? "folder" : "file"),
      body: "A move inside the same folder.",
      ok: "Rename",
      value: base,
      select,
    });
    if (!next || next === base) { setRenaming(null); return; }
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    const to = (dir ? dir + "/" : "") + next.replace(/[\\/]+/g, "/");
    commitRename(path, to);
  }

  async function commitRename(src, to) {
    setRenaming(null);
    if (src === to) return;
    const r = await post("/api/move", src + "\n" + to);
    if (r && r.ok) {
      await refreshTree(root);
      if (current === src) {
        setCurrent(to);
        try { localStorage.setItem("datara.studio.lastFile", to); } catch (e) {}
      }
      setStatus("renamed to " + to);
    } else {
      setStatus((r && (r.detail || r.error)) || "could not rename it");
    }
  }

  /** Ask a yes/no question in the interface's own dialog and wait for it.
   *  Resolves true only if the person said yes - a closed dialog, Escape and
   *  the backdrop all resolve false, so an unanswered question can never be
   *  read as consent. */
  function askUser(q) {
    return new Promise((resolve) => {
      askRef.current = resolve;
      setAsk(q);
    });
  }

  function answerAsk(value) {
    const resolve = askRef.current;
    askRef.current = null;
    setAsk(null);
    if (resolve) resolve(value);
  }

  /** Delete a file or folder. forgen 1.4.0 has no file-delete builtin, so the
   *  server shells out - which means a non-ASCII name cannot be spelled for the
   *  shell and is refused with a reason there, not here. */
  async function removeEntry(kind, path) {
    if (!path) return;
    const base = path.split(/[\\/]/).pop();
    // The question is asked in this program's own dialog rather than the
    // platform's. A folder is asked about differently because the answer is
    // different in kind: a file is one file, a folder is however many are
    // inside it, and that count is not known here.
    const yes = await askUser({
      title: "Delete " + base + "?",
      body: kind === "dir"
        ? "The folder and everything inside it goes. This cannot be undone."
        : "The file goes. This cannot be undone.",
      ok: "Delete",
      danger: true,
    });
    if (!yes) return;
    const r = await post("/api/delete", kind + "\n" + path);
    if (r && r.ok) {
      await refreshTree(root);
      if (current === path) {
        setCurrent(null);
        Editor.setText("");
        try { localStorage.removeItem("datara.studio.lastFile"); } catch (e) {}
      }
      setStatus("deleted " + base);
    } else {
      setStatus((r && (r.detail || r.error)) || "could not delete it");
    }
  }

  /** The current git branch and dirty file list, polled rarely. The server runs
   *  `git` itself (it is on the command whitelist), so the UI only has to show
   *  what comes back. */
  async function refreshGit() {
    if (!root || root === ".") return;
    if (gitMissing.current) return;
    try {
      const r = await post("/api/git", root);
      if (r && r.ok) setGit(r);
      else if (r && /no such endpoint/i.test(r.error || "")) gitMissing.current = true;
    } catch (e) {}
  }

  /** Where a new item goes: the folder of the file being worked on.
   *
   * It used to always go to the workspace root, which is the one place you are
   * least likely to want it when you are deep in `src/`.
   */
  function beginCreate(kind) {
    const file = currentRef.current;
    let key = "";
    if (file && root && root !== "." && file.startsWith(root)) {
      const rel = file.slice(root.length).replace(/^[\\/]+/, "");
      const parts = rel.split(/[\\/]/);
      parts.pop();
      key = parts.join("/");
    }
    setCreateKey(key);
    setCreating(kind);
  }

  /** Give a file opened from the global picker a real workspace.
   *
   * The old browser build could remember `lastFile` without `lastRoot` (or an
   * installer upgrade could preserve that half of localStorage). The file then
   * opened, but the explorer stayed empty and `/api/git` was never asked, so the
   * worktree chip was absent and drag/drop had no destination root. Ask git for
   * the repository root first; for a non-repository file, use its containing
   * folder. This is also what makes opening a file from another drive useful.
   */
  async function ensureWorkspaceForFile(path) {
    if (root || !path) return;
    const clean = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
    const cut = clean.lastIndexOf("/");
    const parent = cut > 2 ? clean.slice(0, cut) : clean;
    if (!parent) return;
    let workspace = parent;
    try {
      const g = await post("/api/git", parent);
      if (g && g.ok && g.root) workspace = g.root;
    } catch (e) {}
    setRoot(workspace);
    await refreshTree(workspace);
  }

  async function openFile(path, force) {
    // Same dialog, same reason: this is a question about losing work, and it
    // used to be the platform's dialog rather than this program's.
    //
    // With autosave on there is nothing to lose, so there is nothing to ask.
    // The buffer is flushed to disk first and the file then opens, which is what
    // "everything is saved live" is supposed to mean - and it is why this prompt
    // used to appear at all: a write that the user believed had happened had
    // not, because the autosave timer never re-armed. Asking now would be
    // asking about work that is already safe.
    if (!force && dirtyRef.current) {
      if (settingsRef.current.autosave) {
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        await save();
      } else {
        const yes = await askUser({
          title: "Discard unsaved changes?",
          body: (current ? current.split(/[\\/]/).pop() : "The open file")
            + " has changes that were not written.",
          ok: "Discard",
          danger: true,
        });
        if (!yes) return;
      }
    }
    await ensureWorkspaceForFile(path);
    const r = await post("/api/read", path);
    if (!r.ok) { setStatus("cannot open " + path); return; }
    setCurrent(path);
    setDirty(false);
    Editor.setText(r.content);
    setSuggestions([]);
    setCompDiag([]);
    setAiDiag([]);
    ghostRef.current = ""; Editor.setGhost("");
    Editor.hideTip();
    // the outline comes from whichever language owns this file, so a Python
    // file is not scanned with a Datara regex
    const lang = providerFor(path);
    langRef.current = lang;
    // Datara gets the compiler lexer; every other language gets a safe escaped
    // surface instead of Datara tokens miscolouring strings and comments.
    Editor.highlighter = lang.highlight || plainHighlight;
    const syms = lang.symbols(r.content);
    setOutline(syms);
    outlineRef.current = syms;
    Editor.setSymbols(syms);
    // remembered so the next launch lands where this one left off
    try { localStorage.setItem("datara.studio.lastFile", path); } catch (e) {}
    setStatus("opened " + path.split(/[\\/]/).pop() + "  ·  " + r.bytes + " bytes"
      + (lang.id === "datara" ? "" : "  ·  " + lang.label));
    // check it straight away rather than after the first keystroke: opening a
    // file with a known error should show the error, not wait to be told
    runCheck();
    // and ask the companion for a suggestion at the caret, for the same reason:
    // a suggestion that only appears once you start typing is not a suggestion,
    // it is an autocomplete. This is a no-op when the companion is off.
    scheduleAI();
  }

  /** Create a file or a folder inside the workspace root.
   *
   * The row that collects the name lives in the tree, so by the time this runs
   * the name is settled - including the extension, which `resolveName` decided
   * while the user was typing.
   */
  async function createItem(name, isDir) {
    const key = createKey;
    setCreating(null);
    setCreateKey("");
    const base = root && root !== "." ? root.replace(/[\\/]+$/, "") : "";
    const dir = base && key ? base + "/" + key : base;
    const path = (dir ? dir + "/" + name : name).replace(/\\/g, "/");

    if (isDir) {
      const r = await post("/api/mkdir", path);
      if (r && r.ok) { await refreshTree(root); setStatus("created folder " + path); }
      else setStatus((r && (r.detail || r.error)) || "could not create the folder");
      return;
    }

    // A .dtr file gets a compiling skeleton; anything else starts empty. A
    // blank buffer is the honest default, but an empty Datara file is not a
    // program and would fail `forgen check` the moment it was saved.
    const body = path.endsWith(".dtr") ? "fn main() -> Int {\n    return 0\n}\n" : "";
    const r = await post("/api/new", path + "\n" + body);
    if (r && r.ok) {
      await refreshTree(root);
      await openFile(path, true);
      setStatus("created " + path);
    } else {
      setStatus((r && (r.detail || r.error)) || "could not create " + path);
    }
  }

  /** Write the open buffer to disk. Returns whether bytes were actually written.
   *
   * **Ctrl+S with nothing open now creates the file.** It used to open the
   * explorer's create row and stop there - and the row is a name prompt, not a
   * save. If you did not notice it appear, the buffer went nowhere, which is
   * exactly "I press Ctrl+S, it offers to save, and nothing is saved". A
   * keystroke that says save has to end with bytes on disk.
   *
   * The path comes from `currentRef` and not from `current`: this function is
   * called from key handlers and effects that captured an older render, and a
   * save that writes to the previous file is worse than one that fails.
   */
  async function save() {
    const target = currentRef.current;
    if (!target) return await saveAs();
    return await writeTo(target);
  }

  /** A name for a buffer that has never been on disk, avoiding the ones taken. */
  function untitledName() {
    const taken = new Set(files.map((f) => (f.name || "").toLowerCase()));
    let name = "untitled.dtr";
    let n = 2;
    while (taken.has(name.toLowerCase())) { name = "untitled-" + n + ".dtr"; n = n + 1; }
    return name;
  }

  /** Save As: ask for a name, create the file, then write the buffer into it.
   *
   * Creation goes through `/api/new`, which makes the parent folders as well,
   * so typing `tools/check.dtr` works rather than failing because `tools` does
   * not exist yet.
   *
   * The editor is deliberately NOT re-read from disk afterwards. The buffer is
   * the thing being saved; reloading it would throw away the work the user just
   * asked to keep.
   */
  async function saveAs() {
    const typed = await askUser({
      kind: "prompt",
      title: "Save as",
      body: "A name, or a path relative to the workspace. Folders are created as needed.",
      ok: "Save",
      value: untitledName(),
    });
    if (typed === null) { setStatus("save cancelled"); return false; }
    let name = typed.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name) { setStatus("save cancelled"); return false; }
    // a Datara file with no extension is not a Datara file
    if (name.split("/").pop().indexOf(".") < 0) name = name + ".dtr";
    const base = root && root !== "." ? root.replace(/[\\/]+$/, "") : "";
    const path = (base ? base + "/" + name : name).replace(/\/{2,}/g, "/");
    const r = await post("/api/new", path + "\n" + Editor.getText());
    if (!r || !r.ok) {
      setStatus("save failed: " + ((r && (r.detail || r.error)) || "no answer"));
      return false;
    }
    setCurrent(path);
    currentRef.current = path;
    setDirty(false);
    await refreshTree(root);
    try { localStorage.setItem("datara.studio.lastFile", path); } catch (e) {}
    setStatus("saved " + path + "  ·  " + r.bytes + " bytes");
    return true;
  }

  /** Write the buffer to a path that is already open. */
  async function writeTo(path) {
    try {
      const r = await post("/api/write", path + "\n" + Editor.getText());
      if (r && r.ok) {
        setDirty(false);
        setStatus("saved " + path.split(/[\\/]/).pop() + "  ·  " + r.bytes + " bytes");
        return true;
      }
      setStatus("save failed: " + ((r && (r.detail || r.error)) || "no answer"));
    } catch (e) {
      setStatus("save failed: " + e.message);
    }
    return false;
  }

  /** Remember a workspace so the title screen can offer it next time. */
  function rememberRoot(p) {
    if (!p || p === ".") return;
    setRecents((list) => {
      if (list[0] === p) return list;
      const next = [p].concat(list.filter((x) => x !== p)).slice(0, 8);
      try { localStorage.setItem("datara.studio.recent", JSON.stringify(next)); } catch (e) {}
      return next;
    });
  }

  /** Switch the workspace to `p`, tree and all. */
  async function openWorkspace(p) {
    if (!p) return;
    setRoot(p);
    try { localStorage.setItem("datara.studio.lastRoot", p); } catch (e) {}
    await refreshTree(p);
    setStatus("workspace: " + p);
  }

  /** Create a new project: a folder with a compiling entry point, then open it.
   *
   * "Create new project" is what every editor offers on a blank first launch,
   * and the studio only had "new file" - which leaves you holding one loose file
   * with no folder around it, nothing for `forgen check` to aim at, and nowhere
   * for the second file to go. The skeleton written here is the smallest thing
   * that actually compiles: a `src/main.dtr` with a real `fn main`.
   */
  async function newProject() {
    // Every editor asks *where* before it asks *what*, and this used to skip
    // that step. With no workspace open the typed name became a relative path,
    // which the server resolves against its own working directory - measured on
    // a cold launch, "demo-project" was created at
    // `D:\IDE datara\datara-studio\demo-project`, inside the IDE's own source
    // tree. With a workspace open there is already an answer, so it goes
    // straight to the name.
    if (!root) {
      setPendingProject(true);
      setBrowserMode("folder");
      setBrowserOpen(true);
      return;
    }
    await createProjectIn(root);
  }

  /** Ask for a name, and build the project inside `base`. */
  async function createProjectIn(base) {
    const typed = await askUser({
      kind: "prompt",
      title: "New project folder",
      body: "The project is created inside the folder you chose.",
      ok: "Create",
      value: "my-project",
    });
    if (typed === null) { setStatus("new project cancelled"); return; }
    const name = typed.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!name) { setStatus("new project cancelled"); return; }
    const home = base && base !== "." ? base.replace(/[\\/]+$/, "") : "";
    const dir = (home ? home + "/" + name : name).replace(/\/{2,}/g, "/");

    const made = await post("/api/mkdir", dir);
    if (!made || !made.ok) {
      setStatus((made && (made.detail || made.error)) || "could not create the project folder");
      return;
    }
    const entry = dir + "/src/main.dtr";
    const body = "fn main() -> Int {\n    println(\"hello from " + name + "\")\n    return 0\n}\n";
    const f = await post("/api/new", entry + "\n" + body);
    if (!f || !f.ok) {
      setStatus((f && (f.detail || f.error)) || "could not create the entry point");
      return;
    }
    await openWorkspace(dir);
    await openFile(entry, true);
    setStatus("new project " + dir);
  }

  /** The first line of compiler output, for a banner that has one line of room. */
  function headline(text) {
    const lines = String(text || "").split(/\r?\n/);
    for (const l of lines) {
      const t = l.trim();
      if (t) return t.replace(/^\s*error\[[^\]]*\]\s*:?\s*/i, "");
    }
    return "";
  }

  async function act(a) {
    let target = currentRef.current || "src/main.dtr";
    if (a === "tree") target = ".";
    const compiles = a === "run" || a === "build" || a === "check" || a === "lint" || a === "audit";

    // Save first, and **always** - not only when the dirty flag is set.
    //
    // The flag is raised by the editor's own input handler, so a buffer changed
    // by anything else - a Generate insert, a snippet from the panel - can
    // differ from the file while `dirty` is false. That is how a run could
    // compile the previous version of the code and report success: the compiler
    // was handed the file, and the file had never been written. Writing a few KB
    // costs nothing next to a 250 ms process launch, so there is no reason to
    // guess which of the two the compiler will see.
    if (compiles && currentRef.current) {
      setStatus("saving before " + a + " ...");
      const saved = await save();
      if (!saved) { setStatus("not running " + a + ": the file could not be saved"); return; }
    }

    if (a === "run" || a === "build") setRunning(true);
    setRunError(null);
    setStatus("forgen " + a + " ...");
    setDrawer({ open: true, title: "forgen " + a + " " + target, text: "", cls: "b" });
    const t0 = performance.now();
    const r = await post("/api/action", a + "\n" + target);
    const ms = performance.now() - t0;
    // "How long did the code take" is the question the drawer was missing an
    // answer to. This is the whole round trip - compile and execute together -
    // because that is what a person waits for when they press Run, and claiming
    // to separate the two would mean trusting the compiler's own timings.
    const took = ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";

    if (!r || !r.ok) {
      setDrawer({ open: true, title: a, text: (r && r.error) || "failed", cls: "e" });
      setRunning(false);
      return;
    }

    // A failed run carries the compiler's diagnostics, and they belong in the
    // Problems panel - where they are clickable and navigate to the line - and
    // in a banner over the code. Leaving them only as raw text in a drawer the
    // user has to open is how "the errors that stopped it launching were
    // invisible" happened. parseForgenDiagnostics already knows the format.
    const failed = r.status !== "ok";
    if (compiles && failed && r.output) {
      let ds = [];
      try { ds = parseForgenDiagnostics(r.output, target) || []; } catch (e) { ds = []; }
      if (ds.length) setCompDiag(ds);
      setRunError({ action: a, count: ds.length, text: headline(r.output) || "the compiler reported an error" });
    }

    // Which backend actually produced this binary.
    //
    // The compiler falls back from LLVM to Cranelift *without failing*, so a
    // build that quietly skipped the optimiser is indistinguishable from one
    // that used it - unless the fact is carried back and named. The server now
    // reports both `linker_ok` (was a native `link.exe` found) and `fell_back`
    // (did the compiler warn that it dropped to Cranelift), so the drawer can
    // state the backend instead of implying it.
    //
    // Only shown for the actions that actually reach codegen. `check`, `lint`
    // and `audit` never do, and a backend badge beside a syntax check would be
    // a lie about what happened.
    //
    // The default is the native backend, not LLVM, and the label says so rather
    // than hiding it: measured here, LLVM wins a tight arithmetic loop by ~5%
    // but costs 3.5x-7x the build time, so the fast-to-use backend is the
    // default and `FORGEN_LLVM=1` asks for the other one.
    let backend = "";
    if (a === "run" || a === "build") {
      if (r.fell_back) {
        backend = "  ·  Cranelift (LLVM fell back - linker missing)";
      } else if (r.linker_ok) {
        backend = "  ·  native (LLVM ready: set FORGEN_LLVM=1)";
      } else {
        backend = "  ·  native (no MSVC linker)";
      }
    }

    setDrawer({ open: true,
      title: "forgen " + a + "  ·  " + r.status
        + (r.exit != null ? "  ·  exit " + r.exit : "")
        + "  ·  took " + took + backend,
      text: r.output, cls: failed ? "e" : "g" });
    setStatus("forgen " + a + " \u2192 " + r.status + "  ·  exit " + r.exit + "  ·  took " + took + backend);
    setRunning(false);
  }

  /** Ask the companion to generate Datara, with the open file as context.
   *
   * This is the neural stack the project actually has today: a trigram model
   * trained on its own sources, not the torch model, which is not installed.
   * Sending the real buffer means it is being tested on real data, not a demo. */
  /** Create an empty file in the workspace and open it. Returns its path. */
  async function createAndOpen(name) {
    const base = root && root !== "." ? root.replace(/[\\/]+$/, "") : "";
    const path = (base ? base + "/" + name : name).replace(/\/{2,}/g, "/");
    const r = await post("/api/new", path + "\n");
    if (!r || !r.ok) {
      setStatus((r && (r.detail || r.error)) || "could not create " + path);
      return null;
    }
    setCurrent(path);
    currentRef.current = path;
    setDirty(false);
    Editor.setText("");
    await refreshTree(root);
    try { localStorage.setItem("datara.studio.lastFile", path); } catch (e) {}
    return path;
  }

  // How long a generate request is allowed to take before the panel gives up.
  //
  // There was no limit here, and that is worse than it sounds: the fetch had no
  // timeout, so a companion that accepted the connection and then closed it
  // without answering left the button reading "generating ..." indefinitely with
  // no way back except a reload. A dropped connection is a thing that happens;
  // an interface that cannot say so is the defect.
  //
  // Verification runs `forgen check` up to three times inside the daemon, so the
  // honest ceiling is generous - this is here to bound the wait, not to hurry
  // the compiler.
  const GEN_TIMEOUT_MS = 90000;

  async function runGenerate() {
    const req = genReq.trim();
    if (!req || genBusy) return;
    setGenBusy(true); setGenErr(""); setGenRes(null); setGenWhere("");
    // The context is captured once and kept, because it is needed twice: it goes
    // to the companion, and it is then subtracted from the answer.
    //
    // The companion does not return "the new part". It returns the whole program
    // with the new part in it - the context is echoed back at the head of `code`.
    // This panel used to insert that entire string at the caret, so asking for a
    // second function wrote a second copy of the file into the file. From the
    // outside that reads as "it does not understand what was written before",
    // and the outside was right: it understood, and then duplicated it.
    const context = Editor.getText().slice(0, GEN_CONTEXT_CHARS);
    setGenCtx({ chars: context.length, used: null });
    let timedOut = false;
    try {
      const r = await fetch("http://127.0.0.1:7890/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: req, context, verify: true }),
        signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
      });
      const j = await r.json();
      if (j.error) setGenErr(j.error + (j.detail ? ": " + j.detail : ""));
      else {
        // What the companion actually read, reported rather than assumed.
        setGenCtx({ chars: context.length, used: j.context_used !== false });
        // The addition is what belongs in the buffer. `startsWith` rather than a
        // trim, because the echo is exact - and when it is not exact, the whole
        // answer is inserted rather than a guess at where the seam is.
        const addition = context && j.code && j.code.startsWith(context)
          ? j.code.slice(context.length).replace(/^\n+/, "")
          : (j.code || "");
        setGenRes({ ...j, code: addition, echoed: context.length, returned: (j.code || "").length });
        // The point of generate is to write code, not to admire it in a panel.
        // It goes into the open file, appended after what is already there, so
        // it is real and saveable the moment it arrives - and both the panel and
        // the status line name the file, because "it should understand which
        // file" is the whole instruction.
        //
        // With nothing open there is nowhere for it to go, and dropping the
        // result on the floor without saying so is the worst option available:
        // the buffer is created first, so the code has somewhere to live.
        let target = currentRef.current;
        if (j.code && !target) {
          target = await createAndOpen("generated.dtr");
        }
        if (addition && target) {
          Editor.append(addition + "\n");
          setDirty(true);
          setGenWhere(target);
          setStatus("appended " + addition.length + " characters to " + target + " - Ctrl+S to keep it");
        } else if (target) {
          setGenWhere("");
          setStatus("nothing new to add - the companion returned what was already in the file");
        }
      }
    } catch (e) {
      // A closed connection and a timeout are different failures and are named
      // differently, because the first is the companion's bug and the second is
      // a companion that is merely slow.
      timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      setGenErr(timedOut
        ? "the companion did not answer within " + Math.round(GEN_TIMEOUT_MS / 1000)
          + " seconds - it may still be verifying. Nothing was written to the file."
        : "the companion closed the connection without answering (" + e.message + ")."
          + " Nothing was written to the file. The companion may need restarting.");
    } finally {
      // In `finally` rather than after the try, because the one path that used to
      // skip it - an exception thrown before the fetch - is exactly the path that
      // left the button stuck on "generating ...".
      setGenBusy(false);
    }
  }

  // ---- chat
  //
  // One session id per workspace root. The daemon keys sessions by this string,
  // so opening a second folder must not continue the first folder's
  // conversation - that would be "the AI lost its mind", not "the AI has
  // context", and the difference is a hash.
  function chatSession() {
    if (chatSessionRef.current) return chatSessionRef.current;
    const seed = (settingsRef.current.aiDir || "") + "|" + (root || "");
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    chatSessionRef.current = "ide-" + Math.abs(h).toString(36);
    return chatSessionRef.current;
  }

  function persistChat(list) {
    try {
      // Keep the tail only: this is a reload cache, not an archive, and an
      // unbounded localStorage entry is a bug that shows up as a slow boot.
      localStorage.setItem("datara.studio.chat", JSON.stringify(list.slice(-40)));
    } catch (e) {}
  }

  /** The companion's view of the context, which is the thing the buttons act on. */
  async function refreshChatCtx() {
    try {
      const r = await fetch("http://127.0.0.1:7890/context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: chatSession(), action: "status" }),
      });
      const j = await r.json();
      if (!j.error) setChatCtx(j);
    } catch (e) {}
  }

  async function runChat() {
    const msg = chatReq.trim();
    if (!msg || chatBusy) return;
    const next = [...chatMsgsRef.current, { role: "user", content: msg }];
    setChatMsgs(next); persistChat(next);
    setChatReq(""); setChatBusy(true); setChatErr("");
    try {
      const r = await fetch("http://127.0.0.1:7890/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          session: chatSession(),
          // The open file is the context the code generator appends to. Sending
          // it is what makes "допиши функцию ниже" do something different from
          // "write me a function".
          file_path: currentRef.current || "",
          context: Editor.getText().slice(0, 4000),
        }),
      });
      const j = await r.json();
      if (j.error) {
        setChatErr(j.error + (j.detail ? ": " + j.detail : ""));
      } else {
        const reply = { role: "assistant", content: j.text, kind: j.kind,
                        code: j.code || "", verified: j.verified };
        const withReply = [...next, reply];
        setChatMsgs(withReply); persistChat(withReply);
        if (j.context) setChatCtx(j.context);
        if (j.kind === "refusal") setStatus("the companion did not have an answer for that");
      }
    } catch (e) {
      setChatErr("companion unreachable: " + e.message);
    }
    setChatBusy(false);
  }

  /** Delete the conversation and the context, in both places, at once. */
  async function clearChat() {
    if (chatClearing) return;
    setChatClearing(true);
    try {
      await fetch("http://127.0.0.1:7890/context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: chatSession(), action: "clear" }),
      });
    } catch (e) {}
    setChatMsgs([]); persistChat([]);
    setChatReq(""); setChatErr("");
    await refreshChatCtx();
    setChatClearing(false);
    setStatus("the companion's context was cleared");
  }

  async function undooChat() {
    try {
      await fetch("http://127.0.0.1:7890/context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: chatSession(), action: "undo" }),
      });
    } catch (e) {}
    // Drop the last exchange locally too, so the panel and the daemon agree.
    let list = chatMsgsRef.current;
    if (list.length && list[list.length - 1].role === "assistant") list = list.slice(0, -1);
    if (list.length && list[list.length - 1].role === "user") list = list.slice(0, -1);
    setChatMsgs(list); persistChat(list);
    await refreshChatCtx();
  }

  async function useProjectContext() {
    try {
      await fetch("http://127.0.0.1:7890/context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: chatSession(), action: "project" }),
      });
    } catch (e) {}
    await refreshChatCtx();
    setStatus("the project context is attached again");
  }

  async function scanLayout(r) {
    setLayoutBusy(true);
    try { setLayout(await post("/api/layout", r || ".")); }
    catch (e) { setLayout(null); }
    setLayoutBusy(false);
  }

  // ---- ai
  async function checkAI() {
    // The ref, not render state. `startAI` schedules two of these with a
    // `setTimeout`, so the closure they carry was built in the render *before*
    // the switch was flipped - and reading `settings.aiEnabled` there meant a
    // companion that had just been turned on was polled by a function that still
    // believed it was off, so the lamp never came on. Same trap as `aiOnlineRef`
    // above, same fix.
    if (!settingsRef.current.aiEnabled) { setAiOnline(false); setAiLabel("off"); return; }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1200);
      const r = await fetch("http://127.0.0.1:7890/health", { signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      const first = !aiOnlineRef.current;
      setAiOnline(true);
      // The label names the backend that is actually loaded, which /health now
      // reports from disk. Falling back to the service name keeps a status dot
      // working against an older companion that does not send the field.
      setAiLabel(String(j.model_kind || j.engine || "companion").split(" ")[0].toLowerCase());
      // Coming online after a cold boot means the context readout was fetched
      // while nothing was listening, so it is refreshed exactly once - not on
      // every poll, which would be a request every five seconds for a number
      // that only changes when the chat is used.
      if (first) refreshChatCtx();
    } catch (e) { setAiOnline(false); setAiLabel("off"); }
  }

  function scheduleAI() {
    if (!settingsRef.current.aiEnabled) return;
    if (aiTimer.current) clearTimeout(aiTimer.current);
    aiTimer.current = setTimeout(runAI, 420);
  }

  async function runAI() {
    // Every one of these three is read at call time, not at closure time. See
    // `aiOnlineRef` above: this function is reached through a handler that is
    // installed once, so any of them read from the closure would be whatever it
    // was in the render that installed it.
    if (!settingsRef.current.aiEnabled || !aiOnlineRef.current || !currentRef.current) return;
    const ta = Editor.ta;
    const pos = ta.selectionStart, v = ta.value;
    const body = {
      prefix: v.slice(Math.max(0, pos - 500), pos),
      suffix: v.slice(pos, pos + 250),
      file_path: currentRef.current,
    };
    const call = async (p, b, ms) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), ms || 3000);
      try {
        const r = await fetch("http://127.0.0.1:7890" + p, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(b), signal: ctl.signal,
        });
        clearTimeout(t);
        return await r.json();
      } catch (e) { clearTimeout(t); return null; }
    };
    const [comp, diag] = await Promise.all([
      call("/complete", body),
      call("/analyze", { file_path: currentRef.current }),
    ]);
    if (comp && comp.completions && comp.completions.length) {
      setSuggestions(comp.completions.slice(0, 8));
      suggestionsRef.current = comp.completions.slice(0, 8);
      const g = String(comp.completions[0].insert_text || "").split("\n")[0];
      ghostRef.current = g;
      Editor.setGhost(g);
      setStatus("ai: " + comp.completions.length + " suggestion(s)  ·  Tab to accept");
    } else {
      setSuggestions([]); ghostRef.current = ""; Editor.setGhost("");
    }
    if (diag && diag.diagnostics) {
      setAiDiag(diag.diagnostics.map((d) => ({ ...d, source: "companion" })));
    }
  }


  // ---- palette items
  const paletteItems = useMemo(() => {
    const cmds = [
      { name: "New file", hint: "Ctrl+N", run: () => beginCreate("file") },
      { name: "New folder", hint: "create", run: () => beginCreate("folder") },
      { name: "Open file", hint: "anywhere on disk", run: () => { setBrowserMode("file"); setBrowserOpen(true); } },
      { name: "Open folder", hint: "workspace", run: () => { setBrowserMode("folder"); setBrowserOpen(true); } },
      { name: "Go to definition", hint: "F12", run: () => gotoDefinition() },
      { name: "Find in project", hint: "Ctrl+Shift+F", run: () => openProjectSearch() },
      { name: "Find references", hint: "Alt+F7", run: () => findRefs() },
      { name: "Search project contents", hint: "the whole text, not just names",
        run: () => { openProjectSearch(); setRefWhole(false); } },
      { name: "Check", hint: "Ctrl+Shift+B", run: () => act("check") },
      { name: "Check the whole project", hint: "every module", run: () => checkProject() },
      { name: "Toggle comment", hint: "Ctrl+/", run: () => Editor.toggleComment(langRef.current.comment) },
      { name: "Indent selection", hint: "Tab", run: () => Editor.indentSelection(1, langRef.current.indent) },
      { name: "Outdent selection", hint: "Shift+Tab", run: () => Editor.indentSelection(-1, langRef.current.indent) },
      { name: "Build", hint: "Ctrl+B", run: () => act("build") },
      { name: "Run", hint: "Ctrl+Enter", run: () => act("run") },
      { name: "Lint", hint: "command", run: () => act("lint") },
      { name: "Audit capabilities", hint: "command", run: () => act("audit") },
      { name: "Save", hint: "Ctrl+S", run: () => save() },
      { name: "Problems", hint: "panel", run: () => setTab("prob") },
      { name: "Structure", hint: "panel", run: () => setTab("struct") },
      { name: "Project", hint: "panel", run: () => setTab("proj") },
      { name: "Scan struct layout", hint: "panel", run: () => { setTab("lay"); scanLayout("."); } },
      // Not offered in the core build: there is no companion to start, and a
      // palette entry that does nothing is worse than one that is absent.
      ...(CORE ? [] : [{ name: "Start the companion", hint: "optional", run: () => startAI(false) }]),
      { name: "Toggle reading mode", hint: "command", run: () => setMode(mode === "programming" ? "reading" : "programming") },
      { name: zen ? "Leave Zen mode" : "Zen mode, just the code", hint: "Ctrl+Shift+Z", run: () => toggleZen() },
      { name: "Reset zoom", hint: "Ctrl+0", run: () => setSettings((s) => { const n = { ...s, fontSize: 13.5 }; applySettings(n); return n; }) },
    ];
    return cmds.concat(files.map((f) => ({ name: f, hint: "file", run: () => openFile(f) })));
  }, [files, mode]);

  // ---- project summary, for the panel that has to work without AI
  const project = useMemo(() => {
    if (!files.length && !dirs.length) return null;
    const counts = {};
    for (const f of files) {
      const base = f.split(/[\\/]/).pop() || "";
      const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "(none)";
      counts[ext] = (counts[ext] || 0) + 1;
    }
    const langs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const name = (root && root !== "." ? root : "").split(/[\\/]/).filter(Boolean).pop() || "workspace";
    return { root, name, files: files.length, dirs: dirs.length, langs };
  }, [files, dirs, root]);

  // ---- column resizing
  //
  // Pointer events with a captured element rather than mousemove on the window:
  // dragging a divider that you then move the pointer off is the classic way a
  // resize handle sticks, and `setPointerCapture` is the fix.
  const startResize = (which) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = which === "tree" ? treeW : panelW;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragRef.current = which;
    const move = (ev) => {
      const delta = which === "tree" ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.max(150, Math.min(560, startW + delta));
      if (which === "tree") setTreeW(next); else setPanelW(next);
    };
    const up = () => {
      dragRef.current = null;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("datara.studio.treeW", String(treeW));
        localStorage.setItem("datara.studio.panelW", String(panelW));
      } catch (err) {}
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  // Column widths are plain px on flex children, so folding a side simply
  // removes its element instead of leaving a zero-width grid track behind.
  // ---- the declaration the caret is inside, for the breadcrumb
  //
  // The outline is already a sorted list of line numbers, so the enclosing
  // declaration is the last one at or above the cursor. No parsing, and it
  // answers the question a breadcrumb exists to answer: where am I?
  const enclosing = useMemo(() => {
    let best = null;
    for (const s of outline) if (s.line <= cursor.line) best = s;
    return best;
  }, [outline, cursor.line]);

  const readMode = mode === "reading";

  return html`<div class="shell">
    <${IntentBar} root=${root} wsName=${wsNameOf(files, root)} coreVersion=${coreVersion}
      aiOnline=${aiOnline} aiLabel=${aiLabel} running=${running} readMode=${readMode}
      treeFold=${treeFold} panelFold=${panelFold}
      onFoldTree=${() => setTreeFold((v) => !v)} onFoldPanel=${() => setPanelFold((v) => !v)}
      onToggleAI=${() => setAiEnabled(!settings.aiEnabled)}
      onAction=${act} onPalette=${() => setPalette(true)} onSave=${save}
      onSettings=${() => setSettingsOpen(true)}
      onOpenFolder=${() => { setBrowserMode("folder"); setBrowserOpen(true); }}
      onToggleMode=${() => setMode(readMode ? "programming" : "reading")}
      onZen=${toggleZen}
      gitBranch=${git.branch} gitDirty=${git.dirty} />

    <div class=${"body" + (readMode ? " reading" : "")
      + (zen && settings.zenWidth > 0 ? " zen-narrow" : "")
      + (zen && settings.zenSurround ? " zen-surround" : "")}
      style=${zen && settings.zenWidth > 0 ? { "--zen-w": settings.zenWidth + "px" } : null}>
      ${treeFold ? null : html`<${React.Fragment}>
        <div class="col tree-col" style=${{ width: treeW + "px" }}>          <${Tree} files=${files} dirs=${dirs} current=${current} filter=${filter} setFilter=${setFilter}
            onOpen=${openFile} dirty=${dirty} root=${root} error=${treeError} note=${treeNote}
            onPickFolder=${() => { setBrowserMode("folder"); setBrowserOpen(true); }}
            creating=${creating} createKey=${createKey} onCreate=${beginCreate} onCommit=${createItem}
            onDropInto=${dropInto} onRename=${beginRename} onDelete=${removeEntry}
            onCancelCreate=${() => { setCreating(null); setCreateKey(""); }} />
        </div>
        <div class="resize" onPointerDown=${startResize("tree")} title="Drag to resize"></div>
      <//>`}
      <div class="center">
        <div class="crumbs">
          ${current
            ? html`<b>${current.split(/[\\/]/).pop()}</b><span class="sep">›</span>
                   <span>${current}</span>
                   ${enclosing
                     ? html`<span class="sep">›</span>
                            <span class="enc">${enclosing.kind} ${enclosing.name}</span>`
                     : null}
                   <span class="sep">›</span>
                   <span>line ${cursor.line}</span>`
            : html`<span>no file open</span>`}
        </div>
        ${runError ? html`<div class="runerr">
            <span class="dot"></span>
            <b>${runError.action} did not start</b>
            <span class="msg">${runError.text}</span>
            <div class="spacer"></div>
            ${runError.count ? html`<button class="mini"
              onClick=${() => { setTab("prob"); }}>${runError.count} problem${runError.count === 1 ? "" : "s"}</button>` : null}
            <button class="mini" onClick=${() => setRunError(null)}>dismiss</button>
          </div>` : null}
        ${root || current
          ? html`<div class="surface" style=${{ position: "relative", flex: 1, minHeight: 0 }} ref=${surfaceRef}></div>`
          : html`<div class="welcome">
              <div class="wmark fico fico-app"></div>
              <h2>Datara Studio</h2>
              <p>A compiler-native editor for Datara. Start a project, open a folder,
                 or open a single file.</p>
              <div class="wactions">
                <button class="wbtn primary" onClick=${newProject}>
                  <span class="t">Create new project</span>
                  <span class="s">a folder with a compiling src/main.dtr</span>
                </button>
                <button class="wbtn" onClick=${() => { setBrowserMode("folder"); setBrowserOpen(true); }}>
                  <span class="t">Open folder</span>
                  <span class="s">work in an existing project</span>
                </button>
                <button class="wbtn" onClick=${() => { setBrowserMode("file"); setBrowserOpen(true); }}>
                  <span class="t">Open file</span>
                  <span class="s">just one file, no folder</span>
                </button>
              </div>
              ${recents.length ? html`<div class="wrecents">
                <div class="lbl">recent</div>
                ${recents.slice(0, 5).map((p) => html`<div class="wrecent" key=${p}
                  onClick=${() => openWorkspace(p)} title=${p}>
                  <${Ico} k="folder" size=${13} /><span class="mono">${p}</span>
                </div>`)}
              </div>` : null}
              <div class="whint">
                <span><b>Ctrl+P</b> open file</span>
                <span><b>Ctrl+N</b> new file</span>
                <span><b>Ctrl+S</b> save</span>
                <span><b>Ctrl+Enter</b> run</span>
              </div>
            </div>`}
        <div class=${"drawer" + (drawer.open ? " open" : "")}>
          <div class="dh"><b>${drawer.title}</b><div class="spacer"></div>
            <button class="mini" onClick=${() => setDrawer({ ...drawer, open: false })}>close</button></div>
          <pre class=${drawer.cls}>${drawer.text}</pre>
        </div>
      </div>
      ${panelFold ? null : html`<${React.Fragment}>
        <div class="resize left" onPointerDown=${startResize("panel")} title="Drag to resize"></div>
        <div class="col panel-col" style=${{ width: panelW + "px" }}>
          <${Panel} tab=${tab} setTab=${setTab}
            order=${settings.panelOrder} hidden=${settings.panelHidden}
            onReorder=${(next) => setSettings((s) => {
              const n = { ...s, panelOrder: next }; applySettings(n); return n;
            })}
            suggestions=${suggestions}
            diagnostics=${diagnostics} aiOnline=${aiOnline} aiLabel=${aiLabel} layout=${layout}
            layoutBusy=${layoutBusy} onScan=${scanLayout}
            genReq=${genReq} genRes=${genRes} genErr=${genErr} genBusy=${genBusy}
            genModel=${genModel} onGenReq=${setGenReq} onGenerate=${runGenerate}
            genWhere=${genWhere} genCtx=${genCtx}
            chatMsgs=${chatMsgs} chatReq=${chatReq} chatBusy=${chatBusy} chatErr=${chatErr}
            chatCtx=${chatCtx} chatClearing=${chatClearing}
            onChatReq=${setChatReq} onChatSend=${runChat} onChatClear=${clearChat}
            onChatUndo=${undooChat} onChatProject=${useProjectContext}
            fmtBytes=${fmtBytes}
            onInsert=${(t) => Editor.insert(t)} onGoto=${(n, c) => Editor.gotoLine(n, c)}
            outline=${outline} current=${current} onOpen=${openFile}
            project=${project} git=${git} refs=${refs} refWord=${refWord} refBusy=${refBusy}
            searchQ=${searchQ} onSearchQ=${setSearchQ} searchFocus=${searchFocus}
            refWhole=${refWhole} onRefWhole=${setRefWhole} onRunSearch=${runProjectSearch}
            refScroll=${refScroll}
            onStartAI=${() => startAI(false)} aiStarting=${aiStarting}
            projDiag=${projDiag} projBusy=${projBusy} projWhere=${projWhere}
            onCheckProject=${checkProject} onGotoProblem=${gotoProblem} />
        </div>
      <//>`}
      <${ZenBar} values=${settings} onExit=${leaveZen}
        onOpenProblems=${() => { setZen(false); setPanelFold(false); setTab("prob"); }}
        fileName=${current ? current.split(/[\\/]/).pop() : ""}
        cursor=${cursor} lang=${langRef.current ? langRef.current.name : ""}
        dirty=${dirty} counts=${diagCounts} running=${running} />
    </div>

    <div class=${"zenhint" + (zenHint ? " show" : "")}>Esc to leave Zen</div>

    <div class="status">
      <div class="stleft">
        <span class="mono">${current ? current.split(/[\\/]/).pop() : "no file"}</span>
        ${dirty ? html`<span>modified</span>` : null}
        ${treeError ? html`<span class="bad">${status}</span>` : html`<span>${status}</span>`}
      </div>
      <div class="stmid">
        ${git.branch ? html`<span class=${"gitmid" + (git.dirty ? " dirty" : "")}
          title=${(git.dirty
            ? git.dirty + " uncommitted change(s)"
            : "clean working tree") + " - click for the Project panel"}
          onClick=${() => setTab("proj")}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="4" cy="3.4" r="1.5"></circle><circle cx="12" cy="12.6" r="1.5"></circle><path d="M4 4.9v6.4a2 2 0 0 0 2 2h4.5"></path><path d="M12 11.1V4.6"></path></svg>
          <span>${git.branch}</span>${git.dirty ? html`<i>${git.dirty}</i>` : null}
        </span>` : null}
      </div>
      <div class="stright">
        ${diagnostics.length ? html`<span class=${"btn " + (compDiag.length ? "bad" : "")}
          onClick=${() => setTab("prob")}>${diagnostics.length} ${diagnostics.length === 1 ? "problem" : "problems"}</span>` : null}
        ${running ? html`<span class="live">running</span>` : null}
        <span class="mono">${cursor.line}:${cursor.col}</span>
        <span class="btn" onClick=${() => setDrawer({ ...drawer, open: !drawer.open })}>output</span>
      </div>
    </div>

    ${palette ? html`<${Palette} items=${paletteItems}
      onPick=${(it) => it.run()} onClose=${() => setPalette(false)} />` : null}
    ${browserOpen ? html`<${Browser} start=${root || recents[0] || ""} mode=${browserMode}
      purpose=${pendingProject ? "project" : "open"}
      onClose=${() => { setBrowserOpen(false); setPendingProject(false); }}
      onPickFile=${(p) => { setBrowserOpen(false); openFile(p); }}
      onOpen=${(p) => {
        setBrowserOpen(false);
        // One dialog, two jobs: opening a workspace means opening what was
        // picked, and choosing a project's home means creating inside it.
        if (pendingProject) { setPendingProject(false); createProjectIn(p); }
        else openWorkspace(p);
      }} />` : null}
    ${settingsOpen ? html`<${Settings} values=${settings} root=${root}
      aiOnline=${aiOnline} aiStarting=${aiStarting} onStartAI=${() => startAI(false)}
      onChange=${(v) => {
        // The companion switch in Settings is the same switch as the plug in the
        // bar, so it takes the same path - otherwise one of the two would start
        // the process and the other would only record an intention.
        if (v.aiEnabled !== undefined) { setAiEnabled(v.aiEnabled); return; }
        setSettings((s) => { const n = { ...s, ...v }; applySettings(n); return n; });
      }}
      onClose=${() => setSettingsOpen(false)}
      onRoot=${() => { setSettingsOpen(false); setBrowserOpen(true); }} />` : null}
    ${ask ? (ask.kind === "prompt"
      ? html`<${Prompt} title=${ask.title} body=${ask.body} ok=${ask.ok}
          value=${ask.value} select=${ask.select}
          onOk=${(v) => answerAsk(v)} onNo=${() => answerAsk(null)} />`
      : html`<${Confirm} title=${ask.title} body=${ask.body} ok=${ask.ok}
          danger=${ask.danger}
          onYes=${() => answerAsk(true)} onNo=${() => answerAsk(false)} />`) : null}
  </div>`;
}

// ------------------------------------------------------------------ not blank
//
// Whatever goes wrong, the window has to say so. Measured: choosing a file left
// the entire client area empty with nothing but the title bar - no message, no
// stack, nothing to act on. A React render that throws unmounts the whole tree,
// and what is left behind is indistinguishable from a page that never loaded.
//
// There are two ways to end up blank, so there are two guards. This one catches
// a throw inside React. The one in `ui/index.html` catches the other: the script
// blocks never running at all, which is what a truncated response or a failed
// wasm decode looks like.
class Crash extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null, where: "" };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    this.setState({ where: (info && info.componentStack) || "" });
    try { console.error("datara-studio stopped:", err, info); } catch (e) {}
  }
  render() {
    const e = this.state.err;
    if (!e) return this.props.children;
    const detail = [String((e && e.message) || e), String((e && e.stack) || "")]
      .filter(Boolean).join("\n\n");
    return html`<div class="crash">
      <div class="crashbox">
        <h2>The interface stopped</h2>
        <p>This is a defect in Datara Studio, not something you did. Everything it
           knows about it is below.</p>
        <pre>${detail}${this.state.where ? "\n\nwhere:" + this.state.where : ""}</pre>
        <div class="crashrow">
          <button class="mini" onClick=${() => location.reload()}>reload</button>
          <button class="mini" onClick=${() => {
            try { navigator.clipboard.writeText(detail + this.state.where); } catch (err) {}
          }}>copy the message</button>
        </div>
      </div>
    </div>`;
  }
}

/** Put a failure that did not unmount anything on screen.
 *
 * A throw inside a timer, a promise or an event handler leaves the tree standing
 * and produces no visible symptom at all - which is how a `ReferenceError` in a
 * `setTimeout` hid for a whole round while the feature it belonged to was simply
 * dead and nothing anywhere said why. These are dismissable, because most of
 * them are recoverable and a permanent banner would be its own annoyance.
 */
function reportFailure(what, detail) {
  if (typeof document === "undefined") return;
  const host = document.getElementById("faults");
  if (!host) return;
  const line = document.createElement("div");
  line.className = "fault";
  line.textContent = what + ": " + detail;
  line.title = "click to dismiss";
  line.onclick = () => line.remove();
  host.appendChild(line);
}

// `typeof window.addEventListener === "function"` rather than just
// `typeof window`: the structure tests load this file in `linkedom`, which has a
// `window` object with no event methods on it, so the shorter guard throws while
// the file is being loaded and takes every render test with it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", (e) => {
    reportFailure("error", (e && e.message) || "unknown");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    reportFailure("unhandled rejection", (r && r.message) || String(r));
  });
}

// Right-clicking anywhere the interface has not claimed shows the webview's own
// menu - "Назад / Обновить / Сохранить как / Печать / Другие инструменты" - which
// is a menu about a browser, drawn inside an editor. It appears over the editor's
// empty space, the panel, the chrome: everywhere except a text field, because
// only the tree rows ever claimed the event.
//
// So the default is off. The exception is a text surface, where the platform's
// cut/copy/paste menu is the only paste route a webview offers and taking it away
// would cost more than the menu costs.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    const textish = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (!textish) e.preventDefault();
  });
}

// Mount only when there is a real document. The guard exists so this file can
// also be loaded in Node by ui/test/render.test.mjs, which renders the component
// tree to static markup. A browser is not available in every environment, and
// "the interface was never rendered anywhere" is not an acceptable state.
if (typeof document !== "undefined" && document.getElementById("root")) {
  // The page's own "I did not start" notice, if it is still up. Reaching this
  // line means this script ran to completion, so the notice is now a lie.
  const boot = document.getElementById("bootfail");
  if (boot) boot.remove();
  ReactDOM.createRoot(document.getElementById("root")).render(
    html`<${Crash}><${App} /></${Crash}>`);
}

// Exposed for the render test.
if (typeof window !== "undefined") {
  window.__Studio = {
    App, Editor, Palette, Tree, TreeNode, Panel, IntentBar, CapControls, Mark, Browser, NewRow, Settings,
    coreHighlight, symbols, buildTree, resolveName, parseForgenDiagnostics, hoverInfo,
    stripAnsi, checkTarget, checkBody, checkNote, dirOf,
    fileIcon, completerFor, contextFunctionName, PROJECT_VERBS,
    KEYWORDS, SNIPPETS, TYPES, BUILTINS, DATARA_DOCS, FILE_KINDS,
    DATARA_LANG, PLAIN_LANG, PROVIDERS, providerFor,
  };
}
