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
// the viewer needs no build output and never creates or alters the schema).
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

// Open lazily so the server still starts (and says why it is empty) when no
// agent has created the database yet. Opened writable but pinned query_only: a
// read-only OPEN of a WAL database is fragile (it needs the -shm file), whereas
// a writable handle with query_only reads WAL cleanly and still rejects writes.
//
// There is no schema preflight. This viewer reads ONE schema, the current one,
// and a database written by an older server is not upgraded, detected, or
// explained: its queries fail raw. Replacing the database is a deployment step,
// not something the running code negotiates.
let db = null;
function getDb() {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  return db;
}

// The sidebar's 30-second refresh: it shows name/activity/presence only, so this
// carries NO pinned and only a SHORT description snippet (for the filter box).
// The full pinned/description are fetched by /api/room when a room is opened.
// Dropping the pinned from this list is what keeps 1000 rooms with 10k intros
// from producing a ~24 MB response every refresh. Only the most-recently-active
// ROOMS_MAX are listed. Exact message
// counts are deliberately absent: recounting history for decorative UI text is
// recurring work with no bearing on room selection.
const ROOM_DESC_SNIPPET = 200;
const ROOMS_MAX = 1000;
function listRooms() {
  const d = getDb();
  if (!d) return null;
  const rooms = d
    .prepare(
      `SELECT r.id, r.name,
              substr(r.description, 1, ${ROOM_DESC_SNIPPET}) AS description,
              (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
              (SELECT created_at FROM messages g WHERE g.room_id = r.id
               ORDER BY seq DESC LIMIT 1) AS last_activity
       FROM rooms r ORDER BY last_activity DESC, r.id DESC LIMIT ${ROOMS_MAX}`,
    )
    .all();
  return { rooms };
}

// Full detail for ONE room (name, description, and the WHOLE pinned intro),
// fetched when a room is opened -- the sidebar list omits the pinned. Returns
// null when the room does not exist. Deletion confirmation uses the lean
// /api/room-exists probe so it never re-fetches a large pinned document.
function getRoomDetail(roomId) {
  const d = getDb();
  if (!d) return null;
  return (
    d
      .prepare(
        `SELECT r.id, r.name, r.description, r.pinned,
                (SELECT COUNT(*) FROM memberships m
                 WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
                (SELECT created_at FROM messages g WHERE g.room_id = r.id
                 ORDER BY seq DESC LIMIT 1) AS last_activity
         FROM rooms r WHERE r.id = ?`,
      )
      .get(roomId) ?? null
  );
}

function roomExists(roomId) {
  const d = getDb();
  if (!d) return null;
  return !!d.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId);
}

// Message columns for the JSON endpoints. Bodies are capped in SQL (substr
// is codepoint-aware, no surrogate splitting): agents can legally post up to
// SQLITE_MAX_LENGTH, and one such message must not balloon a page into
// gigabytes. The full length rides along (body_len: exact UTF-16, the same
// unit as the JS-side shown length) so the client can label the cut.
// reply_to_agent lets the client style replies-to-me without needing the
// parent row loaded.
const MAX_BODY_CHARS = 100_000; // matches the agents' per-page read budget

const MSG_COLS = `g.seq, g.agent_id AS "from",
              a.brand, a.model, a.version, a.is_human,
              substr(g.body, 1, ${MAX_BODY_CHARS}) AS body,
              CASE WHEN length(g.body) > ${MAX_BODY_CHARS}
                   THEN g.body_len ELSE NULL END AS body_length,
              g.format, g.priority,
              g.mentions, g.reply_to_seq, g.reply_to_agent, g.supersedes_seq,
              g.created_at AS at,
              (SELECT s.seq FROM messages s
                WHERE s.room_id = g.room_id AND s.supersedes_seq = g.seq
                ORDER BY s.seq DESC LIMIT 1) AS superseded_by`;

// Aggregate SERIALIZED budget per response: the per-row cap alone let a 400-row
// page of legal 100k bodies serialize to ~40 MB, and counting only body.length
// still undercounted control-heavy rows ~6x (20 rows of ~2M body units
// serialized to ~12 MB). Measure the ACTUAL serialized size of each row, after
// its mentions have been parsed and the body-cap flag applied, so the JSON the
// client receives is what is bounded. Collection stops (with at least one row,
// so paging always progresses) once the running total passes this; `trimmed`
// tells the client the page is short for SIZE, not because history ran out.
const PAGE_BODY_BUDGET = 2_000_000;

