import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the shared database file. All agents on a machine talk through one
 * file by default; override with AGENT_CHAT_DB for isolated rooms / testing.
 * Always ABSOLUTE: a relative override would point tools launched from other
 * working directories (the poller, most commonly) at a different file.
 */
function resolveDbPath(): string {
  const override = process.env.AGENT_CHAT_DB;
  if (override && override.trim().length > 0) {
    const t = override.trim();
    // The ":memory:" sentinel is not a filesystem path. (SQLite "file:" URIs
    // are NOT special-cased: this open does not enable URI parsing, so they
    // are literal filenames and get resolved like any other path.)
    if (t === ":memory:") return t;
    return resolve(t);
  }
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}

/** SQLite's default maximum string/blob byte length (SQLITE_MAX_LENGTH). */
export const SQLITE_MAX_LENGTH = 1_000_000_000;

/**
 * Default serialized-size budget for bulk message reads (catch_up,
 * read_history, get_thread replies, search_messages). Chosen conservatively
 * below observed MCP client output caps (~200k chars): an oversized response
 * fails AFTER the read marker committed, silently skipping messages, so the
 * budget must make responses that always fit. The unit is serialized JSON
 * characters (UTF-16 code units, `JSON.stringify(x).length`) -- the same unit
 * as the client cap -- NOT UTF-8 bytes; multibyte content is larger on the
 * wire but clients cap on chars/tokens, so chars are the correct accounting.
 */
export const DEFAULT_MAX_BYTES = 100_000;

// EXACT worst-case envelopes: the serialized size of each bulk-read response
// with an empty messages array and every scalar at its widest legal value
// (MAX_SAFE_INTEGER = 16 digits, wider than any real seq/count; "false" is
// wider than "true"). max_bytes minus the envelope is the budget handed to
// boundByBytes, which itself charges the array brackets and commas, so the
// WHOLE response honors max_bytes -- approximate reserves kept leaking
// single-digit overruns (50 rows = 51 uncounted separator chars).
const WIDE = Number.MAX_SAFE_INTEGER;
// "[]" subtracted where boundByBytes charges the brackets itself.
const CATCH_UP_ENVELOPE =
  JSON.stringify({
    messages: [],
    new_last_read_seq: WIDE,
    remaining: WIDE,
    advanced: false,
    byte_limited: true,
  }).length - 2;
const HISTORY_ENVELOPE =
  JSON.stringify({
    messages: [],
    oldest_seq: WIDE,
    has_more: false,
    byte_limited: true,
  }).length - 2;
const SEARCH_ENVELOPE =
  JSON.stringify({ matches: [], byte_limited: true, next_offset: WIDE }).length -
  2;
// by_room's placeholder 0 (1 char) is subtracted; its real serialized length
// (brackets included) is measured and charged at call time.
const MENTIONS_ENVELOPE =
  JSON.stringify({
    messages: [],
    total_directed: WIDE,
    next_after_id: WIDE,
    by_room: 0,
    by_room_truncated: true,
    byte_limited: true,
  }).length -
  2 -
  1;
const THREAD_ENVELOPE =
  JSON.stringify({
    message: 0,
    parent: 0,
    replies: [],
    replies_capped: false,
    byte_limited: true,
  }).length -
  2 -
  2;
/** Serialized-size allowance below which shrinkToFit is guaranteed to fit any
 *  legal row as a stub (fixed fields ~430 worst case); budgets floor here. */
const STUB_ALLOWANCE = 500;

/** Age (SQLite datetime modifier) past which a silent private session cursor
 *  is dead: reaped by the join-time GC and by prune (a dead cursor must not
 *  block retention forever). Live sessions refresh on every join/touch. */
const SESSION_GC_AGE = "-7 days";

/**
 * Slice s to at most `end` UTF-16 code units, backing off one unit when the
 * cut would split a surrogate pair: a lone surrogate is not valid Unicode,
 * renders as U+FFFD, and non-JS clients (Python most commonly) can crash
 * re-encoding it. Applies to every preview/shrink cut; get_message offset
 * walks keep their own boundary logic (the caller's offset is a contract).
 */
function safeCut(s: string, end: number): string {
  if (end <= 0) return "";
  if (end >= s.length) return s;
  const c = s.charCodeAt(end - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? end - 1 : end);
}

export type RoomRow = {
  id: number;
  name: string;
  description: string | null;
  pinned: string | null;
  created_at: string;
};

export type RoomSummary = RoomRow & {
  members: number;
  messages: number;
  last_activity: string | null;
  /** Present when the listing preview cut a long pinned/description; the
   *  full text is returned by join_room. */
  pinned_truncated?: boolean;
  description_truncated?: boolean;
};

export type AgentRow = {
  id: string;
  type: string | null;
  role: string | null;
  /** Listing preview (cut at 300 chars, flagged below). */
  description: string | null;
  description_truncated?: boolean;
  joined_at: string;
  last_read_seq: number;
  last_seen: string | null;
  idle_seconds: number | null;
  present: boolean;
  active: boolean;
};

export type RecipientStatus = {
  id: string;
  /** unknown = never joined, left = joined then left, idle = present but not
   *  seen recently, active = present and seen within the liveness window. */
  status: "active" | "idle" | "left" | "unknown";
  present: boolean;
  idle_seconds: number | null;
  last_read_seq: number | null;
};

export type ReplyRef = {
  seq: number;
  from: string | null;
  preview: string;
};

export type MessageRow = {
  seq: number;
  from: string;
  from_type: string | null;
  from_role: string | null;
  format: "text" | "json";
  content: unknown;
  to: string[] | null;
  reply_to: ReplyRef | null;
  /** Local wall-clock "YYYY-MM-DD HH:MM:SS" in the server host's timezone. */
  at: string;
  /** UTC epoch seconds (== Date.now()/1000 at creation); timezone-independent,
   *  directly comparable to what_time_is_it_right_now's `unix`. */
  unix: number;
  /** Present only when a preview/byte/slice cap truncated the body. */
  truncated?: boolean;
  /** Present when the mentions list was cut to fit a byte budget. */
  to_truncated?: boolean;
  /** Full mention count before the cut (only with to_truncated). */
  to_total?: number;
  /** Present when even metadata had to be truncated to fit the budget: the
   *  row is a stub; fetch the real message with get_message. */
  oversized?: boolean;
  /** Full character length of the original body (only when truncated). */
  length?: number;
  /** Character offset of a get_message slice (only when slicing). */
  offset?: number;
  /** seq of this author's earlier message that this one supersedes. */
  supersedes?: number;
  /** seq of the latest message that supersedes this one. */
  superseded_by?: number;
};

/** An inbox entry: a message plus the room it lives in. */
export type MentionRow = MessageRow & { room_id: number; room_name: string };

type RawMessage = {
  seq: number;
  agent_id: string;
  from_type: string | null;
  from_role: string | null;
  format: "text" | "json";
  body: string;
  /** Exact UTF-16 length of the FULL body (the fetched body may be capped).
   *  NULL only for rows written by an old build during a mixed-version window
   *  before this process's startup backfill ran; fall back to body.length. */
  body_len: number | null;
  mentions: string | null;
  reply_to_seq: number | null;
  reply_from: string | null;
  reply_preview: string | null;
  created_local: string;
  created_unix: number;
  supersedes_seq: number | null;
  superseded_by: number | null;
};

/** Full body length in UTF-16 units, tolerant of a missing body_len. */
function fullLen(r: RawMessage): number {
  return r.body_len ?? r.body.length;
}

// A message row joined to its author and (for reply previews) its parent.
// superseded_by resolves ONE hop (the latest direct superseder); readers follow
// chains by looking at that message's own superseded_by.
//
// The body is fetched CAPPED (substr in codepoints, which always covers at
// least as many UTF-16 units): a legal body can be ~1 GB, and loading it whole
// to serve a 100k-char page held gigabytes in the JS heap, sometimes inside an
// IMMEDIATE write transaction. bodyCap is the most body a response could ever
// carry (a row serializes no smaller than its raw body, so content beyond the
// byte budget can never survive shrinking). body_len rides along so truncation
// flags and `length` fields stay exact for capped rows.
function messageCols(bodyCap: number): string {
  const cap = Math.max(1, Math.floor(bodyCap));
  return `g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
          g.format, substr(g.body, 1, ${cap}) AS body, g.body_len,
          g.mentions, g.reply_to_seq,
          datetime(g.created_at, 'localtime') AS created_local,
          CAST(strftime('%s', g.created_at) AS INTEGER) AS created_unix,
          g.supersedes_seq,
          (SELECT s.seq FROM messages s
            WHERE s.room_id = g.room_id AND s.supersedes_seq = g.seq
            ORDER BY s.seq DESC LIMIT 1) AS superseded_by,
          p.agent_id AS reply_from, substr(p.body, 1, 101) AS reply_preview`;
}

const MESSAGE_FROM = `messages g
                      LEFT JOIN agents a ON a.id = g.agent_id
                      LEFT JOIN messages p ON p.room_id = g.room_id AND p.seq = g.reply_to_seq`;

/**
 * SQL predicate for "directed at me": an explicit mention, OR a reply to a
 * message I authored. Binds the agent id to TWO `?` placeholders in order
 * (mention value, then reply-parent author); push the id twice at each call.
 * `alias` is the message row's table alias in the enclosing query ("g" or the
 * bare table name "messages"); `mm` aliases the correlated parent lookup.
 */
