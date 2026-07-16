#!/usr/bin/env bash
# Compatibility entry point for old poller commands. It replaces itself with
# the single-process Node watcher; there is no shell polling loop or child.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLLER="$SCRIPT_DIR/../dist/poller.js"
node_bin=node
args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)
      [[ $# -ge 2 ]] || { echo "wait-for-updates: --node needs a value" >&2; exit 2; }
      node_bin="$2"
      shift 2
      ;;
    --node=*)
      node_bin="${1#*=}"
      shift
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

[[ -n "$node_bin" ]] || { echo "wait-for-updates: empty Node executable" >&2; exit 2; }
command -v "$node_bin" >/dev/null 2>&1 || {
  echo "wait-for-updates: Node executable not found: $node_bin" >&2
  exit 2
}
[[ -f "$POLLER" ]] || { echo "wait-for-updates: $POLLER not found; run 'npm run build'" >&2; exit 2; }
if [[ ${#args[@]} -eq 0 ]]; then
  exec "$node_bin" "$POLLER"
else
  exec "$node_bin" "$POLLER" "${args[@]}"
fi
