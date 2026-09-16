#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

PORT_A="${DATARA_STUDIO_PORT:-7878}"
PORT_B="${DATARA_STUDIO_PORT_B:-7879}"
PORT_C="${DATARA_STUDIO_PORT_C:-7880}"
PORT_D="${DATARA_STUDIO_PORT_D:-7881}"

if ! command -v forgen >/dev/null 2>&1 && [ -z "${DATARA_FORGEN:-}" ]; then
  echo "forgen is not on PATH. Install the Datara toolchain or set DATARA_FORGEN." >&2
  exit 1
fi
if [ ! -f "ui/studio.html" ]; then
  command -v node >/dev/null 2>&1 || { echo "node is required to build ui/studio.html" >&2; exit 1; }
  node scripts/build-ui.mjs
fi

pick_port() {
  local p
  for p in "$@"; do
    if ! (command -v curl >/dev/null 2>&1 && curl -fsS -m 1 "http://127.0.0.1:$p/api/health" >/dev/null 2>&1); then
      echo "$p"
      return 0
    fi
  done
  return 1
}
run_server() {
  local p="$1"
  echo "starting Datara server on 127.0.0.1:$p"
  DATARA_STUDIO_PORT="$p" "${DATARA_FORGEN:-forgen}" run src/main.dtr &
  CHILDREN+=("$!")
}
cleanup() {
  trap - INT TERM EXIT
  for pid in "${CHILDREN[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
CHILDREN=()
trap cleanup INT TERM EXIT

run_server "$(pick_port "$PORT_A" "$PORT_B" "$PORT_C" "$PORT_D")"
run_server "$(pick_port "$PORT_B" "$PORT_C" "$PORT_D" "$PORT_A")" || true

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:$PORT_A" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT_A" >/dev/null 2>&1 || true
fi

echo "Datara Studio is running. Press Ctrl+C to stop it."
wait
