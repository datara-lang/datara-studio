# Design bets for a kernel people will want to build on

This is not a feature list. It is a set of architectural bets, each with what it
buys, what it costs, and how to verify it. The costs are included deliberately:
a proposal without costs is a wish.

Ordering is by leverage, not by effort.

---

## The gap this kernel exists to fill

Five things exist today, and each fails structurally:

* **VS Code.** Semantics live behind a JSON-RPC round trip, so every semantic
  query costs milliseconds. The extension API is imperative and UI-shaped, so
  extensions cannot be cached, budgeted or reasoned about. It cannot be used
  headlessly at all.
* **JetBrains.** PSI is genuinely semantic-first and in-process, which is why its
  refactorings are good. But it is a JVM monolith, not embeddable, not headless,
  and the platform owns the UI.
* **LSP.** The right protocol, the wrong architecture for a kernel. Servers are
  near-stateless and re-derive on demand. There is no cross-file transaction, no
  shared undo model, and cancellation is coarse.
* **Tree-sitter.** Excellent incremental parsing, zero semantics. Every editor
  re-implements the same symbol and diagnostic plumbing on top of it.
* **Emacs / Neovim.** Fast and extensible, but semantics are bolted on and there
  is no shared model to build on.

**Nobody has a fast, in-process, headless, semantics-first kernel with a real
transaction model that both a human UI and an AI agent can drive.** That is the
gap. Everything below is chosen to widen it rather than to tick boxes.

---

## Bet 1 - Queries are the interface, memoized by version key

**Idea.** The primary interface is not an event stream and not a command
dispatcher. It is a registry of **pure queries**:

```
symbols_in(range)      references_to(symbol)     token_at(offset)
outline(document)      diagnostics(document)     hover(offset)
```

Every query is a pure function of `(document revision, workspace epoch, params)`.
The kernel memoizes the result under exactly that key. A UI asking five hundred
questions per frame gets cached answers; an agent asking the same questions gets
the same answers.

**Why this is the non-obvious part.** Everyone builds an event bus and a request
handler. The bottleneck in real IDE UX is not events, it is the *volume of
questions* the UI asks per frame. Making queries pure and versioned turns that
from N round trips into N hash lookups.

**Buys.**
* A stale cached answer becomes **impossible by construction**, because the
  revision is part of the key. Invalidation stops being code you write and
  becomes a property you get.
* Incremental correctness has one place to live instead of being spread across
  every subsystem.
* Agents get cheap, repeatable, side-effect-free introspection. That is exactly
  what an agent needs and exactly what an LSP server cannot give it.

**Costs.** Every query must be honestly pure. Any hidden mutation breaks the
key's meaning. Query results must be structurally shared or memory explodes.

**How to verify.** A test asserts that for a random edit sequence, every query
returns the same result whether computed fresh or read from cache, and that a
revision bump invalidates exactly the affected entries and nothing else.

---

## Bet 2 - Snapshots, not mutable state

**Idea.** The kernel never mutates editor state. It holds an immutable
`Snapshot` (documents plus derived indices). An edit produces a new snapshot.
Undo is a pointer into a snapshot lineage.

**Buys.**
* Undo and redo across files, across refactorings, across *agents*, for free.
* Readers never block writers: a query holds a snapshot and is unaffected by
  concurrent edits.
* "What would happen if I applied this?" is `apply(snapshot, edits)` and then
  throw the result away. That is the speculative-edit primitive agents need, and
  the preview primitive humans want for refactorings.
* Replay and determinism fall out rather than being engineered.

**Costs.** Memory. Mitigated by structural sharing: the rope is already
persistent, and the indices become persistent vectors. Most snapshots share most
of their bytes. Needs measurement, not faith - this is the bet most likely to
need revision under a real large-workspace benchmark.

**How to verify.** Benchmark N snapshots of a 100k-line workspace and assert peak
memory grows sub-linearly in N. Assert that a reader holding snapshot S sees
identical results while a writer produces S+1..S+1000.

---

## Bet 3 - Latency is a contract, not a goal

**Idea.** Every query takes a budget and returns either a complete answer or a
**partial answer plus a resumption token**:

```
answer = query(params, snapshot, budget_micros)
```

**Why this is the strongest single idea here.** LSP has cancellation. Nobody has
resumable partial answers under a stated latency contract. It converts "fast" from
an aspiration into something a test can fail.

