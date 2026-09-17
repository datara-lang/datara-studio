# probes/str_compare_order — string comparison is not deterministic

Reproduces finding 13 in `docs/COMPILER-NOTES.md`.

`main.dtr` parses four fields out of a source line and sorts them by name with a
hand-written insertion sort. It should print `a b c d` every time. It does not.

```
source scripts/env.sh
forgen build probes/str_compare_order/main.dtr
for i in 1 2 3 4 5 6 7 8; do ./main.exe; done
```

Measured on the installed 1.4.0, eight consecutive runs of one binary:

```
pub struct Short {:b c a d
pub struct Short {:d b c a
pub struct Short {:d a c b
pub struct Short {:c a b d
pub struct Short {:c a d b
pub struct Short {:d b a c
pub struct Short {:b a c d
pub struct Short {:d c a b
```

`instrumented.dtr` prints the comparison that lies. Both operands are printed
immediately before they are compared, and they are correct:

```
a=1 cur=1 cur_name=b
   b=0 prev=0 prev_name=a cmp=true      <- "a" > "b" is false
```

`cmp` differs between runs with identical operands.

## What is not the trigger

String comparison in a small function is stable. `"a" < "b"` was correct in every
run of every isolated probe, including one reading both operands out of a
`List<Str>` by variable index inside nested loops. Moving the sort into a function
of its own did not fix it either, so the defect is sensitive to the surrounding
frame — register allocation or stack slot reuse, not the operator itself.

## Workaround

Compare bytes as integers rather than using `<`/`>` on `Str`. See
`st_name_before` in `datara-studio/src/layout.dtr`. Byte order matches what
`layout.rs` produces, because it compares the names as Rust `String`s.
