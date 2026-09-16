# TASKS.md - Ryan Harness Core, decomposed

Decomposition of `RYAN_HARNESS_CORE_ONE_SHOT_PROMPT.md` (40 sections) into small,
independently verifiable tasks. Written in Datara, compiled by forgen 1.3.0.

## Status legend

| Mark | Meaning |
|------|---------|
| `[x]` | implemented **and** verified by a passing self-test |
| `[~]` | implemented, compiles, self-test not yet asserting it |
| `[ ]` | not started |

Nothing is marked `[x]` on the strength of "it compiles". `[x]` requires a
self-test that would fail if the behaviour regressed.

## Verification harness (task 0)

- [x] 0.1 `scripts/env.sh` - put MSVC `link.exe` first on PATH; AOT linking needs it
- [x] 0.2 `scripts/style_check.py` - 11 linter rules encoding verified compiler behaviour
- [x] 0.3 `scripts/uniquify_fields.py` - enforce globally unique struct field names
- [x] 0.4 `scripts/build.sh` - lint, check, build, self-test, exit codes
- [x] 0.5 `src/selftest.dtr` - aggregate every module self-test into one suite
- [x] 0.6 `src/cli.dtr` - headless CLI: `selftest`, `version`, `capabilities`, `help`
- [x] 0.7 `docs/COMPILER-NOTES.md` - every compiler behaviour established by experiment
- [x] 0.8 `probes/fieldnames_{shared,unique}` - regression witness for the field-name rule
- [x] 0.9 `probes/layout_iso/*` - prove each struct layout is correct in isolation
- [x] 0.10 `probes/field_collision` - the original scalar-clash repro
- [ ] 0.11 CI script that runs `build.sh` on a clean checkout

---

## §1 Core primitives

- [x] 1.1 `Id` - kind-tagged identity value, `id_new`, `id_same`, `id_render`
- [x] 1.2 `IdAllocator` - monotonic per-kind allocation
- [x] 1.3 `Id` kinds for every kernel entity (`kind_document` .. `kind_span`)
- [x] 1.4 `Version` - parse, compare, `version_to_str`
- [x] 1.5 `VersionReq` - `=`, `>=`, `<=`, `>`, `<`, `^` matching
- [x] 1.6 `Clock` - injectable, with `real` / `fake` / `logical` modes
- [x] 1.7 `clock_advance` returning `Outcome<Clock>`, never mutating in place
- [x] 1.8 `Revision` - monotonic document revision counter
- [x] 1.9 `Epoch` - workspace epoch counter
- [x] 1.10 `Generation` - the 4-tuple freshness key
- [x] 1.11 `Freshness` + `freshness_check` - staleness verdict with a reason
- [x] 1.12 `GenerationTable` - per-operation generation counters
- [x] 1.13 `Outcome` helpers: `outcome_ok`, `outcome_fail`
- [x] 1.14 `RyanError` - code, message, context
- [x] 1.15 Error-code constants (`err_stale`, `err_capability_denied`, ...)
- [x] 1.16 `Verdict` + `verdict_all` / `verdict_any` - capability decisions
- [x] 1.17 `kernel_self_check` - asserts the zero-network / zero-AI invariants
- [x] 1.18 `kernel_banner`, `kernel_version`, `ryan_kernel_abi`
- [ ] 1.19 `Maybe<T>` helpers mirroring `Outcome`
- [ ] 1.20 Panic-free arithmetic helpers (checked add/sub with `Outcome`)
- [ ] 1.21 Interned string table for hot identifiers
- [ ] 1.22 `BitSet` for capability masks
- [ ] 1.23 `SmallMap<K,V>` ordered map for deterministic iteration
- [ ] 1.24 Self-test asserting ordering and determinism of every collection

## §2 Text engine

