# Roadmap to the IDE: from kernel bets to a product that beats both

The real goal, stated plainly: **program in Datara, in an IDE of my own, faster
and better than VS Code and JetBrains.** The open kernel is how that work gets
reused by others.

That ordering matters, and it changes the plan. This file is the sequencing, the
moat, and the risks.

---

## 1. Where the moat actually is

"Faster and better than VS Code and JetBrains" is not won by the kernel. Both
competitors have excellent engineers and both are architecturally capped, but the
cap is not where you would expect.

**Neither competitor can own your compiler.** That is the whole advantage.

* JetBrains writes PSI by hand, per language. It is a second implementation of the
  language, maintained in parallel with the real compiler, and it drifts.
* VS Code delegates to a language server, which is a third implementation, behind
  a protocol, and it drifts too.
* **You own forgen.** The IDE and the compiler can be one system: one parser, one
  type checker, one symbol table, one source of truth.

Concretely, that buys things no general IDE can offer for Datara:

| Capability | Why JetBrains / VS Code cannot match it |
|---|---|
| Diagnostics that are exactly the compiler's | They re-implement the analysis and disagree at the edges |
| Refactorings that are *verified* before commit | Theirs are heuristic; yours can be type-checked as a transaction |
| Ownership / move visualisation | The information exists only inside your borrow checker |
| Effect display per function | Your effect system; no other language exposes it |
| Comptime evaluation results | Your CTFE; the IDE can show what was folded |
| **Struct layout and offsets inspector** | Your layout optimizer. Today it is invisible, which is exactly why it cost days. Shown in a panel, it becomes a feature nobody else can have. |
| Build and run through `forgen` with the JIT | Sub-second edit-run loop is yours, not something a plugin can fake |

So the moat is: **the IDE knows what the compiler knows, because it *is* the
compiler's front end.** The kernel is how that gets packaged for other people.

And the "faster than VS Code" half is purely architectural, which is what
`DESIGN-BETS.md` is for: no Electron on the hot path, no RPC for semantic
queries, budgeted queries so nothing janks, and one implementation of the
language instead of three.

---

## 2. The trap, and how to avoid it

The stated plan is: build the open kernel, and also build my own IDE.

**The trap is building the kernel first, for hypothetical third parties.** That is
what a forty-section spec does: §12-§20 (process, terminal, debugger, VCS,
packages, extension host, config, persistence) are designed for consumers who do
not exist yet. You would spend a year on generality and still not be able to
write Datara in your own editor.

**The way to get both without throwaway work: extract the kernel, do not design
it.**

Build the IDE for Datara. Enforce one rule while doing it: *every capability is
reached through a documented, provider-based interface, and nothing Datara
specific is allowed below that line.* Then the kernel is defined by deletion - it
is literally the part that survives when you remove the Datara provider, the
compiler bridge and the Datara-specific panels.

This works because it inverts the risk:

* Every kernel interface is **justified by a real consumer** - your own IDE. No
  speculative API.
* Generality is **proven, not hoped for**. When you later add a second language
  provider, you find out immediately whether the boundary was real.
* Nothing is thrown away. The IDE is the deliverable from day one.

The failure mode of the opposite order is well known: a beautiful extension API
with no extensions, and no product.

---

## 3. The minimum IDE

Not forty subsystems. Seven things, in this order. Each one is a reason to open
the editor.

**1. Edit perfectly.** Rope, undo/redo, multi-cursor, search, large files, no
typing latency. Table stakes: if this is not flawless, nothing else is looked at.

**2. Semantic queries that are instant because they are in-process.** Hover,
go-to-definition, find-references, completion, document symbols. No round trip.
This is where the kernel's query registry and budget contract pay off first.

**3. Diagnostics from the compiler, incrementally.** Same code path as
`forgen check`, so the IDE can never disagree with the build. Exact ranges, and
they update as you type.

**4. Verified refactorings.** Rename, extract function, inline, change signature -
each expressed as a transaction and **type-checked before it is committed**. This
is the single clearest "better than JetBrains" feature: their refactorings are
good, yours can be proven.

**5. Language-specific introspection nobody else can show.** A layout and offsets
panel, an ownership view, effect display, comptime folding results. Start with the
layout panel: it is the highest value per unit of work, because it makes the
compiler's least visible decision visible.

**6. Build, run and debug through `forgen`.** The JIT gives a sub-second edit-run
loop. Debugging reuses the compiler's own metadata rather than a re-derived
mapping.

