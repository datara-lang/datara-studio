# Ryan Harness Core

The headless kernel extracted from Datara Studio. It is intentionally small,
offline-first and independent of the IDE chrome: text storage, positions,
workspace epochs, events and host-neutral adapters.

The kernel itself has no AI dependency and no network requirement. The public
invariants `ryan_requires_network()` and `ryan_requires_ai()` are both false,
and `kernel_self_check()` verifies them.

## Layout

- `src/core/` - IDs, versions, clocks, epochs and outcomes
- `src/text/` - piece-table rope, line index, UTF-8/UTF-16 and edits
- `src/events/` - event bus and plans
- `src/cli/` - headless entry point
- `adapters/` - host integration boundaries
- `conformance/` and `tests/` - executable contracts
- `ui/` - a minimal no-AI visual host with local settings

## Start the kernel IDE UI

Windows:

```cmd
scripts\serve-ui.cmd
```

Linux and macOS:

```bash
./scripts/serve-ui.sh
```

Then open `http://127.0.0.1:8088`. The page is a static, dependency-free IDE
host with the useful Studio chrome and no AI surface:

- workspace explorer, file filter, new-file action and tabs;
- direct source editor with line numbers, minimap, indentation and word wrap;
- Problems, Structure, Project, Layout and Output panels;
- command palette with `Ctrl+P`, save with `Ctrl+S`, run and source check;
- local settings for font size, line numbers, wrapping and indentation;
- local persistence for settings, open files and edits.

It is a visual host for the kernel, not a network client and not a companion
front end. No generation, suggestions, remote calls or AI controls are present.

## Run the kernel

```bash
forgen run src/main.dtr
```

The compiler is a separate product. The kernel does not bundle it.

## Cross-platform rule

The source and UI contain no Windows-only runtime dependency. The `.cmd` launcher
is for Windows, the `.sh` launcher is for POSIX systems, and the kernel remains
usable from a headless host or language server.

## Licence

MIT OR Apache-2.0. See `LICENSE-MIT`, `LICENSE-APACHE` and
`THIRD-PARTY-NOTICES.md` if the host adds dependencies.