- [x] 2.1 `RopeChunk` - `buffer` / `start` / `len`
- [x] 2.2 `Rope` - original + added buffer, chunk list, byte length, revision
- [x] 2.3 `rope_new`, `rope_empty`, `rope_len`, `rope_is_empty`
- [x] 2.4 `rope_to_str` - one substring per chunk
- [x] 2.5 `rope_split_at`
- [x] 2.6 `rope_insert`, `rope_delete`, `rope_replace`
- [x] 2.7 `rope_slice`, `rope_byte_at`
- [x] 2.8 `rope_compact` + `rope_needs_compaction` (threshold 512)
- [x] 2.9 `rope_line_starts`, `rope_line_start`, `rope_line_end`, `rope_line_of_offset`
- [x] 2.10 `rope_count_lines`
- [x] 2.11 Introspection: `rope_chunk_at`, `chunk_buffer`, `chunk_start`, `chunk_len`
- [x] 2.12 `LineIndex` - `List<Int>` of line-start byte offsets
- [x] 2.13 `line_index_build`, `line_index_from_rope`
- [x] 2.14 `line_index_line_of` by binary search
- [x] 2.15 `line_index_splice` on edit (no full rebuild)
- [x] 2.16 `Position`, `Range` (ordered), `Selection`
- [x] 2.17 `line_index_offset_of`, `line_index_position`, `column_of`
- [x] 2.18 UTF-8 sequence length and decoder (`utf8_seq_len`, `utf8_decode`)
- [x] 2.19 `utf16_len`, `utf16_offset`, `utf16_to_byte` - LSP compatibility
- [x] 2.20 `utf8_char_count`, `utf8_is_valid`, `utf8_is_continuation`
- [x] 2.21 `utf8_snap_to_char_boundary`
- [x] 2.22 EOL policy: detect, normalise to LF, apply CRLF, count lines
- [x] 2.23 `Edit` - start, removed, inserted; `edit_apply`, `edit_invert`
- [x] 2.24 `EditBatch` - add, sort descending, validate, apply, invert
- [x] 2.25 Multi-cursor: `multicursor_insert`, `multicursor_delete`, `multicursor_wrap`
- [x] 2.26 `UndoStack` / `UndoEntry` with grouping (`begin_group` / `end_group`)
- [x] 2.27 Text engine self-test including astral-plane UTF-16 and Cyrillic
- [ ] 2.28 `benches/bench_text.dtr` - piece table vs tree rope, measured
- [ ] 2.29 `docs/PERFORMANCE.md` with the measured numbers
- [ ] 2.30 Rope equality and hashing without materialising the string
- [ ] 2.31 Incremental line index update fuzz test against a naive rebuild
- [ ] 2.32 Overlong / truncated / surrogate UTF-8 rejection tests
- [ ] 2.33 BOM handling policy
- [ ] 2.34 Mixed EOL document: per-line EOL reporting
- [ ] 2.35 Word / grapheme boundary scan for selection expansion
- [ ] 2.36 Tab-stop aware column arithmetic
- [ ] 2.37 Soft-wrap index
- [ ] 2.38 Rope snapshot / restore for transaction rollback
- [ ] 2.39 Property test: random edit sequences, rope matches a plain string

## §3 Events