// Pull rows off a better-sqlite3 iterator, finalizing each (mentions + body
// cap) so its measured size matches the wire, until the serialized budget is
// spent. Measured in UTF-8 BYTES (Buffer.byteLength), the actual wire unit:
// JSON.stringify(x).length counts UTF-16 units, which undercounts multibyte
// (e.g. CJK) content ~3x and let a "2 MB" budget serialize to ~6 MB.
function takeBudgeted(iter) {
  const rows = [];
  let used = 2; // the array's own brackets (ASCII, 2 bytes)
  let trimmed = false;
  for (const r of iter) {
    finalizeRow(r);
    const size = Buffer.byteLength(JSON.stringify(r)) + (rows.length > 0 ? 1 : 0);
    if (rows.length > 0 && used + size > PAGE_BODY_BUDGET) {
      trimmed = true;
      break;
    }
    used += size;
    rows.push(r);
  }
  return { rows, trimmed };
}

// Parse the mentions JSON and apply the body-cap flag for one row. Done BEFORE
// measuring in takeBudgeted so the measured size is the real serialized size.
function finalizeRow(r) {
  r.priority = r.priority === 1;
  if (r.mentions) {
    try {
      r.mentions = JSON.parse(r.mentions);
    } catch {
      r.mentions = null;
    }
  }
  finishBodyCap(r);
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
  // Rows are already finalized (mentions parsed, body-cap flag) inside
  // takeBudgeted so its size measurement matched the wire.
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
// query_only read handle so a bug in a read path can never write.
let wdb = null;
function getWriteDb() {
  if (wdb) return wdb;
  if (!getDb()) return null; // no database file yet
  wdb = new Database(DB_PATH, { fileMustExist: true });
  wdb.pragma("busy_timeout = 5000");
  // Enforce foreign keys on the write handle, matching the MCP store. The
  // participation paths already assume it: deleteRoomFull deletes messages
  // (and other room-referencing rows) BEFORE the room row precisely "so
  // foreign keys to rooms(id) are satisfied", and postMessage/joinRoom rely on
  // referenced rooms/agents existing. Enabling it turns any future write that
  // forgets those invariants into a clean error instead of a silent orphan.
  wdb.pragma("foreign_keys = ON");
  return wdb;
}

/** Why the database is unusable right now (message for a 503). */
function dbUnavailableError() {
  return `No database at ${DB_PATH}. Start an agent-chat MCP server first.`;
}

const NAME_RE = /^[\w][\w.-]{0,199}$/; // sane self-asserted ids, no whitespace

// Human identity grammar, mirrored from the agents CHECK in src/db.ts.
//
// DUPLICATED ON PURPOSE. This file is a standalone ESM script with no build
// step -- that is the whole reason the viewer needs no dist -- so it cannot
// import an unbuilt TypeScript constant. A shared constants layer would exist
// only to carry two literals across that boundary. The database CHECK remains
// the authority; these exist to produce a 400 with a readable reason instead of
// a raw constraint failure.
const MAX_HUMAN_BASE_CHARS = 177;
const HUMAN_BASE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
// Same lowercase canonical shape src/db.ts assertConnectionId requires. No
// version or variant semantics are invented here: the browser generates these
// with crypto.randomUUID().
const OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reason `v` is not a valid human base name, or "" when it is. NEVER trims or
 *  case-folds: the base is the user's chosen visible name, and normalizing it
 *  here would make two different requests mean the same identity on one path
 *  and different identities on another. */
function badBaseName(v) {
  if (typeof v !== "string") return "base_name must be a string";
  if (v.length < 1 || v.length > MAX_HUMAN_BASE_CHARS) {
    return `base_name must be 1-${MAX_HUMAN_BASE_CHARS} characters`;
  }
  if (!HUMAN_BASE_RE.test(v)) {
    return "base_name must start with a letter, digit, or underscore and contain only letters, digits, underscore, dot, or dash";
  }
  // Case-insensitive: 'Human-' must not squat the reserved namespace either.
  if (v.slice(0, 6).toLowerCase() === "human-") {
    return 'base_name must not begin with "human-" (reserved prefix)';
  }
  return "";
}

/** The agents row for `id` if it is a HUMAN participant, else null. The
 *  is_human test is load-bearing: this API takes the actor from the request
 *  body, so without it a caller could name an LLM persona and post, advance its
 *  durable read marker, or leave its rooms. */
function humanRow(d, id) {
  if (typeof id !== "string" || !NAME_RE.test(id)) return null;
  const row = d
    .prepare(
      "SELECT id, is_human, human_base, human_ordinal FROM agents WHERE id = ?",
    )
    .get(id);
  return row && row.is_human === 1 ? row : null;
}

// Return a human reason if `s` holds text SQLite cannot round-trip (an
// embedded NUL -- substr/length truncate at it -- or a lone surrogate), else
// "". Mirrors the store's assertStorable so a web post is rejected the same way
// an agent's would be.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function badChar(s) {
  if (s.indexOf("\u0000") !== -1) {
    return "contains a NUL character (U+0000), which cannot be stored safely";
  }
  if (LONE_SURROGATE.test(s)) return "contains a lone surrogate (malformed UTF-16)";
  return "";
}

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

