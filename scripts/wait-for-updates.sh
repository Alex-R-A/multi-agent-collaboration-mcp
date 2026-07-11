#!/usr/bin/env bash
#
# Block until there is something new for an agent, then exit. Designed to run
# as a background task: when it exits 0, there is something new to read.
#
# Usage:
#   wait-for-updates.sh --agent <agent_id> [options]           # ALL your rooms
#   wait-for-updates.sh --room <id|name> --agent <agent_id>    # one room
#
# Options:
#   --agent <agent_id>   your identity; baselines are its read markers, and your
#                        own posts are skipped (required unless --room + --since)
#   --room <id|name>     scope the watch to one room (default: every room the
#                        agent is currently present in)
#   --mentions-only      only fire when a message tags --agent or replies to one
#                        of its messages
#   --since <seq>        use this seq as the baseline instead of the read marker
#                        (requires --room: seqs are per-room). Without --agent
#                        this is a room-wide watcher: it has no identity, so it
#                        wakes on ANY message, including yours.
#                        Private-cursor sessions (join_room cursor:'private')
#                        should pass --room with --since = their own
#                        last_read_seq from whoami: markers are identity-level
#                        (the MAX across twin sessions), which can hide a
#                        lagging session's backlog.
#   --interval <sec>     poll interval (default 5)
#   --timeout <sec>      give up after this many seconds of no updates
#                        (default 1200 = 20 minutes; 0 = never)
#
# Scope notes: the all-rooms watch covers rooms the agent is PRESENT in
# (soft-left rooms are muted) and fails fast with exit 2 if the agent is
# present in none (a typo'd id should surface immediately, not burn the
# timeout). An explicit --room watch keeps working after leaving that room:
# naming the room is the intent to watch it. The timeout is a FLOOR: one
# final probe runs at the deadline and may still report updates, so the
# worst-case overshoot is <1s plus one probe. The probe's busy_timeout bounds
# SQLite LOCK waits only, not query execution or a stalled filesystem; a
# wedged probe wedges the poller (accepted: kill the process).
#
# Exit codes: 0 updates found (status JSON printed to stdout), 124 timed out,
# 2 error, 130/143 killed (SIGINT/SIGTERM).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/../dist/check.js"

interval=5
timeout=1200   # 20 minutes; quit even if no updates so a background task never hangs
probe_args=()

need_value() {  # $1 = flag name; ensures a value follows before we read $2
  [[ $# -ge 2 ]] || { echo "wait-for-updates: $1 needs a value" >&2; exit 2; }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) need_value "$@"; interval="$2"; shift 2 ;;
    --timeout)  need_value "$@"; timeout="$2";  shift 2 ;;
    --interval=*) interval="${1#*=}"; shift ;;
    --timeout=*)  timeout="${1#*=}";  shift ;;
    *) probe_args+=("$1"); shift ;;
  esac
done

if ! [[ "$interval" =~ ^[0-9]+$ ]]; then
  echo "wait-for-updates: --interval must be a positive integer" >&2; exit 2
fi
if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "wait-for-updates: --timeout must be a non-negative integer" >&2; exit 2
fi
# Force base 10 BEFORE any arithmetic: bash treats a leading zero as octal,
# so a validated-but-unnormalized "08" blew up the first (( )) with
# "value too great for base" and the wrong exit code.
interval=$((10#$interval))
timeout=$((10#$timeout))
if [[ "$interval" -lt 1 ]]; then
  echo "wait-for-updates: --interval must be a positive integer" >&2; exit 2
fi

# No passthrough flags means neither --agent nor --room. Guard explicitly:
# expanding an empty array as "${probe_args[@]}" below trips `set -u` on bash 3.2.
if [[ ${#probe_args[@]} -eq 0 ]]; then
  echo "wait-for-updates: --agent (all-rooms watch) or --room is required" >&2; exit 2
fi

if [[ ! -f "$CHECK" ]]; then
  echo "wait-for-updates: $CHECK not found; run 'npm run build' first" >&2
  exit 2
fi

# Interruptible sleep that dies WITH us: a foreground `sleep` survives the
# shell being SIGTERMed (reparented, naps out its full interval); running it
# in the background and killing it from the trap ends both immediately.
SLEEP_PID=""
on_signal() {
  local code=$1
  [[ -n "$SLEEP_PID" ]] && kill "$SLEEP_PID" 2>/dev/null
  exit "$code"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
nap() {
  sleep "$1" &
  SLEEP_PID=$!
  # `wait` returns >128 when interrupted by a trapped signal; the trap exits.
  wait "$SLEEP_PID" 2>/dev/null || true
  SLEEP_PID=""
}

start=$(date +%s)
while true; do
  # Deadline first: never launch a probe past the timeout. Strictly-greater:
  # whole-second timestamps otherwise expire a 2s timeout after ~1.1s real
  # time; a timeout must be a FLOOR, so the worst case is now overshoot by
  # <1s plus an in-flight probe's own runtime (bounded by its busy_timeout).
  if [[ "$timeout" -gt 0 ]]; then
    now=$(date +%s)
    if (( now - start > timeout )); then
      echo '{"timed_out":true}' >&2
      exit 124
    fi
  fi

  if out=$(node "$CHECK" "${probe_args[@]}"); then
    echo "$out"          # exit 0 from probe => updates exist
    exit 0
  else
    rc=$?
    # Only rc==1 WITH a status line means "no updates yet". Anything else
    # (probe error 2, or the node process dying: 127/137/139/...) must
    # surface, not be mistaken for a quiet room. The -z guard closes the
    # nastiest gap: node itself exits 1 on a module-load failure (missing
    # node_modules, ABI mismatch, partial build), and a genuine quiet probe
    # always prints exactly one JSON line, while a crashed one prints nothing.
    if [[ $rc -ne 1 || -z "$out" ]]; then
      if [[ -z "$out" ]]; then
        echo "wait-for-updates: probe exited $rc with no status line (crashed?)" >&2
      else
        echo "wait-for-updates: probe exited $rc" >&2
      fi
      exit 2
    fi
    # fall through to sleep
  fi

  if [[ "$timeout" -gt 0 ]]; then
    now=$(date +%s)
    elapsed=$(( now - start ))
    # Never sleep past the deadline: clamp the nap to the time remaining
    # (the top-of-loop check exits once the deadline has passed).
    remaining=$(( timeout - elapsed ))
    if (( remaining < 1 )); then remaining=1; fi
    nap "$(( interval < remaining ? interval : remaining ))"
  else
    nap "$interval"
  fi
done
