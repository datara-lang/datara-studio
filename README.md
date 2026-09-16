# Datara Studio

A working IDE for Datara. Human-first, compiler-native, and small enough to read
in one sitting.

```
datara-studio/
  src/main.dtr        entry point, accept loop, routing
  src/http.dtr        HTTP/1.1 over raw sockets, request parsing, JSON escaping
  src/api.dtr         endpoints: tree, read, write, new, run, action, layout
  src/explorer.dtr    the filesystem browser, and the console-codepage fix
  ui/app.js           the interface
  src-tauri/          the desktop shell - Tauri is only the window
  PORTING.md          every compiler workaround and its removal plan
```

## Run it

The short way, on Windows:

```
start.cmd
```

That builds the single-file interface if it is missing, starts **two** servers
(on 7878 and 7879), starts the optional AI companion, opens the browser, and
watches - restarting the pair if neither port answers. Two servers is not
redundancy for its own sake: the Datara runtime cannot time out a socket, so one
idle connection can wedge a server permanently, and the interface falls back to
the second port. See `PORTING.md` SEAM-6.

The long way, which is also the way to see what the server is doing:

```bash
cd datara-studio
forgen run src/main.dtr
```

Then open <http://127.0.0.1:7878>.

**What runs, and where.**

| Port | What | Started by |
|---|---|---|
| 7878 | the server the browser opens first | `start.cmd`, or `forgen run src/main.dtr` |
| 7879 | the second server, for when 7878 is wedged | `start.cmd` |
| 7880, 7881 | a fresh pair, when a killed server left a bound-but-silent socket on the first two | `start.cmd`, only if neither 7878 nor 7879 answers |
| 7890 | the optional AI companion | `start.cmd`, if `../../python/forgen_ai/ide_daemon.py` exists |

The interface tries all four in order and remembers which one answered, so a
reload does not re-pay the failed attempts. Any of these can be moved:
`DATARA_STUDIO_PORT=7879 forgen run src/main.dtr`.

**Prerequisites.** `forgen` on PATH (`start.cmd` checks and tells you the install
directory if it is missing), and Node.js only if `ui/studio.html` has to be
rebuilt. Nothing else - the servers are native binaries and the interface is one
file with no subresources.

## The desktop build

`src-tauri/` is a Tauri 2 shell. It is a window and nothing else - no bundled
interface, no filesystem access, no commands of its own - because the point of
this IDE is that it can read the project and run the compiler, and a frozen asset
bundle could neither. The shell starts the servers, waits for a port to answer,
opens the window at it, and kills the children on exit.

The one thing the page asks the shell for is the window itself: minimise,
maximise and close. That is a single capability file
(`src-tauri/capabilities/default.json`) granting exactly those permissions and
nothing else.

**The title bar is the interface's, not Windows'.** The window is created
undecorated (`.decorations(false)`), and the interface draws the bar - the mark,
the open file's name, and three caption buttons in the app's own palette. Three
pieces have to agree, and missing each one breaks it differently:

| Piece | Missing it means |
| --- | --- |
| `.decorations(false)` in `src-tauri/src/main.rs` | two title bars |
| `capabilities/default.json` | a bar whose buttons the access-control list refuses |
| `ui/tauri-bridge.js` | no bar at all, and a window with no chrome |

The capability is not optional even though the server is on loopback: Tauri
treats every origin that is not its own as **remote**, and the studio page is
served by the Datara server at `http://127.0.0.1:7878`. Without the `remote.urls`
list the bar draws and its buttons silently do nothing, which reads as broken
buttons rather than a missing permission.

`tauri-bridge.js` is also what keeps the browser build honest: it creates
`window.__DS_SHELL__` only when `window.isTauri` is set, so in a browser the bar
is never drawn and `.shell` keeps its three rows. `drive.mjs` asserts both halves.

**Nothing needs to be running first.** The window starts its own servers, on the
first two of the four ports that are free, and probes them itself.