export function directedAt(alias: string): string {
  // Strictly two-valued (never NULL): EXISTS for the mention term, IFNULL for
  // the reply term, so `NOT directedAt` can never silently drop rows. The
  // reply term reads the DENORMALIZED reply_to_agent column stamped at insert
  // time: a live parent lookup would cost a correlated subquery per row AND
  // silently un-direct replies whose parent was pruned.
  return `(EXISTS (SELECT 1 FROM json_each(${alias}.mentions) WHERE value = ?)
           OR IFNULL(${alias}.reply_to_agent = ?, 0))`;
}

export class ChatStore {
  readonly path: string;
  private db: Database.Database;

  constructor(path = resolveDbPath()) {
    this.path = path;
    if (path !== ":memory:") {
      // Owner-only: chat content is not for other local users. The directory
      // is created 0700; existing files are tightened too (installs that
      // predate this ran under the umask, typically 0644/0755). WAL sidecars
      // inherit the main file's mode, so tightening chat.db before any write
      // covers -wal/-shm as they are (re)created; pre-existing sidecars are
      // tightened explicitly. Best-effort: permissions are a hardening layer,
      // not a startup gate (and a no-op concept on Windows).
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        chmodSync(dirname(path), 0o700);
        for (const p of [path, `${path}-wal`, `${path}-shm`]) {
          if (existsSync(p)) chmodSync(p, 0o600);
        }
      } catch {}
    }
    this.db = new Database(path);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {}
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT,
        pinned      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agents (
        id          TEXT PRIMARY KEY,
        type        TEXT,
        role        TEXT,
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memberships (
        room_id       INTEGER NOT NULL REFERENCES rooms(id),
        agent_id      TEXT NOT NULL REFERENCES agents(id),
        joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        last_seen     TEXT,
        left_at       TEXT,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id      INTEGER NOT NULL REFERENCES rooms(id),
        seq          INTEGER NOT NULL,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        format       TEXT NOT NULL DEFAULT 'text',
        body         TEXT NOT NULL,
        mentions     TEXT,
        reply_to_seq INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (room_id, seq)
      );
    `);

    // Upgrade older database files that predate these columns. Run before
    // creating any column-dependent index so the index never precedes its
    // column on a legacy schema.
    this.ensureColumn("rooms", "pinned", "TEXT");
    this.ensureColumn("memberships", "last_seen", "TEXT");
    this.ensureColumn("memberships", "left_at", "TEXT");
    this.ensureColumn("messages", "format", "TEXT NOT NULL DEFAULT 'text'");
    this.ensureColumn("messages", "reply_to_seq", "INTEGER");
    this.ensureColumn("messages", "mentions", "TEXT");
    this.ensureColumn("messages", "supersedes_seq", "INTEGER");
    this.ensureColumn("messages", "reply_to_agent", "TEXT");
    this.ensureColumn("messages", "body_len", "INTEGER");
    // Backfill the denormalized reply author for rows written by older builds
    // whose parent still exists. Rows whose parent was already pruned stay
    // NULL (their direction is unrecoverable) and are re-examined harmlessly.
    this.db.exec(`
      UPDATE messages SET reply_to_agent =
        (SELECT p.agent_id FROM messages p
          WHERE p.room_id = messages.room_id AND p.seq = messages.reply_to_seq)
      WHERE reply_to_seq IS NOT NULL AND reply_to_agent IS NULL
    `);
    // DB-level enforcement for MIXED-VERSION windows: a still-running old
    // build inserts without these columns, and if the reply's parent is
    // pruned before any new-build process restarts, the startup backfill
    // above can never recover the author -- the reply is silently
    // undirected forever. Triggers live in the database file, so they fire
    // for the old build's inserts too. New builds stamp both columns
    // explicitly, so the WHEN clauses skip their rows.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_reply_agent_ai AFTER INSERT ON messages
      WHEN NEW.reply_to_seq IS NOT NULL AND NEW.reply_to_agent IS NULL BEGIN
        UPDATE messages SET reply_to_agent =
          (SELECT p.agent_id FROM messages p
            WHERE p.room_id = NEW.room_id AND p.seq = NEW.reply_to_seq)
        WHERE id = NEW.id;
      END;

      -- length() counts CODEPOINTS, an exact UTF-16 count only for BMP text;
      -- astral rows from old builds report slightly low until a JS process
      -- re-measures them. Far better than NULL (which forces the capped
      -- fetched length to stand in for the real one).
      CREATE TRIGGER IF NOT EXISTS messages_body_len_ai AFTER INSERT ON messages
      WHEN NEW.body_len IS NULL BEGIN
        UPDATE messages SET body_len = length(NEW.body) WHERE id = NEW.id;
      END;
    `);
    // Backfill body_len (exact UTF-16, so it must be measured in JS) for rows
    // that predate the column. One row at a time, cursored by id: loading a
    // batch could hold several ~1 GB bodies at once, and the id cursor keeps
    // the whole loop a single table pass instead of a rescan per row.
    {
      const next = this.db.prepare(
        "SELECT id, body FROM messages WHERE body_len IS NULL AND id > ? ORDER BY id LIMIT 1",
      );
      const set = this.db.prepare(
        "UPDATE messages SET body_len = ? WHERE id = ?",
      );
      let cursor = 0;
      for (;;) {
        const row = next.get(cursor) as { id: number; body: string } | undefined;
        if (!row) break;
        set.run(row.body.length, row.id);
        cursor = row.id;
      }
    }

    this.db.exec(`
      -- UNIQUE(room_id, seq) already provides an implicit (room_id, seq) index
      -- (sqlite_autoindex, same query plans); an explicit duplicate only taxes
      -- every insert. Drop it from database files created by older builds.
      DROP INDEX IF EXISTS idx_messages_room_seq;
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(room_id, reply_to_seq);
      CREATE INDEX IF NOT EXISTS idx_messages_supersedes ON messages(room_id, supersedes_seq);

      -- Per-session read cursors for identities running multiple concurrent
      -- sessions (join_room cursor:'private'). The memberships marker stays the
      -- identity-level read receipt (advanced to the MAX across sessions).
      CREATE TABLE IF NOT EXISTS session_markers (
        room_id       INTEGER NOT NULL REFERENCES rooms(id),
        agent_id      TEXT NOT NULL REFERENCES agents(id),
        session_id    TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (room_id, agent_id, session_id)
      );

      -- Advisory single-winner work claims with TTL. Purely advisory: nothing
      -- fences the claimed resource itself; expiry frees claims from crashed
      -- holders.
      CREATE TABLE IF NOT EXISTS claims (
        room_id    INTEGER NOT NULL REFERENCES rooms(id),
        key        TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        note       TEXT,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (room_id, key)
      );
    `);

