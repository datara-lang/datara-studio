# Datara in practice: an assessment against forgen 1.4.3

What it is like to write a real program in this language, measured rather than
asserted. Written 2026-09-18 on Windows x86_64, against the installed
**forgen 1.4.3**.

**The evidence base is this repository.** Datara Studio is 4,701 lines of Datara
across six modules - 185,560 bytes - implementing an HTTP server, a filesystem
explorer, a layout inspector, a toolchain probe and a compiler bridge. It is not
a benchmark; it is a program that has to work, and it does. Every claim below
either cites a measurement taken today or says which earlier measurement it is
quoting.

**This supersedes `DATARA-ERGONOMICS.md` for the state of the language.**
That document was written against forgen 1.3.4 and re-tested against 1.4.0, and
it is now three releases stale - its ranked list of problems is the part a reader
would act on, and three of the seven entries no longer hold while two more are
half retired. It has been marked
historical and cross-referenced rather than deleted: how the findings were
reached is still worth reading, and the method in it is the method used here.
The one claim from it that this report did not re-measure was re-checked today
anyway, because it is a reason not to use the language at all - see
`probes/modulo_ifexpr`.

---

## The headline

**The five defects that made this language dangerous to use have been fixed, and
that is the most important thing that has happened to Datara since it compiled
its first program.** They were not cosmetic. Each one returned a wrong answer
instead of an error, which is the failure mode that makes a language unusable
for anything load-bearing.

One new defect has been introduced in their place. It is loud, it is narrow, and
it is in the release optimizer - which is a much better place to be than where
this language was.

---

## 1. Re-measurement: what 1.4.3 changed

Each row was measured today by running the probe in this repository against a
freshly built AOT binary. "AOT" matters: the string defects were AOT-only, and
JIT runs are not evidence about a shipped binary.

| Defect, as measured on 1.4.2 | Status in 1.4.3 | Evidence |
|---|---|---|
| Struct field offsets resolved by bare name across the program - a **silent miscompile** | **Fixed** | `probes/field_offset_min`: `SA.scope_id = 77`, `SB.scope_id = 42`, both correct |
| `Str` comparison not deterministic - 8 runs, 8 different orders | **Fixed** | 8 consecutive runs of one binary now print the identical, correct `a b c d` |
| A run-time-built string does not survive the trip into `system()` under AOT | **Fixed** | a built command wrote its file; the literal control did too |
| `env_set` with a run-time-built value corrupts it | **Fixed** | see below |
| `str_index_of` on a long string segfaults under AOT | **Fixed** | 3,000-byte haystack returns `0`, exit 0 |

### The `env_set` case, because it is the one that broke this IDE

The failure was not a three-byte value. It was this, the exact shape that
`tc_prepend_msvc` used on the most-polled endpoint:

```
env_set("PATH", "MARK;" + env_get("PATH"))
```

On 1.4.2 that left the child unable to resolve `git`, `python` or `cmd.exe`, and
the entire IDE went dead behind it - an unreadable tree, no worktree chip, a dead
companion switch, drag-to-folder doing nothing. A 1,500-character loop-built
string arrived as a single garbage byte.

Re-measured on 1.4.3, with the child reporting what it received:

```
PATH bytes as this process sees it = 2340
staged bytes                        = 2345
c_git    29 bytes : git version 2.55.0.windows.3     <- control
b_git    29 bytes : git version 2.55.0.windows.3     <- after the staged PATH
path   2348 bytes : MARK;C:\Program Files (x86)\Microsoft Visual Studio\...
big    1503 bytes : ZZZZZZ...
```

The child still resolves `git`. The 2,345-byte PATH arrives intact. The
1,500-character value arrives as 1,503 bytes rather than one byte. All four
shapes pass.

**Consequence for this repository:** the `SEAM-1` indirection in
`src/explorer.dtr` - writing the command into a script file and invoking the
script with a compile-time literal - is no longer *required*. It has not been
removed, and should not be removed reflexively: routing the environment through
the child also disposes of shell-quoting and `%`-doubling hazards, so it is
defensible engineering rather than a workaround. But it should stop being
described as a workaround, and the comment in `PORTING.md` should say it was
retired on evidence rather than kept out of caution.

---

## 2. The new defect, and why it is a better class of problem

