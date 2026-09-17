# Writing Datara, day to day

An assessment from the inside. Everything here comes from writing roughly 2000
lines of Datara - the server, the filesystem explorer, the layout inspector and
the HTTP layer of this IDE - and from tracing four silent defects to their cause
in forgen's source. Where a claim is measured, the measurement is given.

Version: written against **forgen 1.3.4**. Re-tested against the installed
**1.4.0** - see the update immediately below, which changes two of the rankings.

---

## 1.4.0 update — what the port changed

The IDE was ported to 1.4.0 and every finding above was re-measured against the
installed binary. Two are fixed, one is smaller, and one new one takes the top of
the list.

**Fixed.** The field-offset defect (section 1) is gone. `probes/field_offset_min`
prints the required value, and `probes/fieldnames_shared` prints correct values
for all three structs. A local `List<Str>` element read (section 4) is correct
too, and an out-of-range *runtime* index returns `""` rather than reading past the
end. `system()` and `process_run()` now return the real exit code, so status is no
longer inferred from output text.

**Smaller.** `file_read` still returns `""` for content that is not valid UTF-8,
but `file_read_bytes` now exists, so a binary file is *detected* instead of
looking empty. Section 3 is half retired.

**Also found on 1.4.0, and it takes ten seconds to check.** `forgen build --tiny`
prints `Profile: Ultra-Compact (dead code stripped, minimal footprint)` and
produces a **larger** binary than the default: 410.5 KB to 444.5 KB on a
400-function program, 488.5 to 489.0 KB on the studio server, unchanged on hello
world. Deterministic across repeats. Either the flag is not wired to the linker
profile it claims, or the profile it selects is worse than the default - and the
size line it prints is the kind of output a build script would reasonably quote.
See section 10 for the size table it should have produced.

**And one that is not a compiler defect but belongs here anyway.** `exec` costs
225-270 ms on this platform, almost all of it process start. That makes it
invisible in a test suite and expensive in production, and it produced the single
largest performance bug in the IDE: `/api/health` spawned `forgen --version` on
every request, so it took 245-305 ms while a filesystem walk took 5.5 ms. Section
10 has the numbers and the fix.

**New, and it is the worst one.** `Str` comparison is not deterministic:

| # | Problem | Class | Cost |
|---|---|---|---|
| 1 | `<` and `>` on `Str` return different answers for the same operands on different runs | **non-deterministic** | days |
| 2 | `dir_list` returns cp1251 while the shell returns cp866 | wrong data | hours |
| 3 | Diagnostics are colourised even into a pipe | broken tooling | hours |
| 4 | `unsafe(justification:)` around every single I/O call | friction | constant |

A non-deterministic operator is worse than the silent miscompile it replaced,
because a wrong answer can be caught by a test and a *changing* answer cannot. A
program that sorts strings has no correct output to assert against: the same
binary, run eight times on the same input, produced eight different orders.

```
$ for i in 1 2 3 4 5 6 7 8; do ./main.exe; done
pub struct Short {:b c a d
pub struct Short {:d b c a
pub struct Short {:d a c b
pub struct Short {:c a b d
pub struct Short {:c a d b
pub struct Short {:d b a c
pub struct Short {:b a c d
pub struct Short {:d c a b
```

Correct output is `a b c d`. Reproduce with
`probes/str_compare_order/`; full analysis in finding 13 of
`docs/COMPILER-NOTES.md`.

Instrumented, the comparison is the liar - both operands print correctly
immediately before being compared, and the result differs between runs:

```
a=1 cur=1 cur_name=b
   b=0 prev=0 prev_name=a cmp=true      <- "a" > "b" is false
```

**What is not the trigger,** because it matters for the fix: string comparison in
a small function is stable. `"a" < "b"` was correct in every run of every isolated
probe, including one reading both operands out of a `List<Str>` by variable index
inside nested loops. Moving the sort into a function of its own did not help
either. The defect needs a larger surrounding frame, which points at register
allocation or stack slot reuse rather than at the comparison.

**Workaround used here,** and it is exact rather than approximate: compare bytes
as integers with `str_byte_at` instead of using the operators. Byte order is also
what `layout.rs` produces, because it compares the names as Rust `String`s. The
layout inspector returned the same correct order on eight consecutive requests
once this was in place.

