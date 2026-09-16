#!/usr/bin/env bash
# build.sh - build and verify Datara Studio.
#
# Order matters:
#   1. the Rust text core, because the interface cannot start without it
#   2. its test suite, because the incremental line index is only correct if it
#      is checked against a full rebuild
#   3. the highlighting pipeline, because a wrong token-to-line split silently
#      corrupts the text the user sees
#   4. the Datara server, because it is what serves all of the above
#
# Usage:  bash scripts/build.sh
# Exit:   0 ok, 1 core test failure, 2 server failure

set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.cargo/bin:$PATH"

echo "== 1/9 Rust text core -> wasm ================================"
if ! node scripts/build-wasm.mjs; then
  echo "wasm build failed"
  exit 2
fi

echo
echo "== 2/9 single-file interface + icons ========================="
# The icon set first, from assets/datara.ico: the window icon, the tab and the
# mark beside a .dtr file all come from that one file, and generating them here
# is what stops them drifting into three different designs.
if ! node scripts/build-icons.mjs; then
  echo "icon build failed"
  exit 2
fi
if ! node scripts/build-ui.mjs; then
  echo "interface build failed"
  exit 2
fi

echo
echo "== 3/9 text core tests ======================================="
if ! node crates/textcore/test/test.mjs; then
  echo "text core tests failed"
  exit 1
fi

echo
echo "== 4/9 highlighting pipeline ================================="
if ! node ui/test/highlight.test.mjs; then
  echo "highlighting tests failed"
  exit 1
fi

echo
echo "== 5/9 interface renders ====================================="
if ! node ui/test/render.test.mjs; then
  echo "render tests failed"
  exit 1
fi

echo
echo "== 6/9 the editor, driven as the app drives it ==============="
if ! node ui/test/editor.test.mjs; then
  echo "the editor does not render text"
  exit 1
fi

echo
echo "== 7/9 boot the built artifact ==============================="
echo "  (loads ui/studio.html in a DOM and runs it; needs: npm install, once)"
if ! node ui/test/boot.test.mjs; then
  echo "the built interface does not boot"
  exit 1
fi

echo
echo "== 8/9 Datara server ========================================="
if ! forgen check src/main.dtr; then
  echo "server check failed"
  exit 2
fi

echo
echo "== 9/9 every snippet is Datara ==============================="
if ! node scripts/check-snippets.mjs; then
  echo "a snippet the editor offers does not compile"
  exit 3
fi

echo
echo "studio OK - start it with:  forgen run src/main.dtr"
echo ""
echo "note: this suite verifies structure, not pixels. To look at the real"
echo "      thing in a real browser, with the server running:"
echo "        node ui/test/shoot.mjs http://127.0.0.1:7878 shots"
echo "        node ui/test/drive.mjs http://127.0.0.1:7878 shots/drive"
echo "      drive.mjs also reads the files back off disk, because a screenshot"
echo "      cannot tell you whether Ctrl+S actually saved anything."
