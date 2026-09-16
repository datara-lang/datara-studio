#!/usr/bin/env bash
# build.sh - lint, build and self-test the Ryan Harness Core kernel.
#
# Order matters: the linter runs FIRST because the compiler cannot detect the
# field-name collision it checks for (see docs/COMPILER-NOTES.md section 1). A
# build that skips the lint can produce a binary that runs and returns wrong
# data with no error.
#
# Usage:  bash scripts/build.sh [--release]
# Exit codes: 0 ok, 1 lint failure, 2 compile failure, 3 self-test failure

set -uo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-python}"
FAIL=0

echo "== 1/4 lint =================================================="
"$PY" scripts/style_check.py src || FAIL=1
if [ "$FAIL" -ne 0 ]; then
  echo
  echo "lint failed. To fix shared field names, run:"
  echo "  $PY scripts/uniquify_fields.py src --apply"
  exit 1
fi

echo
echo "== 2/4 type check (forgen check) ============================="
if ! forgen check src/main.dtr; then
  echo "type check failed"
  exit 2
fi

echo
echo "== 3/4 AOT build ============================================="
if ! forgen build src/main.dtr; then
  echo "build failed"
  exit 2
fi

BIN="src/main.exe"
[ -x "$BIN" ] || BIN=$(find . -maxdepth 2 -name 'main.exe' -o -maxdepth 2 -name 'ryan.exe' 2>/dev/null | head -1)
if [ -z "${BIN:-}" ] || [ ! -x "$BIN" ]; then
  echo "could not locate the built binary"
  exit 2
fi
echo "binary: $BIN"

echo
echo "== 4/4 self-test ============================================="
"$BIN" selftest
STATUS=$?
echo "exit status: $STATUS"
if [ "$STATUS" -ne 0 ]; then
  echo "self-test failed"
  exit 3
fi

echo
echo "kernel OK"