```
$ forgen check main.dtr
[Forgen check] Verified 100% OK in 4ms (1 modules, 0 errors, valid ownership & effects)

$ forgen build main.dtr
[E0901] DMIR verification failed after optimizer pass 'intraproc':
        main: value 180 used in block 0 before its definition dominates it

$ forgen build --debug main.dtr
[Forgen] Build succeeded in 276ms (debug mode)
```

A 130-line program that the checker certifies 100% OK **cannot be built in
release mode.** The optimizer emits invalid IR, and the compiler's own verifier
catches it. Turn the optimizer off and it builds, runs, and prints entirely
correct output.

Reproduced on both `probes/fieldnames_unique` and `probes/fieldnames_shared` -
the same two probes that demonstrate the now-fixed field-offset defect.

Three things make this a better failure than what it replaced:

1. **It is loud.** A wrong answer can be caught by a test; a build that stops is
   caught by a build. The compiler refuses to produce a binary rather than
   producing a wrong one.
2. **It is the compiler's own verifier talking.** `E0901` is forgen checking its
   own work and reporting honestly that it broke something. That machinery is
   the reason the silent defects are now gone, and it is working.
3. **It is narrow.** It needs the release optimizer; debug is unaffected; the
   IDE itself builds clean in release at 510.5 KB.

**The thing to fix is not the optimizer pass.** It is that `forgen check` and
`forgen build` disagree about whether a program is valid. This repository's build
gate runs `forgen check` and nothing else, so it is structurally unable to catch
this class of failure: a green gate currently means "the front end is happy",
not "a binary can be produced". Any CI that only checks is running half a gate.

---

## 3. Performance: the honest numbers

Measured today on this machine, on the 4,701-line / 185,560-byte server.

| Operation | Time |
|---|---|
| `forgen --version` (process startup floor) | **561-566 ms** |
| `forgen check src/main.dtr` | **1,018-1,098 ms** |
| `forgen build src/main.dtr` (release) | **1,597-1,682 ms** |
| AOT output size | 510.5 KB |

**The startup floor is the finding.** `forgen --version` does no work at all and
costs 560 ms. So of a 1,050 ms check, roughly **490 ms is checking and 560 ms is
starting up**. More than half the cost of asking the compiler a question is
getting the compiler to exist.

This is the same shape as the `exec` cost measured earlier at 225-270 ms per
call, which produced the largest performance bug this IDE has had: `/api/health`
spawned a process on every request and took 245-305 ms while a filesystem walk
took 5.5 ms. It is now 560 ms, and it is the reason a compiler cannot be used as
a library.

An earlier assessment recorded `forgen check` at 140-185 ms on a 2,051-line
server. Today it is ~1,050 ms on 4,701 lines. Compiler version and codebase both
changed, so the two figures are not a controlled comparison - but the direction
is unambiguous, and that assessment made a prediction which has now come true:

> Incremental compilation for `check`. 150 ms is fine for one file; on a large
> project the whole-program check will not stay this fast.

It did not stay this fast. **At one second per check, "check on every keystroke"
is no longer achievable**, and this IDE's live diagnostics are the feature that
depends on it. The fix that matters is not making the checker faster - it is
keeping the compiler process alive and talking to it.

### The parts that are genuinely good

**Memory.** The whole server, after a tree scan, a compiler check and a health
call: **11.7 MB working set, 6.2 MB private**. There is no runtime, no GC and no
interpreter, and it shows. For scale, measured in the same minute on the same
machine: a Node process is 42-67 MB.

**The diagnostics are the best part of the compiler.** Machine-readable code,
exact line and column, a caret span showing the length of the offending
expression, the source line, and an `forgen explain E-TYPE-001` hint. That is
more than most compilers provide, and it is why this IDE's squiggles come from
the real compiler rather than from a reimplementation.

```
error[E-TYPE-001]: Type mismatch for argument 1: expected 'Int', got 'Str'
  --> \\?\D:\...\bad.dtr:7:12
   |
 7 |     return helper("not an int")
   |            ^^^^^^^^^^^^^^^^^^^^
   = note: for more details, run 'forgen explain E-TYPE-001'
```

**AOT is genuinely native.** 4,701 lines to a 510 KB standalone executable, with
no runtime to ship. That is a real property and not many languages have it.

---

## 4. What writing it is actually like

### The good