**Also new: `dir_list` is ANSI.** The runtime calls `FindFirstFileA`
(`src/runtime/datara_runtime.c:2623`), so entry names arrive as cp1251 while shell
output arrives as cp866. `path_exists` and `file_exists` expect cp1251 back, so
the filesystem builtins are ANSI in both directions. The visible symptom was a
folder named `тест папка 123` listed as a *file* and unopenable, because the same
path spelled in UTF-8 answers `false`. This one is worth fixing for the same
reason as `exec`: two codepages in one process is a class of bug, not a bug.

**Also still missing** from the installed binary while present in the source:
`StrBuf` is codegen-registered but absent from the resolver
(`undefined symbol 'strbuf_new'`), and `exec_utf8` is registered at
`src/resolver/mod.rs:257` but resolves as undefined.

---

## The short version

**The language is pleasant to read and the compiler is fast. The compiler is also
willing to be silently wrong, and that is the one thing that has to change.**

Ranked by how much time they cost:

| # | Problem | Class | Cost |
|---|---|---|---|
| 1 | Struct field offsets resolved by bare name across the whole program | **silent miscompile** | days |
| 2 | `exec` returns the console codepage, and rejects UTF-8 arguments | wrong data | hours |
| 3 | `file_read` returns `""` for binary content, with no error | silent failure | hours |
| 4 | A local `List<Str>` element read returns a pointer | wrong data | hours |
| 5 | Diagnostics are colourised even into a pipe, which breaks every consumer | broken tooling | hours |
| 6 | No `break` / `continue` / `%` / if-expressions | friction | constant |
| 7 | `unsafe(justification:)` around every single I/O call | friction | constant |

Items 1 to 4 share a shape, and it is the shape that matters: **they all produce
a wrong value rather than an error.** A language that is hard to write is
annoying. A language that compiles something other than what it read is not yet
usable for anything load-bearing.

Item 5 is a different shape and worth naming separately: it is not that the
compiler is wrong about the language, it is that the compiler breaks the tools
built on top of it. A compiler is a component in other people's pipelines, and
writing control characters into a pipe is a decision about someone else's data.

---

## 1. The field-offset defect (the serious one)

forgen keeps struct field offsets in **one table keyed by field name alone**. The
first struct to declare a name fixes that name's offset; every later struct that
reuses the name reads and writes at the *first* struct's offset.

No diagnostic. No warning. No runtime error. The symptom appears and disappears
as unrelated fields are added elsewhere in the program.

```
probes/fieldnames_shared    SA correct, SB corrupt: scope_id = -9223357699800562341
probes/fieldnames_unique    all correct
DATARA_CODEGEN_TRACE=1      class="" field=scope_id offset=40   <- the class is lost
```

1.3.4 fixed **half** of it - field order is now declaration order rather than
alphabetical - which is real, and the other half is untouched.

The chain, at 1.4.0 line numbers:

* `codegen/cranelift/backend/compile_func.rs:631` and `:754` -
  `.or_else(|| field_default_offsets.get(field).copied())`. This is the defect.
* `compile_func.rs:615-619` and `:738-742` - `current_class_name` falls back to
  `f.params.first()` and then to `""`, which is what makes the fallback fire.
* `declare_module.rs:422` - `field_default_offsets: HashMap<String, i32>` is
  still built, bare name, first-wins.
* Same shape in `codegen/llvm/mod.rs:1196-1198`.

**The fix is small:** delete `field_default_offsets` entirely - if the map does
not exist the fallback cannot be written - and make an unresolvable class a hard
error instead of a guess. A compiler that cannot work out which struct a field
belongs to should say so.

Until then every field in this project carries a struct tag (`ev_kind`,
`sub_kind`, `dlv_kind`), which is a workaround a user should never have to
discover.

Two smaller defects in the same area, both silent:

* `declare_module.rs:434-440` keys `string_fields` by bare field name across all
  classes, so a `Str` field in one struct makes that name a string field
  everywhere.
* `optimizer/adaptive/layout.rs:225-228` forces struct-of-arrays when a class
  name merely *contains* `layout` or `soa`. Naming a struct `PageLayout` silently
  changes its memory layout.