```bash
start-tauri.cmd                     # builds the shell if it is missing, then runs it
```

or by hand:

```bash
source scripts/msvc-env.sh          # MSVC's link.exe must precede Git-Bash's
cargo build --release --manifest-path src-tauri/Cargo.toml
src-tauri/target/release/datara-studio.exe
```

Requires Rust (`cargo` on PATH, or `%USERPROFILE%\.cargo\bin`) and the MSVC C++
toolset - `scripts/build-desktop.cmd` checks both and says which one is missing.

**The window opens immediately**, on a bundled splash, and does not wait for the
server. The splash polls all four ports and hands the window over the moment one
answers, and only admits failure after nine seconds. The first version waited up
to twenty seconds before creating any window at all, so a slow start looked like
nothing happening - and the wait was never buying anything, because the page can
do the waiting better than the shell can.

**No console windows.** `start.cmd` launches the servers through
`scripts/hidden.vbs` and the shell passes `CREATE_NO_WINDOW`, because a
GUI-subsystem process spawning a console application makes Windows create one -
so opening the IDE used to flash two black windows and leave them in the taskbar
for as long as it was open. There is no flag that means "minimised and invisible";
`/min` only minimises.

`scripts/build-icons.mjs` generates the icon set from the same geometry as
`ui/icon.svg`. It has no image-library dependency: the mark is a rounded square,
two strokes and a dot, so it is rasterised from signed distances and encoded as
PNG with `zlib`.

On Windows, `scripts/msvc-env.sh` must be sourced first for anything that
produces a native binary, because MSVC's `link.exe` has to precede Git-Bash's GNU
`link`. The JIT path (`forgen run`) needs no setup.

## What works today

| Area | Status |
|---|---|
| **Problems** | the compiler's own diagnostics, underlined at the exact column while you type, **with no AI at all**; the `= help:` line is kept |
| **Project problems** | `forgen check` over the whole project - every error in every module, grouped by file, click to jump to the line. Aimed at the project that governs the open file, because a check pointed above it reports every import as a missing package. 301 ms measured |
| **Typing aids** | auto-indent (plus one level after an opening brace), bracket and quote pairs, backspace inside an empty pair, `Ctrl+/` comment toggle, `Tab` / `Shift+Tab` indent and outdent a selection - each one switchable in settings |
| **Go to definition** | `F12` or Ctrl+click, across the whole workspace |
| **Hover help** | rests on a name and shows where it is declared, or what the builtin does - including the traps |
| **Completion** | this file's symbols, keywords, types and builtins, local and instant; the companion folds in when present |
| **Snippets** | accepting a declaration keyword writes the shape it is always followed by. `fn` Tab gives `fn name() -> Int {` ... `}` with the name **selected**, so typing replaces it, and the body indented to wherever you typed. 19 of them: `fn struct class entity record behavior trait impl enum type if while for match unsafe comptime defer use mod`. Keywords with no shape (`let`, `return`, `pub`, `true`) still insert as the plain word - a skeleton on `true` would be noise |
| **Ghost text** | `Tab` accepts; the suggestion appears at the caret before you finish typing |
| **Resizable panels** | drag the dividers, fold either side; widths are remembered |
| **Zoom** | `Ctrl+wheel` in the editor, `Ctrl+0` to reset; survives a reload |
| **Language providers** | the editor does not know what Datara is - see below |
| File tree | every file and folder, language icons, drag a file onto a folder to move it |
| Create | one `create` control, File or Folder, named inline **in the folder you are working in** |
| Dialogs | every question is drawn by the interface itself - delete, discarding unsaved changes, rename, Save As, naming a new project. There is no `window.confirm`, no `window.prompt` and no platform message box left anywhere, so nothing in the window looks like a different application |
| Status bar | three columns, not a row of loose text: the open file and the server's word on the left, the **git branch in the middle** (dirty count beside it, click for the Project panel), and problems, caret position and the output drawer on the right |
| Open file | any file on the machine, not only the ones in the workspace |
| Open folder | editable path box, drive row, new folder, failures that say what went wrong |
| Reopens where you left off | last file, last workspace, and the port that last answered |
| Editor | textarea over a highlighted layer, line numbers, dirty marker, semantic rail |
| Breadcrumb | shows the declaration the caret is inside, not just the path |
| Check / Build / Run / Lint / Audit | `forgen` invoked from the server, output in the output pane |
| Find references | `Alt+F7`, a real workspace search, or the search box |
| Layout inspector | the layout forgen will choose per struct, and every field-name conflict |
| Companion | optional, starts itself in the background, one dot in the chrome, toggle in settings |
| Degrades without AI | completely. Problems, Structure, Project and Layout all work offline |

