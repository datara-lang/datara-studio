# Compiler notes — forgen, established by experiment

Everything in this file was measured against the installed compiler, not read
from its documentation. Where the README and the compiler disagree, the
compiler wins and the disagreement is recorded here, because these differences
shaped the kernel's design.

Most findings were established against **1.3.0** and re-checked against the
installed **1.3.4**; where a version changed the behaviour it says so. Note that
1.3.4 fixed *half* of finding 1 - field order is now declaration order rather
than alphabetical - while the bare-name offset lookup below is untouched.

Reproduce any claim with the probe projects under `probes/`:

```
source scripts/env.sh
forgen run probes/field_collision/main.dtr
```

---

## 1. Struct field names share ONE global offset table (silent miscompilation)

**Severity: critical.** This is the single most dangerous property of the
compiler for a project this size. It produced every mysterious bug in the kernel
and cost the most time to find.

forgen keeps struct field offsets in one table keyed by **field name alone**.
The first struct to declare a name fixes that name's offset; every later struct
that reuses the name reads and writes at the *first* struct's offset.

**There is no diagnostic. No warning. No runtime error.** The only symptom is
wrong data, and it is layout-dependent, so it appears and disappears as
unrelated fields are added elsewhere in the project.

### The experiment that settled it

`probes/fieldnames_shared` and `probes/fieldnames_unique` contain the same three
struct layouts, differing only in whether the field names are shared:

| project                       | result                          |
|-------------------------------|---------------------------------|
| `fieldnames_shared`           | 2 of 3 structs corrupt          |
| `fieldnames_unique`           | all 3 correct                   |
| `probes/layout_iso/*` (each layout alone) | all 7 correct        |

So the layouts are individually fine. Co-existence is what breaks them.

### The minimal repro, and the variable nobody expected

`probes/field_offset_min/main.dtr` reduces the whole thing to two one-field
structs and eleven lines of code:

```datara
pub struct SA { scope_id: Int }
pub struct SB { s_id: Int, scope_id: Int }

pub fn sa_make() -> SA => SA { scope_id: 77 }
pub fn sb_make() -> SB => SB { s_id: 5, scope_id: 42 }

fn sa_get(view x: SA) -> Int => x.scope_id
fn sb_get(view x: SB) -> Int => x.scope_id

fn main() {
    mut xs: List<SB> = []
    xs = xs.push(sb_make())
    let x = xs[0]
    println("SA.scope_id = " + int_to_str(sa_get(sa_make())))   // 77, correct
    println("SB.scope_id = " + int_to_str(sb_get(x)))           // 5,  must be 42
}
```

`SB` declares `scope_id` second, at offset 8; `SA` declares it first, at offset
0; the read of `SB.scope_id` returns `SB.s_id`. Exit code 0, no diagnostic.

**Two variables decide whether it fires, and the second one is new.**

1. **The layout.** With the same name and *two* fields ahead of it in `SA`
   (`a0: Int, a1: Int, scope_id: Int`), `SA` and `SB` happen to put `scope_id`
   at the same offset and the program is accidentally correct. Measured over
   `SA` leading fields 0, 1, 2, 3, 4, 5, 7:

   | leading fields in SA | `SB.scope_id` read | expected |
   |---|---|---|
   | 0 | 5 (its own `s_id`) | 42 |
   | 1 | 140701747118128 (a pointer) | 42 |
   | 2 | **42** | 42 - correct by coincidence |
   | 3 | 0 | 42 |
   | 4 | 0 | 42 |
   | 5 | -9223362015254351720 | 42 |
   | 7 | 8386104319403253620 | 42 |

2. **The field name.** Same shape, same offsets, only the name changed, five
   runs each:

   | verdict | names |
   |---|---|
   | corrupt | `x`, `y`, `w`, `z`, `zz`, `zzz`, `size`, `value`, `scope_id`, `total`, `state` |
   | correct | `a`, `aa`, `aaa`, `q`, `qq`, `qqq`, `s`, `r`, `m`, `b`, `f`, `n`, `id`, `count`, `data`, `kind`, `flag`, `dup`, `len` |

   Nonsense names split too - `zzz` corrupts and `aaa` does not - so the deciding
   factor is a property of the name itself rather than its meaning. Most likely
   its hash, which points at a `HashMap` in the offset lookup rather than the
   plain `String` key the source suggests. Not yet identified from the outside;
   recorded because it changes how you debug this, and because **it cost an
   afternoon of "it will not reproduce"** - the first three hand-built repros
   used `dup`, which is in the correct list.

   A consequence worth stating plainly: renaming a field can make this bug
   disappear without fixing it. The rule below is therefore not a style
   preference.