**A note on the probe that was supposed to demonstrate this, found while making
the IDE check the whole project.** `probes/field_collision/` exists
to show the collision, and it has never run: both `broken_a.dtr` and
`broken_b.dtr` name their field `shared`, and **`shared` is a reserved word**.
The compiler stops at `E-SYNTAX-001: Expected member name` on line 3, so the
probe demonstrates a syntax error rather than a silent miscompilation - and
`main.dtr` only mentions `use broken` in a comment, so nothing pulls them in. The
working probes are `probes/fieldnames_shared` and `probes/fieldnames_unique`,
which do reproduce it. This is also the first thing the new project-wide Problems
view reported, which is the argument for having it: the IDE found a dead probe on
its first run, in a corner of the tree nobody was looking at.

**The reduction, and the variable nobody expected.**
`probes/field_offset_min/main.dtr` is now eleven lines and reproduces it: two
one-field structs sharing `scope_id`, read through a `List` element, printing 5
where 42 is required, exit code 0. Two things decide whether it fires:

* **The layout.** With two fields ahead of the name in the first struct, both
  structs land on the same offset and the program is accidentally correct.
  Sweeping 0, 1, 2, 3, 4, 5, 7 leading fields gives wrong, wrong, **correct**,
  wrong, wrong, wrong, wrong.
* **The field name.** Same shape, same offsets, only the name changed, five runs
  each: `x`, `y`, `w`, `z`, `zz`, `zzz`, `size`, `value`, `scope_id`, `total`,
  `state` corrupt; `a`, `aa`, `aaa`, `q`, `qq`, `qqq`, `s`, `r`, `m`, `b`, `f`,
  `n`, `id`, `count`, `data`, `kind`, `flag`, `dup`, `len` do not. Nonsense names
  split too (`zzz` corrupts, `aaa` does not), so the deciding factor is a
  property of the name itself - most likely its hash, which points at a
  `HashMap` in the offset lookup rather than the plain `String` key the source
  suggests.

That second variable is why this defect feels random in a real program, and it
carries a trap worth naming: **renaming a field can make the bug disappear
without fixing it**, so "it stopped reproducing" is not evidence of anything. It
also cost an afternoon of failed reproduction here - the first three hand-built
repros happened to use `dup`, which is in the correct list.

**And the mechanism, which is now on the record with line numbers.** `Inst::GetField`
(`src/dmir/ir.rs:114-119`) carries the field name and its type but **not the class
the field belongs to**, so the backend recovers the class from a side table or the
first parameter and otherwise falls back to a global bare-name map
(`compile_func.rs:557-574`). That map is built first-wins over **sorted class
names** (`declare_module.rs:424-431`), so the winner for a shared name is whichever
class sorts first alphabetically. Measured: with the same field name and the same
layouts, `SA`/`SB` corrupts and `SZ`/`SB` is correct. **Renaming a struct flips the
defect too** - and a struct rename is a refactor nobody would think twice about.
The read site can be watched directly:
`DATARA_CODEGEN_TRACE=1` prints `[getfield] fn= class= field= offset=`, and
`class=""` in that line is the fallback firing.

The fix follows from the mechanism, in order: carry the class in `Inst::GetField`,
delete `field_default_offsets` so no fallback can exist, and make an unresolvable
class a hard error. The fallback only exists because the class is missing from the
instruction.

---

## 2. `exec` and the two codepages

Measured on a Russian Windows:

```
exec("dir /b /ad \"D:/\"")
  "Шахматная школа 64 линии" arrives as bytes 152 160 229 172 160 226 ... = cp866
```

The runtime stores what the child wrote, byte for byte, and `str_len` counts
those bytes, so the string is not UTF-8. Anything that then puts it on a socket
under `charset=utf-8` sends mojibake.

**`println` hides it.** The runtime transcodes for the console on the way out, so
the same string prints correctly in a terminal and breaks only at the socket.
That asymmetry is why this survives every test run in-process.

The other direction is worse: cmd reads a narrow command line in the **ANSI**
codepage (cp1251 here, a different codepage from its output), so
`cd /d "D:/Новая папка"` with UTF-8 bytes fails outright. And it cannot be worked
around from Datara, because **a string cannot be constructed from raw bytes** -
the prelude has `str_byte_at` for reading and no writer at all. So a non-ASCII
path can be listed and not entered.

Things that do **not** help, each tested: `chcp 65001` (byte-identical output),
8.3 short names (generation is off on this volume), `file_exists` (see below).

