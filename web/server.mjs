// Read-only web viewer for the agent-chat SQLite database.
//
// Standalone ESM script (no build step): it opens the same file the MCP
// servers write to and serves one HTML page plus two JSON endpoints. No auth,
// bound to localhost, consistent with the project's design.
//
//   Run:  node web/server.mjs     (or: npm run web)
//   Port: AGENT_CHAT_VIEWER_PORT  (default 8787)
//   DB:   AGENT_CHAT_DB           (default ~/.agent-chat-mcp/chat.db)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_CHAT_VIEWER_PORT) || 8787;

// Same resolution the server uses (kept in sync deliberately, not imported, so
// the viewer needs no build output and never runs migrations against the file).
function resolveDbPath() {
  const override = process.env.AGENT_CHAT_DB;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}
const DB_PATH = resolveDbPath();

// Open lazily so the server still starts (and says why it is empty) when no
// agent has created the database yet. Opened writable but pinned query_only: a
// read-only OPEN of a WAL database is fragile (it needs the -shm file), whereas
// a writable handle with query_only reads WAL cleanly and still rejects writes.
let db = null;
function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  return db;
}

function listRooms() {
  const d = getDb();
  if (!d) return null;
  return d
    .prepare(
      `SELECT r.id, r.name, r.description, r.pinned,
              (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
              (SELECT COUNT(*) FROM messages g WHERE g.room_id = r.id) AS messages,
              (SELECT MAX(created_at) FROM messages g WHERE g.room_id = r.id) AS last_activity
       FROM rooms r ORDER BY r.id`,
    )
    .all();
}

function listMessages(roomId, afterSeq, beforeSeq, limit) {
  const d = getDb();
  if (!d) return null;
  const cols = `g.seq, g.agent_id AS "from", a.role, a.type, g.body, g.format,
                g.mentions, g.reply_to_seq, g.created_at AS at`;
  const src = `messages g LEFT JOIN agents a ON a.id = g.agent_id`;
  let rows;
  if (afterSeq > 0) {
    // Incremental tail: only messages newer than what the client already has.
    rows = d
      .prepare(
        `SELECT ${cols} FROM ${src}
         WHERE g.room_id = ? AND g.seq > ? ORDER BY g.seq ASC LIMIT ?`,
      )
      .all(roomId, afterSeq, limit);
  } else if (beforeSeq > 0) {
    // History paging: the `limit` messages just older than what is shown.
    rows = d
      .prepare(
        `SELECT ${cols} FROM ${src}
         WHERE g.room_id = ? AND g.seq < ? ORDER BY g.seq DESC LIMIT ?`,
      )
      .all(roomId, beforeSeq, limit)
      .reverse();
  } else {
    // Initial load: newest `limit`, returned oldest-first for top-to-bottom reading.
    rows = d
      .prepare(
        `SELECT ${cols} FROM ${src}
         WHERE g.room_id = ? ORDER BY g.seq DESC LIMIT ?`,
      )
      .all(roomId, limit)
      .reverse();
  }
  for (const r of rows) {
    if (r.mentions) {
      try {
        r.mentions = JSON.parse(r.mentions);
      } catch {
        r.mentions = null;
      }
    }
  }
  return rows;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Read BEFORE writeHead: a read failure after headers are sent would
      // make the catch's second writeHead throw and crash the process.
      const html = readFileSync(join(HERE, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/rooms") {
      const rooms = listRooms();
      if (rooms === null)
        return sendJson(res, 200, {
          rooms: [],
          error: `No database at ${DB_PATH}. Start an agent-chat MCP server first.`,
        });
      return sendJson(res, 200, { rooms });
    }
    if (url.pathname === "/api/messages") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, { error: "room must be a positive integer" });
      const after = Number(url.searchParams.get("after")) || 0;
      const before = Number(url.searchParams.get("before")) || 0;
      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit")) || 200, 1000),
      );
      const messages = listMessages(roomId, after, before, limit);
      if (messages === null)
        return sendJson(res, 200, {
          messages: [],
          error: `No database at ${DB_PATH}.`,
        });
      return sendJson(res, 200, { messages });
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const present = existsSync(DB_PATH) ? "" : "  (not found yet)";
  console.log(`agent-chat viewer: http://127.0.0.1:${PORT}`);
  console.log(`database: ${DB_PATH}${present}`);
});
