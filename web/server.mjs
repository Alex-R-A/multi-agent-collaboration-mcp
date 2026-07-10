// Web viewer + human participation for the agent-chat SQLite database.
//
// Standalone ESM script (no build step): it opens the same file the MCP
// servers write to and serves one HTML page plus JSON endpoints. Reads use a
// query_only handle; participation (join/post/read/leave) uses a separate
// writable handle whose message insert mirrors ChatStore.postMessage's
// IMMEDIATE-transaction seq allocation, so web posts are safe against
// concurrent agent writers. No auth, bound to localhost: identity is
// self-asserted by design, exactly like the agents themselves.
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

// Writable handle for participation endpoints only. Kept separate from the
// query_only read handle so a bug in a read path can never write.
let wdb = null;
function getWriteDb() {
  if (wdb) return wdb;
  if (!existsSync(DB_PATH)) return null;
  wdb = new Database(DB_PATH, { fileMustExist: true });
  wdb.pragma("busy_timeout = 5000");
  return wdb;
}

const MAX_BODY_CHARS = 100_000; // matches the agents' per-page read budget
const NAME_RE = /^[\w][\w.-]{0,199}$/; // sane self-asserted ids, no whitespace

function readBody(req, cap = 400_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function membership(d, roomId, name) {
  return d
    .prepare(
      "SELECT left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(roomId, name);
}

// { error } results become 400s; { status: ... } results become 200s.
function joinRoom(d, roomId, name) {
  const room = d.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId);
  if (!room) return { error: `no room ${roomId}` };
  // Never overwrite an existing agent's type/role: identity is self-asserted,
  // and a human deliberately resuming an agent id keeps that id's metadata.
  d.prepare(
    "INSERT INTO agents (id, type) VALUES (?, 'human') ON CONFLICT(id) DO NOTHING",
  ).run(name);
  d.prepare(
    "INSERT OR IGNORE INTO memberships (room_id, agent_id) VALUES (?, ?)",
  ).run(roomId, name);
  d.prepare(
    "UPDATE memberships SET left_at = NULL, last_seen = datetime('now') WHERE room_id = ? AND agent_id = ?",
  ).run(roomId, name);
  return { joined: true, agent_id: name, room_id: roomId };
}

function postMessage(d, roomId, name, body, replyToSeq, mentions) {
  const m = membership(d, roomId, name);
  if (!m || m.left_at !== null) {
    return { error: "join the room first (POST /api/join)" };
  }
  const mentionsJson =
    mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
  // Same shape as ChatStore.postMessage: validate the reply target and
  // allocate the next per-room seq inside one IMMEDIATE transaction, so a
  // concurrent agent writer cannot take the same seq and the reply reference
  // cannot dangle against a racing prune.
  const tx = d.transaction(() => {
    if (replyToSeq !== null) {
      const parent = d
        .prepare("SELECT 1 FROM messages WHERE room_id = ? AND seq = ?")
        .get(roomId, replyToSeq);
      if (!parent) {
        throw new Error(`reply_to_seq ${replyToSeq} does not exist in this room`);
      }
    }
    const { next } = d
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
      )
      .get(roomId);
    d.prepare(
      `INSERT INTO messages (room_id, seq, agent_id, format, body, mentions, reply_to_seq)
       VALUES (?, ?, ?, 'text', ?, ?, ?)`,
    ).run(roomId, next, name, body, mentionsJson, replyToSeq);
    d.prepare(
      "UPDATE memberships SET last_seen = datetime('now') WHERE room_id = ? AND agent_id = ?",
    ).run(roomId, name);
    return next;
  });
  try {
    return { seq: tx.immediate() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function markRead(d, roomId, name, seq) {
  const m = membership(d, roomId, name);
  if (!m) return { error: "join the room first (POST /api/join)" };
  // Clamp to the room's latest seq (parity with the MCP server's mark_read):
  // the monotonic max() below makes an unclamped over-large value permanent,
  // wedging the marker above every future message.
  const { latest } = d
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?",
    )
    .get(roomId);
  const eff = Math.min(seq, latest);
  // Monotonic, mirroring the identity-marker semantics agents rely on for
  // read receipts and prune refusal.
  d.prepare(
    `UPDATE memberships SET last_read_seq = max(last_read_seq, ?), last_seen = datetime('now')
     WHERE room_id = ? AND agent_id = ?`,
  ).run(eff, roomId, name);
  const row = d
    .prepare(
      "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(roomId, name);
  return { last_read_seq: row.last_read_seq };
}

function leaveRoom(d, roomId, name) {
  const info = d
    .prepare(
      `UPDATE memberships SET left_at = datetime('now'), last_seen = datetime('now')
       WHERE room_id = ? AND agent_id = ? AND left_at IS NULL`,
    )
    .run(roomId, name);
  return { left: info.changes > 0, room_id: roomId };
}

// Mentions are parsed server-side from @tokens so every client gets the same
// semantics; ids are stored as tagged even if that agent never joined,
// matching how agent mentions behave. Trailing dots/dashes are stripped:
// "ask @bob." tags bob, not "bob.".
function parseMentions(body) {
  const out = [];
  for (const m of body.matchAll(/@([\w][\w.-]{0,199})/g)) {
    const id = m[1].replace(/[.-]+$/, "");
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= 100) break;
  }
  return out;
}

// Full-text search over the room's messages via the FTS index the MCP server
// maintains; best matches first. FTS5 syntax errors surface to the caller.
function searchMessages(roomId, q, limit) {
  const d = getDb();
  if (!d) return null;
  const rows = d
    .prepare(
      `SELECT g.seq, g.agent_id AS "from", a.role, a.type, g.body, g.format,
              g.mentions, g.reply_to_seq, g.created_at AS at
       FROM messages_fts f
       JOIN messages g ON g.id = f.rowid
       LEFT JOIN agents a ON a.id = g.agent_id
       WHERE f.body MATCH ? AND g.room_id = ?
       ORDER BY rank LIMIT ?`,
    )
    .all(q, roomId, limit);
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

async function handlePost(url, req, res) {
  // A foreign web page can fire no-preflight POSTs at localhost from the
  // operator's browser; reject any non-local Origin. Requests without an
  // Origin header (curl, scripts) stay allowed: local processes can already
  // write the database file directly, so this is browser-context hygiene,
  // not authentication.
  const origin = req.headers.origin;
  if (origin) {
    let local = false;
    try {
      const h = new URL(origin).hostname;
      local = h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    } catch {}
    if (!local) {
      return sendJson(res, 403, { error: "cross-origin writes are not allowed" });
    }
  }
  const d = getWriteDb();
  if (!d) {
    return sendJson(res, 503, {
      error: `No database at ${DB_PATH}. Start an agent-chat MCP server first.`,
    });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, 400, { error: String((e && e.message) || e) });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return sendJson(res, 400, { error: "request body must be a JSON object" });
  }
  const roomId = Number(payload.room);
  if (!Number.isInteger(roomId) || roomId <= 0) {
    return sendJson(res, 400, { error: "room must be a positive integer id" });
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!NAME_RE.test(name)) {
    return sendJson(res, 400, {
      error:
        "name must be 1-200 chars: letters, digits, underscore, dot or dash (no spaces)",
    });
  }

  if (url.pathname === "/api/join") {
    const r = joinRoom(d, roomId, name);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (url.pathname === "/api/leave") {
    return sendJson(res, 200, leaveRoom(d, roomId, name));
  }
  if (url.pathname === "/api/read") {
    const seq = Number(payload.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      return sendJson(res, 400, { error: "seq must be a non-negative integer" });
    }
    const r = markRead(d, roomId, name, seq);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (url.pathname === "/api/post") {
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!body) return sendJson(res, 400, { error: "message body is empty" });
    if (body.length > MAX_BODY_CHARS) {
      return sendJson(res, 400, {
        error: `message exceeds ${MAX_BODY_CHARS} chars`,
      });
    }
    let replyTo = null;
    if (payload.reply_to_seq !== undefined && payload.reply_to_seq !== null) {
      replyTo = Number(payload.reply_to_seq);
      if (!Number.isInteger(replyTo) || replyTo <= 0) {
        return sendJson(res, 400, {
          error: "reply_to_seq must be a positive integer",
        });
      }
    }
    const r = postMessage(d, roomId, name, body, replyTo, parseMentions(body));
    return sendJson(res, r.error ? 400 : 200, r);
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  try {
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      return await handlePost(url, req, res);
    }
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
    if (url.pathname === "/api/search") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, { error: "room must be a positive integer" });
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJson(res, 400, { error: "q is required" });
      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit")) || 30, 100),
      );
      try {
        const matches = searchMessages(roomId, q, limit);
        if (matches === null)
          return sendJson(res, 200, {
            matches: [],
            error: `No database at ${DB_PATH}.`,
          });
        return sendJson(res, 200, { matches, q });
      } catch (e) {
        // Most commonly an FTS5 syntax error in q; a 400 the UI can display.
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // Report the real bound port so PORT=0 (ephemeral, used by tests) works.
  const port = server.address().port;
  const present = existsSync(DB_PATH) ? "" : "  (not found yet)";
  console.log(`agent-chat viewer: http://127.0.0.1:${port}`);
  console.log(`database: ${DB_PATH}${present}`);
});