    // Full-text search over message bodies. External-content FTS5 mirrors
    // messages.body keyed by messages.id; triggers keep it in sync.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(body, content='messages', content_rowid='id');

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body)
          VALUES ('delete', old.id, old.body);
      END;
    `);
    // Backfill decision by INDEX CONSISTENCY, not table existence: a process
    // dying between the CREATE above and the rebuild below used to leave a
    // database where every later start saw the table and skipped the rebuild
    // forever -- all pre-FTS messages permanently invisible to search. A row
    // count mismatch also repairs databases already damaged by that window.
    // The index row count MUST come from the messages_fts_docsize shadow
    // table: with external content, COUNT(*) on the virtual table itself
    // reads the content table and always matches. (Triggers exist by this
    // point, so concurrent inserts move both counts together and cannot fake
    // consistency.)
    const { c: msgCount } = this.db
      .prepare("SELECT COUNT(*) AS c FROM messages")
      .get() as { c: number };
    const { c: ftsCount } = this.db
      .prepare("SELECT COUNT(*) AS c FROM messages_fts_docsize")
      .get() as { c: number };
    if (ftsCount !== msgCount) {
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    }
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (e) {
        // Two fresh processes migrating the same legacy file can both pass
        // the PRAGMA check; the loser's ALTER must be a no-op, not a startup
        // crash.
        const msg = e instanceof Error ? e.message : String(e);
        if (!/duplicate column name/i.test(msg)) throw e;
      }
    }
  }

  // --- rooms -------------------------------------------------------------

  createRoom(
    name: string,
    description: string | null,
    pinned: string | null,
  ): RoomRow {
    const info = this.db
      .prepare("INSERT INTO rooms (name, description, pinned) VALUES (?, ?, ?)")
      .run(name, description, pinned);
    return this.db
      .prepare("SELECT * FROM rooms WHERE id = ?")
      .get(info.lastInsertRowid) as RoomRow;
  }

  setPinned(roomId: number, pinned: string | null): void {
    const info = this.db
      .prepare("UPDATE rooms SET pinned = ? WHERE id = ?")
      .run(pinned, roomId);
    // 0 rows = the room vanished under us; report it instead of a false
    // success the caller would trust.
    if (info.changes === 0) {
      throw new Error(
        `room ${roomId} no longer exists (deleted); rejoin with join_room`,
      );
    }
  }

  getRoom(roomId: number): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as
      | RoomRow
      | undefined;
  }

  /** Throw a clean, recoverable error when the room no longer exists. Called
   *  INSIDE write transactions whose room reference was resolved earlier, so
   *  a cross-process delete_room in the window yields this message instead of
   *  a raw FK constraint failure or a false no-op success. */
  private requireRoom(roomId: number): void {
    const row = this.db
      .prepare("SELECT 1 FROM rooms WHERE id = ?")
      .get(roomId);
    if (!row) {
      throw new Error(
        `room ${roomId} no longer exists (deleted); rejoin with join_room`,
      );
    }
  }

  /** Exact name lookup (never interprets the value as an id). */
  getRoomByName(name: string): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE name = ?").get(name) as
      | RoomRow
      | undefined;
  }

  /**
   * Current time from the shared DB clock: UTC epoch seconds plus the local
   * wall-clock string, in the same unit and format as message timestamps so an
   * agent can subtract `unix` values directly to get elapsed seconds.
   */
  currentTime(): { unix: number; at: string; iso: string } {
    const r = this.db
      .prepare(
        `SELECT CAST(strftime('%s','now') AS INTEGER) AS unix,
                datetime('now','localtime') AS at,
                CAST(strftime('%s', datetime('now','localtime')) AS INTEGER)
                  - CAST(strftime('%s','now') AS INTEGER) AS offset_seconds`,
      )
      .get() as { unix: number; at: string; offset_seconds: number };
    // ISO 8601 local time with explicit offset, e.g. 2026-07-08T03:35:13-04:00.
    // offset_seconds is the local wall-clock read as UTC minus true UTC, i.e.
    // the zone offset for THIS instant (so it tracks DST). All SQLite-sourced;
    // no JS Date, keeping the value identical in clock and format to `at`.
    const off = r.offset_seconds;
    const sign = off >= 0 ? "+" : "-";
    const abs = Math.abs(off);
    const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
    const iso = `${r.at.replace(" ", "T")}${sign}${hh}:${mm}`;
    return { unix: r.unix, at: r.at, iso };
  }

  /**
   * Room listing, bounded two ways: at most `limit` rows, and pinned/
   * description cut to listing previews (flagged; join_room returns the full
   * pinned). Unbounded, a few hundred rooms with 10k pinned intros made a
   * multi-megabyte response no client cap tolerates.
   */
  listRooms(limit = 200): { rooms: RoomSummary[]; total: number } {
    const PREVIEW = 300;
    const rows = this.db
      .prepare(
        `SELECT r.id, r.name,
                substr(r.description, 1, ${PREVIEW}) AS description,
                CASE WHEN length(r.description) > ${PREVIEW} THEN 1 ELSE 0 END AS description_cut,
                substr(r.pinned, 1, ${PREVIEW}) AS pinned,
                CASE WHEN length(r.pinned) > ${PREVIEW} THEN 1 ELSE 0 END AS pinned_cut,
                r.created_at,
                (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
                (SELECT COUNT(*) FROM messages g WHERE g.room_id = r.id) AS messages,
                (SELECT MAX(created_at) FROM messages g WHERE g.room_id = r.id) AS last_activity
         FROM rooms r ORDER BY r.id LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as (RoomSummary & {
      description_cut: number;
      pinned_cut: number;
    })[];
    const { c: total } = this.db
      .prepare("SELECT COUNT(*) AS c FROM rooms")
      .get() as { c: number };
    const rooms = rows.map((r) => {
      const { description_cut, pinned_cut, ...rest } = r;
      return {
        ...rest,
        ...(description_cut ? { description_truncated: true } : {}),
        ...(pinned_cut ? { pinned_truncated: true } : {}),
      };
    });
    return { rooms, total };
  }

  /** Present (not soft-left) member count; join_room used to fetch every
   *  agent row merely to count them. */
  presentCount(roomId: number): number {
    const { c } = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM memberships WHERE room_id = ? AND left_at IS NULL",
      )
      .get(roomId) as { c: number };
    return c;
  }

  /** Resolve a room reference that may be a numeric id or a name. */
  resolveRoom(ref: string): RoomRow | undefined {
    if (/^\d+$/.test(ref)) {
      const byId = this.db
        .prepare("SELECT * FROM rooms WHERE id = ?")
        .get(Number(ref)) as RoomRow | undefined;
      if (byId) return byId;
    }
    return this.db.prepare("SELECT * FROM rooms WHERE name = ?").get(ref) as
      | RoomRow
      | undefined;
  }

  // --- agents / membership ----------------------------------------------

  upsertAgent(
    id: string,
    type: string | null,
    role: string | null,
    description: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, type, role, description)
         VALUES (@id, @type, @role, @description)
         ON CONFLICT(id) DO UPDATE SET
           type        = COALESCE(excluded.type, agents.type),
           role        = COALESCE(excluded.role, agents.role),
           description = COALESCE(excluded.description, agents.description)`,
      )
      .run({ id, type, role, description });
  }

  /**
   * Insert a brand-new agent row, doing nothing if the id is already taken.
   * Returns true only if THIS call created it, so a caller assigning a generated
   * id can claim it atomically: two processes racing on the same candidate id
   * cannot both "win" and collapse onto one shared identity/read-marker.
   */
  tryCreateAgent(
    id: string,
    type: string | null,
    role: string | null,
    description: string | null,
  ): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO agents (id, type, role, description)
         VALUES (@id, @type, @role, @description)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({ id, type, role, description });
    return info.changes > 0;
  }

  /**
   * Join (or rejoin) a room: clears any prior leave and refreshes liveness.
   * With sessionId (a private cursor), also ensure a per-session read cursor,
   * initialized from the identity marker so a new session starts where the
   * identity left off; an existing session row keeps its position.
   */
  joinRoom(roomId: number, agentId: string, sessionId: string | null = null): void {
    // One IMMEDIATE transaction: this was the file's only multi-statement
    // read-then-write path running autocommitted, where a cross-process
    // deleteRoom interleaving between statements surfaced as an opaque
    // NOT NULL/FK constraint error instead of a clean failure.
    const tx = this.db.transaction(() => {
    // Existence check INSIDE the write transaction: the caller resolved the
    // room in an earlier statement, and a cross-process delete_room in that
    // window otherwise surfaces as a raw "FOREIGN KEY constraint failed".
    this.requireRoom(roomId);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memberships (room_id, agent_id) VALUES (?, ?)",
      )
      .run(roomId, agentId);
    this.db
      .prepare(
        `UPDATE memberships SET left_at = NULL, last_seen = datetime('now')
         WHERE room_id = ? AND agent_id = ?`,
      )
      .run(roomId, agentId);
    if (sessionId !== null) {
      // Refresh updated_at on rejoin (keeping the cursor position): the GC
      // below must never reap the very session this join is resuming, which
      // an INSERT OR IGNORE (no liveness refresh) allowed.
      this.db
        .prepare(
          `INSERT INTO session_markers (room_id, agent_id, session_id, last_read_seq)
           VALUES (?, ?, ?, (SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?))
           ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
             updated_at = datetime('now')`,
        )
        .run(roomId, agentId, sessionId, roomId, agentId);
      // GC dead session cursors. Live sessions stay off this radar: the
      // upsert above refreshes on join and touch() refreshes on every tool
      // call, so only sessions silent for 7+ days qualify.
      this.db
        .prepare(
          "DELETE FROM session_markers WHERE room_id = ? AND updated_at < datetime('now', ?)",
        )
        .run(roomId, SESSION_GC_AGE);
    }
    });
    tx.immediate();
  }

  /**
   * Drop THIS session's private cursor for a room: called when a session
   * joins a room in SHARED mode, so a leftover private row from an earlier
   * private join cannot keep feeding my_mentions a stale baseline that the
   * session's own catch_up (now shared) no longer uses.
   */
  clearSessionCursor(roomId: number, agentId: string, sessionId: string): void {
    this.db
      .prepare(
        "DELETE FROM session_markers WHERE room_id = ? AND agent_id = ? AND session_id = ?",
      )
      .run(roomId, agentId, sessionId);
  }

  /**
   * Soft leave: keep the membership row (and read position) but mark not
   * present. Private session cursors are deliberately KEPT: the identity
   * marker is the MAX across sessions, so a lagging session's true position
   * exists ONLY in its session_markers row -- deleting it here would jump the
   * session forward to its fastest twin's position on rejoin, silently
   * skipping the gap. Dead rows are reaped by the 7-day GC in joinRoom.
   */
  leaveRoom(roomId: number, agentId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE memberships SET left_at = datetime('now'), last_seen = datetime('now')
         WHERE room_id = ? AND agent_id = ? AND left_at IS NULL`,
      )
      .run(roomId, agentId);
    return info.changes > 0;
  }

  /**
   * Refresh ALL of a session's cursor rows against the 7-day GC, without
   * touching membership state: used when the session has an identity but no
   * active room (post-leave my_mentions polling must still shield cursors).
   */
  touchSessionMarkers(agentId: string, sessionId: string): void {
    this.db
      .prepare(
        "UPDATE session_markers SET updated_at = datetime('now') WHERE agent_id = ? AND session_id = ?",
      )
      .run(agentId, sessionId);
  }

  /**
   * Mark an active agent alive. Also clears left_at: an actively-acting session
   * re-asserts presence, so a soft leave performed by another process using the
   * same agent_id does not leave the live session showing as not-present. (A
   * genuine leave_room clears the session, after which touch is never called.)
   */
  touch(roomId: number, agentId: string, sessionId: string | null = null): void {
    this.db
      .prepare(
        "UPDATE memberships SET last_seen = datetime('now'), left_at = NULL WHERE room_id = ? AND agent_id = ?",
      )
      .run(roomId, agentId);
    if (sessionId !== null) {
      // Keep a live session's cursor rows out of the 7-day GC, in EVERY room:
      // the session may hold private cursors in rooms it is not currently
      // touching, and another agent's join in such a room must not reap a
      // cursor whose owner is demonstrably alive.
      this.touchSessionMarkers(agentId, sessionId);
    }
  }

  getMembership(
    roomId: number,
    agentId: string,
  ): { last_read_seq: number; left_at: string | null } | undefined {
    return this.db
      .prepare(
        "SELECT last_read_seq, left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId) as
      | { last_read_seq: number; left_at: string | null }
      | undefined;
  }

  /**
   * Read the effective cursor: the per-session position when sessionId is set
   * (falling back to the identity marker if the session row does not exist
   * yet), else the identity marker. Read-only, so it is safe inside a deferred
   * (read) transaction.
   */
  getCursor(
    roomId: number,
    agentId: string,
    sessionId: string | null,
  ): { last_read_seq: number; left_at: string | null } | undefined {
    const membership = this.getMembership(roomId, agentId);
    if (!membership || sessionId === null) return membership;
    const s = this.db
      .prepare(
        "SELECT last_read_seq FROM session_markers WHERE room_id = ? AND agent_id = ? AND session_id = ?",
      )
      .get(roomId, agentId, sessionId) as { last_read_seq: number } | undefined;
    return s
      ? { last_read_seq: s.last_read_seq, left_at: membership.left_at }
      : membership;
  }

  /**
   * Move the cursor to seq. Shared mode sets the identity marker exactly
   * (rewind allowed, preserving mark_read semantics). Session mode upserts the
   * session cursor exactly and raises the identity marker monotonically to the
   * MAX across sessions, keeping it meaningful as "some session of this
   * identity has read this far" for read receipts.
   */
  private setCursor(
    roomId: number,
    agentId: string,
    sessionId: string | null,
    seq: number,
  ): void {
    if (sessionId === null) {
      this.db
        .prepare(
          "UPDATE memberships SET last_read_seq = ? WHERE room_id = ? AND agent_id = ?",
        )
        .run(seq, roomId, agentId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO session_markers (room_id, agent_id, session_id, last_read_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
           last_read_seq = excluded.last_read_seq, updated_at = datetime('now')`,
      )
      .run(roomId, agentId, sessionId, seq);
    this.db
      .prepare(
        "UPDATE memberships SET last_read_seq = max(last_read_seq, ?) WHERE room_id = ? AND agent_id = ?",
      )
      .run(seq, roomId, agentId);
  }

  /**
   * Agents in a room, bounded like listRooms: at most `limit` rows (with the
   * filtered total riding along) and descriptions cut to listing previews.
   */
  listAgents(
    roomId: number,
    activeWithinMinutes: number,
    filter?: string,
    limit = 200,
  ): { agents: AgentRow[]; total: number } {
    const PREVIEW = 300;
    const cols = `SELECT a.id, a.type, a.role,
                         substr(a.description, 1, ${PREVIEW}) AS description,
                         CASE WHEN length(a.description) > ${PREVIEW} THEN 1 ELSE 0 END AS description_cut,
                         m.joined_at,
                         m.last_read_seq, m.last_seen, m.left_at,
                         (strftime('%s','now') - strftime('%s', m.last_seen)) AS idle_seconds
                  FROM memberships m JOIN agents a ON a.id = m.agent_id
                  WHERE m.room_id = ?`;
    const count = `SELECT COUNT(*) AS c
                   FROM memberships m JOIN agents a ON a.id = m.agent_id
                   WHERE m.room_id = ?`;
    const lim = Math.max(1, Math.floor(limit));
    type Row = Omit<AgentRow, "present" | "active"> & {
      left_at: string | null;
      description_cut: number;
    };
    let rows: Row[];
    let total: number;
    if (filter && filter.trim().length > 0) {
      // Literal-substring semantics: escape LIKE wildcards so a filter of
      // "50%" matches those three characters, not everything.
      const like = `%${filter.trim().replace(/[\\%_]/g, "\\$&")}%`;
      const cond = ` AND (IFNULL(a.role,'') LIKE ? ESCAPE '\\' OR IFNULL(a.type,'') LIKE ? ESCAPE '\\'
                        OR IFNULL(a.description,'') LIKE ? ESCAPE '\\' OR a.id LIKE ? ESCAPE '\\')`;
      rows = this.db
        .prepare(`${cols}${cond} ORDER BY m.joined_at LIMIT ?`)
        .all(roomId, like, like, like, like, lim) as Row[];
      total = (
        this.db.prepare(`${count}${cond}`).get(roomId, like, like, like, like) as {
          c: number;
        }
      ).c;
    } else {
      rows = this.db
        .prepare(`${cols} ORDER BY m.joined_at LIMIT ?`)
        .all(roomId, lim) as Row[];
      total = (this.db.prepare(count).get(roomId) as { c: number }).c;
    }
    const threshold = activeWithinMinutes * 60;
    const agents = rows.map((r) => {
      const { left_at, description_cut, ...rest } = r;
      return {
        ...rest,
        ...(description_cut ? { description_truncated: true } : {}),
        present: left_at === null,
        active:
          left_at === null &&
          r.idle_seconds !== null &&
          r.idle_seconds <= threshold,
      };
    });
    return { agents, total };
  }

  // --- messages ----------------------------------------------------------

  /**
   * Insert a message, allocating the next per-room seq atomically. Also
   * reports the poster's blind spot: `crossed` counts messages from OTHERS the
   * poster had not read at post time (cursor-relative), with the seq range, so
   * a poster learns in the same call that it may have posted over unseen
   * traffic. supersedesSeq marks the poster's OWN earlier message as
   * superseded by this one. Both replyToSeq and supersedesSeq are validated
   * in-transaction, so a concurrent prune cannot slip a dangling reference
   * between a pre-check and the insert.
   */
  postMessage(
    roomId: number,
    agentId: string,
    body: string,
    format: "text" | "json",
    mentions: string[] | null,
    replyToSeq: number | null,
    supersedesSeq: number | null = null,
    sessionId: string | null = null,
  ): {
    id: number;
    seq: number;
    crossed: number;
    crossed_range: { from_seq: number; to_seq: number } | null;
  } {
    const mentionsJson =
      mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
    const tx = this.db.transaction(() => {
      // The caller's room reference predates this transaction; a concurrent
      // delete_room otherwise surfaces as a raw FK failure on the INSERT.
      this.requireRoom(roomId);
      let replyToAgent: string | null = null;
      if (replyToSeq !== null) {
        // Author only -- never fetch the body, which can be huge. The author
        // is denormalized onto the reply so its directedness survives pruning
        // of the parent.
        const parent = this.db
          .prepare("SELECT agent_id FROM messages WHERE room_id = ? AND seq = ?")
          .get(roomId, replyToSeq) as { agent_id: string } | undefined;
        if (!parent) {
          throw new Error(
            `reply_to_seq ${replyToSeq} does not exist in this room`,
          );
        }
        replyToAgent = parent.agent_id;
      }
      if (supersedesSeq !== null) {
        const target = this.db
          .prepare(
            "SELECT agent_id FROM messages WHERE room_id = ? AND seq = ?",
          )
          .get(roomId, supersedesSeq) as { agent_id: string } | undefined;
        if (!target) {
          throw new Error(
            `supersedes_seq ${supersedesSeq} does not exist in this room`,
          );
        }
        if (target.agent_id !== agentId) {
          throw new Error(
            `supersedes_seq ${supersedesSeq} was written by ${target.agent_id}; you can only supersede your own messages`,
          );
        }
      }
      // Crossing report: computed before the insert so "unread" excludes the
      // message being posted.
      const cursor = this.getCursor(roomId, agentId, sessionId);
      const from = cursor?.last_read_seq ?? 0;
      const crossing = this.db
        .prepare(
          `SELECT COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx FROM messages
           WHERE room_id = ? AND seq > ? AND agent_id != ?`,
        )
        .get(roomId, from, agentId) as {
        c: number;
        mn: number | null;
        mx: number | null;
      };
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { next: number };
      const info = this.db
        .prepare(
          `INSERT INTO messages (room_id, seq, agent_id, format, body, body_len, mentions, reply_to_seq, reply_to_agent, supersedes_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roomId,
          next,
          agentId,
          format,
          body,
          body.length, // exact UTF-16; readers use it when the fetch is capped
          mentionsJson,
          replyToSeq,
          replyToAgent,
          supersedesSeq,
        );
      return {
        id: Number(info.lastInsertRowid),
        seq: next,
        crossed: crossing.c,
        crossed_range:
          crossing.c > 0
            ? { from_seq: crossing.mn!, to_seq: crossing.mx! }
            : null,
      };
    });
    // IMMEDIATE acquires the write lock before reading MAX(seq), so concurrent
    // writer processes cannot allocate the same seq.
    return tx.immediate();
  }

  private rowToMessage(r: RawMessage, previewChars?: number): MessageRow {
    const total = fullLen(r);
    const truncate = previewChars !== undefined && total > previewChars;
    // A truncated body is returned as a raw (possibly partial) string even for
    // json: a sliced JSON string does not parse, so the caller must fetch the
    // full body with get_message. `truncated`/`length` signal exactly that.
    // A body larger than the fetch cap arrives here already cut; it can never
    // fit the byte budget anyway, so shrinkToFit re-flags it downstream.
    const content = truncate
      ? safeCut(r.body, previewChars)
      : r.format === "json"
        ? safeParse(r.body)
        : r.body;
    return {
      seq: r.seq,
      from: r.agent_id,
      from_type: r.from_type,
      from_role: r.from_role,
      format: r.format,
      content,
      to: r.mentions ? (safeParse(r.mentions) as string[]) : null,
      reply_to:
        r.reply_to_seq === null
          ? null
          : {
              seq: r.reply_to_seq,
              from: r.reply_from,
              preview: makePreview(r.reply_preview),
            },
      at: r.created_local,
      unix: r.created_unix,
      ...(truncate ? { truncated: true, length: total } : {}),
      ...(r.supersedes_seq !== null && r.supersedes_seq !== undefined
        ? { supersedes: r.supersedes_seq }
        : {}),
      ...(r.superseded_by !== null && r.superseded_by !== undefined
        ? { superseded_by: r.superseded_by }
        : {}),
    };
  }

  /**
   * Shrink ONE message until its serialized size fits `budget`. Stages:
   * proportional content cut (no fixed floor: content may go to zero, the
   * body is always recoverable via get_message), a one-shot correction for
   * escaping inflation (control chars serialize 6x), mention shedding, then
   * a stub (oversized:true) whose display metadata is HALVED until the
   * measured size fits -- a single code-unit cut under-counts JSON escaping,
   * which is how control-heavy room names kept escaping the budget. Every
   * stage measures the real serialized output, so for any budget >=
   * STUB_ALLOWANCE the result is guaranteed to fit.
   */
  private shrinkToFit<T extends MessageRow>(
    r: RawMessage,
    previewChars: number | undefined,
    budget: number,
    map: (r: RawMessage, previewChars?: number) => T,
  ): T {
    const m = map(r, previewChars);
    const size = JSON.stringify(m).length;
    if (size <= budget) return m;
    const measured =
      typeof m.content === "string" ? m.content.length : r.body.length;
    const envelope = Math.max(0, size - measured);
    // Stage 1: proportional content cut.
    let keep = Math.max(0, Math.floor((budget - envelope) * 0.9));
    let head = map(r, Math.min(keep, previewChars ?? Infinity));
    let sz = JSON.stringify(head).length;
    // Stage 2: correct once for escaping inflation.
    if (sz > budget && keep > 0) {
      keep = Math.max(0, Math.floor((keep * budget * 0.85) / sz));
      head = map(r, Math.min(keep, previewChars ?? Infinity));
      sz = JSON.stringify(head).length;
    }
    const h = head as MessageRow;
    // Stage 3: shed mentions (down to none if needed); size can live
    // entirely in a legal `to` list. Flags set before the deciding measure.
    if (sz > budget && Array.isArray(h.to) && h.to.length > 0) {
      h.to_total = h.to.length;
      h.to_truncated = true;
      while (sz > budget && h.to.length > 0) {
        h.to = h.to.slice(0, Math.floor(h.to.length / 2));
        sz = JSON.stringify(head).length;
      }
    }
    // Stage 4: stub. Body emptied, reply preview dropped; the seq remains
    // the durable reference and oversized:true says "use get_message".
    if (sz > budget) {
      const stub = head as MessageRow & { room_name?: string };
      stub.content = "";
      stub.truncated = true;
      stub.length = fullLen(r);
      stub.reply_to = null;
      stub.to = null;
      stub.oversized = true;
      sz = JSON.stringify(head).length;
      const half = (s: string) => safeCut(s, Math.floor(s.length / 2));
      while (
        sz > budget &&
        ((stub.from_role?.length ?? 0) > 0 ||
          (stub.from_type?.length ?? 0) > 0 ||
          (stub.room_name?.length ?? 0) > 0)
      ) {
        if (stub.from_role) stub.from_role = half(stub.from_role);
        if (stub.from_type) stub.from_type = half(stub.from_type);
        if (stub.room_name) stub.room_name = half(stub.room_name);
        sz = JSON.stringify(head).length;
      }
      // Sender identity shortens last (the seq still identifies the message).
      while (sz > budget && stub.from.length > 0) {
        stub.from = half(stub.from);
        sz = JSON.stringify(head).length;
      }
    }
    return head;
  }

  /**
   * Bound a bulk read by serialized size: accumulate whole messages (in row
   * order) until adding the next would exceed maxBytes. Charges the
   * serialized ARRAY -- brackets plus a comma per element -- not just the
   * bare elements (summing elements undercounts a 50-row page by 51 chars).
   * If the FIRST message alone exceeds the budget it is delivered shrunk
   * (never an empty page, which would deadlock paging); see shrinkToFit.
   * `map` lets callers decorate rows (e.g. thread depth) while sizes are
   * measured on the real output shape.
   */
  private boundByBytes<T extends MessageRow>(
    rows: RawMessage[],
    previewChars: number | undefined,
    maxBytes: number,
    map: (r: RawMessage, previewChars?: number) => T,
  ): { messages: T[]; byteLimited: boolean } {
    const out: T[] = [];
    let used = 2; // the array's own brackets
    for (const r of rows) {
      const m = map(r, previewChars);
      const size = JSON.stringify(m).length + (out.length > 0 ? 1 : 0);
      if (out.length === 0 && used + size > maxBytes) {
        // The head must fit alone: an advancing catch_up commits its marker
        // before the client sees the page, so an over-budget page a client
        // rejects means silent message loss. byte_limited stays truthful:
        // a lone shrunk row with no rows behind it leaves nothing to page.
        out.push(this.shrinkToFit(r, previewChars, maxBytes - 2, map));
        return { messages: out, byteLimited: rows.length > 1 };
      }
      if (used + size > maxBytes && out.length > 0) {
        return { messages: out, byteLimited: true };
      }
      out.push(m);
      used += size;
    }
    return { messages: out, byteLimited: false };
  }

  /**
   * Fetch one message. Bodies are capped at maxChars per call (default 100k,
   * safely under client output limits); page a longer body with `offset`. A
   * partial view carries truncated/length/offset markers, and a sliced json
   * body is returned as a raw partial string, not a parsed object.
   */
  getMessage(
    roomId: number,
    seq: number,
    offset = 0,
    maxChars = DEFAULT_MAX_BYTES,
  ): MessageRow | undefined {
    // Fetch capped at offset+maxChars CODEPOINTS: substr counts codepoints,
    // and N codepoints always cover at least N UTF-16 units, so the fetched
    // prefix fully contains the requested UTF-16 window. Memory is bounded by
    // the caller's own window instead of the whole (up to ~1 GB) body; only a
    // walk into the deep tail of a giant body still pays proportionally.
    const r = this.getRawMessage(roomId, seq, offset + maxChars);
    if (!r) return undefined;
    const total = fullLen(r);
    let start = offset;
    // A caller-chosen offset can land BETWEEN a surrogate pair; back the
    // start up one unit to include the high surrogate rather than emit a
    // lone low surrogate. The reported `offset` is the actual start, so
    // pagers stepping by offset + returned chars remain exact.
    if (
      start > 0 &&
      start < r.body.length &&
      r.body.charCodeAt(start) >= 0xdc00 &&
      r.body.charCodeAt(start) <= 0xdfff &&
      r.body.charCodeAt(start - 1) >= 0xd800 &&
      r.body.charCodeAt(start - 1) <= 0xdbff
    ) {
      start -= 1;
    }
    let end = Math.min(start + maxChars, total);
    // Back off a cut that would split a surrogate pair, but never below one
    // unit past start: a pager stepping by content.length stays exact (the
    // next page picks up the deferred unit), and an empty page would stall it.
    if (end < total && end - start > 1) {
      const c = r.body.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    let chunk = r.body.slice(start, end);
    // Serialized-size correction: maxChars caps RAW characters, but JSON
    // escaping inflates control-heavy bodies up to 6x on the wire (100k NULs
    // serialized past 600k). Shrink the slice until its serialized form fits
    // ~maxChars too; the walk contract survives because truncated/offset are
    // recomputed from the ACTUAL returned chunk.
    while (chunk.length > 1 && JSON.stringify(chunk).length - 2 > maxChars) {
      const ratio = maxChars / (JSON.stringify(chunk).length - 2);
      chunk = safeCut(
        chunk,
        Math.min(chunk.length - 1, Math.max(1, Math.floor(chunk.length * ratio))),
      );
    }
    end = start + chunk.length;
    const partial = start > 0 || end < total;
    if (!partial) return this.rowToMessage(r);
    // Build the envelope without parsing the (possibly huge) body.
    const base = this.rowToMessage({ ...r, body: "", body_len: 0 });
    return {
      ...base,
      content: chunk,
      // truncated means "there is more BEYOND this slice", so the final page
      // of an offset walk reports false and pagers terminate on it instead of
      // spinning on empty tail pages.
      truncated: end < total,
      length: total,
      offset: start,
    };
  }

  /**
   * Per-recipient delivery status for tagged ids, preserving input order:
   * whether each ever joined, is still present, how long since last seen, and
   * how far it has read (compare to a message seq for a read receipt). Lets a
   * poster judge whether a tag will be read or is posting into the void.
   */
  recipientStatus(
    roomId: number,
    ids: string[],
    activeWithinMinutes: number,
  ): RecipientStatus[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT agent_id, last_read_seq, left_at,
                (strftime('%s','now') - strftime('%s', last_seen)) AS idle_seconds
         FROM memberships
         WHERE room_id = ? AND agent_id IN (${placeholders})`,
      )
      .all(roomId, ...ids) as {
      agent_id: string;
      last_read_seq: number;
      left_at: string | null;
      idle_seconds: number | null;
    }[];
    const byId = new Map(rows.map((r) => [r.agent_id, r]));
    const threshold = activeWithinMinutes * 60;
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) {
        return {
          id,
          status: "unknown",
          present: false,
          idle_seconds: null,
          last_read_seq: null,
        };
      }
      const present = r.left_at === null;
      const active =
        present && r.idle_seconds !== null && r.idle_seconds <= threshold;
      return {
        id,
        status: present ? (active ? "active" : "idle") : "left",
        present,
        idle_seconds: r.idle_seconds,
        last_read_seq: r.last_read_seq,
      };
    });
  }

  /** Fetch one raw message row (author + reply preview joined), body capped
   *  at bodyCap codepoints (see messageCols). */
  private getRawMessage(
    roomId: number,
    seq: number,
    bodyCap: number = DEFAULT_MAX_BYTES,
  ): RawMessage | undefined {
    return this.db
      .prepare(
        `SELECT ${messageCols(bodyCap)} FROM ${MESSAGE_FROM}
         WHERE g.room_id = ? AND g.seq = ?`,
      )
      .get(roomId, seq) as RawMessage | undefined;
  }

  /**
   * A message plus its parent (if any) and a bounded, depth-annotated tree of
   * its replies. Descendants come back pre-order (each parent immediately before
   * its children) with a `depth` field (1 = direct reply). `maxDepth` bounds how
   * many reply levels are walked; the descendant set is capped and `replies_capped`
   * flags when the cap was hit. `previewChars` truncates descendant bodies.
   * The whole response shares ONE byte budget with an exact envelope: the
   * focal message spends first (reserving a stub allowance for an existing
   * parent), the parent takes what remains minus a replies reserve, and the
   * replies get the measured remainder -- when that remainder cannot even
   * hold a stub, replies are omitted with byte_limited:true rather than
   * delivered over budget. Oversized bodies arrive truncated with markers;
   * page them via get_message.
   */
  getThread(
    roomId: number,
    seq: number,
    maxDepth = 3,
    previewChars?: number,
  ):
    | {
        message: MessageRow;
        parent: MessageRow | null;
        replies: (MessageRow & { depth: number })[];
        replies_capped: boolean;
        byte_limited?: boolean;
      }
    | undefined {
    const focalRow = this.getRawMessage(roomId, seq);
    if (!focalRow) return undefined;
    const mapPlain = (r: RawMessage, pc?: number) => this.rowToMessage(r, pc);
    const budget = DEFAULT_MAX_BYTES - THREAD_ENVELOPE;
    // Reserve the parent's slot before spending on the focal message: a stub
    // allowance when a parent exists, 4 chars of literal null otherwise. The
    // trailing 2 covers an empty replies array.
    const parentSeq = focalRow.reply_to_seq;
    const parentReserve = parentSeq === null ? 4 : STUB_ALLOWANCE + 2;
    const message = this.shrinkToFit(
      focalRow,
      undefined,
      budget - parentReserve - 2,
      mapPlain,
    );
    let remaining = budget - JSON.stringify(message).length;
    let parent: MessageRow | null = null;
    if (parentSeq !== null) {
      const parentRow = this.getRawMessage(roomId, parentSeq);
      if (parentRow) {
        // Leave a stub allowance (plus array brackets) for the replies when
        // more than that remains; otherwise the parent gets a stub itself.
        parent = this.shrinkToFit(
          parentRow,
          undefined,
          Math.max(STUB_ALLOWANCE, remaining - STUB_ALLOWANCE - 2),
          mapPlain,
        );
      }
    }
    remaining -= parent ? JSON.stringify(parent).length : 4;

    const cap = 500;
    // Recursive walk of the reply subtree. `path` (zero-padded seq per level)
    // orders siblings numerically and yields pre-order DFS when sorted. Fetch
    // cap+1 rows to detect (without a separate COUNT) that more were available.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants(seq, depth, path) AS (
           SELECT g.seq, 1, printf('%010d', g.seq)
             FROM messages g
            WHERE g.room_id = @room AND g.reply_to_seq = @root
           UNION ALL
           SELECT c.seq, d.depth + 1, d.path || '/' || printf('%010d', c.seq)
             FROM messages c
             JOIN descendants d ON c.reply_to_seq = d.seq
            WHERE c.room_id = @room AND d.depth < @maxDepth
         )
         SELECT ${messageCols(DEFAULT_MAX_BYTES)}, d.depth AS depth
           FROM descendants d
           JOIN messages g ON g.room_id = @room AND g.seq = d.seq
           LEFT JOIN agents a ON a.id = g.agent_id
           LEFT JOIN messages p ON p.room_id = g.room_id AND p.seq = g.reply_to_seq
          ORDER BY d.path
          LIMIT @lim`,
      )
      .all({ room: roomId, root: seq, maxDepth, lim: cap + 1 }) as (RawMessage & {
      depth: number;
    })[];

    const replies_capped = rows.length > cap;
    // Below a stub allowance boundByBytes cannot guarantee even its head row
    // fits; omit the replies instead of delivering an over-budget response
    // (byte_limited says they exist; get_thread on a reply seq fetches them).
    let replies: (MessageRow & { depth: number })[] = [];
    let byteLimited = false;
    if (rows.length > 0 && remaining < STUB_ALLOWANCE + 2) {
      byteLimited = true;
    } else if (rows.length > 0) {
      ({ messages: replies, byteLimited } = this.boundByBytes(
        rows.slice(0, cap),
        previewChars,
        remaining,
        (r, pc) => ({
          ...this.rowToMessage(r, pc),
          depth: (r as RawMessage & { depth: number }).depth,
        }),
      ));
    }
    return {
      message,
      parent,
      replies,
      replies_capped,
      ...(byteLimited ? { byte_limited: true } : {}),
    };
  }

  /** Count of messages newer than the marker that the agent did NOT write. */
  unreadCount(roomId: number, lastReadSeq: number, agentId: string): number {
    const { c } = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE room_id = ? AND seq > ? AND agent_id != ?`,
      )
      .get(roomId, lastReadSeq, agentId) as { c: number };
    return c;
  }

  /**
   * Unread messages (seq > last_read_seq), oldest first; ADVANCES the read
   * marker over exactly the rows returned. Mention filtering deliberately does
   * NOT exist here: a filtered view of one room's stream gets mistaken for a
   * room sync (an agent concludes "quiet" while broadcasts sit unread). The
   * mentions inbox is myMentions: cross-room and never marker-advancing.
   */
  catchUp(
    roomId: number,
    agentId: string,
    limit: number,
    previewChars?: number,
    maxBytes: number = DEFAULT_MAX_BYTES,
    sessionId: string | null = null,
  ): {
    messages: MessageRow[];
    new_last_read_seq: number;
    remaining: number;
    advanced: boolean;
    byte_limited?: boolean;
  } {
    // Advancing path: read the cursor, fetch, and advance inside one IMMEDIATE
    // transaction so a concurrent same-identity call serializes behind it and
    // reads the updated cursor instead of returning overlapping messages.
    // The byte bound trims BEFORE the advance, so the cursor only ever covers
    // rows actually included in the response: a response the client rejects as
    // oversized can no longer strand messages behind an advanced marker.
    const tx = this.db.transaction(() => {
      const cursor = this.getCursor(roomId, agentId, sessionId);
      if (!cursor) throw new Error("not a member of this room");
      const from = cursor.last_read_seq;
      const rows = this.db
        .prepare(
          `SELECT ${messageCols(maxBytes)} FROM ${MESSAGE_FROM}
           WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
           ORDER BY g.seq ASC LIMIT ?`,
        )
        .all(roomId, from, agentId, limit) as RawMessage[];
      // Exact envelope reserve so the WHOLE response honors maxBytes, not
      // just the messages array. The floor never engages at the schema's
      // 1000-char minimum; it is the stub allowance boundByBytes can honor.
      const { messages, byteLimited } = this.boundByBytes(
        rows,
        previewChars,
        Math.max(STUB_ALLOWANCE, maxBytes - CATCH_UP_ENVELOPE),
        (r, pc) => this.rowToMessage(r, pc),
      );
      const lastSeq =
        messages.length > 0 ? messages[messages.length - 1].seq : from;
      if (lastSeq > from) {
        this.setCursor(roomId, agentId, sessionId, lastSeq);
      }
      return {
        messages,
        new_last_read_seq: lastSeq,
        remaining: this.unreadCount(roomId, lastSeq, agentId),
        advanced: lastSeq > from,
        ...(byteLimited ? { byte_limited: true } : {}),
      };
    });
    return tx.immediate();
  }

  /**
   * Cross-room mentions INBOX: unread messages directed at the agent (its
   * @mentions, or replies to its messages) across every room it is currently
   * present in; rooms it soft-left are muted. Oldest first (messages.id is a
   * global total order across rooms), each row tagged room_id/room_name.
   *
   * Strictly a PEEK: no read marker moves. An entry clears when its room is
   * actually read (catch_up / mark_read there). Baselines follow the CALLER's
   * cursor: with a sessionId, each room's private session cursor when one
   * exists (falling back to the identity marker), so the inbox never hides a
   * message the same session's catch_up would still deliver; identity-level
   * otherwise. The poller remains identity-level (it cannot know the nonce).
   *
   * Paging: rows come back oldest-first by messages.id (a global total order
   * across rooms); pass next_after_id back as afterId to page past `limit` or
   * a byte cut without waiting for rooms to be read. afterId is paging state
   * only; by_room counts stay marker-relative.
   *
   * by_room lists EVERY present room with any unread from others (most
   * directed first), reporting both `directed` and total `unread` (broadcasts
   * included): an empty inbox with nonzero unread means rooms have traffic to
   * sync, not silence. by_room shares the byte budget (capped to a third,
   * worst rooms dropped with by_room_truncated:true) so many chatty rooms
   * cannot bury the entries themselves. Rows and counts read one DEFERRED
   * snapshot.
   */
  myMentions(
    agentId: string,
    limit: number,
    previewChars?: number,
    maxBytes: number = DEFAULT_MAX_BYTES,
    sessionId: string | null = null,
    afterId = 0,
  ): {
    messages: MentionRow[];
    total_directed: number;
    next_after_id: number;
    by_room: { room_id: number; name: string; unread: number; directed: number }[];
    by_room_truncated?: boolean;
    byte_limited?: boolean;
  } {
    // '' never collides with a real session id, so one query shape serves
    // both shared and private cursors.
    const sessionKey = sessionId ?? "";
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT ${messageCols(maxBytes)}, g.id AS gid, g.room_id AS room_id, r.name AS room_name
           FROM ${MESSAGE_FROM}
           JOIN memberships mb ON mb.room_id = g.room_id
                AND mb.agent_id = ? AND mb.left_at IS NULL
           LEFT JOIN session_markers sm ON sm.room_id = g.room_id
                AND sm.agent_id = mb.agent_id AND sm.session_id = ?
           JOIN rooms r ON r.id = g.room_id
           WHERE g.seq > COALESCE(sm.last_read_seq, mb.last_read_seq)
             AND g.id > ? AND g.agent_id != ?
             AND ${directedAt("g")}
           ORDER BY g.id ASC LIMIT ?`,
        )
        .all(agentId, sessionKey, afterId, agentId, agentId, agentId, limit) as (RawMessage & {
        gid: number;
        room_id: number;
        room_name: string;
      })[];

      // Placeholder text order: the SUM(CASE directedAt) pair, the membership
      // join, the session-marker join key, then the author exclusion.
      const allRooms = this.db
        .prepare(
          `SELECT g.room_id AS room_id, r.name AS name, COUNT(*) AS unread,
                  SUM(CASE WHEN ${directedAt("g")} THEN 1 ELSE 0 END) AS directed
           FROM messages g
           JOIN memberships mb ON mb.room_id = g.room_id
                AND mb.agent_id = ? AND mb.left_at IS NULL
           LEFT JOIN session_markers sm ON sm.room_id = g.room_id
                AND sm.agent_id = mb.agent_id AND sm.session_id = ?
           JOIN rooms r ON r.id = g.room_id
           WHERE g.seq > COALESCE(sm.last_read_seq, mb.last_read_seq)
             AND g.agent_id != ?
           GROUP BY g.room_id, r.name
           ORDER BY g.room_id`,
        )
        .all(agentId, agentId, agentId, sessionKey, agentId) as {
        room_id: number;
        name: string;
        unread: number;
        directed: number;
      }[];
      const total_directed = allRooms.reduce((a, r) => a + r.directed, 0);

      // Cap by_room to a third of the budget, most directed rooms first, so
      // the response as a whole honors maxBytes.
      const byRoom = [...allRooms].sort(
        (a, b) =>
          b.directed - a.directed || b.unread - a.unread || a.room_id - b.room_id,
      );
      let by_room_truncated = false;
      const roomBudget = Math.floor(maxBytes / 3);
      while (byRoom.length > 1 && JSON.stringify(byRoom).length > roomBudget) {
        byRoom.pop();
        by_room_truncated = true;
      }
      // A single long-named room can still overflow a small budget: halve
      // the display name until the MEASURED serialized size fits (a fixed
      // code-unit cut under-counts JSON escaping, so a control-heavy name
      // slipped past it); room_id remains the stable key.
      if (byRoom.length === 1 && JSON.stringify(byRoom).length > roomBudget) {
        let entry = { ...byRoom[0] };
        while (
          JSON.stringify([entry]).length > roomBudget &&
          entry.name.length > 0
        ) {
          entry = {
            ...entry,
            name: safeCut(entry.name, Math.floor(entry.name.length / 2)),
          };
        }
        byRoom[0] = entry;
        by_room_truncated = true;
      }

      // Joint budget with an exact envelope: messages get what by_room and
      // the fixed response fields leave, floored at the stub allowance
      // (which boundByBytes can always honor; at the schema's 1000-char
      // minimum the floor still cannot push the total past maxBytes).
      const msgBudget = Math.max(
        STUB_ALLOWANCE,
        maxBytes - JSON.stringify(byRoom).length - MENTIONS_ENVELOPE,
      );
      const { messages, byteLimited } = this.boundByBytes(
        rows,
        previewChars,
        msgBudget,
        (r, pc) => {
          const extra = r as RawMessage & { room_id: number; room_name: string };
          return {
            ...this.rowToMessage(r, pc),
            room_id: extra.room_id,
            room_name: extra.room_name,
          };
        },
      );
      const next_after_id =
        messages.length > 0 ? rows[messages.length - 1].gid : afterId;
      return {
        messages,
        total_directed,
        next_after_id,
        by_room: byRoom,
        ...(by_room_truncated ? { by_room_truncated: true } : {}),
        ...(byteLimited ? { byte_limited: true } : {}),
      };
    });
    return tx.deferred();
  }

  /**
   * Read-only browse (never advances the read marker). No beforeSeq => latest
   * `limit`; else older than beforeSeq.
   */
  readHistory(
    roomId: number,
    limit: number,
    beforeSeq?: number,
    previewChars?: number,
    maxBytes: number = DEFAULT_MAX_BYTES,
  ): {
    messages: MessageRow[];
    oldest_seq: number | null;
    has_more: boolean;
    byte_limited?: boolean;
  } {
    const conds = ["g.room_id = ?"];
    const params: (number | string)[] = [roomId];
    if (beforeSeq !== undefined) {
      conds.push("g.seq < ?");
      params.push(beforeSeq);
    }
    const where = conds.join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT ${messageCols(maxBytes)} FROM ${MESSAGE_FROM}
         WHERE ${where} ORDER BY g.seq DESC LIMIT ?`,
      )
      .all(...params, limit) as RawMessage[];
    // Fetched newest-first; byte-bound in that order (keeping the page nearest
    // the requested position), then present oldest-first for natural reading.
    const { messages: bounded, byteLimited } = this.boundByBytes(
      rows,
      previewChars,
      Math.max(STUB_ALLOWANCE, maxBytes - HISTORY_ENVELOPE),
      (r, pc) => this.rowToMessage(r, pc),
    );
    const messages = bounded.reverse();
    const oldest = messages.length > 0 ? messages[0].seq : null;

    // has_more: are there older messages?
    let has_more = false;
    if (oldest !== null) {
      has_more = !!this.db
        .prepare(
          "SELECT 1 FROM messages WHERE room_id = ? AND seq < ? LIMIT 1",
        )
        .get(roomId, oldest);
    }
    return {
      messages,
      oldest_seq: oldest,
      has_more,
      ...(byteLimited ? { byte_limited: true } : {}),
    };
  }

  /**
   * Set the read marker without returning messages. `seq` omitted jumps to the
   * latest message (skip backlog); a value sets the marker to that point,
   * clamped to [0, latest]. A lower value re-exposes those messages to catch_up.
   * Returns the previous and new marker plus the room's latest seq.
   */
  markRead(
    roomId: number,
    agentId: string,
    seq?: number,
    sessionId: string | null = null,
  ): { previous: number; new: number; latest: number } {
    const tx = this.db.transaction(() => {
      const cursor = this.getCursor(roomId, agentId, sessionId);
      if (!cursor) throw new Error("not a member of this room");
      const { latest } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { latest: number };
      const target =
        seq === undefined ? latest : Math.max(0, Math.min(seq, latest));
      this.setCursor(roomId, agentId, sessionId, target);
      return { previous: cursor.last_read_seq, new: target, latest };
    });
    return tx.immediate();
  }

  /**
   * Full-text search of message bodies in a room, best matches first.
   * Byte-bounded like the other bulk reads; trimming drops the WORST matches
   * (rank order), and byte_limited reports that it happened. `offset` skips
   * that many best matches, making pages BEHIND a byte cut or the limit
   * reachable (rank order is stable for a given query, so offset paging is
   * coherent); next_offset points at the first match not returned.
   */
  searchMessages(
    roomId: number,
    query: string,
    limit: number,
    offset = 0,
  ): { matches: MessageRow[]; byte_limited?: boolean; next_offset?: number } {
    const off = Math.max(0, Math.floor(offset));
    const rows = this.db
      .prepare(
        `SELECT ${messageCols(DEFAULT_MAX_BYTES)}
         FROM messages_fts f
         JOIN messages g ON g.id = f.rowid
         LEFT JOIN agents a ON a.id = g.agent_id
         LEFT JOIN messages p ON p.room_id = g.room_id AND p.seq = g.reply_to_seq
         WHERE f.body MATCH ? AND g.room_id = ?
         ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(query, roomId, limit, off) as RawMessage[];
    const { messages, byteLimited } = this.boundByBytes(
      rows,
      undefined,
      DEFAULT_MAX_BYTES - SEARCH_ENVELOPE,
      (r, pc) => this.rowToMessage(r, pc),
    );
    // More matches may exist when the byte bound cut the page OR the page
    // filled to `limit` (the next offset probes for the rest).
    const more = byteLimited || rows.length === limit;
    return {
      matches: messages,
      ...(byteLimited ? { byte_limited: true } : {}),
      ...(more && messages.length > 0 ? { next_offset: off + messages.length } : {}),
    };
  }

  /**
   * Trim a room to its newest `keepLast` messages. Only the oldest are removed,
   * so MAX(seq) is unchanged and future seq numbers stay monotonic.
   */
  pruneMessages(
    roomId: number,
    keepLast: number,
    force: boolean,
  ): {
    deleted: number;
    kept: number;
    refused?: boolean;
    would_delete_unread?: number;
    min_read_seq?: number;
  } {
    // Keep at least the newest message: keepLast=0 would hit OFFSET -1
    // (clamped to 0 by SQLite, silently keeping one row anyway), and deleting
    // ALL rows would reset MAX(seq), breaking the monotonic-seq invariant.
    keepLast = Math.max(1, Math.floor(keepLast));
    const tx = this.db.transaction(() => {
      // A deleted room must not report a successful no-op prune.
      this.requireRoom(roomId);
      // Reap EXPIRED private session cursors first (same 7-day window as the
      // GC in joinRoom): that GC only runs on private joins, so a room whose
      // sessions all vanished otherwise kept a dead marker at some ancient
      // seq blocking every future unforced prune.
      this.db
        .prepare(
          "DELETE FROM session_markers WHERE room_id = ? AND updated_at < datetime('now', ?)",
        )
        .run(roomId, SESSION_GC_AGE);
      const { c: total } = this.db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?")
        .get(roomId) as { c: number };
      if (total <= keepLast) return { deleted: 0, kept: total };
      const cutoff = this.db
        .prepare(
          "SELECT seq FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
        )
        .get(roomId, keepLast - 1) as { seq: number };
      if (!force) {
        // Refuse to delete a message that ANY member who did NOT author it has
        // not yet read. Members that left are included: soft leave preserves the
        // read position for resume, so their unread is real until they return.
        // Private session cursors count too: the identity marker is the MAX
        // across sessions, so a lagging twin's unread is invisible to it and
        // only the session_markers row knows. (The author has implicitly
        // "seen" its own message, matching catch_up's self-exclusion.) Pass
        // force=true to prune past this.
        const { u } = this.db
          .prepare(
            `SELECT COUNT(*) AS u FROM messages g
             WHERE g.room_id = ? AND g.seq < ?
               AND (EXISTS (
                 SELECT 1 FROM memberships mm
                 WHERE mm.room_id = g.room_id
                   AND mm.last_read_seq < g.seq AND mm.agent_id != g.agent_id
               ) OR EXISTS (
                 SELECT 1 FROM session_markers sm
                 WHERE sm.room_id = g.room_id
                   AND sm.last_read_seq < g.seq AND sm.agent_id != g.agent_id
               ))`,
          )
          .get(roomId, cutoff.seq) as { u: number };
        if (u > 0) {
          // min over markers that actually BLOCK the prune (same predicate
          // as the refusal count): a min over all markers pointed callers at
          // harmless laggards, most commonly the doomed messages' own author,
          // whom the refusal itself exempts.
          const { m } = this.db
            .prepare(
              `SELECT MIN(m) AS m FROM (
                 SELECT mm.last_read_seq AS m FROM memberships mm
                  WHERE mm.room_id = ? AND EXISTS (
                    SELECT 1 FROM messages g WHERE g.room_id = mm.room_id
                      AND g.seq < ? AND g.seq > mm.last_read_seq
                      AND g.agent_id != mm.agent_id)
                 UNION ALL
                 SELECT sm.last_read_seq FROM session_markers sm
                  WHERE sm.room_id = ? AND EXISTS (
                    SELECT 1 FROM messages g WHERE g.room_id = sm.room_id
                      AND g.seq < ? AND g.seq > sm.last_read_seq
                      AND g.agent_id != sm.agent_id)
               )`,
            )
            .get(roomId, cutoff.seq, roomId, cutoff.seq) as {
            m: number | null;
          };
          return {
            deleted: 0,
            kept: total,
            refused: true,
            would_delete_unread: u,
            min_read_seq: m ?? 0,
          };
        }
      }
      const info = this.db
        .prepare("DELETE FROM messages WHERE room_id = ? AND seq < ?")
        .run(roomId, cutoff.seq);
      return { deleted: info.changes, kept: total - info.changes };
    });
    // IMMEDIATE: this reads (COUNT/cutoff) before writing; a deferred tx would
    // take a read snapshot that a concurrent WAL writer could invalidate, giving
    // SQLITE_BUSY_SNAPSHOT on the later DELETE.
    return tx.immediate();
  }

  /** Hard-delete a room and all of its messages and memberships. */
  deleteRoom(roomId: number): { messages: number; members: number } {
    const tx = this.db.transaction(() => {
      const { c: messages } = this.db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?")
        .get(roomId) as { c: number };
      const { c: members } = this.db
        .prepare("SELECT COUNT(*) AS c FROM memberships WHERE room_id = ?")
        .get(roomId) as { c: number };
      // Messages first so the FTS delete-trigger fires before the room row goes,
      // and so foreign keys to rooms(id) are satisfied.
      this.db.prepare("DELETE FROM messages WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM memberships WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM session_markers WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM claims WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
      return { messages, members };
    });
    // IMMEDIATE for the same read-then-write snapshot reason as pruneMessages.
    return tx.immediate();
  }

  // --- advisory claims ----------------------------------------------------

  /**
   * Claim exclusive (advisory) ownership of a named resource. Atomic single
   * winner: the read-check and upsert run in one IMMEDIATE transaction, so two
   * simultaneous claimants cannot both be granted (unlike two "I claim X" chat
   * posts, which can cross). Re-claiming your own key renews the TTL; an
   * expired claim is grantable to anyone. Ownership is per agent_id: two
   * sessions sharing an identity share its claims.
   */
  claimResource(
    roomId: number,
    key: string,
    agentId: string,
    ttlSeconds: number,
    note: string | null,
  ):
    | { granted: true; key: string; expires_at: string; renewed: boolean }
    | {
        granted: false;
        key: string;
        holder: string;
        note: string | null;
        expires_at: string;
        expires_in_seconds: number;
      } {
    const tx = this.db.transaction(() => {
      // Same deleted-room window as postMessage: fail cleanly, not with a
      // raw FK error from the claims INSERT.
      this.requireRoom(roomId);
      const row = this.db
        .prepare(
          `SELECT agent_id, note, expires_at,
                  (strftime('%s', expires_at) - strftime('%s', 'now')) AS remaining
           FROM claims WHERE room_id = ? AND key = ?`,
        )
        .get(roomId, key) as
        | {
            agent_id: string;
            note: string | null;
            expires_at: string;
            remaining: number;
          }
        | undefined;
      if (row && row.remaining > 0 && row.agent_id !== agentId) {
        return {
          granted: false as const,
          key,
          holder: row.agent_id,
          note: row.note,
          expires_at: row.expires_at,
          expires_in_seconds: row.remaining,
        };
      }
      this.db
        .prepare(
          `INSERT INTO claims (room_id, key, agent_id, note, expires_at)
           VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' seconds'))
           ON CONFLICT(room_id, key) DO UPDATE SET
             agent_id = excluded.agent_id, note = excluded.note,
             expires_at = excluded.expires_at, updated_at = datetime('now')`,
        )
        .run(roomId, key, agentId, note, ttlSeconds);
      const { expires_at } = this.db
        .prepare("SELECT expires_at FROM claims WHERE room_id = ? AND key = ?")
        .get(roomId, key) as { expires_at: string };
      return {
        granted: true as const,
        key,
        expires_at,
        renewed: row !== undefined && row.agent_id === agentId,
      };
    });
    return tx.immediate();
  }

  /** Release your own claim. Expired claims can be released by anyone. */
  releaseClaim(
    roomId: number,
    key: string,
    agentId: string,
  ):
    | { released: true; key: string }
    | { released: false; key: string; reason: string } {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT agent_id,
                  (strftime('%s', expires_at) - strftime('%s', 'now')) AS remaining
           FROM claims WHERE room_id = ? AND key = ?`,
        )
        .get(roomId, key) as
        | { agent_id: string; remaining: number }
        | undefined;
      if (!row) return { released: false as const, key, reason: "no such claim" };
      if (row.agent_id !== agentId && row.remaining > 0) {
        return {
          released: false as const,
          key,
          reason: `held by ${row.agent_id} for another ${row.remaining}s; expiry frees it`,
        };
      }
      this.db
        .prepare("DELETE FROM claims WHERE room_id = ? AND key = ?")
        .run(roomId, key);
      return { released: true as const, key };
    });
    return tx.immediate();
  }

  /** Active (unexpired) claims in a room, at most `limit` (total rides along);
   *  notes are cut to listing previews. Expired rows are pruned in passing. */
  listClaims(
    roomId: number,
    limit = 200,
  ): {
    claims: {
      key: string;
      holder: string;
      note: string | null;
      note_truncated?: boolean;
      expires_at: string;
      expires_in_seconds: number;
    }[];
    total: number;
  } {
    const PREVIEW = 300;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM claims WHERE room_id = ? AND expires_at <= datetime('now')",
        )
        .run(roomId);
      const rows = this.db
        .prepare(
          `SELECT key, agent_id AS holder,
                  substr(note, 1, ${PREVIEW}) AS note,
                  CASE WHEN length(note) > ${PREVIEW} THEN 1 ELSE 0 END AS note_cut,
                  expires_at,
                  (strftime('%s', expires_at) - strftime('%s', 'now')) AS expires_in_seconds
           FROM claims WHERE room_id = ? ORDER BY key LIMIT ?`,
        )
        .all(roomId, Math.max(1, Math.floor(limit))) as {
        key: string;
        holder: string;
        note: string | null;
        note_cut: number;
        expires_at: string;
        expires_in_seconds: number;
      }[];
      const { c: total } = this.db
        .prepare("SELECT COUNT(*) AS c FROM claims WHERE room_id = ?")
        .get(roomId) as { c: number };
      const claims = rows.map((r) => {
        const { note_cut, ...rest } = r;
        return { ...rest, ...(note_cut ? { note_truncated: true } : {}) };
      });
      return { claims, total };
    });
    return tx.immediate();
  }

  close(): void {
    this.db.close();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** One-line, length-capped preview of a referenced message body. */
function makePreview(s: string | null): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? safeCut(flat, 100) + "..." : flat;
}