**Buys.**
* A UI can demand "answer within 2 ms or give me what you have" and **jank becomes
  architecturally impossible**, not merely unlikely.
* Indexing a 100k-file workspace stops being a background thread with a progress
  bar and becomes a resumable computation that never blocks anyone.
* It composes with Bet 1: a cache hit is a zero-cost completion, a miss is a
  budgeted partial.

**Costs.** Every long operation must be written as a resumable state machine. This
is real work and it leaks into the API shape. Cheaper on Datara than most
languages, because there are no closures to capture - the resumption token is
explicit state, which is what the kernel would do anyway.

**How to verify.** A conformance test runs every public query against a large
synthetic workspace with a hard budget and fails on any overrun. Published, this
is a moat: it is the one claim a competitor cannot match by adding features.

---

## Bet 4 - Semantic merge as a kernel primitive

**Idea.** Two concurrent edit sets merge by *structure*, not by text. Because the
kernel has a syntax tree, it can merge when both sides touched disjoint subtrees,
and produce a **structured conflict** (the two competing nodes, their ranges,
their intent) when they did not - never a `<<<<<<<` block.

**Why it matters now.** "Future IDE" means a human and N agents editing at once.
Textual merge is a disaster at that concurrency level: it produces conflict
markers inside syntactically valid files and destroys the semantic model.

**Buys.**
* Multi-writer becomes tractable without going full CRDT.
* Agents get a machine-readable conflict they can resolve or ask about, instead
  of a text blob they cannot parse.
* It is a feature no editor platform offers as a primitive.

**Costs.** Requires a real tree, which means a real parser per language - so it
only works where a provider exists. Needs an explicit, documented policy for the
single-writer case so the simple path stays simple.

**How to verify.** Property test: for random disjoint edit pairs, merge order does
not matter (commutativity). For overlapping pairs, the conflict names the
disagreeing nodes and never loses an edit silently.

---

## Bet 5 - The kernel's own history is the debugger

**Idea.** Every state is a snapshot and every event carries a correlation id, so a
bug report can be a **replayable session file**. Record, replay, step backward,
inspect semantic state at any point.

**Buys.** Time-travel debugging for the IDE itself, which is nearly free given
Bets 1, 2 and the existing determinism work - and is the single feature most
likely to make a developer *choose* this kernel over rolling their own.

**Costs.** A record format to version, and a bounded recording policy so long
sessions do not grow without limit.

**How to verify.** Record a session, replay it, assert byte-identical traces and
identical query results at every step.

---

## Bet 6 - Extensions are declared pure queries and transforms

**Idea.** An extension does not ship arbitrary code that runs whenever. It
declares:

* **queries** - pure functions of a snapshot, cacheable, budgeted
* **transforms** - pure functions from a snapshot to an edit set

**Buys, all of which fall out of Bets 1-3 for free.**
* Extensions can be cached and memoized, so a slow extension cannot make the UI
  slow.
* They cannot hang anything, because they are budgeted.
* They are automatically undoable, because a transform is a transaction.
* They are automatically testable, because they are pure.
* They can be written in any language through the bridges, because the contract
  is data, not an ABI.

This is a materially stronger extension model than an imperative host process,
and it costs nothing extra if Bets 1-3 are taken.

**Costs.** Some extensions genuinely need imperative behaviour (a debug adapter, a
terminal). Provide an escape hatch as an explicit, sandboxed, capability-gated
*service*, not as the default shape.

**How to verify.** A malicious extension that loops forever must not exceed its
budget or affect any other client's latency.

---

## Bet 7 - One semantics, two transports

**Idea.** The only API is a documented wire protocol, so the UI, an agent, CI, a
terminal and a mobile client are equal clients. For local clients add a
shared-memory transport that is *semantically identical* - same messages, same
ordering, same budgets - just cheaper.

**Buys.** No privileged in-process path, so nothing can depend on being inside the
process. The whole kernel becomes replayable and testable from recorded protocol
traces. And "can I build a web IDE on it" is answered yes on day one.

**Costs.** Latency discipline. Do not let a second, subtly different local API
grow, or the equality guarantee rots.

**How to verify.** The conformance suite runs twice, once over each transport,
and asserts identical results.

---

## Bet 8 - Symbols are integers

**Idea.** Intern identifiers into integer symbol ids at parse time. Comparisons
become integer compares, symbol maps become arrays, and query results become
compact index lists instead of strings.

