#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const connectionId = randomUUID();
const probeStartedAt = new Date().toISOString();
let nickname = null;
let loginCalls = 0;

const SENSITIVE_KEY =
  /authorization|cookie|credential|password|secret|session|token|api[-_]?key/i;
const MAX_STRING_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;

function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (typeof value === "string") {
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}...[truncated ${value.length - MAX_STRING_CHARS} chars]`;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof URL) {
    const safe = new URL(value);
    if (safe.username) safe.username = "[redacted]";
    if (safe.password) safe.password = "[redacted]";
    for (const key of safe.searchParams.keys()) {
      if (SENSITIVE_KEY.test(key)) safe.searchParams.set(key, "[redacted]");
    }
    return safe.toString();
  }
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitize(entry, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      entries.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return entries;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const safe = {};
    for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
      safe[key] = SENSITIVE_KEY.test(key)
        ? {
            redacted: true,
            sha256: fingerprint(
              typeof entry === "string" ? entry : JSON.stringify(entry),
            ),
          }
        : sanitize(entry, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      safe._truncated_keys = entries.length - MAX_OBJECT_KEYS;
    }
    return safe;
  }
  return String(value);
}

function safeAuthInfo(authInfo) {
  if (!authInfo) return null;
  return {
    client_id: authInfo.clientId,
    scopes: sanitize(authInfo.scopes),
    expires_at: authInfo.expiresAt ?? null,
    resource: sanitize(authInfo.resource),
    token: {
      redacted: true,
      sha256: fingerprint(authInfo.token),
    },
    extra: sanitize(authInfo.extra),
  };
}

const server = new McpServer(
  {
    name: "agent-chat-connection-probe",
    version: "0.1.0",
  },
  {
    instructions:
      "Call connection_login. Repeated calls through one MCP connection return " +
      "the same connection_id and nickname. Separately launched MCP processes " +
      "return different values.",
  },
);

server.registerTool(
  "connection_login",
  {
    title: "Inspect MCP connection identity",
    description:
      "Assign and report this MCP server process's connection identity. The " +
      "first call assigns it; later calls reuse it.",
    inputSchema: z.object({}).strict(),
  },
  async (_args, extra) => {
    const assignedNow = nickname === null;
    if (assignedNow) nickname = `connection-${connectionId}`;
    loginCalls += 1;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              connection_id: connectionId,
              nickname,
              assigned_now: assignedNow,
              login_calls: loginCalls,
              observed_at: new Date().toISOString(),
              process: {
                pid: process.pid,
                parent_pid: process.ppid,
                probe_started_at: probeStartedAt,
                working_directory: process.cwd(),
                executable: process.execPath,
                argv: sanitize(process.argv),
                title: process.title,
                node_version: process.version,
                platform: process.platform,
                architecture: process.arch,
                hostname: hostname(),
                uid: process.getuid?.() ?? null,
                gid: process.getgid?.() ?? null,
                stdin_is_tty: process.stdin.isTTY === true,
                stdout_is_tty: process.stdout.isTTY === true,
              },
              mcp: {
                transport: "stdio",
                transport_session_id:
                  extra.sessionId === undefined
                    ? null
                    : {
                        redacted: true,
                        sha256: fingerprint(extra.sessionId),
                      },
                client_reported_info: sanitize(
                  server.server.getClientVersion(),
                ),
                client_reported_capabilities: sanitize(
                  server.server.getClientCapabilities(),
                ),
                request: {
                  jsonrpc_request_id: extra.requestId,
                  task_id: extra.taskId ?? null,
                  task_requested_ttl: extra.taskRequestedTtl ?? null,
                  metadata: sanitize(extra._meta),
                  http:
                    extra.requestInfo === undefined
                      ? null
                      : {
                          url: sanitize(extra.requestInfo.url),
                          headers: sanitize(extra.requestInfo.headers),
                        },
                  auth: safeAuthInfo(extra.authInfo),
                },
                field_sources: {
                  connection_id:
                    "Generated by this probe process; not supplied by MCP.",
                  client_reported_info:
                    "initialize.params.clientInfo supplied by the MCP client.",
                  client_reported_capabilities:
                    "initialize.params.capabilities supplied by the MCP client.",
                  transport_session_id:
                    "RequestHandlerExtra.sessionId when the transport supplies one.",
                },
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

let shutdownPromise;
function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  process.exitCode = exitCode;
  shutdownPromise = server.close().catch(() => undefined);
  return shutdownPromise;
}

process.stdin.once("end", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

try {
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `connection probe ready (connection_id: ${connectionId}, pid: ${process.pid})\n`,
  );
} catch (error) {
  process.stderr.write(
    `connection probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