### The mechanism, from the source

`Inst::GetField` in `src/dmir/ir.rs:114-119` carries the field name and the field
type but **not the class the field belongs to**:

```rust
GetField {
    dest: ValueId,
    object: ValueId,
    field: String,
    ty: String,      // the type, yes; the owning class, no
},
```

So the backend has to *guess* the class at every field read, and it does so by
three fallbacks in `src/codegen/cranelift/backend/compile_func.rs:557-574`:

```rust
let current_class_name = val_to_class.get(object)        // what StructInit recorded
    .map(|s| s.as_str())
    .or_else(|| f.params.first().map(|p| p.1.as_str()))  // or the first parameter's type
    .unwrap_or("");                                      // or nothing at all
let base_c = current_class_name.split('<').next()...split('_').next()...;
let offset = class_field_offsets.get(current_class_name)
    .or_else(|| class_field_offsets.get(base_c))
    .and_then(|m| m.get(field).copied())
    .or_else(|| field_default_offsets.get(field).copied())   // <-- the guess
    .unwrap_or(0);
```

When the class is lost - and `DATARA_CODEGEN_TRACE=1` shows it is, because the
accessor is inlined into a caller whose first parameter is not the struct, so
`class=""` - the per-class map cannot be consulted and the global bare-name map
decides. That map is built at `src/codegen/cranelift/backend/declare_module.rs:424-431`:

```rust
let mut sorted_cls_names: Vec<&String> = dmir_module.class_fields.keys().collect();
sorted_cls_names.sort();                       // <-- class names, sorted
for cls_name in sorted_cls_names {
    for (idx, fname) in fields.iter().enumerate() {
        field_default_offsets.entry(fname.clone()).or_insert((idx * 8) as i32);  // first wins
    }
}
```

The comment above it says first-wins is deliberate, to stop HashMap iteration
order making codegen nondeterministic. It does not say that "first" is *sorted
class name*, and that is the whole defect: **the winner for a shared field name is
whichever class sorts first alphabetically.**

**Measured, and it is a second way to flip the bug.** Same field name, same
layouts, only the class names changed:

| classes | sorted order | `SB.scope_id` read | expected |
|---|---|---|---|
| `SA` / `SB` | SA first | 5 (its own `s_id`) | 42 |
| `SZ` / `SB` | SB first | 42 | 42 |

So the defect is not only name-dependent but **class-name-dependent**: renaming a
struct - a refactor someone might do for unrelated reasons - can switch it on or
off. Crossed against the field names:

| field | `SA`/`SB` (A first) | `SZ`/`SB` (B first) |
|---|---|---|
| `scope_id`, `total`, `value`, `zzz` | CORRUPT | correct |
| `dup`, `aaa`, `count`, `len` | correct | correct |

**The one thing still unexplained**, stated rather than smoothed over: whether the
fallback is *reached* also varies with the field name, and `DATARA_CODEGEN_TRACE=1`
prints an identical line for a corrupt case and a correct one
(`fn=main class="" field=<name> offset=0`). So something else - folding, or a
second resolution path - decides for the "immune" names, and the trace does not
show it. Reproduce with:

```
DATARA_CODEGEN_TRACE=1 forgen run probes/field_offset_min/main.dtr
```

**The fix, in the order that matters.** Carry the class in `Inst::GetField` (and
`SetField`) so the read site never has to guess; delete `field_default_offsets`
so no fallback can exist; and make an unresolvable class a hard error. The
fallback only exists because the class is missing from the instruction - fix that
and the rest follows.

### Earlier theories, and why they were wrong

The first bug found was `RopeChunk.source: Int` reading back as `""` once
`Event.source: Str` was imported. The natural conclusion was "same field name
with a different *type* collides", and that became linter rule R10. It was
tested against these cases and held:

| declaration A            | declaration B            | observed        |
|--------------------------|--------------------------|-----------------|
| `A.f : Int`              | `B.f : Int`              | both correct    |
| `P.items : List<Int>`    | `Q.items : List<Str>`    | both correct    |
| `G<T>.k : T`             | `H.k : Int`              | both correct    |
| `Rev.value : Int`        | `Field.value : Str`      | **broken**      |