**Buys.** Semantic queries stop being string hashing and become array indexing.
This is what makes Bet 1 cheap enough to do at frame rate.

**Costs.** An intern table with a lifetime policy, and a story for stale ids after
a rename. Bounded, well-understood problem.

**How to verify.** Benchmark `references_to` on a 100k-symbol workspace; assert
allocation count per query is O(1) in the number of symbols.

---

## Bet 9 - Conformance as a product

**Idea.** Because the kernel is deterministic and snapshot-based, it can ship a
runnable conformance suite as a first-class artifact:

* property tests: random edit sequences, rope equals a plain string
* memo-stability: cached and fresh answers agree
* budget assertions: no public query exceeds its budget on a large workspace
* a replay corpus: recorded sessions that must replay byte-identically
* capability assertions: every claimed capability has a self-test

**Why it is a moat.** Platforms people build on live or die on whether the
platform is *trustworthy*. A published, runnable suite is the difference between
"we think it is fast" and "here is the proof, run it yourself".

**Costs.** Every claim must be testable, which forces honesty about what is
actually done versus planned. That is the point.

**How to verify.** It is the verification. Make it the artifact people download
first.

---

## Bet 10 - Columnar derived data, chosen deliberately and never silently

**Idea.** Derived data that is queried *across* documents - diagnostics, error
counts, git status - is stored column-wise, because the access pattern is "one
property, many documents". Data queried *within* one document stays row-wise.

**Why it is on this list.** This is the idea the current forgen layout optimizer
was reaching for, and it is a good idea. Its failure was not the idea but the
implementation: the decision was made silently, per aggregate heuristics, with a
name-keyed offset table and no diagnostic. The lesson is not "avoid columnar
layout", it is **"a layout decision must be explicit, documented, and provable,
and it must never change observable semantics."**

**Buys.** Cross-document queries that are otherwise O(documents) become
cache-friendly scans.

**Costs.** Two representations means two code paths and a conversion cost at the
boundary. Only worth it where a benchmark justifies it.

**How to verify.** Benchmark the cross-document query with and without the
columnar representation and publish both numbers. If it does not win, delete it.

---

## Performance model

Latency discipline, in the order it matters:

1. **Nothing on the hot path touches the filesystem or the network.** All I/O is a
   budgeted, resumable task. A query never blocks on a disk.
2. **Byte-addressed internally, UTF-16 only at the LSP boundary.** Already the
   design; keep it.
3. **Arena allocation per snapshot.** Free a whole snapshot at once. Combined with
   structural sharing this removes most allocator pressure and all fragmentation.
4. **No hash-order iteration anywhere ordering is observable.** Determinism is a
   correctness property, not a nicety.
5. **Allocation count is a tested metric**, not just wall time. Wall time hides
   regressions behind cache effects; allocation counts do not.

---

## What not to build

A kernel is defined as much by its refusals.

* No UI toolkit, no windowing, no theming. Not one line.
* No built-in language. Providers only, with exactly one reference provider that
  exists to prove the contract.
* No plugin marketplace, no account system, no telemetry by default. Those are
  products built on the kernel, not parts of it.
* No editor shell, no application. The kernel is a library plus a process.
* No AI *in* the kernel. The kernel's correctness must not depend on AI - which is
  a different rule from "no AI". The API should be designed for an AI client,
  including streaming, speculative edits and machine-readable conflicts.

---

## What I would cut from the current forty sections

The current plan is breadth-first, and that is the main risk to the project.

**Keep, and go deep:** text engine, transactions, events, staleness, queries
(Bet 1), one language provider, the protocol, conformance, determinism.

**Defer until a real client demands it:** process and terminal, debugger, VCS,
package management, extension host, configuration, persistence, observability,
security hardening.

Those are each a separate product. Building them now produces forty half-modules
and no users. The sequence that produces users is: rope, indices, transactions,
queries, staleness, one provider, LSP, **then put a real editor on it.** The rest
should be pulled by demand, not pushed by plan.

---

## Sequencing, given the compiler

1. Fix the layout optimizer (`docs/COMPILER-NOTES.md` section 1 has the traced
   chain). Nothing above is trustworthy until field access is trustworthy - the
   kernel holds the user's code and their undo history.
2. Re-run the probes as the regression gate.
3. Then Bet 1 and Bet 2, because every other bet is expressed in terms of them.
4. Then Bet 3, because it is the differentiator and it is cheap to add while the
   query layer is young and expensive to retrofit later.