Keyboard: `Ctrl+S` save, `Ctrl+N` new file, `Ctrl+B` build, `Ctrl+Shift+B` check
the open file, `Ctrl+Enter` run, `Ctrl+P` file palette, `Ctrl+,` settings, `F12`
or Ctrl+click go to definition, `Alt+F7` references, `Ctrl+/` comment toggle,
`Ctrl+wheel` zoom, `Ctrl+0` reset zoom. `Tab` resolves in one fixed order: it
accepts the open completion list first - and a declaration keyword there writes
its whole shape, not the word - then a ghost suggestion, and only then does it
indent (outdent with `Shift`, or indent every line of a selection). `Esc`
dismisses the list. `Ctrl+P` also offers **Check the whole project** -
`forgen check` over every module.

## The language provider seam

The editor must not know what Datara is. Everything language-specific sits behind
one object - `DATARA_LANG` in `ui/app.js` - which owns the keywords, the types,
the builtins, the hover documentation, symbol extraction, the indent string and
the **compiler check**.

There are two implementations. The second is `PLAIN_LANG`, which claims no
extensions and offers nothing: open a `.py` file and the editor still works
normally, but with no Datara keywords suggested, no Datara symbols in the
outline, and no compiler asked to check a file it cannot read.

That second provider is not decoration. **A boundary with one implementation is
an abstraction nobody has tested**, so the plain-text provider exists to prove
the seam is real - and 20 assertions hold it to that, including that a plain file
never calls the compiler at all.

Adding a language is one object. Adding one with a compiler is one object with a
real `check`. This is the first boundary the project found on its own rather than
designed up front, which is the order the roadmap asks for: extract the kernel,
do not design it.

The right panel is ordered **offline first** - Problems, Structure, Project,
Layout, then AI and Generate - because a person who never starts the companion
should still get a useful panel. See `docs/DATARA-ERGONOMICS.md` for the
measurements and for what is still missing.

## The AI companion

The IDE talks to `forgen_ai` (`D:\ryan`) directly over HTTP on port 7890. It is
**optional**: with it absent the status dot goes grey and everything else keeps
working. That is the design rule from the spec - no mandatory AI - enforced by
architecture rather than by policy.

Start it:

```bash
cd D:\ryan
python python/forgen_ai/ide_daemon.py --port 7890
```

Then the IDE picks it up within five seconds.

`PORTING.md` SEAM-4 explains the one change made in that project: the neural
stack is now imported lazily, so the daemon starts and serves completions without
`torch`. Only `/chat` needs the model.

## Architecture

Three languages, each doing what it is fastest at. The split is the design, not
an accident:

```
ui/app.js        React 18 + htm   the chrome: title bar, rail, tree, panels,
                                  status bar, command palette
ui/app.js        direct DOM       the text surface, mounted imperatively
crates/textcore  Rust -> wasm     the document, the line index, the lexer
src/*.dtr        Datara           files, the compiler, the layout inspector,
                                  and the server that serves all of the above
```

**Rust owns the text, and here is the measured reason.** On a 1 MB / 20k-line
document:

| operation | time |
|---|---|
| load the document | 4.1 ms |
| lex the whole document | 5.6 ms -> 260001 tokens |
| verify the line index against a rebuild | 4.4 ms |
| one edit in the middle | 0.091 ms |
| one edit at offset 0 (worst case) | 0.1 ms |

`node crates/textcore/test/test.mjs` reproduces those numbers, and it asserts the
incremental line index against a full rebuild after every edit - a fast path that
is never checked against the slow path is a bug waiting to happen. 40 assertions.

**React owns the chrome, and explicitly not the text.** Re-rendering a 20k-line
highlighted document through React on every keystroke is the single biggest
performance mistake an editor can make. So the text surface is mounted once into
a div React renders and then never touches, and updated imperatively. The rule:
React renders things a person clicks.

**No `wasm-bindgen`.** The ABI is flat C over linear memory: write UTF-8 into a
scratch buffer from `alloc`, call with `(ptr, len)`, read results as a
`Uint32Array` view over `lex_ptr()`. That keeps the module at 39 KB, removes a
toolchain dependency, and makes the number of boundary crossings explicit -
which matters, because that is where wasm speed is lost.

**The AI is a separate process** (port 7890) and the browser calls it directly.
The Datara server never proxies it, so an AI failure cannot take the editor down.

**Everything that touches the project** goes through the Datara server, which is
the only component holding a capability grant.

## Build and verify

```bash
bash scripts/build.sh
```

Nine stages, **346 assertions**, all green:

| stage | assertions | what it proves |
|---|---|---|
| wasm build | - | the module compiles and embeds |
| single-file interface + icons | - | the Tauri icon set is generated from `assets/datara.ico`, and React, htm, app.js and the wasm core inline into one `ui/studio.html` with zero subresources, with the icon inlined as a data URI. **Fails the build** if the mark beside a `.dtr` file is backed by an icon under 32 px - see the icon note below |
| Rust text core | 40 | the incremental line index matches a full rebuild after every edit |
| highlighting pipeline | 40 | the token-to-line split is lossless on empty input, trailing newlines, unterminated strings, Cyrillic and emoji, **and every comment token starts with `//` and stops at its own line** - which is what caught the byte-offset bug |
| interface renders | 192 | the component tree renders without throwing, every piece of chrome is present, the create name rule holds, an empty folder survives into the tree, the compiler's real coloured output parses into line, column and span, and a project check is aimed inside the workspace |
| the editor, driven as the app drives it | 74 | text, highlight layer, gutter, every editor layer and textarea height agree, and every editing aid leaves the text, the highlight layer and the caret agreeing. 19 of these drive the snippet table: that each keyword expands to a body that parses, that the placeholder is selected, that the caret lands inside it - the `unsafe` one inside the quotes - and that an indented keyword indents its body to match |
| boot the built artifact | - | the shipped `ui/studio.html` mounts in a DOM, shows the title screen, and defers the editor until a file is open |
| Datara server | - | `forgen check` reports 100% OK |

Then:

```bash
forgen run src/main.dtr     # open http://127.0.0.1:7878
```

**What is verified and what is not.** The text core is verified by execution:
the numbers in the table above are measured, not estimated. The interface is
verified by *structure* in `build.sh`, and separately **by pixels and by
gestures**:

```bash
node ui/test/shoot.mjs http://127.0.0.1:7878 shots        # real Chromium, writes PNGs
node ui/test/drive.mjs http://127.0.0.1:7878 shots/drive  # real gestures, then reads the bytes off disk
```

Neither is part of `build.sh`, because both need a running server and a
Playwright install. `shoot.mjs` drives the real page in a real engine at a real
viewport; `drive.mjs` right-clicks the tree, saves with Ctrl+S and presses Run,
and then reads the result off the filesystem instead of trusting the screen. It
currently makes **66** such checks, and because it walks every panel tab and
drives every dialog, it is the only thing here that would notice a control that
kills the window when you use it. It is also the only thing that types `fn` into
a real browser and presses `Tab` - the structure suite can prove the table is
right, but only a real key event proves the key is wired to it.

