# Third-party notices

Datara Studio itself is licensed under MIT OR Apache-2.0 (see `LICENSE-MIT` and
`LICENSE-APACHE`). It ships third-party code, listed here with the licence each
one is used under.

The distinction that matters for redistribution is **bundled** versus
**development only**. Everything in the first table ends up inside the shipped
`ui/studio.html` or the desktop binary, so its notice has to travel with the
product. Everything in the second table never leaves a development machine.

## Bundled in the shipped interface

The studio ships as one self-contained HTML file with no subresources, so these
are inlined into it as text. `scripts/build-ui.mjs` does the inlining.

| Component | Version | Licence | Copyright |
|---|---|---|---|
| React | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| React DOM | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| React DOM Server (legacy, browser build) | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| htm | bundled UMD build | MIT | Copyright (c) 2017 Jason Miller |

Sources: `ui/vendor/react.production.min.js`,
`ui/vendor/react-dom.production.min.js`,
`ui/vendor/react-dom-server-legacy.production.min.js`, `ui/vendor/htm.umd.js`.

React is used for the chrome only - the panels, the tree, the dialogs. The text
surface is direct DOM, deliberately, because re-rendering twenty thousand lines
per keystroke is the largest performance mistake an editor can make.

## Bundled in the desktop build

| Component | Version | Licence | Copyright |
|---|---|---|---|
| Tauri | 2.x | MIT OR Apache-2.0 | Copyright (c) 2017 - present, The Tauri Programme within The Commons Conservancy |
| tauri-build | 2.x | MIT OR Apache-2.0 | Copyright (c) 2017 - present, The Tauri Programme within The Commons Conservancy |

Tauri is the window and nothing else. There is no shell plugin and no IPC
surface: the interface reaches the Datara server over loopback exactly as it does
in a browser, which is why the desktop and browser builds cannot drift apart.
Because Tauri is offered under a choice of two licences, this project takes it
under **Apache-2.0**.

## Development and test only

These are never shipped. They exist so the test suites can run.

| Component | Licence | Copyright | Used by |
|---|---|---|---|
| linkedom | MIT | Copyright (c) 2021 Andrea Giammarchi | `ui/test/editor.test.mjs`, the boot test, `scripts/check-snippets.mjs` |
| Playwright | Apache-2.0 | Copyright (c) Microsoft Corporation | `ui/test/shoot.mjs`, `ui/test/drive.mjs` |

## No third-party Rust crates

The text core - the document, the incremental line index and the Datara lexer -
is `crates/textcore`, and its `Cargo.toml` declares no dependencies at all. The
wasm module therefore carries no third-party Rust code and no third-party licence
obligations beyond the Rust standard library and `wasm32` target, both of which
are covered by the Rust project's own MIT OR Apache-2.0 terms.

That is a deliberate property rather than an accident: a text core is a place
where a dependency tree becomes a supply-chain surface, and this one is small
enough to have none.

## The compiler is not distributed here

`forgen`, the Datara compiler, is a separate product and is not included in this
repository or in the built interface. The studio invokes it as an external
program. Its licence is stated in its own repository.

## Keeping this file honest

If a dependency is added, added to this file in the same change. The test suite
does not verify this list, so the only thing keeping it accurate is the habit of
updating it - which is why it is written as prose with sources named rather than
as a bare list of names.
