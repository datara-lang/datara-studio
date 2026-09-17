# DESIGN-UI.md - the visual language

Written while the language is being updated, so that the interface can be
rebuilt once on the new version instead of patched twice.

This is a proposal, not a description of what exists. Nothing here is built yet.

---

## What is wrong with the current interface

Looking at it honestly, it fails in four specific ways.

1. **It is a wireframe with colours.** Every region is a rectangle outlined by a
   1px border. Borders everywhere is how you draw a diagram of an interface, not
   how you build one. Real depth comes from luminance steps and spacing, not from
   lines.
2. **The chrome is colourless and the code is the only thing with life.** The
   panels are inert grey. Nothing tells you what is alive, what is running, what
   has focus, except a thin blue underline on one tab.
3. **The status bar is a debug readout.** `309 lines  13318 chars  5052 tokens
   lex 2.3 ms  0 diag  ln 309, col 1  UTF-8  Datara`. That is telemetry, not
   information. A person reading it learns nothing they needed at that moment.
   Tokens and lex time were there because I was measuring the wasm core; they
   should never have been shipped to the user.
4. **Everything has the same weight.** The file name, the breadcrumb, the tree
   entries and the panel labels are all roughly the same size, colour and
   density. There is no hierarchy, so the eye has nowhere to land.

## Principles

1. **Depth by luminance, not by borders.** Five surface levels. A panel is
   distinguished by being slightly lighter than what is behind it, not by
   having an outline. Borders are reserved for real separation: the edge of the
   window, the boundary of a floating layer.
2. **One accent, and only for live state.** A single colour means "this is
   happening now": the active tab, the running process, the focused input. It
   appears in a handful of places on screen at once. Everything else is
   grayscale.
3. **Colour is reserved for meaning, never for decoration.** Red, amber and
   green exist only on code, only for problems and results. A green button would
   spend the most loaded colour in the palette on a thing that is not a problem
   and not a result.
4. **Type does the work that boxes used to do.** Small caps with letter-spacing
   for section labels, mono for values, three sizes and two weights total. A
   section is introduced by a label and space, not by a frame.
5. **The interface is quiet until asked.** Nothing animates on its own, nothing
   pulses for attention, no badge counts. State changes are visible; idle states
   are nearly invisible.
6. **Density where it is read, air where it is not.** Code: tight, 19px leading.
   Chrome: generous. A cramped toolbar next to dense code is the mistake both
   major IDEs make.
7. **Motion only to explain.** 120-160ms, ease-out. A panel opening, a state
   change, a progress sweep. Nothing decorative, nothing over 200ms.

## Tokens

### Surface, five levels

```
--s0  #0B0B0E   the code itself, deepest
--s1  #101014   panels, rails, the tree
--s2  #16161B   elevated: inputs, the intent bar
--s3  #1D1D23   hover, the active row
--s4  #26262E   floating layers, menus, the palette
```

Hairlines, used sparingly, at 7% and 14% white rather than a solid grey. A solid
grey line on a dark surface reads as a scratch; a translucent one reads as depth.

### Ink

```
--ink-1  #E9E9EE   primary, code, values
--ink-2  #9A9AA4   labels, secondary
--ink-3  #5C5C66   hints, disabled, line numbers
```

### The accent

```
--live   #7DD3C0   mint-teal
```

Chosen because it is not the blue that every IDE uses, it reads as calm rather
than alarming, and it sits far from red and amber so the diagnostic colours keep
their meaning. It marks: the active tab, the focused field, the running state,
the current line in the gutter. Nothing else.

### Signal, on code only

```
--err    #D9705F
--warn   #D6A461
--ok     #7FB069
```

Muted, so a file full of warnings is still readable as text.

### Type

Two families, three sizes, two weights. Nothing else.

```
sans  Inter / system-ui    12.5px 400  body, labels
                           11px   500  section labels, small caps, +0.08em
mono  Cascadia / JetBrains 12.5px 400  code, values, paths
                           19px leading
```

### Geometry

```
radius  6px for controls, 10px for floating layers, 0 for the window edge
spacing 4 / 8 / 12 / 16 / 24 - no other values
```

---

## The intent bar

Replaces the toolbar, the title bar and the command palette with one strip.

```
  Datara Studio   │  ⌘  check, build, run, open file, refactor…        │  ▸ ▾
```

Three parts:

* **identity** - the mark and the workspace, quiet, left;
* **one input** - focus it with `⌘K`, type what you want. It is the file
  picker, the command palette and the search box at once, because those were
  always the same interaction wearing three costumes;
* **the run control** - right, where a hand expects it.