function membership(d, roomId, agentId) {
  return d
    .prepare(
      "SELECT left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(roomId, agentId);
}

// A web actor must be a HUMAN participant with a present membership.
//
// The is_human check is load-bearing, not decoration: the web API takes the
// participant name from the request body, so without it anyone could type an
// LLM persona's id and post, mark read, or advance that persona's durable read
// marker over messages it has never seen. Membership alone is not enough,
// because an LLM persona joined through MCP has exactly that. The two
// populations are disjoint (a human id is server-allocated under the reserved
// `human-` prefix, and identify_persona escapes any LLM slug that would land
// there), so "is this row human" is a complete and stable answer.
// Gates /api/post and /api/read.
function webJoined(d, roomId, agentId) {
  if (!humanRow(d, agentId)) return false;
  const m = membership(d, roomId, agentId);
  return !!m && m.left_at === null;
}

/** Insert-or-revive THIS membership, preserving cursor, role, and original
 *  join time. Shared by fresh allocation and canonical rejoin; deliberately
 *  NOT reached by an allocation replay, which must not reopen anything. */
function upsertMembership(d, roomId, agentId) {
  d.prepare(
    "INSERT OR IGNORE INTO memberships (room_id, agent_id) VALUES (?, ?)",
  ).run(roomId, agentId);
  d.prepare(
    "UPDATE memberships SET left_at = NULL, last_seen = datetime('now') WHERE room_id = ? AND agent_id = ?",
  ).run(roomId, agentId);
  return d
    .prepare(
      "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(roomId, agentId).last_read_seq;
}

/**
 * Join by one of two EXPLICIT forms, in one IMMEDIATE transaction.
 *
 * fresh:     { room, base_name, operation_id }  -> allocate human-<base>-<N>
 * canonical: { room, agent_id }                 -> rejoin an existing human
 *
 * There is no name alias and no fallback between them. The old single-field
 * form let the browser send whatever it had stored and let the server guess;
 * guessing is what allowed a typed name to land on someone else's row.
 *
 * The allocation lookup comes FIRST, before the room check, so a committed
 * allocation whose room was later deleted still replays to the identity it
 * created instead of allocating a second ordinal for one user action. That
 * ordering is the whole point of the table.
 */
function joinRoom(d, roomId, form) {
  const tx = d.transaction(() => {
    if (form.kind === "fresh") {
      const existing = d
        .prepare(
          "SELECT room_id, human_base, result_agent_id FROM human_allocations WHERE operation_id = ?",
        )
        .get(form.operationId);
      if (existing) {
        // The operation id is bound to its EXACT payload. Reuse with a
        // different room or base is a second allocation request wearing a
        // retry's clothes, not idempotency.
        if (existing.room_id !== roomId || existing.human_base !== form.baseName) {
          return {
            error:
              "operation_id was already used with a different room or base_name",
          };
        }
        const agent = d
          .prepare(
            "SELECT id, is_human, human_base, human_ordinal FROM agents WHERE id = ?",
          )
          .get(existing.result_agent_id);
        if (!agent || agent.is_human !== 1) {
          // NEVER fall through to allocation. The allocation committed; a
          // missing or non-human result row means the database disagrees with
          // itself, and allocating again would mint a second identity for one
          // user action on top of that.
          return {
            http: 500,
            error:
              "allocation record exists but its human identity is missing or invalid",
          };
        }
        // Report state, change nothing: no insert, no revive, no cursor move.
        const m = d
          .prepare(
            "SELECT last_read_seq, left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
          )
          .get(existing.room_id, agent.id);
        return {
          joined: !!m && m.left_at === null,
          agent_id: agent.id,
          base_name: agent.human_base,
          human_ordinal: agent.human_ordinal,
          room_id: existing.room_id,
          last_read_seq: m ? m.last_read_seq : 0,
        };
      }

      const room = d.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId);
      if (!room) return { error: `no room ${roomId}` };
      // Exact, case-sensitive base match: SQLite compares TEXT with BINARY
      // collation by default, so "Alex" and "alex" are separate namespaces,
      // which is what preserving the user's chosen case requires.
      const { max } = d
        .prepare(
          "SELECT MAX(human_ordinal) AS max FROM agents WHERE is_human = 1 AND human_base = ?",
        )
        .get(form.baseName);
      const ordinal = (max ?? 0) + 1;
      if (!Number.isSafeInteger(ordinal) || ordinal > Number.MAX_SAFE_INTEGER) {
        return { error: `no ordinal remains for base_name "${form.baseName}"` };
      }
      const agentId = `human-${form.baseName}-${ordinal}`;
      if (agentId.length > 200) {
        return { error: "the resulting canonical id would exceed 200 characters" };
      }
      // No collision retry. IMMEDIATE serializes writers and the partial unique
      // index on (human_base, human_ordinal) rejects a duplicate outright, so a
      // retry loop would only paper over a real conflict.
      d.prepare(
        "INSERT INTO agents (id, is_human, human_base, human_ordinal) VALUES (?, 1, ?, ?)",
      ).run(agentId, form.baseName, ordinal);
      const lastRead = upsertMembership(d, roomId, agentId);
      d.prepare(
        "INSERT INTO human_allocations (operation_id, room_id, human_base, result_agent_id) VALUES (?, ?, ?, ?)",
      ).run(form.operationId, roomId, form.baseName, agentId);
      return {
        joined: true,
        agent_id: agentId,
        base_name: form.baseName,
        human_ordinal: ordinal,
        room_id: roomId,
        last_read_seq: lastRead,
      };
    }

    // canonical rejoin
    const room = d.prepare("SELECT id FROM rooms WHERE id = ?").get(roomId);
    if (!room) return { error: `no room ${roomId}` };
    const agent = humanRow(d, form.agentId);
    if (!agent) {
      return {
        error: `"${form.agentId}" is not an existing human participant`,
      };
    }
    // Presence is deliberately NOT required: reviving a left membership is
    // exactly what this form is for.
    const lastRead = upsertMembership(d, roomId, agent.id);
    return {
      joined: true,
      agent_id: agent.id,
      base_name: agent.human_base,
      human_ordinal: agent.human_ordinal,
      room_id: roomId,
      last_read_seq: lastRead,
    };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function postMessage(d, roomId, agentId, body, replyToSeq, mentions) {
  const mentionsJson =
    mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
  // Same shape as ChatStore.postMessage: validate membership and the reply
  // target and allocate the next per-room seq inside one IMMEDIATE
  // transaction, so a concurrent agent writer cannot take the same seq, the
  // reply reference cannot dangle against a racing prune, and a concurrent
  // delete_room yields this clean error instead of a raw FK failure.
  const tx = d.transaction(() => {
    if (!webJoined(d, roomId, agentId)) {
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
    const { last_read_seq: from } = d
      .prepare(
        "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId);
    // A backward "latest peer" search becomes quadratic when one unread peer is
    // followed by a growing self tail: every post re-walks that tail. Probe
    // forward instead, stopping at the first peer. If one exists, conservatively
    // normalize no cursor here; catch_up will deliver it and repair own gaps. If
    // none exists, `from` is a safe floor for this participant's cursor. One
    // history probe.
    const unreadPeer = d
      .prepare(
        `SELECT 1 FROM messages
         WHERE room_id = ? AND seq > ? AND agent_id != ?
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(roomId, from, agentId);
    const canNormalize = unreadPeer ? 0 : 1;
    const { next } = d
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
      )
      .get(roomId);
    // body_len is the exact UTF-16 length (same stamp ChatStore.postMessage
    // writes). The column is NOT NULL in the current schema, so stamping it is
    // required, not optional.
    d.prepare(
      `INSERT INTO messages (room_id, seq, agent_id, format, body, body_len, mentions, reply_to_seq, reply_to_agent)
       VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
    ).run(roomId, next, agentId, body, body.length, mentionsJson, replyToSeq, replyToAgent);
    // Own rows are excluded from unread delivery. Move only cursors at/after the
    // proven safe floor through this row; a lagging peer remains unread.
    d.prepare(
      `UPDATE memberships
       SET last_read_seq = CASE WHEN ? = 1 AND last_read_seq >= ?
              THEN max(last_read_seq, ?) ELSE last_read_seq END,
           last_seen = datetime('now')
       WHERE room_id = ? AND agent_id = ?`,
    ).run(canNormalize, from, next, roomId, agentId);
    return next;
  });
  try {
    return { seq: tx.immediate() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function markRead(d, roomId, agentId, seq) {
  // One IMMEDIATE transaction (read-then-write), so a concurrent room
  // deletion cannot vanish the membership row between statements.
  const tx = d.transaction(() => {
    // Gate on the live WEB session, not bare membership: a read landing after
    // this web session left (a stale tab, an in-flight auto-mark) advanced
    // the monotonic durable marker over messages nobody had seen.
    if (!webJoined(d, roomId, agentId)) {
      return { error: "join the room first (POST /api/join)" };
    }
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
    ).run(eff, roomId, agentId);
    const row = d
      .prepare(
        "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId);
    return { last_read_seq: row ? row.last_read_seq : eff };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Full room deletion, mirroring ChatStore.deleteRoom: messages first (so the
// FTS delete-trigger fires), then memberships, wait leases, claims, and the
// room row, in one IMMEDIATE transaction.
// Unauthenticated by design, exactly like the MCP delete_room tool.
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
    // wait_leases carries a rooms(id) FK. Omitting it made a live or lingering
    // blocking wait turn confirmed web deletion into a rolled-back FOREIGN KEY
    // failure; the store's deleteRoom already clears this table.
    d.prepare("DELETE FROM wait_leases WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM claims WHERE room_id = ?").run(roomId);
    d.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    return { deleted_room: roomId, name: room.name, messages, members };
  });
  return tx.immediate();
}

// Soft leave, mirroring ChatStore.leaveRoom: the membership row (and its read
// position) survives so rejoining resumes it. No twin reconciliation is needed
// any more -- a human name cannot be shared with an LLM persona, so the only
// participant behind this row is this one.
function leaveRoom(d, roomId, agentId) {
  const tx = d.transaction(() => {
    // Identity is required, presence is not. This endpoint was the one
    // ungated write: it updated ANY matching membership, so a crafted local
    // request could soft-leave an LLM persona's room. Idempotent by design --
    // already-left and never-joined both report left:false rather than an
    // error, because a retried leave is a normal browser event.
    if (!humanRow(d, agentId)) {
      return { error: `"${agentId}" is not an existing human participant` };
    }
    const info = d
      .prepare(
        `UPDATE memberships SET left_at = datetime('now'), last_seen = datetime('now')
         WHERE room_id = ? AND agent_id = ? AND left_at IS NULL`,
      )
      .run(roomId, agentId);
    return { left: info.changes > 0, room_id: roomId };
  });
  try {
    return tx.immediate();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
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
  // rank, g.id: total, stable order so a size-trimmed page is deterministic.
  // Fetch one MORE than asked (parity with the MCP search): a page of exactly
  // `limit` matches otherwise carried no "more exist" signal at all -- the
  // trimmed flag only fired on a byte cut.
  const taken = takeBudgeted(
    d
      .prepare(
        `SELECT ${MSG_COLS}
         FROM messages_fts f
         JOIN messages g ON g.id = f.rowid
         LEFT JOIN agents a ON a.id = g.agent_id
         WHERE f.body MATCH ? AND g.room_id = ?
         ORDER BY rank, g.id LIMIT ?`,
      )
      .iterate(q, roomId, limit + 1),
  );
  if (taken.rows.length > limit) {
    taken.rows.length = limit;
    taken.trimmed = true;
  }
  // Rows already finalized inside takeBudgeted.
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
    typeof payload.room === "number" && Number.isSafeInteger(payload.room)
      ? payload.room
      : NaN;
  if (!Number.isSafeInteger(roomId) || roomId <= 0) {
    return sendJson(res, 400, {
      error: "room must be a positive safe integer id",
    });
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

  if (url.pathname === "/api/join") {
    // FORM BY FIELD PRESENCE, not by value. A key present with null or the
    // wrong type fails the form it selected rather than falling through to the
    // other one; silent fallback is how the old single-field join let a
    // stored value mean whatever the server found convenient.
    const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
    if (has("name")) {
      return sendJson(res, 400, {
        error:
          "`name` is not accepted: send { room, base_name, operation_id } to allocate a new identity, or { room, agent_id } to rejoin an existing one",
      });
    }
    const wantsFresh = has("base_name") || has("operation_id");
    const wantsCanonical = has("agent_id");
    if (wantsFresh && wantsCanonical) {
      return sendJson(res, 400, {
        error:
          "send either { base_name, operation_id } or { agent_id }, not both",
      });
    }
    if (!wantsFresh && !wantsCanonical) {
      return sendJson(res, 400, {
        error:
          "join requires { room, base_name, operation_id } or { room, agent_id }",
      });
    }
    let form;
    if (wantsFresh) {
      if (!has("base_name") || !has("operation_id")) {
        return sendJson(res, 400, {
          error: "a fresh join requires BOTH base_name and operation_id",
        });
      }
      const bad = badBaseName(payload.base_name);
      if (bad) return sendJson(res, 400, { error: bad });
      if (
        typeof payload.operation_id !== "string" ||
        !OPERATION_ID_RE.test(payload.operation_id)
      ) {
        return sendJson(res, 400, {
          error: "operation_id must be a lowercase canonical UUID string",
        });
      }
      form = {
        kind: "fresh",
        baseName: payload.base_name,
        operationId: payload.operation_id,
      };
    } else {
      // No trim and no case-fold: the canonical id is the server's own value
      // and must round-trip exactly as issued.
      if (typeof payload.agent_id !== "string" || !NAME_RE.test(payload.agent_id)) {
        return sendJson(res, 400, {
          error:
            "agent_id must be an existing canonical human id (1-200 chars: letters, digits, underscore, dot or dash)",
        });
      }
      form = { kind: "canonical", agentId: payload.agent_id };
    }
    const r = joinRoom(d, roomId, form);
    return sendJson(res, r.error ? (r.http ?? 400) : 200, r);
  }

  // Every other participation endpoint acts as a CANONICAL id. There is no
  // base-name form here: a base is what a user types, an agent_id is who acts.
  const actor = typeof payload.agent_id === "string" ? payload.agent_id : "";
  if (!NAME_RE.test(actor)) {
    return sendJson(res, 400, {
      error:
        "agent_id must be 1-200 chars: letters, digits, underscore, dot or dash (no spaces)",
    });
  }

  if (url.pathname === "/api/leave") {
    const r = leaveRoom(d, roomId, actor);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (url.pathname === "/api/read") {
    const seq =
      typeof payload.seq === "number" && Number.isSafeInteger(payload.seq)
        ? payload.seq
        : NaN;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return sendJson(res, 400, {
        error: "seq must be a non-negative safe integer",
      });
    }
    const r = markRead(d, roomId, actor, seq);
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
    // Same well-formedness gate as the MCP store (the web writes SQL directly,
    // so it must enforce this itself): SQLite substr/length stop at a NUL, and
    // a lone surrogate is renormalized, so either would read back corrupt.
    const bad = badChar(body);
    if (bad) return sendJson(res, 400, { error: `message body ${bad}` });
    let replyTo = null;
    if (payload.reply_to_seq !== undefined && payload.reply_to_seq !== null) {
      replyTo =
        typeof payload.reply_to_seq === "number" &&
        Number.isSafeInteger(payload.reply_to_seq)
          ? payload.reply_to_seq
          : NaN;
      if (!Number.isSafeInteger(replyTo) || replyTo <= 0) {
        return sendJson(res, 400, {
          error: "reply_to_seq must be a positive safe integer",
        });
      }
    }
    const r = postMessage(d, roomId, actor, body, replyTo, parseMentions(body));
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
      const result = listRooms();
      if (result === null)
        return sendJson(res, 200, {
          rooms: [],
          error: dbUnavailableError(),
        });
      return sendJson(res, 200, { rooms: result.rooms });
    }
    if (url.pathname === "/api/room") {
      // Full detail for one room (name, description, WHOLE pinned), fetched on
      // open. Recurring deletion checks use /api/room-exists below.
      const roomId = Number(url.searchParams.get("id"));
      if (!Number.isSafeInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, {
          error: "id must be a positive safe integer",
        });
      const d = getDb();
      if (!d) return sendJson(res, 200, { room: null, error: dbUnavailableError() });
      return sendJson(res, 200, { room: getRoomDetail(roomId) });
    }
    if (url.pathname === "/api/room-exists") {
      // Deletion confirmation for an open room displaced from the capped room
      // list. Keep this a one-row existence probe: /api/room may carry a large
      // pinned document and should only be fetched when a room is opened.
      const roomId = Number(url.searchParams.get("id"));
      if (!Number.isSafeInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, {
          error: "id must be a positive safe integer",
        });
      const exists = roomExists(roomId);
      if (exists === null)
        return sendJson(res, 200, { exists: null, error: dbUnavailableError() });
      return sendJson(res, 200, { exists });
    }
    if (url.pathname === "/api/messages") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isSafeInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, {
          error: "room must be a positive safe integer",
        });
      const after = Number(url.searchParams.get("after") ?? 0);
      const before = Number(url.searchParams.get("before") ?? 0);
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(before) ||
        before < 0
      ) {
        return sendJson(res, 400, {
          error: "after/before must be non-negative safe integers",
        });
      }
      // Floor only LIMIT: floats used to reach SQLite and trigger a 500, and
      // limit is a page-size knob rather than a durable sequence identity.
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
      // Membership state for a (room, agent_id): lets the client learn its read
      // marker after a reload so gap-aware read marking works.
      const roomId = Number(url.searchParams.get("room"));
      const actor = url.searchParams.get("agent_id") || "";
      if (!Number.isSafeInteger(roomId) || roomId <= 0 || !NAME_RE.test(actor))
        return sendJson(res, 400, {
          error: "room (id) and agent_id are required",
        });
      const d = getDb();
      if (!d)
        // Distinguish "no database yet" from a genuine not-joined: a bare
        // joined:false hid the real remedy and made gap logic silently wrong.
        return sendJson(res, 200, { joined: false, error: dbUnavailableError() });
      // Unknown and LLM ids are a 400, NOT joined:false. Answering with a
      // marker for an id this endpoint refuses to act for would leak another
      // participant's read position behind a friendly-looking negative.
      if (!humanRow(d, actor))
        return sendJson(res, 400, {
          error: `"${actor}" is not an existing human participant`,
        });
      const m = d
        .prepare(
          "SELECT last_read_seq, left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
        )
        .get(roomId, actor);
      return sendJson(res, 200, {
        // joined means PRESENT here; a retained left row still reports its
        // marker so the client can resume without reopening the membership.
        joined: !!m && m.left_at === null,
        last_read_seq: m ? m.last_read_seq : 0,
      });
    }
    if (url.pathname === "/api/search") {
      const roomId = Number(url.searchParams.get("room"));
      if (!Number.isSafeInteger(roomId) || roomId <= 0)
        return sendJson(res, 400, {
          error: "room must be a positive safe integer",
        });
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
