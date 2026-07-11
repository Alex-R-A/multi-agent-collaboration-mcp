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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = dirname(fileURLToPath(import.meta.url));
// PORT=0 is meaningful (bind an ephemeral port; used by tests), so a falsy
// check must not swallow it. An explicitly SET but invalid value is a user
// error and must fail loudly: silently defaulting served the viewer on a
// port the operator does not expect, and out-of-range values crashed
// listen() with a stack trace instead of a diagnosis.
const rawPort = process.env.AGENT_CHAT_VIEWER_PORT;
let PORT = 8787;
if (rawPort !== undefined && rawPort.trim() !== "") {
  const p = Number(rawPort.trim());
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    console.error(
      `agent-chat viewer: AGENT_CHAT_VIEWER_PORT must be an integer 0-65535, got "${rawPort}"`,
    );
    process.exit(1);
  }
  PORT = p;
}

// Same resolution the server uses (kept in sync deliberately, not imported, so
// the viewer needs no build output and never runs migrations against the file).
// Absolute always: a relative override means a different file per cwd.
function resolveDbPath() {
  const override = process.env.AGENT_CHAT_DB;
  if (override && override.trim().length > 0) {
    const t = override.trim();
    // Only the ":memory:" sentinel is special; URI parsing is not enabled.
    if (t === ":memory:") return t;
    return resolve(t);
  }
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}
const DB_PATH = resolveDbPath();
if (DB_PATH === ":memory:") {
  // An in-memory database is process-private: this viewer would open its own
  // fresh empty one, silently unrelated to whatever wrote the sentinel.
  console.error(
    "agent-chat viewer: cannot attach to a :memory: database (it is private " +
      "to the process that opened it)",
  );
  process.exit(1);
}

