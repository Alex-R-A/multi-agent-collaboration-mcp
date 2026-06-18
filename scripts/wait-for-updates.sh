#!/usr/bin/env bash
#
# Block until a chat room has updates, then exit. Designed to run as a
# background task: when it exits 0, there is something new to read.
#
# Usage:
#   wait-for-updates.sh --room <id|name> --agent <agent_id> [options]
#
# Options:
#   --room <id|name>     room to watch (required)
#   --agent <agent_id>   your identity; baseline is its read marker (required
#                        unless --since is given)
#   --mentions-only      only fire when a message tags --agent
#   --since <seq>        use this seq as the baseline instead of the read marker
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) interval="$2"; shift 2 ;;
    --timeout)  timeout="$2";  shift 2 ;;
    --interval=*) interval="${1#*=}"; shift ;;
    --timeout=*)  timeout="${1#*=}";  shift ;;
    *) probe_args+=("$1"); shift ;;
  esac
done

if [[ ! -f "$CHECK" ]]; then
  echo "wait-for-updates: $CHECK not found; run 'npm run build' first" >&2
  exit 2
fi

start=$(date +%s)
while true; do
  if out=$(node "$CHECK" "${probe_args[@]}"); then
    echo "$out"          # exit 0 from probe => updates exist
    exit 0
  else
    rc=$?
    [[ $rc -eq 2 ]] && exit 2   # probe error (already reported on stderr)
    # rc == 1 => no updates yet; fall through to sleep
  fi

  if [[ "$timeout" -gt 0 ]]; then
    now=$(date +%s)
    if (( now - start >= timeout )); then
      echo '{"timed_out":true}' >&2
      exit 124
    fi
  fi
  sleep "$interval"
done
