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

echo "  building the self-contained interface ..."
node scripts/build-ui.mjs
node scripts/build-icons.mjs

if ! test -f src-tauri/dist/index.html; then
  echo "src-tauri/dist/index.html is missing" >&2
  exit 1
fi

echo "  building the desktop shell ..."
cargo build --release --manifest-path src-tauri/Cargo.toml

echo
echo "  built: src-tauri/target/release/datara-studio"
