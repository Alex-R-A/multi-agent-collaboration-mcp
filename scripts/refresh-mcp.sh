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

# Antigravity (agy) has no MCP-management CLI. It discovers global servers in
# ~/.gemini/config/mcp_config.json, which is separate from Gemini CLI's user
# settings. Update that JSON atomically and preserve every unrelated field and
# server. AGENT_CHAT_AGY_CONFIG provides an isolated path for tests.
if command -v agy >/dev/null 2>&1; then
  if [[ -n "${AGENT_CHAT_AGY_CONFIG:-}" ]]; then
    AGY_CONFIG="$AGENT_CHAT_AGY_CONFIG"
  elif [[ -n "${HOME:-}" ]]; then
    AGY_CONFIG="$HOME/.gemini/config/mcp_config.json"
  else
    AGY_CONFIG=""
  fi
  if [[ -z "$AGY_CONFIG" ]]; then
    echo "[Antigravity/agy] failed: HOME is unset; set AGENT_CHAT_AGY_CONFIG" >&2
    failed=$((failed + 1))
  elif [[ "$AGY_CONFIG" != /* ]]; then
    echo "[Antigravity/agy] failed: config path must be absolute: $AGY_CONFIG" >&2
    failed=$((failed + 1))
  else
    echo "[Antigravity/agy] refreshing '$MCP_NAME' in $AGY_CONFIG"
    if "$NODE_BIN" - "$AGY_CONFIG" "$MCP_NAME" "$NODE_BIN" "$SERVER_PATH" <<'NODE'
const fs = require("node:fs");
const pathModule = require("node:path");

const [requestedPath, name, command, serverPath] = process.argv.slice(2);
const exists = fs.existsSync(requestedPath);
const configPath =
  exists && fs.lstatSync(requestedPath).isSymbolicLink()
    ? fs.realpathSync(requestedPath)
    : requestedPath;

let config = {};
if (exists) {
  const source = fs.readFileSync(configPath, "utf8");
  config = source.trim().length === 0 ? {} : JSON.parse(source);
}
if (config === null || typeof config !== "object" || Array.isArray(config)) {
  throw new Error(`${configPath} must contain a JSON object`);
}
if (config.mcpServers === undefined) config.mcpServers = {};
if (
  config.mcpServers === null ||
  typeof config.mcpServers !== "object" ||
  Array.isArray(config.mcpServers)
) {
  throw new Error(`${configPath}: mcpServers must be a JSON object`);
}

// Explicit remove + add semantics, committed as one atomic file replacement.
delete config.mcpServers[name];
config.mcpServers[name] = { command, args: [serverPath] };

const dir = pathModule.dirname(configPath);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const mode = exists ? fs.statSync(configPath).mode & 0o777 : 0o600;
const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
try {
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode,
  });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, configPath);
} catch (error) {
  try {
    fs.unlinkSync(tempPath);
  } catch {}
  throw error;
}
NODE
    then
      refreshed=$((refreshed + 1))
    else
      echo "[Antigravity/agy] failed to refresh '$MCP_NAME'" >&2
      failed=$((failed + 1))
    fi
  fi
else
  echo "[Antigravity/agy] skipped: 'agy' is not installed" >&2
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