// Structures this viewer's queries depend on. The viewer never migrates the
// shared file (that is the MCP server's job); on an older-schema database its
// queries used to fail as a mix of opaque 400/500s, so check ONCE per open
// attempt and report the real remedy instead.
function schemaGaps(d) {
  const gaps = [];
  const col = (t, c) =>
    !!d
      .prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = '${c}'`)
      .get();
  const table = (t) =>
    !!d
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','trigger') AND name = ?")
      .get(t);
  for (const t of ["rooms", "agents", "memberships", "messages", "session_markers", "claims"]) {
    if (!table(t)) gaps.push(`table ${t}`);
  }
  if (gaps.length) return gaps; // column checks would all fail anyway
  for (const [t, c] of [
    ["rooms", "pinned"],
    ["memberships", "left_at"],
    ["messages", "supersedes_seq"],
    ["messages", "reply_to_agent"],
    ["messages", "body_len"],
  ]) {
    if (!col(t, c)) gaps.push(`${t}.${c}`);
  }
  if (!table("messages_fts")) gaps.push("table messages_fts");
  return gaps;
}
let schemaError = null; // sticky reason string when the file is too old

// Open lazily so the server still starts (and says why it is empty) when no
// agent has created the database yet. Opened writable but pinned query_only: a
// read-only OPEN of a WAL database is fragile (it needs the -shm file), whereas
// a writable handle with query_only reads WAL cleanly and still rejects writes.
let db = null;
function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  const candidate = new Database(DB_PATH, { fileMustExist: true });
  candidate.pragma("busy_timeout = 5000");
  candidate.pragma("query_only = ON");
  const gaps = schemaGaps(candidate);
  if (gaps.length) {
    // Re-checked on every request (cheap PRAGMAs, no cached handle): an MCP
    // server may migrate the file at any moment, after which the viewer
    // starts working without a restart.
    candidate.close();
    schemaError =
      `database schema predates this viewer (missing ${gaps.join(", ")}); ` +
      "start the current agent-chat MCP server once to migrate it";
    return null;
  }
  schemaError = null;
  db = candidate;
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

// Message columns for the JSON endpoints. Bodies are capped in SQL (substr
// is codepoint-aware, no surrogate splitting): agents can legally post up to
// SQLITE_MAX_LENGTH, and one such message must not balloon a page into
// gigabytes. The full length rides along (body_len when stamped: exact UTF-16,
// the same unit as the JS-side shown length) so the client can label the cut.
// reply_to_agent lets the client style replies-to-me without needing the
// parent row loaded.
const MAX_BODY_CHARS = 100_000; // matches the agents' per-page read budget

const MSG_COLS = `g.seq, g.agent_id AS "from", a.role, a.type,
              substr(g.body, 1, ${MAX_BODY_CHARS}) AS body,
              CASE WHEN length(g.body) > ${MAX_BODY_CHARS}
                   THEN COALESCE(g.body_len, length(g.body)) ELSE NULL END AS body_length,
              g.format,
              g.mentions, g.reply_to_seq, g.reply_to_agent, g.supersedes_seq,
              g.created_at AS at,
              (SELECT s.seq FROM messages s
                WHERE s.room_id = g.room_id AND s.supersedes_seq = g.seq
                ORDER BY s.seq DESC LIMIT 1) AS superseded_by`;

// Aggregate BODY budget per response: the per-row cap alone let a 400-row
// page of legal 100k bodies serialize to ~40 MB. Collection stops (with at
// least one row, so paging always progresses) once the running body total
// passes this; `trimmed` tells the client the page is short for size, NOT
// because history ran out.
const PAGE_BODY_BUDGET = 2_000_000;

// Pull rows off a better-sqlite3 iterator until the body budget is spent.
function takeBudgeted(iter) {
  const rows = [];
  let used = 0;
  let trimmed = false;
  for (const r of iter) {
    if (rows.length > 0 && used + r.body.length > PAGE_BODY_BUDGET) {
      trimmed = true;
      break;
    }
    used += r.body.length;
    rows.push(r);
  }
  return { rows, trimmed };
}

function listMessages(roomId, afterSeq, beforeSeq, limit) {
  const d = getDb();
  if (!d) return null;
  const src = `messages g LEFT JOIN agents a ON a.id = g.agent_id`;
  let taken;
  if (afterSeq > 0) {
    // Incremental tail: only messages newer than what the client already has.
    taken = takeBudgeted(
      d
        .prepare(
          `SELECT ${MSG_COLS} FROM ${src}
           WHERE g.room_id = ? AND g.seq > ? ORDER BY g.seq ASC LIMIT ?`,
        )
        .iterate(roomId, afterSeq, limit),
    );
  } else if (beforeSeq > 0) {
    // History paging: the `limit` messages just older than what is shown.
    taken = takeBudgeted(
      d
        .prepare(
          `SELECT ${MSG_COLS} FROM ${src}
           WHERE g.room_id = ? AND g.seq < ? ORDER BY g.seq DESC LIMIT ?`,
        )
        .iterate(roomId, beforeSeq, limit),
    );
    taken.rows.reverse();
  } else {
    // Initial load: newest `limit`, returned oldest-first for top-to-bottom reading.
    taken = takeBudgeted(
      d
        .prepare(
          `SELECT ${MSG_COLS} FROM ${src}
           WHERE g.room_id = ? ORDER BY g.seq DESC LIMIT ?`,
        )
        .iterate(roomId, limit),
    );
    taken.rows.reverse();
  }
  for (const r of taken.rows) {
    if (r.mentions) {
      try {
        r.mentions = JSON.parse(r.mentions);
      } catch {
        r.mentions = null;
      }
    }
    finishBodyCap(r);
  }
  return taken;
}

// Expose the SQL-side body cap as a flag the client can render. The decision
// is made in SQL (both sides in codepoints); body_length is non-NULL exactly
// when the body was cut, and carries the full character count.
function finishBodyCap(r) {
  if (r.body_length != null) {
    r.body_truncated = true;
  } else {
    delete r.body_length;
  }
}

// Writable handle for participation endpoints only. Kept separate from the
// query_only read handle so a bug in a read path can never write. The schema
// preflight in getDb() has already gated this: the write paths can assume
// every current column exists.
let wdb = null;
function getWriteDb() {
  if (wdb) return wdb;
  if (!getDb()) return null; // absent file or stale schema (schemaError set)
  wdb = new Database(DB_PATH, { fileMustExist: true });
  wdb.pragma("busy_timeout = 5000");
  return wdb;
}

/** Why the database is unusable right now (message for a 503). */
function dbUnavailableError() {
  return (
    schemaError ??
    `No database at ${DB_PATH}. Start an agent-chat MCP server first.`
  );
}

const NAME_RE = /^[\w][\w.-]{0,199}$/; // sane self-asserted ids, no whitespace

// Cap in BYTES. Sized so a maximal legal post (MAX_BODY_CHARS UTF-16 units,
// worst case ~3 UTF-8 bytes per unit, plus JSON envelope) still fits.
function readBody(req, cap = 700_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        // Pause, never destroy here: destroying tears down the socket the
        // RESPONSE shares, so the 413 the handler sends would never reach
        // the client (it saw a bare connection reset instead).
        req.pause();
        const err = new Error("request body too large");
        err.tooLarge = true;
        reject(err);
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
  // One IMMEDIATE transaction: with the room-exists check outside it, a
  // concurrent agent delete_room between statements surfaced as an uncaught
  // FK throw (a 500) and left a stray agents row behind.
  const tx = d.transaction(() => {
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
  const m = d
    .prepare(
      "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(roomId, name);
  return {
    joined: true,
    agent_id: name,
    room_id: roomId,
    last_read_seq: m.last_read_seq,
  };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function postMessage(d, roomId, name, body, replyToSeq, mentions) {
  const mentionsJson =
    mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
  // Same shape as ChatStore.postMessage: validate membership and the reply
  // target and allocate the next per-room seq inside one IMMEDIATE
  // transaction, so a concurrent agent writer cannot take the same seq, the
  // reply reference cannot dangle against a racing prune, and a concurrent
  // delete_room yields this clean error instead of a raw FK failure.
  const tx = d.transaction(() => {
    const m = membership(d, roomId, name);
    if (!m || m.left_at !== null) {
      throw new Error("join the room first (POST /api/join)");
    }
    let replyToAgent = null;
    if (replyToSeq !== null) {
      const parent = d
        .prepare("SELECT agent_id FROM messages WHERE room_id = ? AND seq = ?")
        .get(roomId, replyToSeq);
      if (!parent) {
        throw new Error(`reply_to_seq ${replyToSeq} does not exist in this room`);
      }
      replyToAgent = parent.agent_id;
    }
    const { next } = d
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
      )
      .get(roomId);
    // body_len is the exact UTF-16 length (same stamp ChatStore.postMessage
    // writes); the schema preflight guarantees both columns exist.
    d.prepare(
      `INSERT INTO messages (room_id, seq, agent_id, format, body, body_len, mentions, reply_to_seq, reply_to_agent)
       VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
    ).run(roomId, next, name, body, body.length, mentionsJson, replyToSeq, replyToAgent);
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
  // One IMMEDIATE transaction (read-then-write), so a concurrent room
  // deletion cannot vanish the membership row between statements.
  const tx = d.transaction(() => {
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
    // Monotonic BY DESIGN for the web viewer, unlike MCP mark_read (which
    // supports deliberate rewind): the browser auto-marks from async
    // completions, so a delayed stale write must never regress the marker.
    d.prepare(
      `UPDATE memberships SET last_read_seq = max(last_read_seq, ?), last_seen = datetime('now')
       WHERE room_id = ? AND agent_id = ?`,
    ).run(eff, roomId, name);
    const row = d
      .prepare(
        "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, name);
    return { last_read_seq: row ? row.last_read_seq : eff };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Full room deletion, mirroring ChatStore.deleteRoom: messages first (so the
// FTS delete-trigger fires), then memberships, session markers, claims, and
// the room row, in one IMMEDIATE transaction. Unauthenticated by design,
// exactly like the MCP delete_room tool.
function deleteRoomFull(d, roomId) {
  const tx = d.transaction(() => {
    const room = d.prepare("SELECT name FROM rooms WHERE id = ?").get(roomId);
    if (!room) return { error: `no room ${roomId}` };
    const { c: messages } = d
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?")
      .get(roomId);
    const { c: members } = d
      .prepare("SELECT COUNT(*) AS c FROM memberships WHERE room_id = ?")
      .get(roomId);
    d.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM memberships WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM session_markers WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM claims WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    return { deleted_room: roomId, name: room.name, messages, members };
  });
  return tx.immediate();
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
  // Capture up to 201 chars, strip trailing punctuation, THEN length-check:
  // capping the regex at 200 made a 201-char id silently tag its first-200
  // prefix, a nonexistent identity.
  for (const m of body.matchAll(/@([\w][\w.-]{0,200})/g)) {
    const id = m[1].replace(/[.-]+$/, "");
    if (!id || id.length > 200 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 100) break;
  }
  return out;
}

// Full-text search over the room's messages via the FTS index the MCP server
// maintains; best matches first. FTS5 syntax errors surface to the caller.
function searchMessages(roomId, q, limit) {
  const d = getDb();
  if (!d) return null;
  const taken = takeBudgeted(
    d
      .prepare(
        `SELECT ${MSG_COLS}
         FROM messages_fts f
         JOIN messages g ON g.id = f.rowid
         LEFT JOIN agents a ON a.id = g.agent_id
         WHERE f.body MATCH ? AND g.room_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .iterate(q, roomId, limit),
  );
  for (const r of taken.rows) {
    if (r.mentions) {
      try {
        r.mentions = JSON.parse(r.mentions);
      } catch {
        r.mentions = null;
      }
    }
    finishBodyCap(r);
  }
  return taken;
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
  // operator's browser; require the request's own EXACT origin (scheme +
  // host + port). Hostname-only checking let any other localhost-bound
  // process's page (a dev server on another port) write here. Requests
  // without an Origin header (curl, scripts) stay allowed: local processes
  // can already write the database file directly, so this is browser-context
  // hygiene, not authentication. The Host header was allowlisted upstream.
  const origin = req.headers.origin;
  if (
    origin &&
    origin.toLowerCase() !== `http://${(req.headers.host || "").toLowerCase()}`
  ) {
    return sendJson(res, 403, { error: "cross-origin writes are not allowed" });
  }
  const d = getWriteDb();
  if (!d) {
    return sendJson(res, 503, { error: dbUnavailableError() });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    const tooLarge = !!(e && e.tooLarge);
    res.writeHead(tooLarge ? 413 : 400, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    // Drop the half-received request only after the response has flushed.
    res.on("finish", () => req.destroy());
    return;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return sendJson(res, 400, { error: "request body must be a JSON object" });
  }
  // Require a real JSON number: Number() coercion accepted true/[1]/"1"
  // (all of which coerce to a usable integer) despite the error text below.
  const roomId =
    typeof payload.room === "number" && Number.isInteger(payload.room)
      ? payload.room
      : NaN;
  if (!Number.isInteger(roomId) || roomId <= 0) {
    return sendJson(res, 400, { error: "room must be a positive integer id" });
  }

  if (url.pathname === "/api/delete-room") {
    // No identity required (parity with the MCP delete_room tool), but the
    // same explicit confirm gate: destructive and irreversible.
    if (payload.confirm !== true) {
      return sendJson(res, 400, {
        error:
          "pass confirm:true to permanently delete the room and ALL of its " +
          "messages, memberships, and claims (irreversible)",
      });
    }
    const r = deleteRoomFull(d, roomId);
    return sendJson(res, r.error ? 400 : 200, r);
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
    const seq =
      typeof payload.seq === "number" && Number.isInteger(payload.seq)
        ? payload.seq
        : NaN;
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
      replyTo =
        typeof payload.reply_to_seq === "number" &&
        Number.isInteger(payload.reply_to_seq)
          ? payload.reply_to_seq
          : NaN;
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
  // DNS-rebinding hygiene on EVERY request (reads included): a hostile page
  // whose hostname rebinds to 127.0.0.1 issues requests the browser treats
  // as same-origin, exfiltrating chat content via the GET endpoints. The
  // Host header still carries the page's own hostname through a rebind, so
  // requiring a local one closes that door. Same class as the Origin gate
  // on writes: browser-context hygiene, not authentication.
  const rawHost = (req.headers.host || "").toLowerCase();
  const hostname = rawHost.startsWith("[")
    ? rawHost.slice(0, rawHost.indexOf("]") + 1)
    : rawHost.split(":")[0];
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    return sendJson(res, 403, { error: "unrecognized Host header" });
  }
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
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        // The page carries destructive controls (room deletion); refuse to
        // render inside any frame so a hostile page cannot clickjack them.
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/rooms") {
      const rooms = listRooms();
      if (rooms === null)
        return sendJson(res, 200, {
          rooms: [],
          error: dbUnavailableError(),
        });
      return sendJson(res, 200, { rooms });
    }
    if (url.pathname === "/api/messages") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, { error: "room must be a positive integer" });
      // floor everything bound to SQL integer slots: a float LIMIT is a
      // "datatype mismatch" 500 out of SQLite.
      const after = Math.floor(Number(url.searchParams.get("after"))) || 0;
      const before = Math.floor(Number(url.searchParams.get("before"))) || 0;
      const limit = Math.max(
        1,
        Math.min(Math.floor(Number(url.searchParams.get("limit"))) || 200, 1000),
      );
      const result = listMessages(roomId, after, before, limit);
      if (result === null)
        return sendJson(res, 200, {
          messages: [],
          error: dbUnavailableError(),
        });
      return sendJson(res, 200, {
        messages: result.rows,
        // Short page because of the SIZE budget, not exhausted history; the
        // client must not conclude "no more messages" from it.
        ...(result.trimmed ? { trimmed: true } : {}),
      });
    }
    if (url.pathname === "/api/me") {
      // Membership state for a (room, name): lets the client learn its read
      // marker after a reload so gap-aware read marking works.
      const roomId = Number(url.searchParams.get("room"));
      const name = (url.searchParams.get("name") || "").trim();
      if (!Number.isInteger(roomId) || roomId <= 0 || !name)
        return sendJson(res, 400, { error: "room (id) and name are required" });
      const d = getDb();
      if (!d) return sendJson(res, 200, { joined: false });
      const m = d
        .prepare(
          "SELECT last_read_seq, left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
        )
        .get(roomId, name);
      return sendJson(res, 200, {
        joined: !!m && m.left_at === null,
        last_read_seq: m ? m.last_read_seq : 0,
      });
    }
    if (url.pathname === "/api/search") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, { error: "room must be a positive integer" });
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJson(res, 400, { error: "q is required" });
      const limit = Math.max(
        1,
        Math.min(Math.floor(Number(url.searchParams.get("limit"))) || 30, 100),
      );
      try {
        const result = searchMessages(roomId, q, limit);
        if (result === null)
          return sendJson(res, 200, {
            matches: [],
            error: dbUnavailableError(),
          });
        return sendJson(res, 200, {
          matches: result.rows,
          q,
          ...(result.trimmed ? { trimmed: true } : {}),
        });
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