**7. Replayable sessions.** A bug report is a file. Given determinism this is
nearly free, and it is what makes the IDE trustworthy enough to live in.

Everything else - terminal, VCS UI, package UI, extension marketplace - comes
after someone is actually using items 1 through 7 daily.

---

## 4. Where the speed comes from, concretely

1. **No Electron on the hot path.** The text surface and the semantic queries are
   native, in-process.
2. **No RPC for semantic queries.** A query is a function call against a memoized
   version key. This is the difference between 0.1 ms and 5 ms, times hundreds of
   queries per frame.
3. **Budgeted queries.** Nothing can jank, because nothing is allowed to run
   longer than its budget. Tested, not promised.
4. **Incremental everything**, driven by the compiler's own incremental state
   rather than a parallel re-analysis.
5. **One implementation of the language.** VS Code's stack for Datara would be
   three (server, tree-sitter grammar, compiler). Yours is one.

---

## 5. The honest hard part: the UI

The kernel is the part that is interesting to build. **The UI is the part that
decides whether anyone uses it**, and it is where VS Code and JetBrains actually
win: panels, settings, keybindings, themes, a hundred small affordances.

Two viable strategies. Pick one deliberately, early:

* **Custom renderer for the text surface, existing shell for everything else.**
  Write the text surface yourself (that is where speed is felt, and it is a
  bounded problem: glyphs, cursors, selection, scroll). Use a webview or an
  existing toolkit for panels, settings and dialogs. Gets most of the speed
  benefit for a fraction of the UI work. **Recommended as the starting point.**
* **Fully custom UI.** Higher ceiling, much more work, and it is work that does
  not differentiate. Only after the IDE is in daily use.

Do not start with the second one. The first one is how you get a usable editor
this year and still hit "faster than VS Code" on the axis that users feel.

---

## 6. Order of work

**Stage 0 - unblock.** Fix the layout optimizer. Nothing above it can be trusted
while field access is not (`COMPILER-NOTES.md` section 1). Re-run the probes as
the gate.

**Stage 1 - kernel core, proven by the IDE.** Rope, indices, transactions,
queries, staleness, budget. Every interface gets its shape from a real IDE call
site. Milestone: a text editor with instant semantic queries over one file.

**Stage 2 - the Datara provider.** Parser reuse, symbols, diagnostics, hover,
definition, references, completion. Milestone: **you can write Datara in it.**
This is the first genuinely useful day, and everything after it is improvement.

**Stage 3 - the moat features.** Verified refactorings, layout inspector,
ownership view, effects, comptime display. Milestone: it is now better than
JetBrains for Datara, not merely faster.

**Stage 4 - the boundary becomes real.** Extract the kernel, write the protocol,
write the conformance suite. Add a second, deliberately minimal provider for a
different language to prove the boundary. Milestone: **someone else can build an
IDE on it**, and you find out honestly whether the abstraction holds.

**Stage 5 - breadth, pulled by demand.** Terminal, VCS, packages, extension host -
each only when a real user asks. The extension model is declared queries and
transforms (`DESIGN-BETS.md` bet 6), which means extensions are written **in
Datara**. That is a genuine pitch: extend your IDE in the language you write your
code in.

---

## 7. Risks, ranked

1. **Sequencing.** Building the universal kernel before the working IDE. Mitigated
   by extraction, section 2.
2. **UI scope.** Underestimated by every developer who has not shipped an editor.
   Mitigated by the split in section 5.
3. **The language itself.** An IDE is the most demanding consumer a language can
   have: it needs fast strings, cheap allocation, predictable layout and good
   FFI, all at interactive latency. Every gap found while building the IDE is real
   feedback on the language - which is the point of dogfooding, but it means the
   compiler and the IDE have to be developed together, not sequentially. Already
   hit: no closures (shaped the event bus), flat namespaces (manual prefixes do
   not scale to a large IDE), weak string handling (tooling drifted to Python).
4. **Single implementer.** The plan must stay ruthlessly narrow. Stages 0-2 are
   the product; stages 3-5 are leverage.

---

## 8. The one sentence version

Build the IDE for Datara, structure every capability behind a provider boundary,
and let the open kernel be what remains when the Datara-specific parts are
deleted - because the advantage is not a better kernel, it is that **the IDE and
the compiler are the same system**, and no general-purpose competitor can copy
that.