R10 was therefore narrowed to "different scalar types". That was still wrong.
The `Int`/`Int` case only looked safe because the two structs happened to give
`f` the same offset. The rule is about **the name**, not the type.

### Symptoms, all with zero diagnostics

* `RopeChunk.source: Int` read back as `""`. Consequence:
  `rope_insert(rope_new("hello world"), 5, ",")` returned `",,"` instead of
  `"hello, world"`.
* `Subscription.delivered` / `deferred_mode` / `cancelled` read back as values
  belonging to other fields, so the event-bus self-test reported
  `expected 3 deliveries, got 1` and then a 1/2 sync/deferred split.
* `TestResult.passed` read as `Unit`.
* In the minimal repro, the program printed **nothing at all** and exited 0.

### The rule this project follows

**Every struct field name is globally unique**, and every field carries a
struct tag: `Event` → `ev_*`, `Subscription` → `sub_*`, `Delivery` → `dlv_*`,
`Rope` → `rope_*`, `RopeChunk` → `chunk_*`, and so on.

Two tools enforce it:

* `scripts/uniquify_fields.py src --apply` performs the rename. It needs the
  type of the expression before each `.`, so it does lightweight inference from
  function signatures, struct literals, `let`/`mut` bindings and call return
  types, and recurses into call arguments.
* `scripts/style_check.py` rule **R11** fails the build if any field name is
  declared by more than one struct. R10 is kept for the narrower scalar-clash
  diagnosis. Both run before every build.

Naming discipline: **a field name is unique across the entire project, forever.**
Readability comes from the suffix (`ev_cancelled`, `sub_cancelled`), not from
short names.

---

## 2. `view` goes before the parameter name, not after the type

The README shows `name: view Type`. The compiler rejects that with
`Expected type name` / `Expected ')' after parameters`.

```datara
pub fn rope_len( view r: Rope) -> Int { ... }   // correct
pub fn rope_len(r: view Rope) -> Int { ... }    // rejected
```

Encoded as linter rule **R1** (auto-fix).

## 3. `pub` is not accepted on struct fields or on top-level `let`

```datara
pub struct Rope {          // pub on the struct: OK
    original: Str          // pub here: "Expected member name"
}
pub let X = 1              // rejected
pub fn ryan_abi() -> Int => 1   // the idiom that replaces `pub let`
```

Rules **R6** and **R7**.

## 4. `str_starts_with` / `str_ends_with` / `str_contains` return `Int`

`src/types/prelude.rs` declares `str_contains` as returning `Bool`, but the
runtime yields an `Int`, so a bare use in a condition is not reliable. The
kernel always compares explicitly:

```datara
if str_contains(s, "x") == 1 { ... }
```

Rule **R2** (auto-fix).

## 5. No bitwise operators, no if-expressions, no `break`

* `|` and `&` do not exist; use `math_or`, `math_and`, `math_shl`. `or(` and
  `and(` are reserved keywords and cannot be called as functions.
* `let x = if ... { } else { }` is a parse error. Use `mut x = default` then
  assign inside an `if`.
* `break` inside `while` is rejected. Loops use a flag plus a compound
  condition instead.
* There is no `\u{...}` escape; non-ASCII must be embedded literally.
* `async` breaks any identifier it prefixes (`async_mode` → `Unexpected token`),
  so the kernel says `deferred_mode`.
* `out` and `from` are statement keywords and cannot be identifiers.
* `str_substr` does not exist; the builtin is `str_substring(s, start, len)`.
* `class` is deprecated in favour of `struct` + `behavior` (warning W0100).

Rules **R3**, **R4**, **R5**, **R8**, **R9**.

## 6. Reading `acc[0]` immediately after `push` is not understood

```datara
mut acc: List<Str> = []
acc = acc.push("x")
let v = acc[0]        // E0947: Index 0 is out of bounds for array of length 0
```

The bounds checker does not track the `push`. Reading the list inside a helper
function works, and that is the workaround the kernel uses.

## 7. A `List<Str>` returned across a function boundary can be corrupted