**The fix belongs in `exec`:** convert UTF-8 out to the child's ANSI codepage and
the child's OEM output back to UTF-8. Until then this IDE carries a 127-entry
cp866 table and a conversion at the boundary, labelled SEAM-7 in `PORTING.md`.

**A third thing `exec` does wrong: it never returns while a detached child holds
the pipe.** `exec` reads the child's output until the pipe closes, and a
grandchild that inherits the write end keeps it open - so the call blocks even
though the command it ran returned immediately. Starting a background service is
exactly where this bites:

```datara
# hangs the caller permanently
exec("start \"title\" /min cmd /c \"cd /d \"D:\\app\" && python daemon.py\"")

# returns in 0 ms
exec("wscript //nologo //B \"scripts\\hidden.vbs\" \"cmd /c cd /d \"D:\\app\" && python daemon.py\"")
```

The same missing close-on-exec applies to sockets, and that one is nastier: a
shell child spawned by a Datara server inherits its listening socket, so
force-killing the server leaves the port bound with **no process owning it**.
`netstat` shows `LISTENING`, `tasklist` shows nothing for that PID, and every new
connection goes nowhere. Diagnosing that cost real time, and the fix is a flag
(`O_CLOEXEC`, `HANDLE_FLAG_INHERIT` cleared) rather than anything the user of the
language can do.

---

## 3. `file_read` on binary content

```
file_read("ui/vendor/textcore.wasm")   -> ""      (the file is 40070 bytes)
```

An empty string, no error, no way to distinguish it from an empty file. This
forced the wasm module to be embedded as base64 in a generated JavaScript file
rather than fetched - which works, and is a workaround for a missing error.

Related, and measured while investigating: `file_exists` returns **false for a
directory**. It means "exists and is a file". That is a defensible definition and
an indefensible name.

---

## 4. `List<Str>` element access

```datara
fn elem(view xs: List<Str>, i: Int) -> Str => xs[i]

fn main() {
    let parts = str_split("a=b=c", "=")
    println(parts[0])        // 2092347375680   <- a pointer
    println(elem(parts, 0))  // a               <- correct
}
```

Reproduces with no structs at all, so it is independent of the field defect.
`parts.len()` is correct; only the element read is wrong. Every `List<Str>` read
in this project goes through a helper function because of it.

---

## 5. Diagnostics are colourised into a pipe

**This one is worth reading even if you skip the rest, because of how it hides.**
`forgen check <file>` writes ANSI colour codes even when its output is a
redirected pipe. There is no `isatty` check and no `NO_COLOR` handling, so a
program that captures the compiler's output - which is what every tool does -
receives this, byte for byte from the installed 1.3.4 binary:

```
\033[1;31merror[E-TYPE-001]\033[0m: \033[1mType mismatch ...\033[0m
  \033[1;34m-->\033[0m \\?\D:\...\bad.dtr:2:5
     \033[1;34m|\033[0m     \033[1;31m^^^^^^^^^^^^^^\033[0m
     \033[1;34m=\033[0m \033[1;36mhelp:\033[0m parse String to Int using 'str_to_int(val)'
```

Seven or eight lines carrying ESC for a single error. It cost the IDE three
separate failures, and only the first was ever visible:

1. **Unparseable JSON, exactly when the compiler had something to say.** A raw
   control character is not legal inside a JSON string, so `/api/check` returned
   a document the browser rejected - and it did so *only* for files with errors.
   The clean case, "Verified 100% OK", has no colour and parsed fine. So the
   editor showed no squiggle on a file with a real mistake in it, and showed
   nothing wrong on a file without one: the failure was invisible in every test
   that used a clean file, which is most of them.
2. **The location line stopped matching.** An editor's parser anchors on
   column-0 shapes - `error[CODE]:`, `--> file:line:col`, `= help: ...`. With
   `ESC[1;34m` in front of `-->`, nothing matches and every diagnostic is
   dropped, even with valid JSON.
3. **Escaping alone is not enough.** Turning ESC into `\u001b` makes the JSON
   valid and then the browser prints `\u001b[1;31m` as literal text in the
   output pane.

