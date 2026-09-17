# PORTING.md - the seams

Everything in Datara Studio that exists **because of a forgen 1.3.0 limitation**
rather than because of a design decision. Each seam is confined to one place, is
labelled `SEAM-n` in the source, and lists the exact change to make once the
compiler is fixed.

The point of this file: when we rewrite on the fixed language, we should be able
to grep `SEAM-` and know precisely what to delete. Nothing else in the project
should need to change.

---

## Status on 1.4.0 — measured, not assumed

The compiler was updated to 1.4.0 and every seam was re-tested against the
installed binary. Three of them are gone or smaller; the rest are live. The
sections below still describe the 1.3.0 world, so read them with this table.

Confirmed against 1.4.1 (the installed `forgen --version` reports 1.4.1 while
`Cargo.toml` in the compiler's own tree said 1.4.0 - the seams below behave
identically under both, and `forgen check src/main.dtr` is 100% clean on it).

| Seam | 1.4.0 | Evidence |
|------|-------|----------|
| SEAM-1 element access | **retired** | `parts[0]` returns the string; an out-of-range *runtime* index returns `""` instead of reading past the end. `st_at` is deleted. |
| SEAM-2 capability calls | **live** | A bare `file_read` is still `E0940`; `unsafe(justification:)` is still required. |
| SEAM-3 exit status | **retired** | `system()` and `process_run()` return the real code (measured 7 and 3 from deliberate exits). `st_run` captures output to a file and reads back `exit`. |
| SEAM-4 companion import | **live** | Not a compiler limitation, so 1.4.0 does not touch it. |
| SEAM-5 binary reads | **shrunk** | `file_read_bytes` exists, so a binary file is now *detected* rather than looking empty. `file_read` still returns zero bytes on invalid UTF-8. |
| SEAM-6 stuck socket | **live** | `socket_recv` has no timeout and no non-blocking mode; a silent connection still blocks the accept loop. |
| SEAM-7 console codepage | **shrunk and renamed** | The listing no longer shells out: `dir_list`, `path_exists`, `file_exists`, `file_read`, `file_write` are native. `st_from_oem` survives for shell *output* only. A new defect replaced the old one - see below. |
| SEAM-8 colourised diagnostics | **live** | `forgen check` still emits ANSI into a pipe and ignores `NO_COLOR` (`src/diagnostics/engine.rs:94-98` hardcodes `true`). `st_strip_ansi` survives. |

### What 1.4.0 added to the list

Two new defects, both found by using the IDE rather than by reading a changelog.
Neither has a `SEAM-n` label because neither has a workaround that can be deleted
later - both are handled structurally.

1. **`dir_list` returns cp1251, not UTF-8.** The runtime calls `FindFirstFileA`
   (`src/runtime/datara_runtime.c:2623`), so a folder named `тест папка 123`
   arrives as raw cp1251 bytes. `path_exists` and `file_exists` expect cp1251
   back, so the filesystem builtins are ANSI in *both* directions, while shell
   output is OEM (cp866). Measured: the same path spelled in UTF-8 answers
   `false`, and spelled in the bytes `dir_list` returned answers `true`. The
   consequence was that a Cyrillic folder was listed as a *file* and could not be
   opened.

   Handled by keeping entry names **raw** on the inside of `src/explorer.dtr` and
   converting only what reaches JSON. `st_fs_path` turns a path from the browser
   back into the form the filesystem accepts, by *finding* each segment in its
   parent's listing rather than reconstructing it - because a Datara string
   cannot be built from byte values, so a name the filesystem has never seen
   cannot be spelled for it. A path that is being *created* therefore works while
   it stays ASCII and is refused with a reason when it does not.

2. **`Str` comparison is not deterministic.** `<` and `>` on `Str` return
   different answers for the same operands on different runs of the same binary.
   A six-request loop against one unchanged file returned six different field
   orders. See finding 13 in `docs/COMPILER-NOTES.md` and the
   reproduction under `probes/str_compare_order/`. Worked around by
   comparing bytes as integers (`st_name_before` in `src/layout.dtr`).

Also still missing from the installed binary while present in the source:
`StrBuf` is codegen-registered but absent from the resolver
(`undefined symbol 'strbuf_new'`), and `exec_utf8` is registered at
`src/resolver/mod.rs:257` but still resolves as undefined.