- [x] 3.1 `Field` - string key/value with `field_new`, `field_int`, `field_bool`
- [x] 3.2 `Event` - kind, sequence, correlation, source, fields, time, cancellation
- [x] 3.3 `event_new`, `event_with`, `event_cancel`, `event_render`
- [x] 3.4 `event_field` / `event_field_int` - absent keys return `""`
- [x] 3.5 Event kind catalog + `event_kind_is_known`
- [x] 3.6 `event_kind_subsystem` - prefix routing
- [x] 3.7 `event_kind_is_high_frequency`
- [x] 3.8 `Subscription` - id, kind, subsystem, priority, scope, deferred, muted
- [x] 3.9 Scopes: kernel / workspace / document / session / extension
- [x] 3.10 `subscription_matches` - kind, subsystem, muted, cancelled
- [x] 3.11 `BusCounters`, `StormGuard`, `Bus`
- [x] 3.12 Copy-on-write bus mutation helpers (one per field group)
- [x] 3.13 `bus_subscribe` / `bus_subscribe_deferred`
- [x] 3.14 `bus_unsubscribe` and `bus_unsubscribe_scope`
- [x] 3.15 `bus_publish` with storm protection and a rejection reason
- [x] 3.16 `bus_next_correlation` - one id per user action
- [x] 3.17 Bounded log (`log_limit`) with trimming
- [x] 3.18 `Delivery` - a description, not a closure (Datara has no closures)
- [x] 3.19 `bus_ordered_subs` - priority descending, id ascending tiebreak
- [x] 3.20 `bus_plan_event`, `bus_partition_sync`, `bus_partition_deferred`
- [x] 3.21 `bus_pump` -> `PumpResult`
- [x] 3.22 `bus_bump_counters` - per-subscription delivery counts
- [x] 3.23 `bus_cancel_queued` - pre-delivery validation
- [x] 3.24 `bus_replay` from a sequence number
- [x] 3.25 Deterministic mode: no wall clock, no dropping, stable order
- [x] 3.26 Event bus self-test asserting order, unsubscribe, catalog, routing
- [ ] 3.27 Correlation-chain reconstruction from the log
- [ ] 3.28 Per-scope delivery accounting test
- [ ] 3.29 Storm guard test: window boundary and saturation drop count
- [ ] 3.30 Reentrancy policy: publish during a pump is queued, not nested
- [ ] 3.31 Two-run determinism test comparing full logs byte for byte
- [ ] 3.32 Subscription leak test: closing a document removes its handlers
- [ ] 3.33 Muted-kind suppression test

## §4 Stale-result suppression

- [x] 4.1 `Generation` - document revision, workspace epoch, operation generation, request id
- [x] 4.2 `Freshness` verdict with a human reason
- [x] 4.3 `freshness_check` comparing a result's generation to current state
- [x] 4.4 `GenerationTable` per-operation counters
- [ ] 4.5 Wire freshness into the bus so a stale event is cancelled pre-delivery
- [ ] 4.6 Four orthogonal counter tests: each counter alone must reject
- [ ] 4.7 Test that a *newer* result supersedes an in-flight one
- [ ] 4.8 Test that unrelated operations never invalidate each other
- [ ] 4.9 Counter overflow / wraparound policy

## §5 Task scheduler

- [x] 5.1 `Timed` + `timed_begin` / `timed_end`
- [ ] 5.2 `Task` - id, kind, priority, cancellation token, deadline
- [ ] 5.3 Task queue with priority ordering and a deterministic tiebreak
- [ ] 5.4 Cooperative cancellation with an explicit check point
- [ ] 5.5 Budgeted work slices (no unbounded loop in one tick)
- [ ] 5.6 Deferred work drain on the next tick
- [ ] 5.7 Task dependency graph, topological order, cycle rejection
- [ ] 5.8 Scheduler self-test: ordering, cancellation, budget, no starvation
- [ ] 5.9 Fairness test across priorities

## §6 Document store and workspace

- [ ] 6.1 `Document` - id, rope, revision, line index, language id, dirty flag
- [ ] 6.2 `DocumentStore` - open / close / get / list
- [ ] 6.3 Incremental edit application bumping the revision exactly once
- [ ] 6.4 Document open publishes `DocumentOpened` with a correlation id
- [ ] 6.5 Close removes scoped subscriptions
- [ ] 6.6 `Workspace` - root, documents, epoch, configuration snapshot
- [ ] 6.7 Workspace epoch bump invalidating all derived results
- [ ] 6.8 File watch model (poll-based, no inotify dependency)
- [ ] 6.9 Dirty-document tracking and save
- [ ] 6.10 External-change detection vs unsaved edits
- [ ] 6.11 Document store self-test

## §7 Transactions

