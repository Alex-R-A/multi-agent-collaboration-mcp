#!/usr/bin/env bash
# Re-register the freshly built agent-chat MCP server with supported AI CLIs.
# The npm script runs the build first; this file also validates the artifact so
# invoking it directly fails clearly instead of installing a broken command.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PATH="$ROOT_DIR/dist/index.js"
MCP_NAME="${AGENT_CHAT_MCP_NAME:-agent-chat}"
NODE_BIN="${AGENT_CHAT_NODE_BIN:-${npm_node_execpath:-}}"

if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$MCP_NAME" ]]; then
  echo "refresh-mcp: AGENT_CHAT_MCP_NAME cannot be empty" >&2
  exit 2
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "refresh-mcp: Node.js was not found; install Node 22+ or set AGENT_CHAT_NODE_BIN" >&2
  exit 2
fi
if [[ ! -f "$SERVER_PATH" ]]; then
  echo "refresh-mcp: $SERVER_PATH not found; run 'npm run build' first" >&2
  exit 2
fi

node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
if [[ ! "$node_major" =~ ^[0-9]+$ || "$node_major" -lt 22 ]]; then
  echo "refresh-mcp: Node 22+ is required (found: $("$NODE_BIN" --version 2>/dev/null || echo unknown))" >&2
  exit 2
fi

refreshed=0
failed=0
skipped=0

remove_registration() {
  local label=$1
  shift
  echo "[$label] removing existing '$MCP_NAME' registration..."
  if ! "$@"; then
    # Claude exits nonzero when the name is absent. Continue because add is the
    # authoritative step and will still expose permission/configuration errors.
    echo "[$label] no removable user registration found; continuing" >&2
  fi
}

add_registration() {
  local label=$1
  shift
  echo "[$label] adding '$MCP_NAME' -> $NODE_BIN $SERVER_PATH"
  if "$@"; then
    refreshed=$((refreshed + 1))
  else
    echo "[$label] failed to add '$MCP_NAME'" >&2
    failed=$((failed + 1))
  fi
}

if command -v codex >/dev/null 2>&1; then
  remove_registration "Codex" codex mcp remove "$MCP_NAME"
  add_registration "Codex" \
    codex mcp add "$MCP_NAME" -- "$NODE_BIN" "$SERVER_PATH"
else
  echo "[Codex] skipped: 'codex' is not installed" >&2
  skipped=$((skipped + 1))
fi

# agy 1.x does not expose MCP add/remove commands. Gemini CLI owns the Gemini
# MCP configuration, so refresh that registration directly and label it for
# both names used by the local workflow.
if command -v gemini >/dev/null 2>&1; then
  remove_registration "Gemini/agy" \
    gemini mcp remove --scope user "$MCP_NAME"
  add_registration "Gemini/agy" \
    gemini mcp add --scope user --transport stdio \
      "$MCP_NAME" "$NODE_BIN" -- "$SERVER_PATH"
else
  echo "[Gemini/agy] skipped: 'gemini' is not installed (agy has no compatible MCP subcommand)" >&2
  skipped=$((skipped + 1))
fi

if command -v claude >/dev/null 2>&1; then
  remove_registration "Claude" \
    claude mcp remove --scope user "$MCP_NAME"
  add_registration "Claude" \
    claude mcp add --scope user --transport stdio \
      "$MCP_NAME" -- "$NODE_BIN" "$SERVER_PATH"
else
  echo "[Claude] skipped: 'claude' is not installed" >&2
  skipped=$((skipped + 1))
fi

echo
echo "MCP refresh complete: $refreshed refreshed, $skipped skipped, $failed failed."
echo "Restart or reconnect already-running CLI sessions so they spawn the new server build."

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
if [[ "$refreshed" -eq 0 ]]; then
  exit 2
fi