Observed while diagnosing the field collision: a bare
`pub fn build() -> List<Str>` returned pointer-shaped integers
(`140695623106688`) instead of strings. Wrapping the element
(`List<StrBox>`) or never letting the list leave the function both work.

This was a *symptom of rule 1*, not an independent bug — it disappeared once
the field collisions were fixed. It is recorded because the symptom is
misleading: it looks like a list bug and is actually a name-collision bug.
When something in Datara misbehaves inexplicably, **check R10 first.**

## 8. `forgen` AOT linking needs MSVC `link.exe` first on PATH

On a Git-Bash machine the GNU coreutils `link` shadows MSVC's and AOT linking
fails with `extra operand '/DEBUG:NONE'`. `scripts/env.sh` prepends the MSVC
toolset bin directory and sets `LIB` / `INCLUDE`.

`forgen run` (Cranelift JIT) is unaffected and needs no toolchain setup.

## 9. Diagnostics are colourised even when the output is a pipe

**Severity: high for tooling, zero for humans reading a terminal.** `forgen
check` writes ANSI escape sequences unconditionally - there is no `isatty` check
and no `NO_COLOR` handling - so a program that captures its output receives
control characters. Byte for byte from the installed 1.3.4 binary:

```
\033[1;31merror[E-TYPE-001]\033[0m: \033[1mType mismatch ...\033[0m
  \033[1;34m-->\033[0m \\?\D:\...\bad.dtr:2:5
     \033[1;34m|\033[0m     \033[1;31m^^^^^^^^^^^^^^\033[0m
     \033[1;34m=\033[0m \033[1;36mhelp:\033[0m parse String to Int using 'str_to_int(val)'
```

One error, seven or eight lines carrying ESC. For a consumer this breaks three
things: a raw control character makes an enclosing JSON document invalid; the
parse anchors on column-0 shapes (`error[...]`, `-->`, `= help:`) which the codes
push out of alignment; and escaping alone only moves the problem, because the
browser then renders `\u001b[1;31m` as literal text.

Worked around in `datara-studio` (`st_strip_ansi` + the control-character branch
of `st_json_escape`, PORTING.md SEAM-8) and verified end to end.

**Fix:** do not colourise a non-TTY. In the 1.4.0 tree the decision is
`src/diagnostics/engine.rs:94-96`, where `format_all()` hardcodes
`format_with_options(true)`; `format_plain()` (`:98-100`) already exists and is
called from nowhere. The colour is baked into a `String` at
`src/driver/pipeline.rs:413` and ~30 sibling sites, so the CLI cannot un-colour it
at the print site (`src/cli/build.rs:67`). `src/lint/diagnostics.rs:148-150` is
worse than unconditional: a function named `is_terminal()` that only checks
`NO_COLOR`, so `forgen lint` colours a pipe as well. The idiom is already used
elsewhere in the tree - `src/repl/mod.rs:418`, `std::io::IsTerminal`.

Related, and worth fixing in the same pass: the success line goes to stdout
(`src/cli/build.rs:65`) and the diagnostics to stderr (`:67`), so a consumer
reading only stdout sees "Verified 100% OK" beside exit code 1.

## 10. A multi-file check resolves every `use` against ONE file's directory

**Severity: high for any tool that runs `forgen check` on more than one file.**

`src/driver/mod.rs:242` derives the module search path from the first path in the
list:

```rust
let base_dirs = self.module_base_dirs(paths[0].as_path());
```

`paths[0]` is the entry point chosen by `src/project/discovery.rs:183-190` - the
first `main.dtr` in the sorted list, or the first path when there is none. And
`module_base_dirs` (`src/driver/modules.rs:17-32`) contributes only that file's
parent, its grandparent, and the cwd. Every *other* file's `use` is therefore
resolved against the wrong directory, falls through to the stdlib, and is
reported as an external dependency (`src/driver/modules.rs:874`):

```
[Forgen] package 'beta' not found; run `datara install beta` or set FORGEN_AUTO_INSTALL=1
error[E-RESOLVE-005]: Module 'beta' not found in project or stdlib
```

Minimal repro: two sibling directories, each holding a `main.dtr` and one module
it imports.

| command | result |
|---|---|
| `forgen check <parent of both>` | `E-RESOLVE-005` for `beta`, in `b/main.dtr` |
| `forgen check <b>` | 2 modules, 0 errors |
| `forgen check <a>` | 2 modules, 0 errors |