Two fixes, both in the IDE: strip ANSI at the one boundary where child output
enters the program, and handle control characters properly in the JSON writer
(which is a correctness fix regardless - it was a latent bug waiting for any
child that emits a tab or a NUL). Verified end to end against a running server:
HTTP 200, **0 ESC bytes in the whole response**, valid JSON, `status: "failed"`,
and the `= help:` line intact - 299 ms including the compiler's own process
start.

**The general lesson, which is the reason this is a section and not a footnote:**
the test that would have caught it is "check a file that is broken", and every
convenience path in a build script uses a file that is not. A green suite proves
nothing about the error path until something deliberately fails.

**What forgen should do:** do not colourise a non-TTY. The decision is one line -
`src/diagnostics/engine.rs:94-96`, where `format_all()` hardcodes
`format_with_options(true)` and `format_plain()` (`:98-100`) sits unused. The
colour is baked into a `String` at `src/driver/pipeline.rs:413`, so the CLI
cannot strip it when it prints (`src/cli/build.rs:67`). And
`src/lint/diagnostics.rs:148-150` is a function named `is_terminal()` that only
checks `NO_COLOR`, so `forgen lint` colours a pipe as well. The idiom is already
in the tree at `src/repl/mod.rs:418`. Then the IDE deletes `st_strip_ansi` and
the client's `stripAnsi`, and keeps only the JSON escaper.

One more thing worth fixing in the same pass: the success line goes to stdout and
the diagnostics to stderr, so a consumer that reads only stdout sees "Verified
100% OK" while the exit code says 1.

---

## 6. Small things that cost time every day

Not defects, but each one is a thing a writer has to remember instead of a thing
the compiler handles:

| Missing | What you write instead |
|---|---|
| `break` | a flag and a compound loop condition |
| `continue` | nested `if / else` |
| `%` | `a - (a / b) * b`, or repeated subtraction |
| if-expressions | `mut x = default` then assign inside an `if` |
| indexing a `List<Str>` | a helper function, always |
| closures / function values | a static dispatch table or an out-of-process protocol |
| `exit()` | `fn main() -> Int` (declared but `datara_rt_exit` is unresolved) |

Reserved words that break ordinary identifiers: `out`, `from`, `where`, `view`,
`class`, `own`, `shared`, `type`, `require`, `ensure`, `val`, `bits`. Naming a
parameter `from` is a parse error, and `async_mode` fails to lex. Two of the four
defects I fixed this session started as a reserved word.

**`unsafe(justification: "...")` is required on every capability call** - `exec`,
`file_read`, `file_write`, `file_exists`, `socket_*`, `env_get`. There is no
`[capabilities]` section in `datara.toml`, so a legitimate program that reads a
file must write a sentence justifying it. In this project that is 30-odd call
sites. The capability *model* is a good idea; the absence of any way to grant a
capability to a module is what makes it ceremony.

---

## 6. What is genuinely good

It would be dishonest to leave this section out.

**Compile speed.** `forgen check` on this 2051-line, 80 KB server: **140-185 ms**.
That is fast enough to run on every keystroke, and this IDE now does - the red
squiggles come from the real compiler, not from a linter.

**The diagnostics are excellent.** This is not a compromise:

```
error[E-TYPE-001]: Type mismatch for argument 1: expected 'Int', got 'Str'
  --> \\?\D:\...\bad.dtr:7:12
     |
   7 |     return helper("not an int")
     |            ^^^^^^^^^^^^^^^^^^^^
     = note: for more details, run 'forgen explain E-TYPE-001'
```

A machine-readable code, an exact line and column, a caret span giving the length
of the offending expression, the source line, and a `forgen explain` hint. That
is everything an editor needs and more than most compilers provide. Parsing it
took forty lines of JavaScript.

**AOT build speed.** 2051 lines to a 472 KB native executable in **0.99 s**.

**Memory.** The whole server, after a tree scan, a compiler check and a file
read: **9.8 MB**. For scale, on the same machine at the same moment: python
39.9 MB, WebView2 605 MB across 18 processes, node 761 MB. This is a real and
large advantage, and it comes from having no runtime, no GC and no interpreter.

**Capabilities as a language concept.** `unsafe(justification:)` is annoying in
practice, but the idea that a function's I/O is visible in its signature is
right, and it is the kind of thing a compiler-native IDE can surface in a way no
text editor can.

---

## 8. What a senior developer would miss