### Not a seam, but fixed on the same pass: `/api/health` was the slowest route

Measured before the fix, one process, unchanged source:

| route | time | what it does |
|-------|------|--------------|
| `/api/health` | **245-305 ms** | returns a four-field JSON object |
| `/api/tree` | 5.5 ms | walks the filesystem |
| `/api/layout` | 6.0 ms | scans sources, builds JSON |
| `/` | 2.1 ms | serves the whole 354 KB interface |

The cheapest handler was 120x slower than the most expensive one. Cause:
`st_health()` called `st_toolchain()`, which ran `exec("forgen --version")` - and
that process launch costs **225-270 ms** on its own, more than everything else in
the server combined. `start.cmd`'s watchdog asks for `/api/health` every four
seconds on up to four ports, so the single-threaded accept loop spent most of its
idle time waiting on a process that always returns the same string.

The comment that justified it ("read once per health request rather than cached,
because the toolchain must not be stale") was reasonable and wrong: the running
server *is* a product of the toolchain it reports, and that binary cannot change
while the process lives. A toolchain upgrade restarts the server.

Fixed by reading it once in `main()` and threading it through as
`st_health(tc)`. **1.8-2.1 ms after the change, about 140x faster**, with the same
JSON body and the same toolchain string.

Worth keeping as a rule: `exec` costs a quarter of a second on this platform, so
it must never sit on a request path. It is also why an in-process `forgen check`
would remove most of `/api/check`'s 299 ms - the same 225 ms is process start, and
forgen reports **0 ms** of actual compile time for one file and for 2828 alike.

---

## SEAM-1 - `List<Str>` element access must go through a function

**Where:** `src/http.dtr`, `st_at`, and every call site.

**Symptom.** Indexing a *local* `List<Str>` returns a pointer, not the string:

```datara
fn elem(view xs: List<Str>, i: Int) -> Str => xs[i]

fn main() {
    let parts = str_split("a=b=c", "=")
    println(parts[0])        // 2092347375680      <- pointer garbage
    println(elem(parts, 0))  // a                  <- correct
}
```

`parts.len()` is correct (3). Only the element read is wrong, and only when the
list is a local rather than a parameter. It reproduces with no structs in the
file, so it is independent of the field-name defect.

**Cost.** Every element read in the server goes through `st_at`, which adds a
function call and an explicit bounds check. Measurable in a hot loop; irrelevant
here, because HTTP request handling is not hot.

**Fix once the compiler is fixed.** Delete `st_at`, replace `st_at(xs, i)` with
`xs[i]` throughout, delete this section.

**Repro to keep as a regression test:** the four lines above.

---

## SEAM-2 - `unsafe(justification: "...")` around every capability call

**Where:** `src/api.dtr` and `src/main.dtr`, wrapping `exec`, `file_read`,
`file_write`, `file_exists`, `socket_*`.

**Symptom.** Without the wrapper the type checker rejects the call:

```
error[E0940]: Security Violation: Operation 'exec' requires 'Capability<ProcessExec>'
```

The capability lattice is real and enforced, but there is no way for a program
to *declare* that it holds a capability. `unsafe(justification: ...)` is the only
escape hatch, so a legitimate IDE backend has to wrap every I/O call and write a
human sentence each time.

**Why it is a seam and not a complaint.** The check is correct and worth having.
The missing piece is a manifest: `datara.toml` should be able to say

```toml
[capabilities]
allow = ["FileRead", "FileWrite", "ProcessExec", "NetworkListen"]
```

and then the module body needs no `unsafe` at all, because the grant is declared
once and auditable in one place. That is also strictly *better* for security
than N inline justifications: one list to review instead of N sentences to skim.

**Cost.** Noise. `unsafe` blocks flatten scoping, so a few locals had to be
hoisted out of them, and every block carries a sentence that will rot.

**Fix once the manifest lands.** Add `[capabilities]` to `datara.toml`, delete
every `unsafe(...) { }` wrapper, keep the bodies. Delete this section.

---

## SEAM-3 - child exit status is inferred from output text

**Where:** `src/api.dtr`, `st_run`.

**Symptom.** `system(cmd) -> Int` returns the exit code but discards output.
`exec(cmd) -> Str` returns output but discards the code. There is no call that
gives both, and running the command twice is not acceptable for `forgen run`.

So `st_run` reports:

```json
{ "status": "ok", "status_source": "inferred" }
```

where `status` is derived by searching the output for `error[`, `error:` and
`failed`. The `status_source` field exists so the UI can label it honestly
rather than passing an inference off as a fact.

**Why this matters more than it looks.** An IDE must not claim the build passed
when it did not. The current behaviour can be wrong in both directions: a
program that prints the word "failed" is reported as failed, and a command that
fails silently with no matching text is reported as ok. It is a real correctness
hole, contained by making it visible.

**Fix once the compiler is fixed.** Add something like
`process_capture(cmd) -> Outcome<ProcessResult>` with `code` and `output`, then
`st_run` returns the real code and `status_source` becomes `"exit_code"`. Delete
this section.

---

## SEAM-4 - the AI companion imports its neural stack lazily

**Where:** `D:\ryan\python\forgen_ai\ide_daemon.py` (the other project, not this
one).

**Symptom.** `ide_daemon.py` imported `model.py` and `inference.py` at module
scope. Both `import torch`. With torch absent the daemon refused to start at all,
so the IDE could not get completions - even though every IDE-facing endpoint
(`/complete`, `/analyze`, `/fix`, `/doctor`, `/sparks`) is pure Python: a static
trigger table plus a scan of the project's `.dtr` files. Only `/chat` touches the
model.

**Change made.** Moved the `tokenizer` / `model` / `inference` imports inside
`get_engine()`, and made `/chat` return `503` with a hint instead of crashing
when torch is missing.

**Fix once the neural stack is a hard dependency.** Restore the top-level
imports and delete this section. Until then this is the change that lets the IDE
and the companion talk at all, and it is worth keeping regardless: a daemon whose
whole purpose is to serve an editor should not require a 2 GB ML runtime to
answer a keyword completion.

---

## SEAM-5 - `file_read` returns zero bytes on binary content

**Where:** `src/api.dtr` (`st_read_asset`), `scripts/build-wasm.mjs`,
`ui/app.js` (`loadTextCore`).

**Symptom.** `file_read` returns a `Str`, and on a non-UTF-8 file it returns an
empty string with no error:

```
POST /api/read   ui/vendor/textcore.wasm
{"ok":true,"bytes":0,"content":""}          <- the file is 40070 bytes
```

So the Datara server cannot serve a `.wasm` file, which is how the Rust text
core is delivered to the browser.

The failure mode is the bad part: `ok: true` and `bytes: 0` looks like an empty
file, not like a refusal. A caller cannot distinguish "the file is empty" from
"the file is binary and I will not read it".

**Workaround.** `scripts/build-wasm.mjs` embeds the module as base64 in a
generated `ui/vendor/textcore.js`. That costs 34% size on a 39 KB module and
removes one startup round trip, so it is not a bad trade even setting the
limitation aside. It does mean the interface is generated, not hand-written, and
that regenerating is a build step.

**Fix once the compiler is fixed.** Add a binary-safe read - either
`file_read_bytes(path) -> List<Byte>` or `file_read(path) -> Outcome<Str>` so
failure is representable. Then serve `/vendor/textcore.wasm` directly and delete
the base64 generator. Delete this section.

---

## SEAM-6 - a socket that connects and sends nothing blocks the server forever

**This one made the interface load to a blank page.** It is the most important
entry in this file.

**Where:** `src/main.dtr` (the accept loop), `src/http.dtr` (`st_read_request`),
`scripts/build-ui.mjs`, `start.cmd`.

**Symptom.** A connection that connects and then sends nothing blocks the
single-threaded accept loop permanently, because `socket_recv` blocks until data
arrives and there is no way to bound it. Measured:

```
$ curl -s .../api/health                    -> 200
$ exec 3<>/dev/tcp/127.0.0.1/7878           # connect, send nothing
$ curl -s --max-time 5 .../api/health       -> times out
$ exec 3<&-                                 # close the idle socket
$ curl -s .../api/health                    -> 200 again
```

`netstat` during the hang shows the dead connection `ESTABLISHED` and every
finished one stuck in `CLOSE_WAIT`, because the loop never gets back to
`socket_close`.

Browsers open exactly such connections - preconnect sockets, sockets for a
request they then cancel. So opening `http://127.0.0.1:7878` in Chrome produced a
blank page: the document request sat behind an idle socket that never spoke.

**There is no way to bound the wait.** The runtime offers `socket_create`,
`bind`, `listen`, `accept`, `connect`, `recv`, `send`, `close` and nothing else:
no `SO_RCVTIMEO`, no non-blocking mode, no `select`/`poll`, and no thread,
fiber or actor builtin to move a connection onto. `socket_recv(fd, 0)` was tried
as a way to poll and it **blocks too** (`.probe3`: it returned after 3 s, exactly
when the client finally sent a byte). So a receive timeout cannot be built.

**Fix, in two parts.**

1. **Remove the reason to open extra connections.** `scripts/build-ui.mjs`
   inlines React, htm, app.js and the wasm core into ONE `ui/studio.html` with a
   data-URI favicon. The browser now needs exactly one request and has no
   subresources to open a parallel or speculative socket for. Verified: the
   served page has zero external references.
2. **Make the failure survivable.** `start.cmd` pings `/api/health` every four
   seconds and restarts the server if it stops answering. The limitation is
   still there; it just cannot leave the user stuck.

**Fix once the compiler is fixed.** Any one of these makes part 2 unnecessary:
a receive timeout (`socket_set_timeout`), a non-blocking mode with a poll, or
any concurrency primitive that can own a connection. Then `st_read_request` gets
a deadline, the accept loop stops being a single point of failure, and the
watchdog can be deleted. The single-file interface stays either way - one
request instead of six is simply better.

**A second finding, from the same investigation: `socket_bind` succeeds twice on
the same port.** Measured while debugging the launcher - two `forgen run`
processes both bound `127.0.0.1:7878`, and `netstat` showed two `LISTENING` rows
for the one port. Windows is delivering connections to one of them, and if that
one is wedged the other never sees a request. So a stray duplicate server does
not fail loudly with "port in use"; it silently splits traffic and produces
exactly the intermittent hangs this seam is about.

That is why the launcher's two servers must be on two *different* ports, and why
`DATARA_STUDIO_PORT` exists. `socket_bind` should refuse a port it cannot have -
the current behaviour makes a duplicate server undetectable from the outside.

**Worth saying plainly:** this is a runtime capability gap, not a Datara language
problem. Any single-threaded server without a receive timeout has this bug, in
any language. It is recorded here because it cost the user a blank screen.

---

## SEAM-7 - `exec` returns the console codepage, so every non-ASCII path is mojibake

**Where:** `src/explorer.dtr` (`st_oem_table`, `st_from_oem`), applied in
`st_list_dir`, and in `src/api.dtr` for `st_tree` and `st_run`. Every command
that still needs the shell - `mkdir`, `move`, `delete`, `git`, content search -
runs through `st_sh` and therefore lands here too; `st_git` and `st_delete` are
the two most recent additions to that set.

**Symptom.** A folder named "Шахматная школа 64 линии" arrives from `dir` as the
bytes `152 160 229 172 160 226 173 160 239 32 ...` - that is **cp866**, the OEM
codepage of a console on a Russian Windows. The runtime keeps whatever the child
wrote, byte for byte, and `str_len` counts those bytes, so the string is not
UTF-8. `socket_send` then puts it on the wire under
`Content-Type: application/json; charset=utf-8`, the browser decodes it as UTF-8,
and the explorer shows `˜ å¬ â­ ï èª®« 64 «¨¨`.

**Why it is invisible in a terminal.** `println` transcodes for the console on
the way out, so the same string prints correctly in `forgen run`. It only breaks
at the socket. That is exactly the kind of defect that survives every test that
runs in the same process.

**`chcp 65001` does not fix it.** Measured with and without: the bytes are
identical. cmd writes a redirected pipe in the OEM codepage regardless of the
console codepage.

**8.3 short names are not an escape either.** `dir /x` on this machine prints an
empty short-name column - generation is off on the volume - so there is no
ASCII-only route into a non-ASCII folder.

**Fix.** One conversion at the boundary where shell output enters the program: a
127-entry cp866 table and `st_from_oem`, with a fast path that returns the string
untouched when no byte above 0x7F is present, so the four-second tree poll costs
nothing for a mostly-ASCII workspace. `str_join` is used rather than `+` in the
loop, because `+` in a loop is quadratic and a tree listing is a few hundred
kilobytes.

**What is still broken, and cannot be fixed from here.** The *input* direction.
cmd reads a narrow command line in the **ANSI** codepage (cp1251 here), not the
OEM one, so a UTF-8 path cannot be handed back to the shell. Measured:

```
cd /d "D:/Новая папка"        (UTF-8 bytes) -> Системе не удается найти указанный путь.
echo D:/Новая папка                         -> D:/Р?Р?Р?Р°С? РїР°РїРєР°
```

Consequences: the folder browser lists a Cyrillic folder correctly and **cannot
enter it**. There is no workaround inside Datara, because a string cannot be
constructed from raw bytes - the prelude has `str_byte_at` for reading and
nothing for writing, so the OEM or ANSI bytes cannot be synthesised to put on the
command line. The alternatives all add a runtime dependency (a Node or PowerShell
helper receiving the path through a UTF-8 file rather than argv), which is a
bigger decision than this bug deserves on its own.

**Fix once the compiler is fixed.** `exec` should convert in both directions:
UTF-8 out to the child's ANSI codepage, and the child's OEM output back to UTF-8.
Then `st_oem_table` and `st_from_oem` are deleted outright, and the path box in
the folder browser becomes fully usable. A directory-listing builtin would remove
the dependency on the shell for this entirely.

**Where the conversion is applied, and the one place it was missing.** `st_tree`
converted the file and folder names but **not** the failure text, so the
`ok:false` branch returned the shell's own error message as cp866 bytes: a
Russian Windows answered "cannot read that folder - <twelve unreadable
characters>", which names nothing. An error message that cannot be read is
barely better than no message, and it cost a diagnosis. Every string on that path
goes through `st_from_oem` now, including the failure detail.

**Related, and worth checking at the same time:** `file_write` and `file_read`
round-trip a non-ASCII path *self-consistently* but disagree with the shell about
what the name on disk is, which suggests the file builtins pass UTF-8 bytes to
the ANSI API as well. `file_exists("D:/…/кириллица.txt")` returns true for a file
the runtime just created and false for a folder, and `dir` shows that same file
under a different name. Worth confirming before changing anything, because the
self-consistency hides it.

---

## SEAM-8 - forgen colourises its diagnostics even when the output is a pipe

**Where:** `src/http.dtr` (`st_strip_ansi`, `st_has_control`, the control branch
of `st_json_escape`), applied in `src/api.dtr` (`st_run`) and
`src/explorer.dtr` (`st_find`). Second line of defence in `ui/app.js`
(`stripAnsi`, used by `parseForgenDiagnostics`).

**Symptom.** `forgen check <file>` writes ANSI colour codes into a redirected
pipe - there is no `isatty` check and no `NO_COLOR` handling. Captured from the
installed 1.3.4 binary, byte for byte:

```
\033[1;31merror[E-TYPE-001]\033[0m: \033[1mType mismatch ...\033[0m
  \033[1;34m-->\033[0m \\?\D:\...\bad.dtr:2:5
     \033[1;34m|\033[0m     \033[1;31m^^^^^^^^^^^^^^\033[0m
     \033[1;34m=\033[0m \033[1;36mhelp:\033[0m parse String to Int using 'str_to_int(val)'
```

One error carries 7-8 lines containing ESC. That broke the IDE three ways at
once, and only the first was visible:

1. **The JSON was invalid.** `st_json_escape` did not touch control characters,
   so a raw `ESC` (0x1B) sat inside a JSON string literal. A raw control
   character is not legal in a JSON string, so the whole document failed to
   parse - `/api/check` returned unparseable JSON **exactly when the compiler
   reported an error**. The one moment the editor needed the answer was the one
   moment it could not read it, which is why a file with a real mistake in it
   never showed a red squiggle.
2. **The location line stopped matching.** The client's parse anchors on
   column-0 shapes (`error[CODE]:`, `--> file:line:col`, `= help: ...`). With
   `ESC[1;34m` in front of `-->`, the location line matches nothing, so every
   diagnostic would be dropped even if the JSON had survived.
3. **The output pane would have shown the codes as text.** Escaping alone turns
   ESC into `\u001b`, which the browser then renders literally as `\u001b[1;31m`
   in the run/console pane.

**Fix.** Strip at the one boundary where child output enters the program, and
escape control characters in the JSON writer as a correctness fix in its own
right. The `st_has_control` fast path is what keeps this free: a tree response is
a few hundred kilobytes and almost never contains a control byte, so the common
case is one scan and no rebuild. The client strips again - deliberately
duplicated, because the failure mode of getting it wrong is an editor that
silently shows no problems at all.

**Verified end to end, not at the unit level.** With the server running,
`POST /api/check` on a file with a real type error returns HTTP 200, **0 bytes
of ESC anywhere in the response**, valid JSON, `status: "failed"`, and the
`= help:` line intact. Round trip 299 ms including the compiler's own process
start. The project-wide variant over the whole workspace root returns in 301 ms.

**Fix once the compiler is fixed.** forgen should not colourise a non-TTY, and
the decision is one line. The chain, in the 1.4.0 tree:

* `src/diagnostics/engine.rs:94-96` - `format_all()` hardcodes
  `self.format_with_options(true)`. **This is the line to change.**
* `src/diagnostics/engine.rs:98-100` - `format_plain()` already exists and is
  **called from nowhere in the tree**, so the non-coloured path is written and
  unused.
* The colour is baked into a `String` long before anyone prints it:
  `src/driver/pipeline.rs:413` and ~30 sibling call sites do `diag.format_all()`,
  and the CLI just prints the result (`src/cli/build.rs:67`,
  `eprintln!("{}", res.diagnostics)`). **The print site cannot un-colour it** -
  by then the escapes are data.
* `src/lint/diagnostics.rs:148-150` is the sharper one: a function named
  `is_terminal()` that never tests a terminal -
  `std::env::var("NO_COLOR").is_err()`. So `forgen lint` colourises into a pipe
  too (`diag.render(None)` at `src/cli/tools.rs:268` and `src/cli/misc.rs:213`).
* The idiom already exists in the same tree: `src/repl/mod.rs:418` uses
  `std::io::IsTerminal::is_terminal(&io::stdin())`.

One more trap while this is open: the success line goes to **stdout**
(`println!`, `src/cli/build.rs:65`) and the diagnostics to **stderr**
(`eprintln!`, `:67`). A consumer that reads only stdout sees "Verified 100% OK"
while the exit code is 1. The IDE happens to merge them (`exec(cmd + " 2>&1")`),
but that is luck rather than design.

Then `st_strip_ansi` and the client's `stripAnsi` are both deleted, and the JSON
escaper keeps its control branch because it is correct regardless.

---

## Compiler findings from this work

Recorded here because they shaped the code above.

**A multi-file `forgen check` resolves every file's `use` against ONE file's
directory.** `src/driver/mod.rs:242` derives the module search path from
`paths[0]` alone - `self.module_base_dirs(paths[0].as_path())` - and `paths[0]` is
the entry point chosen by `src/project/discovery.rs:183-190`: the first
`main.dtr` in the sorted list, or the first path when there is none.
`module_base_dirs` (`src/driver/modules.rs:17-32`) pushes that file's parent, its
grandparent and the cwd, and nothing else. So a `use` in any *other* file is
looked up in the wrong directory, falls through to the stdlib, and is reported as
an external dependency:

```
[Forgen] package 'beta' not found; run `datara install beta` or set FORGEN_AUTO_INSTALL=1
error[E-RESOLVE-005]: Module 'beta' not found in project or stdlib
```

Isolated repro, measured: two sibling directories, each with a `main.dtr` and one
module it imports.

| command | result |
|---|---|
| `forgen check .probe_resolve` (the parent) | `E-RESOLVE-005` for `beta`, in `b/main.dtr` |
| `forgen check .probe_resolve/b` | 2 modules, 0 errors |
| `forgen check .probe_resolve/a` | 2 modules, 0 errors |

Same files, same compiler; only the target changed. This is why checking the
workspace root reported 23 errors for code that compiles clean, and it is **not**
about `datara.toml` - an earlier version of this note said it was, and that was
wrong: neither repro directory has a manifest, and both check clean.

Two consequences for the IDE, both implemented and verified: the project-wide
check is aimed at the directory of the project that governs the open file, so the
entry point discovery picks is that project's own `main.dtr`; and the walk up to
the project file is bounded by the workspace root. The bound was load-bearing
while the studio lived at `D:/ryan/IDE datara`, which resolved to the forgen_ai
project in `D:/ryan` above it and reported ten errors from somebody else's code.
The studio now sits at `D:/IDE datara` with no project file above it, so the bound
no longer fires - it is kept because the studio is installed wherever a person
puts it, and it is what makes the answer independent of that.

A compiler that cannot resolve a module should say which directories it searched,
rather than reinterpreting an internal import as an external package.

**`file_read` cannot read binary** (SEAM-5 above).

**`%` does not exist and there is no modulo builtin.** The `math_*` family has
`abs`, `min`, `max`, `clamp`, `shl`, `shr`, `and`, `or`, `xor`, `not`, `pow`,
`sqrt`, `ceil`, `floor`, `round`, `clz`, `ctz`, `popcnt` - but no `mod` or `rem`.
`src/layout.dtr` computes its alignment remainder by repeated subtraction.

**`continue` does not exist**, the same as `break`. Loop bodies that would
early-exit are restructured into `if / else`.

**`out` and `where` are reserved** and cannot be variable names.

**`stdlib.http.server` cannot serve an application.** Its `listen_once` binds,
accepts one connection, answers it and closes the listener. `src/http.dtr` keeps
the socket loop itself.

**No directory-listing builtin**, so the file tree shells out. The listing is not
read from `dir`'s exit code or its error text: each command is wrapped as
`(cd /d "PATH" && echo MARK && dir /b /ad) 2>&1` and the marker is the only thing
inspected. That is what makes a failed path detectable on a localised Windows -
matching the English "No such file or directory" turned the Russian equivalent
into a *folder entry* named after the error message. See SEAM-7.

**Modules have real visibility.** A plain `fn` is private to its own file; only
`pub fn` is reachable from another module, and reaching for a private one is
`E0042`. Helper functions shared across modules must be exported, which is why
`st_ok_mark`, `st_sh` and `st_join` carry `pub` despite being internal plumbing.

**`str_len` counts bytes, not characters.** `str_len("Шахматная школа 64 линии")`
is 43, not 24. `byte_len` and `char_len` are the explicit forms, and
`str_next_offset` / `str_scalar_at` / `str_chars` are there for walking character
boundaries - `str_substring` indexes bytes, so an arithmetic offset into a string
that mixes two- and three-byte characters lands mid-character.

**`str_substr` does exist.** It is registered as an alias of `str_substring`
alongside it in the prelude. An earlier note in this project claimed otherwise;
that claim was wrong and is corrected here.

**A literal `%` passes through to the shell.** `%` is not an operator in Datara,
so it needs no escaping, and cmd's `for` loop variable syntax works unchanged -
`for %d in (A B C)` enumerates drives. Worth knowing because `%` is the one cmd
metacharacter the language could plausibly have eaten.

**`exec` never returns while a detached child holds the pipe.** `exec` reads the
child's output until the pipe closes, so a grandchild that inherits the write end
keeps it open and the call blocks forever - even though the command it ran
returned immediately. Measured: `exec("start \"title\" /min cmd /c \"cd /d
\"D:\ryan\" && python daemon.py\"")` hung permanently, while
`exec("wscript //nologo //B scripts\hidden.vbs \"cmd /c cd /d \"D:\ryan\" &&
python daemon.py\"")` returned in 0 ms. The difference is that `WshShell.Run(cmd,
0, False)` creates the process with no inherited standard handles.

**This is also why a killed server can leave its port bound.** The same handle
inheritance applies to sockets: a shell child spawned by the server inherits the
listening socket, so force-killing the parent leaves the socket registered and
Windows keeps delivering connections to it. Observed repeatedly - two
`LISTENING` rows for one port, with the owner absent from the process list. It is
not a Datara bug on its own, but it is a consequence of the same missing
`close-on-exec`, and it is worth knowing before blaming the IDE for a port that
"nobody" holds.

**No socket options and no concurrency primitives.** The socket builtins are
exactly `socket_create`, `socket_bind`, `socket_listen`, `socket_accept`,
`socket_connect`, `socket_recv`, `socket_send`, `socket_close`, plus
`net_listen` / `net_connect`. There is no `socket_set_timeout`, no
`set_nonblock`, no `select` / `poll`, and no `thread_*` / `spawn` / `fiber` /
`actor` builtin in the prelude. See SEAM-6 for what that costs.

---

## Design choices, not workarounds

These look like seams but are decisions. They stay.

**Two interface variants from one source, not two builds.** `app.js` reads
`window.__DS_CORE__` in four places and the palette, the panel, the bar and
Settings each honour it. `scripts/build-ui.mjs` writes `studio.html` and
`studio-core.html` from that one file, and the server picks between them on
`?core=1`. The alternative - a separate source for the core build - is how the
two get to disagree about what the editor does; a flag read in four places can be
audited in one sitting. The build refuses to emit if the flag is not set before
`app.js` loads, because the failure mode is a core file that silently contains
the full studio.

**The desktop shell starts the Datara server rather than bundling a page.** A
static asset bundle could not read the project, run the compiler or watch the
filesystem, which is the whole point. `src-tauri/src/main.rs` spawns
`forgen run src/main.dtr` twice (two ports, because SEAM-6 makes one port a
single point of failure), opens the window immediately on the bundled splash, and
kills the children on exit. The webview talks to the server over loopback
exactly as a browser does, which is why the desktop and browser builds cannot
drift apart.

**Build note, because it cost an hour:** `cargo` is installed at
`%USERPROFILE%\.cargo\bin` but is **not** on the Bash tool's `PATH`, so
`scripts/build-desktop.sh` fails with "cargo is required" under a Git Bash
session while working fine in `cmd`. Prefix with
`export PATH="$HOME/.cargo/bin:$PATH"`. The script's own guard is correct; the
environment is what lies.

**The shell had never actually compiled.** `src-tauri/target/release/datara-studio.exe`
was 8.6 MB and dated, which read as "built and working" - but the source did not
compile: `std::env::var("HOME")` moved `home` into the first `PathBuf::from` and
used it again on the next line (`E0382`). The `.exe` was a stale artifact from an
earlier revision. Fixed, and `scripts/build-desktop.sh` now runs clean. Worth
knowing as a general lesson: **an existing binary is not evidence that the source
builds.** Rebuild before believing it.

**Line-based request bodies instead of JSON.** Writing JSON is trivial; parsing
it in Datara is not, and no endpoint here needs a structured request. Two-argument
endpoints use "first line is the argument, the rest is the payload", which works
because no path or action name contains a newline. If a structured request is
ever genuinely needed, this becomes the place to add a real parser - but not
before.

**One request per connection, no keep-alive.** A local single-client tool gains
nothing from connection reuse, and every protocol feature left out is one that
cannot be wrong.

**The UI is read from disk on every request.** One small file, the OS page cache
makes it free, and editing the UI needs no server restart. Caching it would be a
pessimisation during development.

**No structs in the server.** Deliberate, given the field-name defect. It costs
readability in two places (`st_tree`, `st_run`) and buys immunity to a whole
class of silent miscompilation. Worth revisiting once the layout optimizer is
fixed - but only after the fix is verified by the probes.

**Single-threaded accept loop.** Fine for one local client. The AI companion is
a separate process, so a slow `forgen build` blocks the IDE's file reads but not
its suggestions. A thread pool is the first thing to add if that ever hurts.

**The check writes the buffer out before asking the compiler, when autosave is
on.** Not a seam - the compiler only ever sees files, and `/api/check` is aimed at
a path, so a check issued with unwritten changes describes the previous save.
Measured: type a syntax error and stop, and the panel still read "no problems in
this file", because with autosave on nothing re-checked after the write landed.
Writing first costs no extra writes - it moves the one autosave was about to make
from 900 ms to 650 ms, and the autosave effect's cleanup drops its now-redundant
timer. With autosave **off** the file is deliberately left alone, because not
writing until asked is the entire meaning of that setting; there the check
honestly reports the last save. The real fix is a check that reads the buffer
rather than a path, which is a compiler-side change.

---

## What gets better after the rewrite

Not just cleaner - faster, in ways worth measuring:

1. **`st_at` disappears.** Element reads become direct indexing, and the
   bounds check moves to where the compiler can hoist it.
2. **`unsafe` blocks disappear,** so `st_run` and `st_tree` lose their hoisted
   locals and the code reads as written.
3. **Real exit codes** make `act()` in the UI able to mark a build as failed
   without heuristics, which is the difference between a toy and a tool.
4. **Structs become usable again.** The document model (open buffers, revisions,
   per-file diagnostics) should be structs, and the server should hold state
   rather than re-reading files. That is the next real architectural step and it
   is blocked only by SEAM-1's parent defect.
5. **A typed JSON layer** instead of string concatenation, which removes the
   whole `st_json_escape` class of bug.

The order matters: fix the layout optimizer, re-run the probes, then do (4) and
(5) together, because both are about giving the server a real model.