- **Reading it is pleasant.** The syntax is small and regular, `pub fn` /
  `fn` visibility is real and enforced, and a file reads top to bottom.
- **Ownership and effects are visible in signatures.** `unsafe(justification:)`
  is irritating in practice, but the idea that a function's I/O is declared is
  right, and a compiler-native editor can surface what no text editor can.
- **The error messages teach.** The `forgen explain` hint and the caret span
  mean a beginner can act on a diagnostic without asking anyone.

### The friction, which is real and constant

| Missing | What you write instead |
|---|---|
| `break` | a flag and a compound loop condition |
| `continue` | nested `if` / `else` |
| `%` | `a - (a / b) * b`, or repeated subtraction |
| if-expressions | `mut x = default` then assign inside an `if` |
| `const` | a zero-arg `fn` |
| indexing a `List<Str>` | a helper function, always |
| closures / function values | a static dispatch table or an out-of-process protocol |

**`unsafe(justification: "...")` on every capability call.** There is no
`[capabilities]` section in `datara.toml`, so a program that reads a file must
write a sentence justifying it, at every call site. This project has 30-odd of
them. The capability *model* is a good idea; the absence of any way to grant a
capability to a module is what turns it into ceremony.

**Reserved words reach ordinary identifiers**: `out`, `from`, `where`, `view`,
`class`, `own`, `shared`, `type`, `require`, `ensure`, `val`, `bits`. Naming a
parameter `from` is a parse error. This is a small thing that costs time every
single day, and it is the cheapest item on this list to fix.

**The namespace is flat.** `use` merges everything, so every public name carries
a manual prefix (`rope_len`, `bus_publish`) and collisions are silent.

### What a senior developer would ask for, in order

1. **A directory listing builtin.** This IDE shells out for every listing - a
   process creation per call. `fs_readdir(path) -> List<Str>` removes a whole
   class of problem, including the two-codepages-one-process problem below.
2. **Errors as values, not empty strings.** `file_read` returning `""` for
   non-UTF-8 content is the archetype. The language already has `Outcome<T>`.
3. **A way to build a string from bytes.** Without it there is no binary buffer,
   no charset encoding, and no escape from the codepage problem from user code.
4. **A concurrency primitive.** Not threads necessarily - but a Datara server
   cannot bound a socket read, so one idle connection blocks the accept loop
   permanently. This is the whole gap between "a language I can write tools in"
   and "a language I can write servers in".
5. **`forgen fmt`.** Every project invents its own style.

Two smaller ones, both measured and both still open as far as this repository
knows: `socket_bind` succeeds twice on the same port, so two servers split
traffic silently instead of one failing with "port in use"; and the language
reference still disagrees with the compiler in places - the README declares
`str_contains` as `Bool` where the compiler returns `Int`. A reference that
disagrees with its implementation teaches users to distrust both.

---

## 5. The verdict

**Datara is now a language I would choose for a program like this one.** That is
a change of answer from the last assessment, and it is not a softening - it is
what the measurements say. The defect that made it unsafe was that it would
compile something other than what it read, silently. Five instances of that are
gone, and the one that replaced them refuses to build.

Ranked by what would change the experience most:

| # | Item | Class |
|---|---|---|
| 1 | `check` and `build` disagree: `E0901` rejects programs the checker certifies | **blocks release builds** |
| 2 | 560 ms process-startup floor, so the compiler cannot be a long-lived library | performance |
| 3 | No `break` / `continue` / `%` / if-expressions / `const` | friction, constant |
| 4 | `unsafe(justification:)` with no module-level grant | friction, constant |
| 5 | Reserved words that reach ordinary identifiers | friction, constant |
| 6 | No directory listing, no error values, no byte-built strings | missing builtins |
| 7 | No concurrency primitive - servers cannot bound a read | missing, architectural |
| 8 | Flat namespace, no formatter | tooling |

**If one thing changes, make it #1.** A compiler that says 100% OK and then
refuses to link is a compiler whose verdict cannot be trusted in either
direction, and it is the only item on this list that can turn a green CI run
into a broken release.

**If two things change, make it #2.** Every ergonomic complaint above is felt
through an editor, and an editor cannot ask a compiler a question 60 times a
second if the question costs 560 ms before any work begins. Keeping the compiler
resident is worth more to how the language *feels* than any syntax change here.