Beyond the defects, in rough priority order:

1. **A directory listing builtin.** This IDE shells out to `dir` for every
   listing, which costs a process creation per call - 487 ms per tree refresh on
   this machine. `fs_readdir(path) -> List<Str>` would remove an entire class of
   problem, including the encoding one.
2. **Error values instead of empty strings.** `file_read` returning `""` for
   binary content is the archetype. An `Outcome<Str>` there would have saved
   hours. The language already has `Outcome<T>`.
3. **Constructing a string from bytes.** Without it there is no way to build a
   binary buffer, no way to encode to a specific charset, and no way to escape
   the codepage problem from user code.
4. **Some concurrency primitive.** Not threads necessarily - but a Datara server
   currently cannot bound a socket read, and a single idle connection blocks the
   accept loop permanently. Any of `select`, a non-blocking mode, a receive
   timeout, or an actor would fix it. This is the single biggest gap between
   "a language I can write tools in" and "a language I can write servers in".
   Related and measured: **`socket_bind` succeeds twice on the same port.** Two
   processes both bound `127.0.0.1:7878` and `netstat` showed two `LISTENING`
   rows; connections then went to one of them, and when that one was wedged the
   other never saw a request. A duplicate server should fail loudly with "port in
   use" instead of silently splitting traffic.
5. **A test runner and an assertion macro.** `src/selftest.dtr` in this project
   is hand-rolled: a module returns `Outcome<Str>` and a top-level function
   aggregates. It works, and every language that has this built in is better off.
6. **`break` and `continue`.** Their absence makes ordinary loops read worse, and
   nothing is gained - the flag-and-compound-condition idiom is strictly harder
   to follow.
7. **A package/module system with real namespacing.** `use` merges everything into
   one flat namespace, so every public name must carry a manual prefix
   (`rope_len`, `bus_publish`) and collisions are silent. Modules do have real
   visibility (`fn` is private, `pub fn` is exported, E0042) - that part works
   well - but the namespace is flat.
8. **A formatter.** Every project invents its own style. `forgen fmt` would end
   the argument.
9. **Incremental compilation for `check`.** 150 ms is fine for one file; on a
   large project the whole-program check will not stay this fast.
10. **Documentation that matches the compiler.** The README is wrong about `view`
    placement, about `pub` on fields, and about the return type of
    `str_contains` (it declares `Bool`, the compiler returns `Int`). A language
    whose reference and implementation disagree teaches users to distrust both.

---

## 9. What the IDE should get next

Ordered by what would change the experience most, and honest about which need
compiler work first.

**Needs no compiler change:**

1. **Inlay hints.** Parameter names at call sites, and inferred types. The
   information is in the source; showing it removes the round trip to the
   declaration.
2. **A real symbol table across the workspace.** Today go-to-definition is a
   workspace search filtered for declaration-shaped lines, and the outline is a
   regex per file. Both work and neither is a parser. Parsing every `.dtr` once
   and keeping an index would make rename and real references possible - and it
   belongs in the Rust text core, next to the lexer, rather than in JavaScript.
3. **A structural diff.** Datara has structs, traits and behaviors - a diff that
   understands declarations would be far more useful than a line diff.
4. **Multi-cursor.** The editing operation a person notices missing within the
   first hour.

**Blocked on the compiler, and worth doing the moment it lands:**

5. **Ownership, effects and capability lenses.** These are the things the IDE can
   show that no general-purpose editor can, because the information exists only
   inside forgen. A gutter marker for where a value moves, a hover showing what a
   function can do to the outside world, a panel listing the capabilities a
   module needs. This is the actual moat: the editor and the compiler are the
   same system.
6. **Comptime results inline.** What a `comptime` expression evaluated to, shown
   at the expression.
7. **The chosen struct layout, live.** The Layout tab already reimplements
   forgen's algorithm and flags field-name conflicts. Once `GetField` resolves
   per class, the compiler can just tell the IDE and the reimplementation goes
   away.

**Done, and worth recording because they were on this list:**