### The icon is measured, not assumed

The mark beside a `.dtr` file and in the title bar is drawn at 13-16 px **CSS**,
which is not 13-16 device px: a 16 px box is 20 device px at 125% display
scaling, 24 at 150%, 32 at 200%, and the browser upsamples whatever source it has
to fill it. Backing that with the ICO's own 16 px entry - the obvious choice -
meant a 3x upsample on a 200% display. Measured, focus = variance of Laplacian /
variance of luma, the mark drawn at 16 px CSS:

| display scaling | 16 px entry | 32 px entry |
|---|---|---|
| 100% | 6.57 | **9.59** |
| 125% | 1.51 | **12.46** |
| 150% | 1.02 | 9.50 |
| 200% | 0.34 | 8.01 |

The 16 px entry is the worst of the seven entries at *every* scaling, and it is
not even best at 100%, so "the only size at which this artwork is crisp" - which
is what the stylesheet claimed - was simply wrong. The 32 px entry covers 16 px
CSS exactly up to 200% and won on the sum, so that is what backs it now, and
`build-ui.mjs` refuses to build if that ever drops below 32.

The 128 px entry the title screen uses was checked the same way, and it is
**genuine**: it differs from a proper 256 -> 128 resample by a mean of 1.77 of
255 per channel, against 7.62 for a 64 -> 128 upscale. It is not a fake upscale,
which is what it looks like when magnified 4x.

`drive.mjs` also covers the desktop shell's title bar without needing the shell
binary: it stubs what Tauri injects before any page script runs, and then asserts
that the real `ui/tauri-bridge.js` picks it up, that the bar appears with three
controls, and that each control reaches the window plugin with the window label
the shell actually created. The converse is asserted too, because it is the
property easiest to lose silently - **a browser must draw no title bar at all**.

That pair is how the worst defects in this studio were found, and none of them
was visible to a structure test:

* **Opening the Project tab destroyed the interface.** `Panel`'s `proj()` read
  `git.branch`, `git.files` and `git.log` - and `git` is state that lives in
  `App`'s scope, which `Panel` was never given. The tab threw
  `ReferenceError: git is not defined`, the error boundary caught it, and the
  whole window was replaced by "The interface stopped". It had been that way for
  as long as the panel has existed, and every other check in this file passed
  while it was true, because nothing ever clicked a tab. Found by clicking one,
  and now asserted tab by tab.
* **A `.wbtn` of the same name squashed the title screen.** The title bar's
  caption buttons were `.wbtn`, which the title screen already used for its three
  ways in. Both rules are one class deep, so the one declared earlier in the
  stylesheet won every property the later one did not also set - and the caption's
  `width:46px` landed on "Create new project", wrapping it into a column of single
  words. No assertion noticed; the screenshot did. The classes are now `.capbtn`,
  and `drive.mjs` measures the three cards' width so the next one is caught by the
  suite rather than by eye.

* **The editor was never mounted on a cold boot** - the mount effect ran once,
  before there was a surface to mount into, and never retried, so the code area
  was empty while the breadcrumb and the status bar both reported the file as
  open.
* **The title screen could never appear**, because the workspace defaulted to the
  server's own directory, which is truthy, so the "create a project / open a
  folder" screen was unreachable code.
* **The companion never suggested anything.** `Editor.onInput` is installed by
  the mount effect, so the `runAI` it closed over was built before the first
  `/health` answer and had `aiOnline` frozen at `false` for the life of the page.
  The indicator still read "companion: on", because it renders from state rather
  than from the closure - so reading the code did not find it. Proved by running
  identical keystrokes with the surface mounted before and after the health poll:
  two `/complete` requests and ghost text in one ordering, nothing in the other.