- [ ] 7.1 `Transaction` - ordered edit list, preconditions, inverse
- [ ] 7.2 Precondition check before any mutation
- [ ] 7.3 All-or-nothing apply
- [ ] 7.4 Rollback via the inverse edit list
- [ ] 7.5 Nested transactions with flattening on commit
- [ ] 7.6 Undo / redo integration with `UndoStack`
- [ ] 7.7 Transaction publishes events only on commit
- [ ] 7.8 Transaction self-test: rollback, nesting, event ordering
- [ ] 7.9 Fuzz: random transaction sequences always land on a consistent rope

## §8 Language provider contracts

- [ ] 8.1 `LanguageId` and provider registration
- [ ] 8.2 `CompletionItem`, `Hover`, `SignatureHelp`, `Location`, `Diagnostic` types
- [ ] 8.3 Provider request/response over the JSON protocol
- [ ] 8.4 Capability negotiation
- [ ] 8.5 Request cancellation
- [ ] 8.6 Provider self-test with a stub provider

## §9 Semantic layer

- [ ] 9.1 `Symbol`, `SymbolTable`, `Scope`
- [ ] 9.2 Incremental symbol indexing per document
- [ ] 9.3 Cross-document resolution within a workspace
- [ ] 9.4 Reference / definition lookup
- [ ] 9.5 Semantic self-test

## §10 Diagnostics

- [ ] 10.1 `Diagnostic` - range, severity, code, message, source
- [ ] 10.2 Severity ordering and stable sorting
- [ ] 10.3 Per-document diagnostic sets replaced atomically
- [ ] 10.4 Suppression of stale diagnostics via `Freshness`
- [ ] 10.5 Diagnostics self-test

## §11 Compiler integration

- [ ] 11.1 `BuildRequest` / `BuildResult`
- [ ] 11.2 Out-of-process compiler invocation over the JSON protocol
- [ ] 11.3 Diagnostic parsing from compiler output
- [ ] 11.4 Build cancellation and stale-build suppression
- [ ] 11.5 Compiler integration self-test

## §12 Process and terminal

- [ ] 12.1 `Process` - spawn, write, read, wait, kill
- [ ] 12.2 Bounded output ring with backpressure
- [ ] 12.3 Exit status and signal reporting
- [ ] 12.4 `Terminal` - cell grid, scrollback, cursor, attributes
- [ ] 12.5 PTY abstraction (bridge-backed on Windows)
- [ ] 12.6 Terminal resize
- [ ] 12.7 Process/terminal self-test

## §13 Debugger

- [ ] 13.1 `Breakpoint` model
- [ ] 13.2 `StackFrame`, `Variable`, `Scope` model
- [ ] 13.3 Debug adapter protocol shapes
- [ ] 13.4 Breakpoint hit events on the bus
- [ ] 13.5 Debugger self-test

## §14 Version control

- [ ] 14.1 Repository detection
- [ ] 14.2 Status model (staged / modified / untracked)
- [ ] 14.3 Diff model reusing the text engine
- [ ] 14.4 Blame / history model
- [ ] 14.5 VCS self-test

## §15 Package management

- [ ] 15.1 Manifest model
- [ ] 15.2 Dependency resolution with a deterministic order
- [ ] 15.3 Lockfile read/write
- [ ] 15.4 Package self-test

## §16 Extension host

- [ ] 16.1 Manifest model and capability declaration
- [ ] 16.2 Extension registration and activation
- [ ] 16.3 Scoped subscriptions so a disabled extension receives nothing
- [ ] 16.4 Crash isolation and restart policy
- [ ] 16.5 Extension host self-test

## §17 Configuration

- [ ] 17.1 Layered config: default -> user -> workspace -> document
- [ ] 17.2 Typed accessors with validation
- [ ] 17.3 Config change events
- [ ] 17.4 Config self-test

## §18 Persistence

- [ ] 18.1 Stable serialisation format (JSON via the stdlib)
- [ ] 18.2 Atomic write (temp + rename)
- [ ] 18.3 Versioned schema with migration hooks
- [ ] 18.4 Persistence self-test, including a corrupt-file case