* **Diagnostics for the whole project, not one file** - `forgen check` over the
  project that governs the open file, grouped by file, click a problem to open
  that file at that line. It costs the same as checking one file (301 ms round
  trip against 299 ms), because the expense is the compiler's process start and
  not the volume of code.
  The first version aimed at the workspace root, and that was wrong in a way
  worth recording, because the first explanation of *why* was also wrong.
  `src/driver/mod.rs:242` derives the module search path from `paths[0]` alone -
  one file, chosen by `src/project/discovery.rs:183-190` as the first `main.dtr` -
  so every other file's `use` is looked up in the wrong directory and reported as
  an external package. Isolated repro: two sibling directories, each with a
  `main.dtr` and one module it imports. `forgen check <parent>` reports
  `E-RESOLVE-005` for the second directory's module; `forgen check` on either
  directory alone reports 2 modules and 0 errors. Same files, same compiler.
  It is **not** about `datara.toml` - that explanation fits the symptom, was
  written down first, and was then falsified: neither repro directory has a
  manifest and both check clean. The target is now the open file's directory, the
  walk up to the project file is bounded by the workspace root (at the time the
  studio lived at `D:/ryan/IDE datara`, which resolved to the forgen_ai project
  in `D:/ryan` above it and reported ten errors from somebody else's code; the
  studio now sits at `D:/IDE datara` with nothing above it, and the bound stays
  because the studio is installed wherever a person puts it), and the panel says
  which directory was actually checked. Three rules, all learned by running it
  once.
  Known limit, and it is the honest one: a workspace holding several projects
  gets one check per project - the one governing the open file - not a union.
  A union would be wrong rather than merely incomplete, because the check would
  pick one project's entry point and resolve the others' imports against it,
  which is the defect above.
* **Toggle comment, auto-indent, bracket pairs, indent and outdent a selection** -
  each one a pure text edit with a caret to place, so each one is covered by the
  editor suite rather than trusted. Auto-indent is the one that matters in a
  braces language; `Ctrl+/` and `Tab` / `Shift+Tab` are the two a person reaches
  for without thinking.
* **Go to definition** (`F12`, Ctrl+click) - one workspace search filtered for
  declaration-shaped lines, so it works across the project without an index to
  keep in sync. When nothing matches it says "not declared in this workspace"
  rather than "not found", which for `str_len` or `Int` is the true and more
  useful statement.
* **Hover help and completion from the language, not from a global table** - both
  now go through the provider interface, which is also what makes a second
  language possible without touching the editor.

---

## 10. Measurements

All on the machine this was developed on (Windows, Git-Bash under a sandbox),
on the installed 1.4.0. Re-measured rather than carried forward: several numbers
in this section were wrong by 100x until they were measured again.

**Server** (one process, unchanged source)

| Operation | Time |
|---|---|
| `/api/health` | **1.8-2.1 ms** |
| `GET /` (363 KB interface, one request) | 2.1-2.7 ms |
| `/api/tree` (workspace root, native walk) | 26 ms |
| `/api/tree` (`D:/`, budgeted, 5998 entries) | 951 ms |
| `/api/layout` | 6.0 ms |
| `/api/check` on one file (spawn forgen + check, round trip) | 299 ms |
| `/api/check` on the whole project (round trip) | 301 ms |
| `forgen check` one file, as a bare process | **224 ms wall, 0 ms compiler time** |
| Memory after tree + check + read | **9.8 MB** |

The check pair is the useful one: checking every module of the project costs the
same as checking one file, because the cost is process start and not the amount of
code. That is what makes a project-wide Problems view affordable at all - and it is
also the argument for an in-process check, which would remove almost the whole
number.

**`/api/health` was the slowest route in the server, and that is the lesson of
this table.** It returned a four-field JSON object in **245-305 ms** while
`/api/tree` walked the filesystem in 5.5 ms and the whole 354 KB interface came out
in 2.1 ms. Cause: the handler called `st_toolchain()`, which ran
`exec("forgen --version")` - and that process launch costs 225-270 ms, more than
everything else in the server combined. The launcher's watchdog asks for
`/api/health` every four seconds on up to four ports, so the single-threaded accept
loop spent most of its idle time waiting on a process that always returns the same
string.