Same files, same compiler, only the target changed. Note what this is **not**: it
is not about `datara.toml`. Neither repro directory has a manifest and both check
clean, and the resolution code never consults one. A plausible story that fits the
symptom ("a directory without a project file makes every import a package") was
written down first and then falsified by this experiment; the real cause is the
`paths[0]`-only base directory.

**Fix:** build the base directory list per importing file, or union the
directories of every path in the check, instead of taking one file's. A compiler
that cannot resolve a module should also say which directories it searched.

## 11. Reserved words, and the probe that never ran because of one

`shared` is a reserved word. It is in the list this project already knew about
(`out`, `from`, `where`, `view`, `class`, `own`, `type`, `require`, `ensure`,
`val`, `bits`) and it is not an obvious one, because it reads like an ordinary
field name.

Consequence, found when the IDE began checking the whole project:
`probes/field_collision/broken_a.dtr` and `broken_b.dtr` - the two files that
exist to demonstrate finding 1 - both name their field `shared`, so they fail to
compile with `E-SYNTAX-001: Expected member name` on line 3. `main.dtr` mentions
`use broken` only in a comment, so nothing pulls them in and nothing noticed. The
probe has therefore never demonstrated a silent miscompilation; it demonstrates a
syntax error. The probes that do reproduce the defect are `fieldnames_shared` and
`fieldnames_unique`.

Rename the field (`shared_v`) and import the pair, or the evidence for the most
serious finding in this file is missing.

## 12. The compiler is not the documentation

`D:\DATARA\datara + forgen\README.md` is 151 KB and substantially inaccurate on
several of the points above. The reserved-keyword list and the builtin-function
list in this kernel were extracted from `src/lexer/mod.rs` and
`src/types/prelude.rs` rather than from the README.

## 13. String comparison is not deterministic (1.4.0)

**Severity: critical, and the most surprising defect found so far.** `<` and `>`
on `Str` return different answers for the same operands on different runs of the
same binary. This is not a wrong answer that a test could catch and pin - it is
an answer that changes, which means a program that sorts strings has no correct
output to compare against.

Measured on the installed 1.4.0, with `probes/`-style standalone binaries run
eight times each:

* A hand-written insertion sort over four fields named `a, b, c, d` returned
  **eight different orders in eight runs** - `b c a d`, `d b c a`, `d a c b`,
  `c a b d`, `c a d b`, `d b a c`, `b a c d`, `d c a b`. The correct order is
  `a b c d`.
* The same defect reached the HTTP surface: six identical `POST /api/layout`
  requests against one unchanged source file returned six different field orders.
* Instrumented, the comparison itself is the liar. With `prev_name` printing as
  `a` and `cur_name` printing as `b`, `prev_name > cur_name` evaluated `true` on
  one run and `false` on the next. Both operands were correct at the moment they
  were printed.

**What is not the trigger.** String comparison in a small function with literal
or freshly built lists is stable - `"a" < "b"` was correct across every run of
every isolated probe, including one that read both operands out of a `List<Str>`
by variable index inside nested loops. The defect appears only when the sort runs
inside a larger function. Extracting the sort into its own function did **not**
fix it. It is therefore sensitive to the surrounding frame, which points at
register allocation or stack slot reuse rather than at the comparison itself.

**What is the trigger.** Any name comparison inside the sorting loop. Forcing the
caller to skip the sort entirely made the output deterministic again, which is
how the loop was isolated as the site.

**Workaround, and it is exact.** Compare bytes as integers instead of using the
operators:

```datara
fn st_name_before( a: Str, b: Str) -> Bool {
    let na = byte_len(a)
    let nb = byte_len(b)
    mut i = 0
    while i < na && i < nb {
        let ca = str_byte_at(a, i)
        let cb = str_byte_at(b, i)
        if ca < cb { return true }
        if ca > cb { return false }
        i = i + 1
    }
    return na < nb
}
```

With this in place the layout inspector returned the same correct order on eight
consecutive requests. Byte order is also the order the compiler's own
`layout.rs` uses, because it compares the names as Rust `String`s, so the
workaround is not an approximation.

**Fix, in order:** make `Str` comparison deterministic, then reproduce with the
same sort inline in a large function; and add a test that runs a string sort
several times in one process and asserts the result is identical, because a
single-run test passes about one time in six.