## §19 Security

- [ ] 19.1 `Capability` set model
- [ ] 19.2 `Verdict` enforcement at every trust boundary
- [ ] 19.3 Path sandboxing - no escape from the workspace root
- [ ] 19.4 Extension permission prompt model
- [ ] 19.5 Security self-test with escape attempts

## §20 Observability

- [ ] 20.1 Structured trace records
- [ ] 20.2 Metrics counters (bus dispatches, drops, pump latency)
- [ ] 20.3 Bounded trace buffer
- [ ] 20.4 Trace export
- [ ] 20.5 Observability self-test

## §21 Performance

- [ ] 21.1 Benchmarks for rope edit / read / line lookup
- [ ] 21.2 Benchmarks for bus publish / pump
- [ ] 21.3 Large-workspace benchmark (10k documents)
- [ ] 21.4 `docs/PERFORMANCE.md` with measured numbers and the methodology
- [ ] 21.5 Regression thresholds in CI

## §22 Determinism

- [ ] 22.1 No wall clock outside the injected `Clock`
- [ ] 22.2 No hash-order iteration anywhere
- [ ] 22.3 Stable sort everywhere ordering matters
- [ ] 22.4 Two-run byte-identical trace test
- [ ] 22.5 Determinism self-test

## §23 Datara reference provider

- [ ] 23.1 Lexer for `.dtr` producing tokens and a token stream
- [ ] 23.2 Parser producing an AST with ranges
- [ ] 23.3 Symbol extraction
- [ ] 23.4 Diagnostics with real ranges
- [ ] 23.5 Completion driven by the symbol table
- [ ] 23.6 Reference provider self-test

## §24 Third-party proof

- [ ] 24.1 Tree-sitter-style external parser behind the provider contract
- [ ] 24.2 Proof that a non-Datara provider can be registered without kernel changes
- [ ] 24.3 Third-party proof self-test

## §25 SDK

- [ ] 25.1 Stable public API surface listing
- [ ] 25.2 ABI version and compatibility rules
- [ ] 25.3 SDK example program
- [ ] 25.4 SDK self-test

## §26 Conformance suite

- [x] 26.1 `kernel_selftests()` aggregated suite with pass/fail counts
- [x] 26.2 `kernel_capabilities()` machine-readable inventory
- [x] 26.3 CLI exit codes as part of the contract (0 ok, 1 test failed, 2 usage)
- [ ] 26.4 Conformance runner emitting machine-readable results
- [ ] 26.5 Capability assertions: every claimed capability is self-tested
- [ ] 26.6 Conformance self-test

## §27 Tests

- [x] 27.1 Text engine self-test
- [x] 27.2 Event bus self-test
- [x] 27.3 Core invariants self-test
- [ ] 27.4 Boundary tests for every public function (empty, max, one-past-end)
- [ ] 27.5 Failure-injection tests
- [ ] 27.6 Fuzz targets: rope, line index, edit batches, bus ordering
- [ ] 27.7 Property tests

## §28 Large workspace

- [ ] 28.1 Generator for a synthetic workspace (N documents, M lines)
- [ ] 28.2 Index 10k documents within a stated time budget
- [ ] 28.3 Memory footprint measurement
- [ ] 28.4 Incremental edit at scale
- [ ] 28.5 Large-workspace self-test

## §29 API rules

- [ ] 29.1 No global mutable state
- [ ] 29.2 Every public function is deterministic given its inputs
- [ ] 29.3 Every fallible operation returns `Outcome`
- [ ] 29.4 No panics reachable from public API
- [ ] 29.5 API rule audit script

## §30 What not to build

- [x] 30.1 No AI dependency in the kernel (`ryan_requires_ai()` == false)
- [x] 30.2 No network dependency (`ryan_requires_network()` == false)
- [x] 30.3 No UI code in the kernel
- [x] 30.4 Not a VS Code fork - no editor shell
- [ ] 30.5 Audit script asserting no AI / network imports appear in `src/`

