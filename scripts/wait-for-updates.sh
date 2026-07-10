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
#   --db <path>          db file (default $AGENT_CHAT_DB or ~/.agent-chat-mcp/chat.db)
#
# Exit codes: 0 updates found (status JSON printed to stdout), 124 timed out,
# 2 error.
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

if ! [[ "$interval" =~ ^[0-9]+$ ]] || [[ "$interval" -lt 1 ]]; then
  echo "wait-for-updates: --interval must be a positive integer" >&2; exit 2
fi
if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "wait-for-updates: --timeout must be a non-negative integer" >&2; exit 2
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

start=$(date +%s)
while true; do
  # Deadline first: never launch a probe past the timeout, so a caller's
  # timing contract holds even when a probe plus sleep straddles the line.
  if [[ "$timeout" -gt 0 ]]; then
    now=$(date +%s)
    if (( now - start >= timeout )); then
      echo '{"timed_out":true}' >&2
      exit 124
    fi
  fi

  if out=$(node "$CHECK" "${probe_args[@]}"); then
    echo "$out"          # exit 0 from probe => updates exist
    exit 0
  else
    rc=$?
    # Only rc==1 means "no updates yet". Anything else (probe error 2, or the
    # node process itself dying: 127/137/139/...) must surface, not be mistaken
    # for a quiet room.
    if [[ $rc -ne 1 ]]; then
      echo "wait-for-updates: probe exited $rc" >&2
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
    sleep "$(( interval < remaining ? interval : remaining ))"
  else
    sleep "$interval"
  fi
done
