#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to build Datara Studio." >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to build the desktop shell. Install Rust from https://rustup.rs" >&2
  exit 1
fi
if ! command -v forgen >/dev/null 2>&1 && [ -z "${DATARA_FORGEN:-}" ]; then
  echo "forgen is required to build or run Datara Studio." >&2
  echo "Set DATARA_FORGEN to its full path, or put forgen on PATH." >&2
  exit 1
fi

# The build inputs, in the order that makes them inputs. Three of them write
# gitignored files that a later step reads, so a fresh checkout has none of them
# and the order is not cosmetic:
#
#   build-wasm.mjs   -> ui/vendor/textcore.js, which build-ui.mjs INLINES.
#   build-icons.mjs  -> src-tauri/icons/ and ui/mark.ico, which build-ui.mjs
#                       embeds.
#   build-ui.mjs     -> ui/studio.html and, with --core, ui/studio-core.html.
#                       BOTH are declared resources in tauri.conf.json, and
#                       `tauri-build` fails if a declared resource is missing.
#
# This script had them the other way round and never built the text core, which
# is the same defect `scripts/build-desktop.cmd` shipped with: on a fresh
# checkout `build-ui.mjs` dies on "cannot inline /vendor/textcore.js". It went
# unnoticed because `verify-build-order.mjs` did not list this file as an entry
# point - the one platform this script exists for is not the one it was written
# on. It is in the list now.
echo "  building the self-contained interface ..."
node scripts/build-wasm.mjs
node scripts/build-icons.mjs
node scripts/build-ui.mjs
node scripts/build-ui.mjs --core

# The shell bundles the Datara server as studio/src/main.exe. Rebuilding only
# the Rust shell leaves that resource at whatever version happened to be built
# last, which is how a 0.4.0 installer can still report 0.3.0 and carry the old
# move/mkdir implementation. On Windows the MSVC linker must precede Git Bash's
# GNU link; on Unix the normal toolchain is correct.
if [[ "$OSTYPE" == msys* || "$OSTYPE" == mingw* || "$OSTYPE" == cygwin* ]]; then
  source scripts/msvc-env.sh
fi
echo "  building the Datara server resource ..."
forgen build src/main.dtr

if ! test -f src-tauri/dist/index.html; then
  echo "src-tauri/dist/index.html is missing" >&2
  exit 1
fi

echo "  building the desktop shell ..."
cargo build --release --manifest-path src-tauri/Cargo.toml

echo
echo "  built: src-tauri/target/release/datara-studio"