A toolbar of five text buttons becomes one control and one input. That is the
whole gain, and it is also why it looks unlike other IDEs: nothing else has
removed the toolbar.

## The run control

A split button. The single most important control in the interface, so it is the
only one with a filled surface.

**Form.** Two halves joined, separated by a hairline: the action on the left, a
chevron on the right. Height 26px, radius 6px.

**Idle.** Surface `--s2`. The play triangle in **`--ink-1`, off-white** - not
green, not the accent. A play button is not a success and not a live state; it is
a neutral verb, and colouring it green is the mistake every editor makes. The
triangle is a clean SVG path, optically centred, not a glyph.

```
   ▸ │ ▾
```

**Hover.** Surface lifts to `--s3`. No colour change. 120ms.

**Running.** The triangle becomes a stop square. A 1px `--live` line sweeps
along the bottom edge of the button, left to right, 900ms, looping. This is the
only looping animation in the interface, and it is the only place the accent
appears in the chrome.

**Failed.** The surface keeps a 1px `--err` underline until the output panel is
read. No red fill, no shake.

**The dropdown** opens downward, aligned to the right edge of the button, as a
floating `--s4` layer with a 10px radius and a soft shadow. Entries:

```
  ▸  Run                    ⌘⏎
  ⚙  Build                  ⌘B
  ✓  Check
  ⚗  Test
  ◷  Profile
  ─────────────
  ⚙  Run configuration…
```

Each row: a 14px SVG icon in `--ink-3`, a label in `--ink-1`, the shortcut
right-aligned in `--ink-3`. The hovered row is `--s3`. Icons are line drawings at
1.4px, never filled, never coloured.

## The semantic rail

The right edge of the code area, 14px wide, replaces the text minimap.

A minimap that duplicates the text is a picture of a file you already have. This
instead shows structure as marks aligned to the document: one tick per function,
taller for exported; diagnostic dots at their real lines; test results. It is a
map of meaning, not of pixels, and it costs no attention until looked at.

## The status line

One quiet line, and it shows **only what is exceptional**.

```
  main.dtr · modified                                    2 errors · running
```

Everything else is on demand: click for the rest. Line and column appear while
the caret moves and fade after a second. Encoding, language and file size are in
the intent bar's tooltip, because a person who needs them knows where to look and
a person who does not should not be told.

**Removed outright:** token counts, lexer timing, character counts. They were
instrumentation for the wasm core and had no business in the user's eyeline.

## What this gets that nothing else has

* **No toolbar.** One input and one control. Every other IDE still has a row of
  buttons; removing it is the single largest visual difference available.
* **A live accent rather than a static one.** Colour that means "now" instead of
  colour that means "this product".
* **A structure rail instead of a text minimap.** Information rather than a
  smaller copy of what is already on screen.
* **A status line that stays empty when nothing is wrong.** Most status bars are
  full all the time, which is why nobody reads them.

## What to do first, when work resumes

1. Tokens and surfaces - the whole look changes from this alone, no layout work.
2. The intent bar with the run control - the most visible single change.
3. The status line, including deleting the telemetry.
4. The semantic rail last, because it needs real structure from the provider.

## Done since this was written

Kept here rather than deleted, because each one records a decision that would
otherwise be re-litigated.

* **Tokens and surfaces** - in. Five levels, one accent, three inks, two
  families. The hairlines are translucent, which is what stopped them reading as
  scratches.
* **The intent bar with the run control** - in. No toolbar; one input and one
  split button. The play triangle is off-white, not green.
* **The status line, telemetry deleted** - in. Token counts, lexer timing and
  character counts are gone.
* **Icons from one source** - `scripts/mark.mjs` holds the geometry and
  `scripts/build-icons.mjs` writes all eight artefacts from it. This replaces an
  earlier arrangement that generated them from `assets/datara.ico`, which sounds
  like the same thing and was not: that file was a *fourth* design - a yellow
  palm inside a yellow rounded square - while the interface drew two pale
  brackets and a mint dot. Two marks were live in one window and the one on the
  taskbar was the one that did not match. `ui/icon.svg` and `mark.mjs` now
  describe the same shape, and the build fails if the SVG stops containing the
  three brand colours.
* **Small sizes are drawn for the grid, not scaled onto it** - see below.
* **The companion is a guest, not the host** - the AI tabs are last, the panel
  opens on Problems, and the whole interface works with the companion off.

### The 16px icon, which is where icons actually live

The taskbar icon looked blurry and unreadable. It was not a resolution problem:
the 16px entry was there and correctly sized. Rendering it back out as ASCII
made the cause obvious in one screen:

```
.++++MM++MM++++.     the node, split into four corners
.++++#++++#++++.     the bracket, one pixel wide
.+++#++MM++#+++.     and the node poking through it
```

Scaling the 64-unit drawing down by 0.8 made the 5.5-unit node *wider* than the
5-unit stroke. At 16px one unit is a quarter of a pixel, so both shapes were
fighting over the same one-pixel budget and neither won. Shrinking harder cannot
fix that - the two shapes have to stop being the same drawing.

So `SMALL` in `mark.mjs` carries a separate 16px and 24px layout with its own
numbers, fitted on the pixel grid in pixels rather than in 64-space units. A
16px icon is a different drawing that resembles the 256px one.

Two things this cost, both worth keeping:

* The first attempt invented plausible numbers (`spread 9, tip 9`) and produced
  **two solid vertical bars with no bracket at all** - a polyline whose apex and
  tips are equidistant from the centre is a straight line. The working numbers
  came from fitting the shape on a character grid first, then converting.
* The second attempt fed those pixel offsets straight into the sampler, which
  works in 64-space, so the brackets came out half a pixel wide and vanished.
  The fields are now named `apexPx`, `tipPx`, `topPx` and converted once, on the
  way in. The `Px` suffix is load-bearing.

`scripts/verify-ico.mjs` now runs in the build and reads the finished `.ico`
back: every size present, square, RGBA, in bounds, the declared size equal to
the encoded size, no yellow surviving. The generator can only report that it
wrote something; this is what notices when what it wrote is wrong.
`scripts/taskbar-sheet.mjs` draws old and new at 16/20/24/32/48 on both
surfaces, because reviewing a 256px PNG would never have caught this.

### Zen mode

`Ctrl+Shift+Z`, or the button beside the panel toggle. Everything that is not the
code goes: title bar, toolbar, explorer, right panel, breadcrumbs, status bar.
`Esc` leaves.

The mode is carried on `<html>` as `data-zen`, not as a React class, because the
rules it drives are about the shell's own **grid** - and a grid track cannot be
removed by a rule inside the grid's subtree. Hiding five children with
`display:none` leaves the reserved tracks behind, so the code would sit in a 1fr
row with dead space above and below it. Collapsing to `grid-template-rows:1fr` is
what makes the editor actually fill the window, and that rule has to sit outside.

What survives is one 26px bar, and every part of it is opt-in in Settings:

* **file name** - where you are
* **position, language, running** - another question people ask mid-sentence
* **problems** - an error and warning count, clickable, that leaves Zen and opens
  the panel. This is the one piece of the right panel worth interrupting for, and
  a count you cannot act on is a taunt. A clean file says `no problems` rather
  than going quiet, because silence is indistinguishable from a broken bar.
* **soft wrap**, **breathing room**, **extra size**, **column width**

With all of the informational parts off the bar collapses entirely, so "just the
code" means just the code rather than a 26px stripe of nothing.

Three decisions worth keeping:

* **The mode is not persisted; its preferences are.** Restoring a window with no
  interface and no obvious way back is how a person concludes the app is broken.
* **The shortcut is registered at window level, not in the editor mount.** The
  editor effect begins `if (!edRef.current) return;`, so anything inside it exists
  only while a file is open. Zen registered there did nothing at all on a cold
  start with no file - the key arrived, no handler was listening, and the mode
  looked broken rather than unavailable.
* **The centred column insets the text surface, not the text.** A `max-width` on
  the code alone would leave the line-number gutter stranded at the window edge
  and put the caret in the wrong place, because the gutter is positioned from the
  surface's own box.

`ui/test/zen.mjs` drives all of this in a real browser and measures, because
"did the grid collapse" is not a question a static DOM can answer. Two traps it
records: the API endpoints take a **raw path** as the body rather than JSON
(sending `"{}"` made the server treat `{}` as the workspace root and answered
"cannot read that folder"), and a fresh browser profile has no remembered
workspace, so it shows the welcome screen and there is no editor to measure -
every layout assertion came back `-1`, which reads as "Zen is broken" when the
truth was "there is no editor here".

### The core build

`scripts/build-ui.mjs --core`, served at `/?core=1`, is the same interface with
the companion removed: four compiler tabs instead of six, no plug in the bar, no
"start the companion" in the palette, no companion section in Settings. Not a
separate source file - one `app.js` with `window.__DS_CORE__` read in four
places. A fork would be two files that get to disagree; a flag is auditable.

### The panel tab strip, which was the worst thing in the window

Eight tabs will not fit in a 264px panel, so the row runs off the edge and
scrolls. That was the intent, and the first implementation of it was wrong in a
way nothing caught for a long time:

* The auto-scroll that keeps the selected tab visible was not clamped. Selecting
  the last tab scrolled the row to an offset past its own end, which pushed the
  **first** tab out the **left** edge - measured at 1440x900, `Problems` was
  reported at x 1066 with the strip's own left edge at 1176. It was sitting over
  the code column, outside its container, while a 0px scrollbar said there was
  nothing to scroll.
* Nothing said the row overflowed at all. No arrows, no fade, no partial tab at
  the edge on load. You found the hidden tabs by accident or not at all.

Both are fixed and both are now checked by `ui/test/tabs.mjs`, which drives the
real page in Chromium and asserts reachability rather than appearance: every tab,
when clicked, is brought fully into view; the row starts at `scrollLeft 0`; and
the arrows only exist when the row actually overflows.

Two things that came out of building that check, worth keeping:

* **`getBoundingClientRect` does not know about clipping.** A child scrolled past
  its container still reports its geometric position, so a check written as "no
  tab may have `left < strip.left`" fails against a strip that is working
  perfectly. The screenshot settles it - at full scroll `Project` is cut
  mid-word at the panel edge, which is clipping. Assert on whether hiding is in
  effect, not on rects. (This cost two rounds.)
* **Labels were abbreviated to fit, not to look tidy.** `Issues` and `Symbols`
  instead of `Problems` and `Structure` bring 380px of tabs down to 268, which
  fits a default panel with room to spare. The full name stays in the tooltip and
  in the Settings list.

### The labels in the strip are the short ones

`PANEL_TAB_LABELS` is what a tab is *called* (Settings, tooltips);
`PANEL_TAB_SHORT` is what the strip *draws*. They are separate because the
Settings list is a comfortable place for `Structure` and a 264px strip is not.

## Open questions for Kirill

* The accent: mint-teal as proposed, or warmer? The whole interface is built
  around this one choice and it is the easiest thing to get wrong. *(Shipped as
  mint, #7DD3C0 - say the word and it is one token.)*
* Does the intent bar replace the file tree too, or does the tree stay open by
  default? *(Shipped: the tree stays, and folds to a rail.)*
* Reading mode: a separate layout, or just a different density of the same one?
  *(Shipped: the same layout with the tree hidden.)*

### Found by driving the interface, and left for you to decide

Behaviour choices, not bugs to be fixed quietly. The code and the numbers are
below each one. The first two are still open; the third is here because the way
it failed is worth keeping.

**Generate writes a whole module, including `fn main()`, into the file at the
caret.** Into a file that already has a `main` - which is every file that has
been run - that is:

```
error[E-RESOLVE-002]: Duplicate function definition 'main'   hello.dtr:36:1
```

while the panel says `VERIFIED`, which is true of the snippet in isolation and
false of the file it was just written into. `runGenerate` inserts what it is
given rather than editing the model's output, which is the right instinct. The
change belongs on the companion side - it already receives `context`, so it
should generate *in* that context - and the panel should not claim VERIFIED when
the result it inserted has diagnostics.

**`Create new project` had no location step** - now fixed, and left here because
the way it failed is worth keeping. With no workspace open the name was used as a
*relative* path, so it resolved against the server's working directory. Measured
on a cold launch: it created `D:\IDE datara\datara-studio\demo-project\src\main.dtr`
- inside the IDE's own source tree. It now asks where before what, and the folder
dialog no longer opens on the studio's own directory. Two independent things were
wrong, which is why the fix is two changes rather than one:

* the dialog opened on `""`, and the server answers an empty listing request by
  describing its **own working directory**, so it offered `src`, `crates` and
  `ui` as somewhere to put a new project. It opens on a drive now, or on the last
  workspace.
* the 8 s tree poll ran with no workspace, and `refreshTree` fell back to `"."`
  when the reply carried no root - which handed the studio a workspace nobody
  chose and changed the dialog's `start` prop underneath it, discarding the
  folder that had just been typed. The poll no longer runs without a workspace,
  and `refreshTree` only adopts a root that was actually asked for.

It still writes no `datara.toml`, though a manifest-less folder does compile and
run (verified: a two-module program in it printed `hi from helper`), so that part
is structural rather than breaking.

**The suggestion asked for on open is asked at caret 0**, where the prefix sent to
the model is empty and the answer is a template (`name = value`). The comment on
that call argues deliberately for suggesting at the caret on open, so this is a
choice to make rather than an oversight to correct - but the ghost you see on
opening a file is not a completion, and it is worth knowing that before deciding
whether to keep the eager request.