* **The squiggles described the last save.** `/api/check` is aimed at a path and
  the compiler reads that path, so a check issued with a dirty buffer reported
  the file as it was before you typed; with autosave on, nothing re-checked after
  the write, so an error you had just typed appeared only after the next
  keystroke. `runCheck` now writes the buffer first.
* **A new project was created inside the IDE's own source tree.** `Create new
  project` asked for a name and never for a location, so with no workspace open
  the name became a path relative to the *server's* working directory - measured
  on a cold launch, `demo-project` landed in `datara-studio/`. Two things had to
  be true at once and both were: the folder dialog opened on the server's own
  directory, and the 8 s tree poll ran with no workspace, took the `root: "."`
  the server answers such a request with, and overwrote the folder the reader had
  just typed. Both are checked on disk now, because a project in the wrong place
  looks exactly like a project in the right place.

A screenshot alone would not have caught any of them; a screenshot plus a
filesystem check did.

`linkedom` is a **development** dependency of the structure tests, installed with
`npm install` in this directory. The studio ships no runtime npm packages: the
interface is one generated HTML file with React, htm and the wasm core inlined.

## Endpoints

All POST, plain-text bodies, JSON responses.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /` | - | the interface |
| `GET /api/health` | - | service info |
| `POST /api/tree` | root path | `{root, files:[...], dirs:[...]}` recursive, with the resolved absolute root |
| `POST /api/read` | path | `{content, bytes}` |
| `POST /api/write` | `path` newline `content` | `{bytes}` |
| `POST /api/new` | `path` newline `content` | creates the file, making its folder first |
| `POST /api/mkdir` | path | creates a directory, parents included |
| `POST /api/move` | `from` newline `to` | moves or renames, creating the destination folder |
| `POST /api/delete` | `kind` newline `path` | deletes a file, or a folder and everything in it |
| `POST /api/list` | path | one level: `dirs`, `files`, plus `parent` and `roots` |
| `POST /api/check` | path | the compiler's own output for that file |
| `POST /api/find` | `root` newline `query` | content search: `{file, line, text}[]` |
| `POST /api/git` | workspace root | `{branch, dirty, files:[{status,path}], log:[{shorthand,subject}]}` |
| `POST /api/ai/start` | companion dir | starts the optional companion, detached and minimised |
| `POST /api/run` | a whitelisted command | `{status, output}` |
| `POST /api/action` | `action` newline `target` | `{status, output}` |
| `POST /api/layout` | workspace root | `{structs, collisions}` |

`/api/run` accepts only `forgen`, `git`, `python` and `bash` prefixes. An HTTP
endpoint that runs arbitrary commands is a backdoor even on loopback.

**`/api/check` is the important one.** The red underlines come from `forgen`
itself, parsed into line/column/span, so they appear while you type and do not
need the companion to be running. The diagnostics panel used to be fed only by
the AI's linter, which meant that with the AI off the editor looked like it was
paying no attention - while the compiler, which already had the answer, sat
unused.

Creation endpoints report failure by **checking the result**, not by reading the
shell's message: `st_mkdir` enters the folder afterwards and `st_new_file` asks
the runtime whether the file is there. Matching the English "already exists"
would still have missed the localised wording, and on this machine it did - the
first version turned the shell's Russian error text into a folder entry named
after the error.

## The layout inspector

The Layout tab reimplements forgen's layout optimizer (`layout.rs`) in Datara and
shows what it will decide, because the compiler reports none of it:

* **field order** - descending type rank (Float4/Int4=16, Int/Float/Str/ptr=8,
  Int32=4, Int16=2, Bool/Byte=1), alphabetical on ties, offsets as `index * 8`;
* **alignment and size** - 64 bytes at 8+ fields, 32 at 4+, else 16;
* **the SoA rule** - a struct whose name merely *contains* `soa` or `layout`, or
  that has 4+ fields, is flagged as columnar.

