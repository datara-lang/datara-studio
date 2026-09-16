#!/usr/bin/env bash
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PORT="${RYAN_HARNESS_UI_PORT:-8088}"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/ui"
