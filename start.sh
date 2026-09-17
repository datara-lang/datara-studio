#!/usr/bin/env bash
# Datara Studio launcher for Linux and macOS.
#
# The POSIX counterpart of `start.cmd`, and it is meant to stay one. It used to
# do less than its Windows twin in two ways that mattered:
#
#   * it never started the AI companion, so the suggestions, the second opinion
#     on diagnostics and the chat panel were Windows-only in practice - even
#     though `st_ai_start` has a working Unix branch and the companion itself is
#     pure Python and perfectly portable. On Linux the IDE simply appeared to
#     have no AI.
#   * it never watched the servers. The Datara runtime gives a socket no timeout
#     and no non-blocking mode, so one connection that connects and then sends
#     nothing blocks that server's single-threaded accept loop permanently, and
#     browsers open exactly such connections. `start.cmd` restarts the pair when
#     neither port answers; this did not, so on Linux a wedged server stayed
#     wedged until the launcher was killed by hand.
#
# What is deliberately *not* copied from `start.cmd`: it spawns the servers and
# then tests whether they came up, which is how it ends up needing the C and D
# fallback ports. Here the free port is chosen before anything is started, so the
# fallback is the first choice and there is nothing left to fall back from.
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

PORT_A="${DATARA_STUDIO_PORT:-7878}"
PORT_B="${DATARA_STUDIO_PORT_B:-7879}"
PORT_C="${DATARA_STUDIO_PORT_C:-7880}"
PORT_D="${DATARA_STUDIO_PORT_D:-7881}"
AI_PORT="${DATARA_AI_PORT:-7890}"

if ! command -v forgen >/dev/null 2>&1 && [ -z "${DATARA_FORGEN:-}" ]; then
  echo "forgen is not on PATH. Install the Datara toolchain or set DATARA_FORGEN." >&2
  exit 1
fi
if [ ! -f "ui/studio.html" ]; then
  command -v node >/dev/null 2>&1 || { echo "node is required to build ui/studio.html" >&2; exit 1; }
  echo "  ui/studio.html is missing - building it ..."
  node scripts/build-ui.mjs
fi

# Does this port have a server that actually *answers*?
#
# Two endpoints, not one: the studio serves `/api/health` and the companion
# serves `/health`. Asking the wrong one gets a 404, which reads as "down", and
# the companion start is guarded by this check - so the wrong path there starts a
# second daemon on every launch. That is the 115-process failure `st_port_busy`
# was written to prevent, and it was reintroduced here for exactly one run before
# being caught: the log said "starting the AI companion" while one was already
# answering on 7890.
#
# The response goes to the shell's `/dev/null`, not to `curl -o /dev/null`.
# Measured on this machine: `-o /dev/null` exits 23 (`CURLE_WRITE_ERROR`) even on
# a 200 that took 2 ms, so every check reported "down" - the launcher picked
# ports that were already in use, the servers failed to bind, and the watchdog
# restarted a healthy pair in a loop.
health() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS -m 3 "$1" >/dev/null 2>&1
}
studio_up() { health "http://127.0.0.1:$1/api/health"; }
companion_up() { health "http://127.0.0.1:$1/health"; }