Then it cross-references every struct and reports each field name that two
structs place at **different offsets**. That is the condition that silently
corrupts one of them, and the reason the kernel's struct fields carry a prefix.

Verified against the two probe projects that reproduce the defect:

```
probes/fieldnames_shared   3 structs, 6 conflicts
    scope_id       SA 40   SB 16   SC 16     <- different offsets, one field name
    deferred_mode  SA 48   SB 24   SC 24
    cancelled      SA 56   SB 32   SC 32
    delivery_count SA 64            SC 40

probes/fieldnames_unique   3 structs, 0 conflicts
```

The field ordering it produces matches the compiler's own choices, which is how
the reimplementation was checked: it is not a guess, it is the same algorithm.

This is the tool that would have turned a day of bisecting probes into a
five-minute look. It is also the first Datara-specific surface in the IDE - the
kind of thing no general-purpose editor can offer, because the information exists
only inside forgen.

## Honest limitations

1. **Build status is authoritative again.** `system()` returns the process's real
   exit code on 1.4.0, so `/api/run` reports `exit` and derives `status` from the
   number rather than from the text - `status_source` is no longer `inferred`.
   SEAM-3 is retired; see `PORTING.md`. The output is still captured to a file
   rather than a pipe, because that is one process launch instead of two.
2. **No document model on the server.** The browser holds the text and sends it
   on save; the server re-reads files. There is no revision tracking, no undo
   across sessions, no stale-result suppression yet - the kernel's `Freshness`
   and `Generation` counters are not wired in. That is the next real step.
3. **The server holds no state and no structs.** Deliberate: it keeps every
   string raw and converts only at the JSON boundary, which is what makes the
   codepage handling tractable; see `PORTING.md` finding 1.
4. **Single-threaded.** A slow `forgen build` blocks the IDE's own file reads
   for its duration. Suggestions are unaffected because the AI is a separate
   process. This is why `/api/health` must never spawn a process - it used to,
   and it made the cheapest endpoint in the server the slowest one.
5. **There is no terminal.** `/api/run` will execute a whitelisted command
   (`forgen`, `git`, `python`, `bash`) and return its real output and real exit
   code, but **nothing in the interface types into it** - the UI only calls
   `/api/action`, which runs a fixed `forgen` action. The `output` drawer is the
   closest thing that exists. An interactive console is unbuilt, not hidden.
6. **The file tree is native now.** `dir_list` replaced the two shell listings,
   so `/api/tree` is **26 ms** on this workspace (was 487 ms). The walk is
   breadth-first with a budget, because a depth-first walk spends the whole
   budget inside the first folder it meets - on `D:/` that showed 5998 files and
   **2 folders** instead of 157. **A drive root is still listed one level deep
   on purpose** (`shallow: true` in the response): a recursive listing of `D:/`
   grew the server to 3.9 GB and stopped it answering, which is how a workspace
   saved as `D:/` became unreadable.
7. **Non-ASCII paths work, except for creating one.** `dir_list` returns cp1251
   and the server keeps entry names raw on the inside, so a Cyrillic folder now
   lists, opens, reads and writes correctly. `st_fs_path` resolves a path from
   the browser by *finding* each segment in its parent's listing rather than
   reconstructing it, because a Datara string cannot be built from byte values -
   which is also why a **new** folder or file whose name is not ASCII is refused
   with a reason instead of silently creating a misnamed one. See `PORTING.md`
   finding 1.
8. **Syntax highlighting is a single-pass line tokenizer.** It does not
   understand multi-line strings or nested block comments, and it is not the
   semantic highlighting the spec asks for. Real semantic regions need the
   Datara provider, which does not exist yet.
9. **Reading mode is a layout change, not a different mode.** The spec's Reading
   Mode wants call graphs, dependency views and ownership surfaces. Today it
   widens the viewport and hides the tree.