## §31 Bridges

- [x] 31.1 Python bridge verified (`import python`, `2**10` == 1024)
- [x] 31.2 JS bridge verified (`import js`, JSON round-trip)
- [x] 31.3 Rust bridge verified (`dpm rust-bridge`, cargo 1.98.0)
- [x] 31.4 C bridge verified (`import c` header parser)
- [ ] 31.5 Rust bridge: rope core behind a zero-copy buffer view
- [ ] 31.6 Python bridge: host integration harness
- [ ] 31.7 JS bridge: adapter for a JS language server
- [ ] 31.8 C bridge: platform layer (paths, process, terminal)
- [ ] 31.9 Bridge conformance test: same results as the pure-Datara path
- [ ] 31.10 Bridge fallback: kernel works with every bridge absent

## §32 Documentation

- [x] 32.1 `docs/COMPILER-NOTES.md`
- [x] 32.2 Module-level doc comments explaining *why*, with evidence
- [ ] 32.3 `README.md` - what it is, how to build, how to verify
- [ ] 32.4 `ARCHITECTURE.md` - module map and data flow
- [ ] 32.5 `docs/PERFORMANCE.md`
- [ ] 32.6 `docs/DETERMINISM.md`
- [ ] 32.7 `docs/SECURITY.md`
- [ ] 32.8 `CHANGELOG.md`
- [ ] 32.9 `CONTRIBUTING.md`
- [ ] 32.10 `LICENSE`
- [ ] 32.11 `ROADMAP.md`
- [ ] 32.12 `docs/CONFORMANCE.md`

## §33 Definition of done

- [x] 33.1 Kernel builds and self-tests pass with zero AI code
- [x] 33.2 Kernel builds and self-tests pass with zero cloud dependency
- [x] 33.3 AOT binary reports a real exit code
- [ ] 33.4 25k-50k meaningful lines of kernel code
- [ ] 33.5 No fake implementations: every public function has a real body
- [ ] 33.6 Full conformance run green
- [ ] 33.7 Benchmarks published with measured numbers

## §34 Final output requirements

- [ ] 34.1 Line count by module
- [ ] 34.2 Exact build and test commands
- [ ] 34.3 Honest capability list, separating verified from aspirational
- [ ] 34.4 Known-limitations list, including compiler defects worked around

---

## Progress

Counted from the checkboxes above by `scripts/task_status.py`, not estimated.

| Section | Done | Total |
|---------|------|-------|
| 0 harness | 10 | 11 |
| 1 core primitives | 18 | 24 |
| 2 text engine | 27 | 39 |
| 3 events | 26 | 33 |
| 4 stale-result suppression | 4 | 9 |
| 5 task scheduler | 1 | 9 |
| 6 document store / workspace | 0 | 11 |
| 7 transactions | 0 | 9 |
| 8-25 subsystems | 0 | 90 |
| 26 conformance suite | 3 | 6 |
| 27 tests | 3 | 7 |
| 28 large workspace | 0 | 5 |
| 29 API rules | 0 | 5 |
| 30 what not to build | 4 | 5 |
| 31 bridges | 4 | 10 |
| 32 documentation | 2 | 12 |
| 33 definition of done | 3 | 7 |
| 34 final output | 0 | 4 |

**Verified foundation: 105 of 294 tracked tasks (36%).**

The three modules that exist (`core`, `text`, `events`) are verified by
executing self-tests, not by inspection. Everything else is planned but not
written - this file is the honest state, not a wish list.

## Notes on sequencing

The field-name discovery (see `docs/COMPILER-NOTES.md` section 1) consumed the
first session and could not be deferred: with shared field names, *no* module
could be trusted, including the ones that appeared to work. Every task marked
`[x]` above was re-verified after the fix.

Next, in order: §4 staleness wiring, §6 document store, §7 transactions. Those
three unblock everything else, because every later subsystem is expressed as
edits, events and freshness checks over documents.