Fixed by reading it once in `main()` and threading it in as `st_health(tc)`:
**1.8-2.1 ms, about 140x faster**, same body. The comment that justified the old
behaviour ("read once per request rather than cached, because the toolchain must
not be stale") was reasonable and wrong - the running server *is* a product of the
toolchain it reports, and that binary cannot change while the process lives.

**The general rule this produced: `exec` costs a quarter of a second here, so it
must never sit on a request path. And measure every endpoint, not the interesting
ones - the cheapest handler hid the worst latency.**

**Binary size** (`forgen build`, release, x86_64-pc-windows-msvc)

| Program | Size | Build |
|---|---|---|
| C hello, `cl /O2 /MD` | 9,216 B | - |
| C hello, `cl /O2 /MT` | 138,240 B | - |
| Datara hello world | 375,296 B (366.5 KB) | 285-450 ms |
| 400 functions / 2405 lines | 420,352 B (410.5 KB) | 751 ms |
| **the studio server, 2828 lines** | **500,224 B (488.5 KB)** | 739 ms |

The runtime floor is **~366 KB** and it is almost the entire hello world; per-line
cost is roughly **50 bytes**. The whole IDE costs **+122 KB over hello world**.
Shipped footprint - server exe, self-contained `ui/studio.html`, wasm-as-base64 -
is **895.5 KB**, against a 5.5 MB Tauri shell that is mostly WebView2.

`--tiny` is **broken**: it prints `Profile: Ultra-Compact (dead code stripped,
minimal footprint)` and produces a *larger* binary - 410.5 KB to **444.5 KB**
(+34 KB) on the 400-function program, 488.5 to 489.0 KB on the server, unchanged
on hello. Deterministic across repeats. Do not use it and do not quote its output
line.

**Runtime speed, against MSVC `/O2`** (5 runs each, interleaved; every pair
printed the same answer)

| Benchmark | Datara | C `/O2` |
|---|---|---|
| integer loop, 1e8 iterations | 0.571-0.601 s | 0.573-0.616 s |
| `fib(35)` | 0.303 s | 0.357 s |
| build + search 2e5 strings | 0.262 s | 0.322 s |
| push + sum a 5e6 list | 0.301 s | 0.280 s |

Parity, not a handicap. Cranelift AOT is a real backend, and the string case being
*faster* than `snprintf`-based C is worth noting.

**Where the startup time goes** (launch to the server's own banner: ~850 ms)

| Component | Cost |
|---|---|
| process creation in this environment | ~275 ms |
| Datara runtime init, before `main` | ~285 ms |
| the server's own work (bind, banner) | ~290 ms |

The first line is this environment - a bare `true` in Git-Bash costs 275 ms here,
and an empty Datara exe 560 ms. On a normal Windows shell the process-creation
part would be 10-30 ms, so the realistic figure is roughly 350-400 ms. That is
also why every `exec` in the server costs a quarter of a second, and why the
figures above are upper bounds rather than a property of the compiler.

**Text core** (Rust to wasm, 40,070 B), measured on 1 MB / 20 000 lines:

| Operation | Time |
|---|---|
| load the document | 4.1 ms |
| lex the whole document | 5.6 ms (260 001 tokens) |
| verify the line index against a rebuild | 4.4 ms |
| one edit in the middle | 0.091 ms |

**Verification**: 8 stages, **298 assertions**, all green - 40 text core, 30
highlighting, 170 interface, 58 editor, plus a boot test of the shipped artifact
and `forgen check` on the server. The interface suite parses the compiler's real
coloured output, captured from the installed binary rather than written by hand,
because a hand-written sample of a broken-output bug is the one sample that will
not contain the bug.

---

## 11. If I could change three things

1. **Put the class back into `Inst::GetField`, then delete
   `field_default_offsets` and make an unresolvable class a hard error.** In that
   order, because the fallback exists only because the instruction lost the
   class: fix the instruction and the guess has nothing to guess from. Everything
   else in this document is a papercut; this one is a correctness hole, and a
   compiler that guesses is worse than one that stops.
2. **Make `exec` encoding-aware in both directions.** Two conversions, and the
   IDE deletes a table and a whole class of "works in the terminal, breaks in the
   browser".
3. **Return errors instead of empty strings.** `file_read`, and anything else
   that currently fails quietly. A missing error is more expensive than a missing
   feature, because a missing feature is visible.

And a fourth that is one line of code and would delete two workarounds from this
IDE: **do not colourise a non-TTY.** `IsTerminal` plus `NO_COLOR`, the same as
every other compiler. The colour is only useful on a terminal, and on a pipe it
is data corruption with a nice hue.