10. **The layout inspector is a text scan, not a parser.** It reads multi-line
   declaration bodies only, so a single-line `pub struct X { a: Int }` is
   skipped, and generics are taken as text. It recognises all four declaration
   keywords (`struct`, `class`, `entity`, `record`), which it did not before - it
   matched `struct` alone, so a project using `class` reported zero structs. It
   mirrors forgen's optimizer rather than calling it, so if the optimizer changes
   the mirror has to be updated; that file is the thing to fix, and it says so at
   the top. Its field sort compares bytes as integers rather than using `Str`
   `<`, because `Str` comparison is not deterministic on 1.4.0 (finding 13 in
   `ryan-harness/docs/COMPILER-NOTES.md`).
11. **Deleting is permanent, and an ASCII-only operation.** Delete and rename
    both work in the explorer now, but delete shells out - forgen 1.4.0 has no
    file-delete builtin - so a name that is not ASCII cannot be spelled for the
    shell and is refused, with the reason, rather than silently deleting the
    wrong thing. There is no trash and no undo: the confirmation is the only
    thing between a mis-click and the loss, which is why it says so in as many
    words and why the destructive button is the one that has to be aimed at.

## Next, in order

1. **An in-process check.** `/api/check` costs 299 ms and forgen reports **0 ms**
   of compile time for one file and for 2828 alike - all of it is process start.
   Reusing the compiler as a library removes nearly the whole number, and it is
   the single largest latency win left in the IDE.
2. **An interactive console.** `/api/run` already runs a whitelisted command and
   returns the real exit code; what is missing is the input line, the history and
   the streaming. Roughly a day, and it is the one thing people expect an IDE to
   have that this one does not.
3. A real document model on the server: open buffers, revisions, `Freshness`
   wired in, so a slow analysis can never overwrite a newer edit.
4. A Datara provider: reuse forgen's own lexer and symbol table instead of the
   regex highlighter. This is the step that makes the IDE *compiler-native*
   rather than a text editor with a colour scheme.
5. Semantic lenses: types, ownership, effects, capabilities, and the struct
   layout inspector - the panel that would have turned the layout bug into a
   five-minute diagnosis instead of a day.

## Licence

**MIT OR Apache-2.0**, at your option. Both texts are in the repository:
`LICENSE-MIT` and `LICENSE-APACHE`.

```
SPDX-License-Identifier: MIT OR Apache-2.0
```

The dual form is the Rust convention, and this project is a Rust, wasm and
Datara stack, so it is what contributors and downstream packagers already expect
to find. The two licences are not redundant: MIT is the shortest thing to read
and the easiest to satisfy, while Apache-2.0 adds an explicit patent grant, a
trademark clause and a termination condition. Offering the choice lets a user
pick whichever fits their own legal constraints, and for a project that is not
trying to sell anything, that is the point - the licence should never be the
reason someone does not use it.

**Why not copyleft.** GPL and AGPL exist to force commercial users to share
their changes. With no revenue to protect, that buys little here, while its cost
is real: it would block anyone from embedding this interface in a proprietary
tool, and it would make the project's own future relicensing impossible without
the agreement of every contributor who had ever sent a patch. AGPL is aimed at
network services in any case, and a desktop IDE is not one.

**Why not public domain.** A dedication like Unlicense carries no patent grant
and is on uncertain ground in some jurisdictions. For a compiler toolchain,
where the patent grant is the clause most likely to matter one day, that is the
wrong trade.

**The one alternative worth naming** is MPL-2.0, which is file-level copyleft:
changes to files that are already MPL must be published, but MPL code can be
combined with proprietary code freely. If the intent ever changes to
"improvements to this must come back", MPL-2.0 is the switch to make, and it is
the least restrictive copyleft available.

**Contributions.** There is no CLA. Contributions come in under the same dual
licence they were received under, which is the norm for MIT/Apache-2.0 projects
and keeps the barrier to a first patch at zero.

Third-party components that ship inside the built interface are listed, with
their licences and copyright holders, in `THIRD-PARTY-NOTICES.md`.