# The first port that nothing is answering on.
#
# Asking `/api/health` rather than testing the bind: a server that was killed can
# leave its listening socket registered, and the port is then bound but silent. A
# bind test would call that port free and hand it to a new server, which on Unix
# fails to bind and exits - so the IDE would come up pointing at nothing.
pick_port() {
  local p
  for p in "$@"; do
    if ! studio_up "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

any_up() {
  local p
  for p in "$PORT_A" "$PORT_B" "$PORT_C" "$PORT_D"; do
    if studio_up "$p"; then return 0; fi
  done
  return 1
}

CHILDREN=()

kill_children() {
  local pid
  for pid in "${CHILDREN[@]:-}"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  CHILDREN=()
}

cleanup() {
  trap - INT TERM EXIT
  kill_children
}
trap cleanup INT TERM EXIT

run_server() {
  local p="$1"
  echo "  starting the Datara server on 127.0.0.1:$p"
  DATARA_STUDIO_PORT="$p" "${DATARA_FORGEN:-forgen}" run src/main.dtr &
  CHILDREN+=("$!")
}

spawn_pair() {
  local a b p
  a="$(pick_port "$PORT_A" "$PORT_B" "$PORT_C" "$PORT_D" || true)"
  if [ -z "$a" ]; then
    echo "  every port from $PORT_A to $PORT_D is busy - nothing started." >&2
    return 1
  fi
  # The second port cannot be found by asking, so it is found by exclusion.
  #
  # `pick_port` answers "is anything listening here", and the server on `$a` has
  # not bound yet - it was started one line ago and takes a moment. Asking again
  # therefore returns `$a` itself, and the pair became two servers fighting over
  # one port. Measured, verbatim, before this fix:
  #
  #     starting the Datara server on 127.0.0.1:7880
  #     starting the Datara server on 127.0.0.1:7880
  #     datara-studio: could not bind 127.0.0.1:7880
  #
  # which is one server running and one dead, in a launcher whose whole reason
  # for existing is that the interface has a second port to fall back to.
  b=""
  for p in "$PORT_B" "$PORT_C" "$PORT_D" "$PORT_A"; do
    if [ "$p" != "$a" ] && ! studio_up "$p"; then
      b="$p"
      break
    fi
  done
  run_server "$a"
  if [ -n "$b" ]; then run_server "$b"; fi
}

# ---- the optional AI companion --------------------------------------------
#
# Optional in the same sense as on Windows: if it is not there the IDE runs, with
# no suggestions and a panel that says so.
#
# `FORGEN_AI_DIR` points at the directory that *contains* `forgen_ai/`, the same
# variable `start.cmd` reads - the two launchers must not disagree about where
# the companion lives. (It is not the same convention as `st_ai_start`'s `dir`
# argument, which points at the directory containing `python/`. The two differ by
# one level, and this variable means this one.)
#
# The search order itself is not here. It lives in `scripts/find-companion.mjs`
# and both launchers ask that file, because the copy that used to live here and
# in `start.cmd` was wrong in both: `../../python` was correct while the studio
# lived at `D:\ryan\datara-studio` and has resolved to `D:\python`, which does
# not exist, since the workspace moved to `D:\IDE datara`. Measured on this
# machine, the companion is at `D:/ryan/python/forgen_ai/ide_daemon.py`. A batch
# copy of the search cannot be run at all on a machine whose tooling cannot reach
# `cmd.exe`, so it would have shipped unexecuted a second time; `node` is already
# required by this repository for the interface build, and the search is checked
# by `scripts/verify-companion.mjs`.
companion_dir() {
  local c
  if command -v node >/dev/null 2>&1; then
    # The script prints the candidates it tried on stderr, so a "not found" here
    # is followed by the list without this function repeating it.
    c="$(node scripts/find-companion.mjs || true)"
    if [ -n "$c" ]; then
      echo "$c"
      return 0
    fi
  fi
  # Without node the only candidate left that can be checked here is the explicit
  # one, and reimplementing the rest would be the copy this avoids.
  c="${FORGEN_AI_DIR:-}"
  if [ -n "$c" ] && [ -f "$c/forgen_ai/ide_daemon.py" ]; then
    echo "$c"
    return 0
  fi
  return 1
}

start_companion() {
  local ai_dir
  if ! ai_dir="$(companion_dir)"; then
    echo "  AI companion not found - the IDE runs without suggestions."
    echo "    set FORGEN_AI_DIR to the directory containing forgen_ai/"
    return 0
  fi
  if companion_up "$AI_PORT"; then
    echo "  the AI companion is already running on 127.0.0.1:$AI_PORT"
    return 0
  fi
  local py="" cand
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then py="$cand"; break; fi
  done
  if [ -z "$py" ]; then
    echo "  the AI companion needs python3 - the IDE runs without suggestions." >&2
    return 0
  fi
  echo "  starting the AI companion on 127.0.0.1:$AI_PORT  ($ai_dir)"
  # Detached on purpose: the companion outlives this launcher, so closing the
  # window does not take the suggestions with it. It is also the same process the
  # IDE would have started itself, which is why `st_port_busy` has to see it.
  ( cd "$ai_dir/.." && "$py" -E -s python/forgen_ai/ide_daemon.py --port "$AI_PORT" >/dev/null 2>&1 & )
}

echo
echo "  Datara Studio"
echo "  -------------"
start_companion
spawn_pair

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:$PORT_A" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT_A" >/dev/null 2>&1 || true
fi

echo
echo "  Datara Studio is running. This window must stay open; Ctrl+C to stop it."
echo

# The watchdog. Restarting only when *no* port answers, because restarting on one
# slow response would fight a server that is merely busy - the same rule
# `start.cmd` uses, and the reason this polls all four rather than one.
while true; do
  sleep 4
  if ! any_up; then
    echo "  [$(date +%H:%M:%S)] no port answered - restarting the servers"
    kill_children
    sleep 1
    spawn_pair
    echo "  [$(date +%H:%M:%S)] restarted"
  fi
done
