import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertWellFormedUtf16, assertWellFormedJsonValue } from "./unicode.js";

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
/** Application safety cap. SQLite's ~1 GB theoretical ceiling is not a safe
 * API limit: JSON parsing, validation, binding, WAL, and FTS can hold several
 * copies of one body at once. */
export const MAX_MESSAGE_BODY_BYTES = 10_000_000;
/** Crossed-message previews ride inside a post response rather than a paged
 * read, so keep each body small and the aggregate response separately capped. */
export const MAX_CROSSED_PREVIEW_CHARS = 2_000;
/** Public MCP/store caps used to keep direct callers from bypassing bounded
 * reads with values the tool schemas would reject. */
const MAX_BULK_RESULT_CHARS = 400_000;
const MAX_CATCH_UP_ROWS = 500;
const MAX_GET_MESSAGE_CHARS = 400_000;
/** Caller-supplied post idempotency keys are opaque, room/author scoped, and
 * intentionally small enough to keep the sparse unique index cheap. */
export const MAX_CLIENT_MESSAGE_ID_CHARS = 200;

/** Above this body length the store's json well-formedness re-validation is
 *  skipped: parsing a ~GB body into memory to walk it would defeat the
 *  memory-bounded read design, and such a caller owns validation (the MCP
 *  handler validates pre-serialization, independent of size). */
const JSON_VALIDATE_MAX_CHARS = 1_000_000;

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
const CATCH_UP_SUMMARY_ENVELOPE =
  JSON.stringify({
    messages: [],
    new_last_read_seq: WIDE,
    remaining: WIDE,
    advanced: false,
    byte_limited: true,
    rooms_with_unread: [],
    rooms_with_unread_truncated: true,
  }).length - 2;
const PRIORITY_CATCH_UP_ENVELOPE =
  JSON.stringify({
    messages: [],
    new_last_read_seq: WIDE,
    remaining: WIDE,
    advanced: false,
    byte_limited: true,
    lossy: false,
    priority_only: false,
    skipped_count: WIDE,
    qualifying_remaining: WIDE,
    cutoff_seq: WIDE,
  }).length - 2;
const PRIORITY_CATCH_UP_SUMMARY_ENVELOPE =
  JSON.stringify({
    messages: [],
    new_last_read_seq: WIDE,
    remaining: WIDE,
    advanced: false,
    byte_limited: true,
    lossy: false,
    priority_only: false,
    skipped_count: WIDE,
    qualifying_remaining: WIDE,
    cutoff_seq: WIDE,
    rooms_with_unread: [],
    rooms_with_unread_truncated: true,
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

/** Smallest budget that can safely carry catch_up's fixed fields plus one
 *  shrunk message stub. The MCP wrapper subtracts its own routing/wait
 *  metadata before entering the advancing transaction; if less than this
 *  remains it must reject the call rather than advance past an undeliverable
 *  page. */
export const MIN_CATCH_UP_RESULT_BUDGET =
  Math.max(CATCH_UP_ENVELOPE, PRIORITY_CATCH_UP_ENVELOPE) + STUB_ALLOWANCE;

/** Age (SQLite datetime modifier) past which a silent private session cursor
 *  is dead: reaped by the join-time GC and by prune (a dead cursor must not
 *  block retention forever). Live sessions refresh on every join/touch. */
const SESSION_GC_AGE = "-7 days";

/** Serialized-size budget for a metadata listing's row ARRAY, leaving room for
 *  the response envelope (total, truncated/size_trimmed flags) AND the keyset
 *  paging cursor, so the WHOLE response stays under DEFAULT_MAX_BYTES. The
 *  reserve covers a worst-case cursor: list_claims' next_key is a claim key up
 *  to 500 chars, which JSON-escaping can inflate ~6x on control-heavy input. */
const LIST_ROW_BUDGET = DEFAULT_MAX_BYTES - 4000;

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

/**
 * Slice s to its first `n` CODEPOINTS (characters), the unit get_message and the
 * reported `length` field use. preview_chars is a codepoint budget, so cutting
 * in codepoints keeps preview length and reported length in the same unit (an
 * emoji counts once, not twice). Iterating by codepoint never splits a surrogate
 * pair, and it stops after n codepoints, so cost is O(n) not O(|s|) -- safe on a
 * body up to the fetch cap.
 */
function cutToCodepoints(s: string, n: number): string {
  if (n <= 0) return "";
  let count = 0;
  let units = 0;
  for (const ch of s) {
    if (count >= n) break;
    units += ch.length;
    count++;
  }
  return units >= s.length ? s : s.slice(0, units);
}

/**
 * Reject text SQLite cannot round-trip losslessly, at WRITE time, so a read
 * never silently loses data:
 *  - U+0000 (NUL): SQLite's string functions are C NUL-terminated, so
 *    substr()/length() stop at the first NUL. A body "abc\0def" reads back as
 *    "abc" with no truncation flag, and catch_up advances the marker past it,
 *    so "def" is unrecoverable. Every capped reader has this hazard.
 *  - lone surrogate: not valid Unicode; SQLite renormalizes it to the
 *    replacement character, so the stored value's length diverges from the
 *    JS length we stamped, corrupting truncation/paging math.
 * Failing loud at write is the only safe option: stripping mutates the
 * caller's content, and there is no faithful storage for these.
 */
function assertStorable(value: string | null, field: string): void {
  if (value === null) return;
  if (value.indexOf("\u0000") !== -1) {
    throw new Error(
      `${field} contains a NUL character (U+0000), which SQLite cannot store without silently truncating; remove it`,
    );
  }
  assertWellFormedUtf16(value, field);
}

/**
 * Enforce the MCP layer's metadata length caps in the store too (character =
 * UTF-16 units, the same unit zod's .max counts): the listing byte budgets
 * assume them. fitRows always keeps at least one row (paging must progress)
 * and LIST_ROW_BUDGET's cursor reserve assumes a claim key <= 500 chars, so a
 * direct store caller (web viewer, tests) writing a 120k-char key shipped an
 * over-budget listing no MCP input could ever produce. Message bodies use the
 * separate MAX_MESSAGE_BODY_BYTES safety cap and are shrunk at read time.
 */
function assertMaxLen(value: string | null, field: string, max: number): void {
  if (value !== null && value.length > max) {
    throw new Error(`${field} exceeds ${max} characters`);
  }
}

/**
 * Trim a metadata listing to a serialized-size budget, dropping WHOLE rows off
 * the end (still reachable via offset paging). The per-row preview caps bound
 * one row, but control-heavy metadata serializes ~6x, so 200 rows could still
 * blow past any client output cap; this caps the response itself. Keeps at
 * least one row so a page is never empty.
 *
 * Linear: each row is serialized ONCE and its size accumulated (brackets +
 * per-element comma charged like boundByBytes), instead of re-serializing the
 * whole shrinking array on every pop -- the quadratic version took ~1.3s to
 * trim 1000 control-heavy rooms.
 */
function fitRows<T>(rows: T[], budget: number): { rows: T[]; sizeTrimmed: boolean } {
  const kept: T[] = [];
  let used = 2; // the array's own brackets
  let sizeTrimmed = false;
  for (const r of rows) {
    const size = JSON.stringify(r).length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && used + size > budget) {
      sizeTrimmed = true;
      break; // rows are appended in order, so the rest are droppable/pageable
    }
    kept.push(r);
    used += size;
  }
  return { rows: kept, sizeTrimmed };
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
  /** True ONLY while the agent has an open blocking catch_up wait in this
   *  room (see RecipientStatus.watching). */
  watching: boolean;
};

export type RecipientStatus = {
  id: string;
  /** unknown = never joined, left = joined then left, idle = present but not
   *  seen recently, active = present and seen within the liveness window. */
  status: "active" | "idle" | "left" | "unknown";
  present: boolean;
  idle_seconds: number | null;
  last_read_seq: number | null;
  /** Room messages already past this recipient's read marker (0 = fully
   *  caught up). Computed at call time; post_message samples it after its new
   *  row is inserted, inside that same transaction. null for unknown. */
  marker_behind: number | null;
  /** True ONLY while the recipient has an open blocking catch_up wait in
   *  this room (an in-turn wait lease): the model is mid-turn, awaiting the
   *  call's return, so a message now is delivered into a live turn. Never
   *  produced by detached pollers. */
  watching: boolean;
};

export type PendingCursor = {
  oldest_unix: number;
  agent_id: string;
  room_id: number;
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
  /** Author-declared durable checkpoint for lossy priority catch-up. Omitted
   *  when false to keep ordinary pages compact. */
  priority?: true;
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
  priority: number;
  body: string;
  /** Exact UTF-16 length of the FULL body (the fetched body may be capped).
   *  NULL only for rows written by an old build during a mixed-version window
   *  before this process's startup backfill ran; fall back to body.length. */
  body_len: number | null;
  /** Full body length in CODEPOINTS (length(body)); the reported `length`
   *  field's unit, consistent with get_message. Present on every fetched row.
   *  Absent (undefined) only on synthetic rows the code builds in-memory. */
  body_cp?: number;
  mentions: string | null;
  reply_to_seq: number | null;
  reply_from: string | null;
  reply_preview: string | null;
  created_local: string;
  created_unix: number;
  supersedes_seq: number | null;
  superseded_by: number | null;
};

/** Full body length in CODEPOINTS, the unit the reported `length` field uses
 *  everywhere. Prefers the fetched-row codepoint count; for a synthetic row
 *  built in code (no body_cp), the number of codepoints in the body in hand. */
function codepointLen(r: RawMessage): number {
  if (r.body_cp !== undefined) return r.body_cp;
  let n = 0;
  for (const _ of r.body) n++;
  return n;
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
  // body_cp = length(g.body) is the full CODEPOINT count (a memory-safe
  // scalar, never the body itself). The reported `length` field uses it so a
  // message's length is the SAME character count everywhere -- get_message
  // (which pages in codepoints) and the bulk reads used to disagree by the
  // astral factor (an emoji is 1 codepoint but 2 UTF-16 units). NUL is
  // rejected/sanitized, so length() is exact.
  return `g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
          g.format, g.priority, substr(g.body, 1, ${cap}) AS body, g.body_len,
          length(g.body) AS body_cp,
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
      // Owner-only: chat content is not for other local users. Tighten only
      // what is OURS: the database file and its WAL sidecars, and a directory
      // ONLY IF WE CREATED IT. An earlier version chmod'd dirname(path)
      // unconditionally, which changed a pre-existing, caller-owned parent
      // (e.g. a shared project dir, or /tmp for a custom db path) from 0755 to
      // 0700, affecting unrelated files and other users. mkdirSync(recursive)
      // returns the FIRST directory it created, or undefined if the path
      // already existed; chmod only that. Best-effort: permissions are a
      // hardening layer, not a startup gate (and a no-op concept on Windows).
      const created = mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        if (created) chmodSync(created, 0o700);
        for (const p of [path, `${path}-wal`, `${path}-shm`]) {
          if (existsSync(p)) chmodSync(p, 0o600);
        }
      } catch {}
    }
    this.db = new Database(path);
    try {
      if (path !== ":memory:") {
        try {
          chmodSync(path, 0o600);
        } catch {}
      }
    // Converting a legacy rollback-journal file to WAL needs an exclusive
    // lock, and SQLite can return SQLITE_BUSY here WITHOUT consulting the
    // busy handler (better-sqlite3's default 5s timeout does not cover this
    // path), so two fresh processes racing to convert the same legacy file
    // intermittently crashed on startup (reproduced ~1 in 24 synchronized
    // opens). Retry with a short synchronous backoff: the loser of the race
    // finds the file already in WAL and succeeds immediately. A no-op on
    // already-WAL files, i.e. every startup after the first.
    for (let attempt = 1; ; attempt++) {
      try {
        this.db.pragma("journal_mode = WAL");
        break;
      } catch (e) {
        // Prefix match: better-sqlite3 surfaces EXTENDED result codes (e.g.
        // SQLITE_BUSY_RECOVERY when another connection is mid-WAL-recovery,
        // plausible in exactly this conversion race), and all of them mean
        // the same thing here: someone else holds the file, try again.
        const code = (e as { code?: string }).code ?? "";
        if (attempt >= 20 || !code.startsWith("SQLITE_BUSY")) {
          throw e;
        }
        // Synchronous sleep (constructor context); ~4.75s worst-case total.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * attempt);
      }
    }
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    // One process performs versioned data maintenance at a time. Without an
    // IMMEDIATE transaction, concurrent MCP startups could all observe the
    // old version and then repeat full-corpus backfills/FTS rebuilds.
      this.db.transaction(() => this.migrate()).immediate();
    } catch (error) {
      // A constructor that throws has no caller-visible instance on which to
      // call close(); cover pragma/setup failures as well as migration errors.
      try {
        this.db.close();
      } catch {}
      throw error;
    }
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
        priority     INTEGER NOT NULL DEFAULT 0,
        body         TEXT NOT NULL,
        mentions     TEXT,
        reply_to_seq INTEGER,
        client_message_id TEXT,
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
    this.ensureColumn("messages", "priority", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "reply_to_seq", "INTEGER");
    this.ensureColumn("messages", "mentions", "TEXT");
    this.ensureColumn("messages", "supersedes_seq", "INTEGER");
    this.ensureColumn("messages", "reply_to_agent", "TEXT");
    this.ensureColumn("messages", "body_len", "INTEGER");
    this.ensureColumn("messages", "client_message_id", "TEXT");
    // DB-level enforcement for MIXED-VERSION windows: a still-running old
    // build inserts without these columns, and if the reply's parent is
    // pruned before any new-build process restarts, the startup backfill
    // below can never recover the author -- the reply is silently
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

      -- Routine current-build inserts provide body_len and occupy no entry.
      -- This makes the recurring mixed-version repair an empty-index probe on a
      -- healthy file instead of a corpus scan.
      CREATE INDEX IF NOT EXISTS idx_messages_body_len_missing
        ON messages(id) WHERE body_len IS NULL;

      -- Reject an embedded NUL at the DATABASE level: SQLite's substr()/length()
      -- stop at U+0000, so a NUL body reads back truncated with the marker
      -- advancing past the lost tail. New builds already reject it in JS
      -- (assertStorable), but an OLD build writing during a rolling upgrade
      -- would not -- this trigger fires for its inserts too and aborts them,
      -- closing that window. (A SQL trigger cannot SANITIZE the value: replace()
      -- is itself NUL-terminated. Existing NUL rows are healed in JS below.)
      CREATE TRIGGER IF NOT EXISTS messages_reject_nul BEFORE INSERT ON messages
      WHEN instr(NEW.body, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'message body contains a NUL character (U+0000), which SQLite cannot store without silently truncating');
      END;

      -- Metadata listings also use SQLite substr()/length(), so old/direct
      -- writers must not be able to introduce a new silently truncated value.
      -- UPDATE guards are per-column: a v3 heal can repair two malformed room
      -- fields one at a time without the other field blocking it.
      CREATE TRIGGER IF NOT EXISTS rooms_reject_nul_insert BEFORE INSERT ON rooms
      WHEN instr(NEW.description, char(0)) > 0 OR instr(NEW.pinned, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'room metadata contains a NUL character (U+0000)');
      END;
      CREATE TRIGGER IF NOT EXISTS rooms_description_reject_nul_update
      BEFORE UPDATE OF description ON rooms
      WHEN instr(NEW.description, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'room description contains a NUL character (U+0000)');
      END;
      CREATE TRIGGER IF NOT EXISTS rooms_pinned_reject_nul_update
      BEFORE UPDATE OF pinned ON rooms
      WHEN instr(NEW.pinned, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'room pinned intro contains a NUL character (U+0000)');
      END;
      CREATE TRIGGER IF NOT EXISTS agents_reject_nul_insert BEFORE INSERT ON agents
      WHEN instr(NEW.description, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'agent description contains a NUL character (U+0000)');
      END;
      CREATE TRIGGER IF NOT EXISTS agents_description_reject_nul_update
      BEFORE UPDATE OF description ON agents
      WHEN instr(NEW.description, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'agent description contains a NUL character (U+0000)');
      END;
    `);
    // The former messages_body_len_ai trigger stamped SQLite length(NEW.body),
    // which under-counts astral text versus the web viewer's UTF-16 body_len.
    // Keep a harmless blocker UNDER THE LEGACY NAME so a restarted old build's
    // CREATE TRIGGER IF NOT EXISTS cannot resurrect that stamper. Inspect the
    // stored definition first: unconditional DROP/CREATE caused schema churn,
    // WAL writes, and an exclusive schema lock on every healthy MCP startup.
    const bodyLenBlockerMarker = "agent-chat-body-len-blocker-v3";
    const existingBodyLenTrigger = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_body_len_ai'",
      )
      .get() as { sql: string | null } | undefined;
    if (!existingBodyLenTrigger?.sql?.includes(bodyLenBlockerMarker)) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS messages_body_len_ai;
        CREATE TRIGGER messages_body_len_ai AFTER INSERT ON messages
        WHEN NEW.body_len IS NULL BEGIN
          SELECT '${bodyLenBlockerMarker}';
        END;
      `);
    }
    const SCHEMA_VERSION = 3;
    const currentVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;
    // Keep version gates narrow. Advancing v2 -> v3 for bounded metadata repair
    // must not repeat the older full-message maintenance pass.
    const needsV2Maintenance = currentVersion < 2;
    const needsMetadataV3 = currentVersion < 3;
    const needsBodyNulHeal = currentVersion < 1;

    // Backfill the denormalized reply author AFTER the old-writer trigger above
    // exists, closing a rolling-upgrade gap: with the backfill running FIRST, an
    // old build inserting a reply in the window between the two steps hit
    // neither (backfill already passed, trigger not yet created), and if the
    // parent was pruned before any restart the author was unrecoverable and
    // my_mentions missed the reply forever. Now a reply inserted before the
    // trigger is caught here; one inserted after is stamped by the trigger.
    // Rows whose parent is already gone stay NULL (unrecoverable) and are
    // re-examined harmlessly.
    if (needsV2Maintenance) {
      this.db.exec(`
        UPDATE messages SET reply_to_agent =
          (SELECT p.agent_id FROM messages p
            WHERE p.room_id = messages.room_id AND p.seq = messages.reply_to_seq)
        WHERE reply_to_seq IS NOT NULL AND reply_to_agent IS NULL
      `);
    }
    // The message-body NUL scan below runs ONLY until this file is marked
    // migrated via PRAGMA user_version. It reads EVERY body to evaluate
    // instr(body, char(0)) -- costly on a large corpus (a 1 GB body is read
    // every startup) and pointless once done: the reject trigger blocks any new
    // NUL row, so a migrated file cannot acquire one. The gate is set at the END
    // of migrate(), so a crash mid-scan just re-runs. Everything else
    // Schema/index/trigger creation and the sparse body_len repair stay
    // recurring; each later migration has its own narrowly-scoped gate.
    // Heal existing rows that already hold a NUL (written by a pre-guard build):
    // a plain SELECT is NOT NUL-terminated, so the full body is recoverable;
    // replace each NUL with U+FFFD so substr()/length() readers see it whole,
    // and clear body_len so the backfill below re-stamps the corrected length.
    // Cursored ONE ROW AT A TIME (not .all(), which materialized every
    // malformed body at once and could OOM the process at startup on many/large
    // NUL bodies), via a regex replace (not split/join, which builds a giant
    // array on an all-NUL body). instr() detects them; healing a row clears its
    // NUL, so the predicate never revisits it and the id cursor moves strictly
    // forward.
    let healedMessageBody = false;
    if (needsBodyNulHeal) {
      const nextNul = this.db.prepare(
        `SELECT id, length(CAST(body AS BLOB)) AS bytes
         FROM messages
         WHERE instr(body, char(0)) > 0 AND id > ?
         ORDER BY id LIMIT 1`,
      );
      const getBody = this.db.prepare("SELECT body FROM messages WHERE id = ?");
      const fix = this.db.prepare(
        "UPDATE messages SET body = ?, body_len = NULL WHERE id = ?",
      );
      let cursor = 0;
      for (;;) {
        const row = nextNul.get(cursor) as
          | { id: number; bytes: number }
          | undefined;
        if (!row) break;
        if (row.bytes > MAX_MESSAGE_BODY_BYTES) {
          throw new Error(
            `legacy message ${row.id} is ${row.bytes} bytes and contains NUL; ` +
              `refusing to load it above the ${MAX_MESSAGE_BODY_BYTES}-byte safety limit`,
          );
        }
        const { body } = getBody.get(row.id) as { body: string };
        fix.run(body.replace(/\u0000/g, "\ufffd"), row.id);
        healedMessageBody = true;
        cursor = row.id;
      }
    }
    // Backfill body_len (the exact UTF-16 length the WEB viewer reports) for
    // rows that predate the column. It must be measured in JS, so we LOAD the
    // body -- but only for rows small enough to be safe (length() is a cheap
    // codepoint gate, an upper bound on UTF-16 units is 2x that, so <=
    // BACKFILL_MAX_CHARS codepoints is at most ~2x that many UTF-16 units held
    // at once). Giant legacy rows are stamped with the memory-safe codepoint
    // count via SQL (a low-but-nonzero bound; the web viewer's COALESCE still
    // shows a length and its total>shown guard tolerates the codepoint skew).
    // Cursored by id so the whole sweep is one table pass, one body resident.
    // Always repair the sparse set of mixed-version NULL rows. On a healthy
    // file idx_messages_body_len_missing is empty, so this is O(1); it avoids a
    // full startup scan while keeping the documented next-reopen guarantee.
    const BACKFILL_MAX_CHARS = 1_000_000;
    this.db
      .prepare(
        `UPDATE messages INDEXED BY idx_messages_body_len_missing
         SET body_len = length(body)
         WHERE body_len IS NULL AND length(body) > ?`,
      )
      .run(BACKFILL_MAX_CHARS);
    const nextMissingBodyLen = this.db.prepare(
      `SELECT id, body FROM messages INDEXED BY idx_messages_body_len_missing
       WHERE body_len IS NULL AND id > ? ORDER BY id LIMIT 1`,
    );
    const setBodyLen = this.db.prepare(
      "UPDATE messages SET body_len = ? WHERE id = ?",
    );
    let bodyLenCursor = 0;
    for (;;) {
      const row = nextMissingBodyLen.get(bodyLenCursor) as
        | { id: number; body: string }
        | undefined;
      if (!row) break;
      setBodyLen.run(row.body.length, row.id);
      bodyLenCursor = row.id;
    }

    this.db.exec(`
      -- UNIQUE(room_id, seq) already provides an implicit (room_id, seq) index
      -- (sqlite_autoindex, same query plans); an explicit duplicate only taxes
      -- every insert. Drop it from database files created by older builds.
      DROP INDEX IF EXISTS idx_messages_room_seq;
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(room_id, reply_to_seq);
      CREATE INDEX IF NOT EXISTS idx_messages_supersedes ON messages(room_id, supersedes_seq);
      -- Routine posts store NULL and therefore occupy no entry in this sparse
      -- index. Only callers opting into lost-response deduplication pay for it.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_message_id
        ON messages(room_id, agent_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      -- A mentions-only poll must not rescan every broadcast in a large unread
      -- backlog every few seconds. Its candidate predicate uses this partial
      -- index, then evaluates json_each only for rows that could be directed.
      CREATE INDEX IF NOT EXISTS idx_messages_directed_candidates
        ON messages(room_id, seq)
        WHERE mentions IS NOT NULL OR reply_to_agent IS NOT NULL;

      -- The memberships PK starts with room_id, while all-rooms poller probes
      -- start with one agent. Without this reverse index every quiet interval
      -- scanned the complete membership table before checking any room.
      CREATE INDEX IF NOT EXISTS idx_memberships_agent_present
        ON memberships(agent_id, left_at, room_id);

      -- Per-session read CURSORS for identities running multiple concurrent
      -- sessions (join_room cursor:'private'). The memberships marker stays the
      -- identity-level read receipt (advanced to the MAX across sessions). The
      -- left_at column here is VESTIGIAL and no longer read: presence moved to
      -- the session_presence table below, which every session (shared too)
      -- registers in, so a leave can no longer evict a live twin.
      CREATE TABLE IF NOT EXISTS session_markers (
        room_id       INTEGER NOT NULL REFERENCES rooms(id),
        agent_id      TEXT NOT NULL REFERENCES agents(id),
        session_id    TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        left_at       TEXT,
        PRIMARY KEY (room_id, agent_id, session_id)
      );
      -- touch()/touchSessionMarkers refresh a session's rows by session_id
      -- ALONE (a process-unique nonce, keyed independently of room/agent). The
      -- PK starts with room_id, so that predicate had no usable index and did a
      -- full session_markers scan on every liveness touch; this covers it.
      CREATE INDEX IF NOT EXISTS idx_session_markers_session
        ON session_markers(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_markers_room_updated
        ON session_markers(room_id, updated_at);

      -- Per-session PRESENCE, decoupled from cursors: EVERY session (shared or
      -- private) registers a row here on join, keyed by its process nonce, so a
      -- leave can tell whether any OTHER session of the identity is still here.
      -- memberships.left_at is recomputed from this table as "present iff any
      -- row is live (left_at IS NULL and refreshed within the GC window)", which
      -- keeps the cross-process poller (it reads memberships.left_at) working
      -- unchanged. Separate from session_markers so it never perturbs cursor
      -- semantics (a shared session has a presence row but no cursor row).
      CREATE TABLE IF NOT EXISTS session_presence (
        room_id    INTEGER NOT NULL REFERENCES rooms(id),
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        left_at    TEXT,
        PRIMARY KEY (room_id, agent_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_presence_session
        ON session_presence(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_presence_room_updated
        ON session_presence(room_id, updated_at);

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

      -- In-turn wait leases: a row exists ONLY while an agent's blocking
      -- catch_up wait is open in that room, making "actively watching" a
      -- verifiable server state (recipientStatus/list_agents expose it as
      -- "watching"). expires_at is the wait deadline plus a small grace, so a
      -- crashed waiter's row self-expires; the handler deletes it on every
      -- normal or aborted exit. Detached pollers never write here (their
      -- probe is query_only), which is deliberate: shell liveness must not
      -- read as model availability.
      CREATE TABLE IF NOT EXISTS wait_leases (
        room_id    INTEGER NOT NULL REFERENCES rooms(id),
        agent_id   TEXT NOT NULL REFERENCES agents(id),
        session_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id, session_id)
      );
    `);
    // Add session_markers.left_at to database files created before presence
    // became session-aware (the CREATE TABLE above already has it for fresh
    // files). Runs after the table exists, so ensureColumn's ALTER is valid.
    this.ensureColumn("session_markers", "left_at", "TEXT");
    // claims is created in the block above, later than rooms/agents, so install
    // its old/direct-writer NUL guards here before the one-time v3 heal.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS claims_reject_nul_insert BEFORE INSERT ON claims
      WHEN instr(NEW.note, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'claim note contains a NUL character (U+0000)');
      END;
      CREATE TRIGGER IF NOT EXISTS claims_note_reject_nul_update
      BEFORE UPDATE OF note ON claims
      WHEN instr(NEW.note, char(0)) > 0 BEGIN
        SELECT RAISE(ABORT, 'claim note contains a NUL character (U+0000)');
      END;
    `);

    // Heal legacy embedded NULs in metadata columns too (message bodies are
    // healed above, with their body_len reset). Listing SQL uses substr(), which
    // stops at the first NUL, so a legacy NUL silently truncated the shown
    // value. Runs after every table exists; new writes are already rejected.
    // Run once with the versioned maintenance pass. Even small full-table
    // scans become expensive when multiplied across many MCP processes.
    if (needsMetadataV3) {
      this.healNulColumn("rooms", "description");
      this.healNulColumn("rooms", "pinned");
      this.healNulColumn("agents", "description");
      this.healNulColumn("claims", "note");
    }

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
    // A steady-state empty/nonempty mismatch repairs the crash window without
    // a corpus scan; the pre-v2 migration additionally performs exact counts.
    // The index row count MUST come from the messages_fts_docsize shadow
    // table: with external content, COUNT(*) on the virtual table itself
    // reads the content table and always matches. BOTH counts are read in ONE
    // statement (a single consistent snapshot): two separate SELECTs could
    // straddle a concurrent insert -- messages counted pre-insert, fts counted
    // post-trigger -- making an already-inconsistent {2,1} file read as {2,2}
    // and skip the rebuild it actually needed. A legacy NUL repair changes a
    // body before these triggers exist; row counts still match in that case,
    // so the repair flag must force a rebuild to replace stale tokens.
    const { hasMessages, hasFtsRows } = this.db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM messages LIMIT 1) AS hasMessages,
                EXISTS(SELECT 1 FROM messages_fts_docsize LIMIT 1) AS hasFtsRows`,
      )
      .get() as { hasMessages: number; hasFtsRows: number };
    let rebuildFts = healedMessageBody || hasMessages !== hasFtsRows;
    // The steady-state sentinel above catches the historical empty-index crash
    // class in O(1). A full consistency count remains appropriate during the
    // one-time pre-v2 migration, but not on every MCP process startup.
    if (!rebuildFts && needsV2Maintenance) {
      const { msgCount, ftsCount } = this.db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM messages) AS msgCount,
                  (SELECT COUNT(*) FROM messages_fts_docsize) AS ftsCount`,
        )
        .get() as { msgCount: number; ftsCount: number };
      rebuildFts = ftsCount !== msgCount;
    }
    if (rebuildFts) {
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    }

    // Mark this file migrated so the message-body NUL scan above is skipped on
    // future startups (one-time work; the reject trigger keeps new rows clean).
    // Set LAST, only after the scan ran, so a crash mid-scan leaves user_version
    // unchanged and it re-runs.
    if (currentVersion < SCHEMA_VERSION) {
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
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

  /**
   * Heal legacy embedded NULs in a bounded TEXT metadata column (room
   * description/pinned, agent description, claim note): replace U+0000 with
   * U+FFFD so a listing's substr()/length() reads the value whole instead of
   * truncating at the NUL. Cursored by rowid one row at a time (these columns
   * cap at <=10k and NUL rows are exotic); a plain SELECT is not NUL-terminated,
   * so the value is recoverable. `table`/`col` are fixed internal identifiers,
   * never caller input. Healing clears the NUL, so the predicate never revisits
   * a row and the rowid cursor moves strictly forward.
   */
  private healNulColumn(table: string, col: string): void {
    const next = this.db.prepare(
      `SELECT rowid AS rid, ${col} AS v FROM ${table}
       WHERE instr(${col}, char(0)) > 0 AND rowid > ? ORDER BY rowid LIMIT 1`,
    );
    const fix = this.db.prepare(
      `UPDATE ${table} SET ${col} = ? WHERE rowid = ?`,
    );
    let cursor = 0;
    for (;;) {
      const row = next.get(cursor) as { rid: number; v: string } | undefined;
      if (!row) break;
      fix.run(row.v.replace(/\u0000/g, "\ufffd"), row.rid);
      cursor = row.rid;
    }
  }

  // --- rooms -------------------------------------------------------------

  createRoom(
    name: string,
    description: string | null,
    pinned: string | null,
  ): RoomRow {
    assertStorable(name, "room name");
    assertMaxLen(name, "room name", 200);
    assertStorable(description, "room description");
    assertMaxLen(description, "room description", 2000);
    assertStorable(pinned, "room pinned intro");
    assertMaxLen(pinned, "room pinned intro", 10_000);
    return this.db
      .prepare(
        `INSERT INTO rooms (name, description, pinned) VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(name, description, pinned) as RoomRow;
  }

  setPinned(roomId: number, pinned: string | null): void {
    assertStorable(pinned, "room pinned intro");
    assertMaxLen(pinned, "room pinned intro", 10_000);
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
   * Room listing, bounded three ways: at most `limit` rows, pinned/description
   * cut to listing previews (flagged; join_room returns the full pinned), and
   * the whole response trimmed to a serialized-size budget (control-heavy
   * metadata serializes far larger than its raw length). `total` is the
   * unfiltered room count.
   *
   * KEYSET-paged by id (id > afterId), NOT OFFSET: a concurrent delete_room
   * shifts every OFFSET after the removed row and skips a still-live room
   * across pages (the same race listClaims avoids). id is unique and the sort
   * key, so `id > afterId` is immune. Pass the prior page's `next_id` back as
   * `afterId` for the next page.
   */
  listRooms(
    limit = 200,
    afterId = 0,
  ): { rooms: RoomSummary[]; total: number; next_id?: number; size_trimmed?: boolean } {
    const PREVIEW = 300;
    const lim = Math.max(1, Math.floor(limit));
    // Rows and total in ONE deferred snapshot: read as separate statements, a
    // concurrent create_room/delete_room BETWEEN them yields an internally
    // contradictory page (e.g. total:4 with no next_id, so the keyset pager
    // stops and misses the now-live room). Fetch one MORE than asked to detect
    // a further page without a tail COUNT.
    const { rows, total } = this.db
      .transaction(() => {
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
             FROM rooms r WHERE r.id > ? ORDER BY r.id LIMIT ?`,
          )
          .all(Math.max(0, Math.floor(afterId)), lim + 1) as (RoomSummary & {
          description_cut: number;
          pinned_cut: number;
        })[];
        const { c: total } = this.db
          .prepare("SELECT COUNT(*) AS c FROM rooms")
          .get() as { c: number };
        return { rows, total };
      })
      .deferred();
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const mapped = page.map((r) => {
      const { description_cut, pinned_cut, ...rest } = r;
      return {
        ...rest,
        ...(description_cut ? { description_truncated: true } : {}),
        ...(pinned_cut ? { pinned_truncated: true } : {}),
      };
    });
    const { rows: rooms, sizeTrimmed } = fitRows(mapped, LIST_ROW_BUDGET);
    // More remain if the byte budget cut the page OR a further row existed
    // beyond `limit`. next_id is the LAST RETURNED room's id (the keyset
    // cursor); omitted once the listing is exhausted.
    const more = sizeTrimmed || (hasMore && rooms.length === page.length);
    const next_id =
      more && rooms.length > 0 ? rooms[rooms.length - 1].id : undefined;
    return {
      rooms,
      total,
      ...(next_id !== undefined ? { next_id } : {}),
      ...(sizeTrimmed ? { size_trimmed: true } : {}),
    };
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

  /** How many rooms an identity is currently present in (for wait_for_messages
   *  to refuse a doomed all-rooms watch when the agent is in none). */
  presentRoomCount(agentId: string): number {
    const { c } = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM memberships WHERE agent_id = ? AND left_at IS NULL",
      )
      .get(agentId) as { c: number };
    return c;
  }

  /** Resolve a room reference that may be a numeric id or a name. */
  resolveRoom(ref: string): RoomRow | undefined {
    // Number.isSafeInteger gate: a 16+ digit numeric ref past 2^53 rounds to a
    // DIFFERENT integer, so Number("9007199254740993") could resolve to the
    // room at 9007199254740992. Skip the id lookup for such refs (fall through
    // to the exact-name lookup) rather than select a neighbour by rounding.
    if (/^\d+$/.test(ref)) {
      const n = Number(ref);
      if (Number.isSafeInteger(n)) {
        const byId = this.db
          .prepare("SELECT * FROM rooms WHERE id = ?")
          .get(n) as RoomRow | undefined;
        if (byId) return byId;
      }
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
    assertStorable(id, "agent id");
    assertMaxLen(id, "agent id", 200);
    assertStorable(type, "agent type");
    assertMaxLen(type, "agent type", 100);
    assertStorable(role, "agent role");
    assertMaxLen(role, "agent role", 200);
    assertStorable(description, "agent description");
    assertMaxLen(description, "agent description", 2000);
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
    assertStorable(id, "agent id");
    assertMaxLen(id, "agent id", 200);
    assertStorable(type, "agent type");
    assertMaxLen(type, "agent type", 100);
    assertStorable(role, "agent role");
    assertMaxLen(role, "agent role", 200);
    assertStorable(description, "agent description");
    assertMaxLen(description, "agent description", 2000);
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
   * Recompute memberships.left_at for ONE identity from its session_presence
   * rows: present (left_at NULL) iff any row is LIVE (not left, and refreshed
   * within the GC window); otherwise mark it left. A NO-OP when the identity has
   * NO presence rows at all -- such an identity (a non-session caller: the web
   * viewer, tests, or a pre-redesign build) manages memberships.left_at directly
   * and must not be evicted by a presence recompute.
   */
  private recomputeMembershipPresence(roomId: number, agentId: string): void {
    const any = this.db
      .prepare(
        "SELECT 1 FROM session_presence WHERE room_id = ? AND agent_id = ? LIMIT 1",
      )
      .get(roomId, agentId);
    if (!any) return;
    const live = this.db
      .prepare(
        `SELECT 1 FROM session_presence
         WHERE room_id = ? AND agent_id = ? AND left_at IS NULL
           AND updated_at >= datetime('now', ?) LIMIT 1`,
      )
      .get(roomId, agentId, SESSION_GC_AGE);
    if (live) {
      this.db
        .prepare(
          "UPDATE memberships SET left_at = NULL WHERE room_id = ? AND agent_id = ?",
        )
        .run(roomId, agentId);
    } else {
      this.db
        .prepare(
          `UPDATE memberships SET left_at = datetime('now')
           WHERE room_id = ? AND agent_id = ? AND left_at IS NULL`,
        )
        .run(roomId, agentId);
    }
  }

  /**
   * Reap dead session_presence rows for a room and reconcile presence. Recompute
   * each affected identity FIRST -- while its rows still exist, so an identity
   * whose only rows are expired is marked left rather than mistaken for an
   * unmanaged (no-rows) identity -- THEN delete the left/expired rows.
   */
  private gcSessionPresence(roomId: number): void {
    // Reap ONLY expired rows (not left-but-fresh ones): a left row must survive
    // its 7-day window because my_mentions reads it to keep muting the room for
    // the session that left -- deleting it on the next unrelated join would
    // silently un-mute. Recompute ignores left rows either way (they are not
    // "live"), so keeping them does not affect identity presence.
    const dead = `updated_at < datetime('now', ?)`;
    const affected = this.db
      .prepare(
        `SELECT DISTINCT agent_id FROM session_presence WHERE room_id = ? AND (${dead})`,
      )
      .all(roomId, SESSION_GC_AGE) as { agent_id: string }[];
    for (const { agent_id } of affected) {
      this.recomputeMembershipPresence(roomId, agent_id);
    }
    this.db
      .prepare(`DELETE FROM session_presence WHERE room_id = ? AND (${dead})`)
      .run(roomId, SESSION_GC_AGE);
  }

  /**
   * Join (or rejoin) a room: clears any prior leave, refreshes liveness, and
   * registers this session's PRESENCE. presenceId (the process nonce) is set for
   * every MCP session, shared OR private; sessionId (the cursor nonce) only for
   * a private cursor. A null presenceId (non-session caller: web, tests) keeps
   * the old identity-level presence, seeding no presence row.
   */
  joinRoom(
    roomId: number,
    agentId: string,
    sessionId: string | null = null,
    presenceId: string | null = null,
  ): void {
    // One IMMEDIATE transaction: this was the file's only multi-statement
    // read-then-write path running autocommitted, where a cross-process
    // deleteRoom interleaving between statements surfaced as an opaque
    // NOT NULL/FK constraint error instead of a clean failure.
    const tx = this.db.transaction(() => {
      // Existence check INSIDE the write transaction: the caller resolved the
      // room earlier, and a cross-process delete_room in that window otherwise
      // surfaces as a raw "FOREIGN KEY constraint failed".
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
      if (presenceId !== null) {
        // Register/refresh this session's presence (present => left_at NULL).
        this.db
          .prepare(
            `INSERT INTO session_presence (room_id, agent_id, session_id)
             VALUES (?, ?, ?)
             ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
               updated_at = datetime('now'), left_at = NULL`,
          )
          .run(roomId, agentId, presenceId);
        // Reap dead presence rows and reconcile memberships.left_at.
        this.gcSessionPresence(roomId);
      }
      if (sessionId !== null) {
        // Private cursor: seed a new one from the identity marker; an existing
        // one keeps its position (refresh only updated_at against the GC, which
        // must never reap the very session this join resumes).
        this.db
          .prepare(
            `INSERT INTO session_markers (room_id, agent_id, session_id, last_read_seq)
             VALUES (?, ?, ?, (SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?))
             ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
               updated_at = datetime('now')`,
          )
          .run(roomId, agentId, sessionId, roomId, agentId);
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
   * Soft leave: keep the membership row (and read positions) but mark THIS
   * session not present. Private session cursors are deliberately KEPT: a
   * lagging session's true read position lives only in its session_markers row,
   * and dead ones are reaped by the 7-day GC.
   *
   * SESSION-aware via session_presence: mark this session's presence row left,
   * then recompute the identity-level memberships.left_at from the surviving
   * sessions -- present iff any twin (shared OR private) still has a live
   * presence row. So one session leaving never evicts a live twin, for EVERY
   * cursor mode (the earlier session_markers-only twin check saw private
   * sessions only, so shared twins evicted each other and a private leave
   * evicted a shared twin). A caller with no presence row (presenceId null, or
   * a pre-redesign session) falls back to an identity-level leave.
   */
  leaveRoom(
    roomId: number,
    agentId: string,
    presenceId: string | null = null,
  ): boolean {
    const tx = this.db.transaction(() => {
      // Reconcile stale presence in this room on the way out: broadens the GC
      // beyond join, so a crashed twin's aged row is reaped (and its identity
      // recomputed) whenever anyone leaves, not only on the next join. The
      // active leaver's own row was refreshed on its last join/touch, so it is
      // not expired and is not reaped here.
      this.gcSessionPresence(roomId);
      if (presenceId !== null) {
        const row = this.db
          .prepare(
            "SELECT 1 FROM session_presence WHERE room_id = ? AND agent_id = ? AND session_id = ?",
          )
          .get(roomId, agentId, presenceId);
        if (row) {
          const s = this.db
            .prepare(
              `UPDATE session_presence SET left_at = datetime('now')
               WHERE room_id = ? AND agent_id = ? AND session_id = ? AND left_at IS NULL`,
            )
            .run(roomId, agentId, presenceId);
          // Reconcile the identity flag from the sessions that remain.
          this.recomputeMembershipPresence(roomId, agentId);
          return s.changes > 0; // true iff this session went present -> left
        }
        // No presence row for THIS session -- e.g. the 7-day GC reaped it while
        // the process stayed alive (idle, no touch). If the identity still has
        // OTHER presence rows (a live twin), reconcile from them rather than
        // blindly evicting via the identity-level leave below (which would defeat
        // the redesign's no-twin-eviction guarantee). Only an identity with NO
        // presence rows at all (web viewer, tests, pre-redesign) takes that path.
      }
      // The same protection is required for a legacy/sessionless leave. During
      // a rolling upgrade it may share an identity with current session-aware
      // twins; an unconditional identity leave must not evict those live rows.
      const anyLive = this.db
        .prepare(
          `SELECT 1 FROM session_presence
           WHERE room_id = ? AND agent_id = ? AND left_at IS NULL LIMIT 1`,
        )
        .get(roomId, agentId);
      if (anyLive) {
        this.recomputeMembershipPresence(roomId, agentId);
        return false;
      }
      const info = this.db
        .prepare(
          `UPDATE memberships SET left_at = datetime('now'), last_seen = datetime('now')
           WHERE room_id = ? AND agent_id = ? AND left_at IS NULL`,
        )
        .run(roomId, agentId);
      return info.changes > 0;
    });
    return tx.immediate();
  }

  /**
   * Refresh ALL of a session's cursor rows against the 7-day GC, without
   * touching membership state: used when the session has an identity but no
   * active room (post-leave my_mentions polling must still shield cursors).
   */
  touchSessionMarkers(_agentId: string, sessionId: string): void {
    // Key on session_id ALONE, not (agent_id, session_id): the session_id is a
    // process-unique nonce, and a single process can switch identity
    // (join_room under a new agent_id). Its earlier identity's private cursor
    // still belongs to THIS live session, so it must keep being refreshed;
    // scoping the refresh to the current agent_id let that older cursor age
    // out and get GC'd, and switching back recreated it at the identity
    // marker, silently skipping everything the private cursor had not read.
    this.db
      .prepare(
        "UPDATE session_markers SET updated_at = datetime('now') WHERE session_id = ?",
      )
      .run(sessionId);
  }

  /**
   * Mark an active agent alive. Also clears the ACTIVE room's left_at (an
   * actively-acting session re-asserts identity presence there). With
   * presenceId, refresh this session's cursor rows (every identity) and the
   * current identity's presence rows in EVERY room against the 7-day GC, and
   * reconcile the active room's presence.
   *
   * One IMMEDIATE transaction: these statements ran as separate autocommits,
   * and another process's GC interleaving between the membership update and
   * the presence upsert could recompute from the half-applied state, leaving
   * a live presence row beside a left membership (an active session hidden
   * from inboxes and pollers) until the next touch.
   *
   * The GC runs here too: join/leave/prune alone never reconciled a crashed
   * twin in a stable room, so it could read present:true indefinitely. touch
   * covers exactly the rooms whose agents anyone can list (list_agents reads
   * the caller's ACTIVE room). Reconciliation stays OPPORTUNISTIC overall: a
   * room no live session joins/leaves/prunes/touches keeps stale presence
   * until the next such operation inside it.
   */
  touch(roomId: number, agentId: string, presenceId: string | null = null): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE memberships SET last_seen = datetime('now'), left_at = NULL WHERE room_id = ? AND agent_id = ?",
        )
        .run(roomId, agentId);
      if (presenceId !== null) {
        // Re-assert this session's presence in the ACTIVE room (recreating a
        // row the 7-day GC reaped while the process stayed alive but idle), so
        // a NULL memberships.left_at is always backed by a live presence row
        // and a later leave or crash reconciles correctly. The active room is
        // never one the session soft-left (leave clears the session's active
        // room), so this cannot resurrect a left room's presence. Upsert FIRST
        // so the GC below never reaps the toucher itself.
        this.db
          .prepare(
            `INSERT INTO session_presence (room_id, agent_id, session_id)
             VALUES (?, ?, ?)
             ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
               updated_at = datetime('now'), left_at = NULL`,
          )
          .run(roomId, agentId, presenceId);
        this.gcSessionPresence(roomId);
        this.touchSessionAlive(presenceId, agentId);
      }
    });
    tx.immediate();
  }

  /**
   * Shield a live session's cursor AND presence rows from the 7-day GC in EVERY
   * room (keyed by the process nonce, so it also covers rooms the session is not
   * currently active in). CURSOR rows are refreshed nonce-wide, for every
   * identity the session has ever held (see touchSessionMarkers for why).
   * PRESENCE rows are refreshed only for the CURRENT identity: a session that
   * switched identity no longer acts as the old one, so the old identity's
   * presence must age out via the GC and read as left -- a nonce-wide refresh
   * kept it `present` for the life of the process with no way to leave it. The
   * old identity's preserved cursor row means a later rejoin under that id
   * resumes its exact read position. LEFT rows (leave tombstones) are refreshed
   * too -- the GC reaps by updated_at alone, so a live session's my_mentions
   * muting otherwise silently expired at the GC age while the session kept
   * polling; left_at itself is never cleared here, and a dead session's
   * tombstones still age out. Used for the no-active-room case (post-leave
   * my_mentions polling) and by touch().
   */
  touchSessionAlive(sessionId: string, agentId: string): void {
    this.touchSessionMarkers("", sessionId);
    this.db
      .prepare(
        "UPDATE session_presence SET updated_at = datetime('now') WHERE session_id = ? AND agent_id = ?",
      )
      .run(sessionId, agentId);
  }

  /**
   * Refresh activity for one room captured by a cross-room operation without
   * silently rejoining it. The exact session-presence row must still be live;
   * a left/tombstoned or never-joined session is a no-op even when a twin keeps
   * the identity-level membership present. IMMEDIATE makes the live-row check
   * and refresh atomic with a concurrent leave.
   */
  touchSessionRoom(
    roomId: number,
    agentId: string,
    sessionId: string,
  ): boolean {
    const tx = this.db.transaction(() => {
      const live = this.db
        .prepare(
          `SELECT 1 FROM session_presence
           WHERE room_id = ? AND agent_id = ? AND session_id = ?
             AND left_at IS NULL`,
        )
        .get(roomId, agentId, sessionId);
      if (!live) return false;
      this.db
        .prepare(
          `UPDATE session_presence SET updated_at = datetime('now')
           WHERE room_id = ? AND agent_id = ? AND session_id = ?
             AND left_at IS NULL`,
        )
        .run(roomId, agentId, sessionId);
      this.db
        .prepare(
          `UPDATE memberships SET last_seen = datetime('now'), left_at = NULL
           WHERE room_id = ? AND agent_id = ?`,
        )
        .run(roomId, agentId);
      return true;
    });
    return tx.immediate();
  }

  /**
   * Open an in-turn wait lease: this (room, agent, session) has a blocking
   * catch_up call pending. TTL covers the wait plus grace, so a hard-killed
   * process cannot leave a permanent "watching" ghost. Expired rows for the
   * room are reaped in passing. IMMEDIATE (read-then-write) and room-checked,
   * so a concurrently deleted room fails with the clean rejoin message
   * instead of a raw FK error.
   */
  beginWaitLease(
    roomId: number,
    agentId: string,
    sessionId: string,
    ttlSeconds: number,
  ): void {
    const tx = this.db.transaction(() => {
      this.requireRoom(roomId);
      this.db
        .prepare(
          "DELETE FROM wait_leases WHERE room_id = ? AND expires_at <= datetime('now')",
        )
        .run(roomId);
      this.db
        .prepare(
          `INSERT INTO wait_leases (room_id, agent_id, session_id, expires_at)
           VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))
           ON CONFLICT(room_id, agent_id, session_id) DO UPDATE SET
             started_at = datetime('now'), expires_at = excluded.expires_at`,
        )
        .run(roomId, agentId, sessionId, Math.max(1, Math.floor(ttlSeconds)));
    });
    tx.immediate();
  }

  /** Close an in-turn wait lease (normal return, timeout, or abort alike). */
  endWaitLease(roomId: number, agentId: string, sessionId: string): void {
    this.db
      .prepare(
        "DELETE FROM wait_leases WHERE room_id = ? AND agent_id = ? AND session_id = ?",
      )
      .run(roomId, agentId, sessionId);
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
   * Return the furthest cursor that can be reached after `afterSeq` without
   * crossing a message from another author. A cursor need not name a surviving
   * row (pruning can leave sequence gaps), so one before the next peer row is
   * safe. Called only inside an IMMEDIATE transaction: no writer can insert a
   * peer row between this proof and the cursor update.
   */
  private ownOnlyFloor(
    roomId: number,
    agentId: string,
    afterSeq: number,
  ): number {
    const { floor } = this.db
      .prepare(
        `SELECT COALESCE(
           (SELECT seq - 1 FROM messages
            WHERE room_id = ? AND seq > ? AND agent_id != ?
            ORDER BY seq ASC LIMIT 1),
           (SELECT max(?, COALESCE(MAX(seq), 0)) FROM messages WHERE room_id = ?)
         ) AS floor`,
      )
      .get(roomId, afterSeq, agentId, afterSeq, roomId) as { floor: number };
    return floor;
  }

  /**
   * Advance shared/private cursors at or beyond a proven safe floor through an
   * accepted self-authored post. The caller derives that floor from the crossing
   * aggregate: it is either the latest peer seq in the room or the posting
   * cursor when no later peer exists. This is a plain indexed marker pass, not a
   * correlated history scan per private session. Sibling marker timestamps are
   * deliberately untouched: active sessions refresh their own liveness, while
   * dead cursors must still GC.
   */
  private advanceOwnOnlyCursors(
    roomId: number,
    agentId: string,
    throughSeq: number,
    safeFloor: number,
  ): void {
    this.db
      .prepare(
        `UPDATE memberships
         SET last_read_seq = max(last_read_seq, ?)
         WHERE room_id = ? AND agent_id = ? AND last_read_seq >= ?`,
      )
      .run(throughSeq, roomId, agentId, safeFloor);
    this.db
      .prepare(
        `UPDATE session_markers
         SET last_read_seq = max(last_read_seq, ?)
         WHERE room_id = ? AND agent_id = ? AND last_read_seq >= ?`,
      )
      .run(throughSeq, roomId, agentId, safeFloor);
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
    after?: number,
  ): {
    agents: AgentRow[];
    total: number;
    next_after?: number;
    size_trimmed?: boolean;
  } {
    const PREVIEW = 300;
    const cols = `SELECT a.id, a.type, a.role,
                         substr(a.description, 1, ${PREVIEW}) AS description,
                         CASE WHEN length(a.description) > ${PREVIEW} THEN 1 ELSE 0 END AS description_cut,
                         m.joined_at, m.rowid AS _rid,
                         m.last_read_seq, m.last_seen, m.left_at,
                         (strftime('%s','now') - strftime('%s', m.last_seen)) AS idle_seconds,
                         EXISTS(SELECT 1 FROM wait_leases wl
                                WHERE wl.room_id = m.room_id AND wl.agent_id = m.agent_id
                                  AND wl.expires_at > datetime('now')) AS watching
                  FROM memberships m JOIN agents a ON a.id = m.agent_id
                  WHERE m.room_id = @room`;
    const count = `SELECT COUNT(*) AS c
                   FROM memberships m JOIN agents a ON a.id = m.agent_id
                   WHERE m.room_id = @room`;
    const lim = Math.max(1, Math.floor(limit));
    type Row = Omit<AgentRow, "present" | "active" | "watching"> & {
      left_at: string | null;
      description_cut: number;
      _rid: number;
      watching: number;
    };
    // Base params (room + optional filter) go to BOTH the row and count queries;
    // row-only params (keyset cursor, limit) are added separately so each
    // prepared statement is handed EXACTLY the named parameters it references.
    const base: Record<string, unknown> = { room: roomId };
    let cond = "";
    if (filter && filter.trim().length > 0) {
      // Literal-substring semantics: escape LIKE wildcards so a filter of
      // "50%" matches those three characters, not everything.
      base.like = `%${filter.trim().replace(/[\\%_]/g, "\\$&")}%`;
      cond = ` AND (IFNULL(a.role,'') LIKE @like ESCAPE '\\' OR IFNULL(a.type,'') LIKE @like ESCAPE '\\'
                  OR IFNULL(a.description,'') LIKE @like ESCAPE '\\' OR a.id LIKE @like ESCAPE '\\')`;
    }
    // KEYSET on the MONOTONIC membership rowid (NOT (joined_at, id)): rowid is
    // assigned on insert and only grows, so a concurrent join is ALWAYS after
    // any prior cursor -- unlike a caller-chosen id, where a same-second joiner
    // whose id sorts below the cursor was skipped. rowid is stable across
    // rejoins (INSERT OR IGNORE keeps the row); rows come back in join order.
    let keyset = "";
    const rowParams: Record<string, unknown> = { ...base, lim: lim + 1 };
    if (after !== undefined && Number.isFinite(after)) {
      keyset = ` AND m.rowid > @after`;
      rowParams.after = Math.floor(after);
    }
    // Rows and count in ONE deferred snapshot so total cannot disagree with the
    // page (parity with listRooms). Fetch one MORE than asked to detect a page.
    const { rows, total } = this.db
      .transaction(() => {
        const rows = this.db
          .prepare(`${cols}${cond}${keyset} ORDER BY m.rowid LIMIT @lim`)
          .all(rowParams) as Row[];
        const total = (
          this.db.prepare(`${count}${cond}`).get(base) as { c: number }
        ).c;
        return { rows, total };
      })
      .deferred();
    const hasMore = rows.length > lim;
    const page = hasMore ? rows.slice(0, lim) : rows;
    const threshold = activeWithinMinutes * 60;
    const mapped = page.map((r) => {
      const { left_at, description_cut, _rid, watching, ...rest } = r;
      void _rid;
      const isWatching = watching === 1;
      return {
        ...rest,
        ...(description_cut ? { description_truncated: true } : {}),
        present: left_at === null,
        active:
          left_at === null &&
          (isWatching ||
            (r.idle_seconds !== null && r.idle_seconds <= threshold)),
        watching: isWatching,
      };
    });
    const { rows: agents, sizeTrimmed } = fitRows(mapped, LIST_ROW_BUDGET);
    // next_after is the last RETURNED agent's membership rowid (monotonic
    // keyset cursor); omitted once the listing is exhausted.
    const more = sizeTrimmed || (hasMore && agents.length === page.length);
    const next_after =
      more && agents.length > 0 ? page[agents.length - 1]._rid : undefined;
    return {
      agents,
      total,
      ...(next_after !== undefined ? { next_after } : {}),
      ...(sizeTrimmed ? { size_trimmed: true } : {}),
    };
  }

  // --- messages ----------------------------------------------------------

  /**
   * Bounded previews of the messages "crossing" a post: rows from others past
   * `baseline`, oldest first, each with a per-row `directed` flag (aimed at
   * the poster). Doubly bounded (row cap AND byte budget) because these ride
   * inside a post RESPONSE, not a paged read; `remaining` reports what the
   * bounds cut. Serves both the CAS-reject path (baseline = the caller's
   * token) and the opt-in crossed_preview_chars path (baseline = the
   * poster's cursor). Runs inside postMessage's transaction.
   */
  private crossedRows(
    roomId: number,
    baseline: number,
    posterId: string,
    previewChars: number | undefined,
    totalCrossed: number,
  ): { rows: (MessageRow & { directed: boolean })[]; remaining: number } {
    const CROSSED_ROWS_MAX = 20;
    const CROSSED_BYTES = 20_000;
    // Fetch one codepoint beyond the public cap so truncation is known without
    // loading a large body; body_cp still carries the full length.
    // MCP validates this range, but ChatStore is also a public boundary used
    // directly by tests and scripts. Clamp here so a direct caller cannot make
    // an otherwise bounded post response materialize an arbitrarily large
    // preview.
    const pc = Math.min(
      MAX_CROSSED_PREVIEW_CHARS,
      Math.max(1, Math.floor(previewChars ?? 300)),
    );
    const fetched = this.db
      .prepare(
        `SELECT ${messageCols(MAX_CROSSED_PREVIEW_CHARS + 1)}, (${directedAt("g")}) AS directed
         FROM ${MESSAGE_FROM}
         WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
         ORDER BY g.seq ASC LIMIT ?`,
      )
      .all(posterId, posterId, roomId, baseline, posterId, CROSSED_ROWS_MAX) as (RawMessage & {
      directed: number;
    })[];
    const { messages } = this.boundByBytes(fetched, pc, CROSSED_BYTES, (r, p) => ({
      ...this.rowToMessage(r, p),
      directed: (r as RawMessage & { directed: number }).directed === 1,
    }));
    return {
      rows: messages,
      remaining: Math.max(0, totalCrossed - messages.length),
    };
  }

  /**
   * Insert a message, allocating the next per-room seq atomically. Also
   * reports the poster's blind spot: `crossed` counts messages from OTHERS the
   * poster had not read at post time (cursor-relative), with the seq range and
   * `crossed_directed` (how many of those are aimed at the poster), so a
   * poster learns in the same call that it may have posted over unseen
   * traffic. supersedesSeq marks the poster's OWN earlier message as
   * superseded by this one. Both replyToSeq and supersedesSeq are validated
   * in-transaction, so a concurrent prune cannot slip a dangling reference
   * between a pre-check and the insert.
   *
   * opts.ifLastReadSeq: conditional post (CAS) for dispositive messages. If
   * ANY message from others carries seq above the token, NOTHING is inserted
   * and the reject result carries the crossing messages (bounded previews,
   * per-row directed) so the caller can assess the delta and idempotently
   * retry; a token ahead of this session's effective cursor is invalid (it
   * cannot have come from that cursor's catch_up and would otherwise bypass
   * the guard). The reject baseline is the TOKEN, unlike the accept path's
   * cursor-relative crossed. opts.crossedPreviewChars additionally returns
   * crossed previews on an ACCEPTED post. A post never consumes an unseen peer
   * message. After an accepted post, the posting cursor and sibling cursors at
   * the proven safe peer floor are normalized through the new own row so their
   * recurring probes do not rescan that suffix.
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
    opts: {
      ifLastReadSeq?: number | null;
      crossedPreviewChars?: number;
      recipientActiveWithinMinutes?: number;
      priority?: boolean;
      clientMessageId?: string | null;
    } = {},
  ):
    | {
        posted: true;
        deduplicated: false;
        id: number;
        seq: number;
        crossed: number;
        crossed_directed: number;
        crossed_range: { from_seq: number; to_seq: number } | null;
        crossed_messages?: (MessageRow & { directed: boolean })[];
        crossed_remaining?: number;
        recipients?: RecipientStatus[];
        priority: boolean;
        client_message_id?: string;
      }
    | {
        posted: true;
        deduplicated: true;
        id: number;
        seq: number;
        priority: boolean;
        client_message_id: string;
      }
    | {
        posted: false;
        rejected: "evidence_pruned";
        oldest_retained_seq: number;
        pruned_through_seq: number;
      }
    | {
        posted: false;
        rejected: "stale_read";
        crossed: number;
        crossed_directed: number;
        crossed_range: { from_seq: number; to_seq: number } | null;
        crossed_messages: (MessageRow & { directed: boolean })[];
        crossed_remaining?: number;
      } {
    // Reject unstorable text BEFORE the transaction: a body with an embedded
    // NUL reads back truncated (SQLite substr/length stop at NUL) and catch_up
    // would advance the marker past the lost tail. mentions are agent ids
    // (already control-char-validated upstream) but guard defensively.
    assertStorable(body, "message body");
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > MAX_MESSAGE_BODY_BYTES) {
      throw new Error(
        `message body exceeds the ${MAX_MESSAGE_BODY_BYTES}-byte safety limit`,
      );
    }
    // Defense in depth for DIRECT store callers (the MCP handler already
    // validated pre-serialization): a json body can hide a nested lone
    // surrogate as an ASCII \uXXXX escape that assertStorable's raw-string check
    // misses, and JSON.parse reconstructs it on read. Validate the parsed
    // content -- bounded, so a pathological ~GB body is not parsed into memory.
    if (format === "json" && body.length <= JSON_VALIDATE_MAX_CHARS) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined; // not valid json; stored as-is, read back as a string
      }
      if (parsed !== undefined) assertWellFormedJsonValue(parsed, "message body");
    }
    if (mentions) {
      for (const m of mentions) {
        assertStorable(m, "mention id");
        assertMaxLen(m, "mention id", 200);
      }
    }
    const mentionsJson =
      mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
    const clientMessageId = opts.clientMessageId ?? null;
    if (clientMessageId !== null) {
      assertStorable(clientMessageId, "client_message_id");
      if (clientMessageId.length === 0) {
        throw new Error("client_message_id must not be empty");
      }
      assertMaxLen(
        clientMessageId,
        "client_message_id",
        MAX_CLIENT_MESSAGE_ID_CHARS,
      );
      if (/[\u0000-\u001f\u007f]/.test(clientMessageId)) {
        throw new Error("client_message_id cannot contain control characters");
      }
    }
    const ifToken = opts.ifLastReadSeq ?? null;
    const tx = this.db.transaction(() => {
      // The caller's room reference predates this transaction; a concurrent
      // delete_room otherwise surfaces as a raw FK failure on the INSERT.
      this.requireRoom(roomId);
      // Lost-response retry: one indexed lookup only when the caller opted in.
      // It precedes CAS/reference validation so a committed first attempt is
      // recoverable even if room state or a referenced parent later changed.
      if (clientMessageId !== null) {
        const prior = this.db
          .prepare(
            `SELECT id, seq, priority,
                    (format = @format AND priority = @priority AND body = @body
                     AND mentions IS @mentions
                     AND reply_to_seq IS @reply_to_seq
                     AND supersedes_seq IS @supersedes_seq) AS same_payload
             FROM messages
             WHERE room_id = @room_id AND agent_id = @agent_id
               AND client_message_id = @client_message_id`,
          )
          .get({
            format,
            priority: opts.priority === true ? 1 : 0,
            body,
            mentions: mentionsJson,
            reply_to_seq: replyToSeq,
            supersedes_seq: supersedesSeq,
            room_id: roomId,
            agent_id: agentId,
            client_message_id: clientMessageId,
          }) as
          | {
              id: number;
              seq: number;
              priority: number;
              same_payload: number;
            }
          | undefined;
        if (prior) {
          if (prior.same_payload !== 1) {
            throw new Error(
              `client_message_id "${clientMessageId}" is already attached to a different stored payload in this room`,
            );
          }
          return {
            posted: true as const,
            deduplicated: true as const,
            id: prior.id,
            seq: prior.seq,
            priority: prior.priority === 1,
            client_message_id: clientMessageId,
          };
        }
      }
      // CAS gate FIRST: a stale dispositive post rejects before any
      // validation error can mask the staleness (the caller reassesses and
      // retries with the same payload either way). In-transaction, so no
      // message can land between this check and the insert below.
      // Keep this after client_message_id lookup: an exact lost-response retry
      // must recover its committed row even if the caller also supplied a bad
      // fresh-attempt token. NaN is especially dangerous here because SQLite
      // binds it as NULL, turning `seq > ?` into an empty predicate.
      if (
        ifToken !== null &&
        (!Number.isSafeInteger(ifToken) || ifToken < 0)
      ) {
        throw new Error("if_last_read_seq must be a non-negative safe integer");
      }
      const cursor = this.getCursor(roomId, agentId, sessionId);
      const from = cursor?.last_read_seq ?? 0;
      if (ifToken !== null) {
        // A future/wrong-cursor token made the predicate `seq > token` empty
        // and silently disabled the CAS while unread messages still existed.
        // Bind the token to the effective shared/private cursor that could
        // actually have produced it. This is misuse detection, not auth: the
        // optional guard remains a caller-chosen safety primitive.
        if (ifToken > from) {
          throw new Error(
            `if_last_read_seq ${ifToken} is ahead of the current read marker ${from}; ` +
              "call catch_up for this room and use its new_last_read_seq",
          );
        }
        // A conditional post promises to reject when ANY peer message landed
        // after the token. Once pruning removes the oldest rows, scanning only
        // the retained tail cannot prove that promise for a token below the
        // gap. Seqs are dense and pruneMessages keeps at least one newest row,
        // so MIN(seq)-1 is the exact pruned-through watermark without another
        // column or write-side bookkeeping. Reject conservatively: the missing
        // rows may all have been authored by this caller, but accepting would
        // silently disable the safety guard when one was not.
        const { oldest } = this.db
          .prepare(
            "SELECT MIN(seq) AS oldest FROM messages WHERE room_id = ?",
          )
          .get(roomId) as { oldest: number | null };
        if (oldest !== null && ifToken < oldest - 1) {
          return {
            posted: false as const,
            rejected: "evidence_pruned" as const,
            oldest_retained_seq: oldest,
            pruned_through_seq: oldest - 1,
          };
        }
        const stale = this.db
          .prepare(
            `SELECT COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx,
                    SUM(CASE WHEN ${directedAt("messages")} THEN 1 ELSE 0 END) AS d
             FROM messages
             WHERE room_id = ? AND seq > ? AND agent_id != ?`,
          )
          .get(agentId, agentId, roomId, ifToken, agentId) as {
          c: number;
          mn: number | null;
          mx: number | null;
          d: number | null;
        };
        if (stale.c > 0) {
          const { rows, remaining } = this.crossedRows(
            roomId,
            ifToken,
            agentId,
            opts.crossedPreviewChars,
            stale.c,
          );
          return {
            posted: false as const,
            rejected: "stale_read" as const,
            crossed: stale.c,
            crossed_directed: stale.d ?? 0,
            crossed_range: { from_seq: stale.mn!, to_seq: stale.mx! },
            crossed_messages: rows,
            ...(remaining > 0 ? { crossed_remaining: remaining } : {}),
          };
        }
      }
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
      // message being posted. The directedAt pair binds FIRST (it sits in the
      // SELECT list, ahead of the WHERE placeholders).
      const crossing = this.db
        .prepare(
          `SELECT COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx,
                  SUM(CASE WHEN ${directedAt("messages")} THEN 1 ELSE 0 END) AS d
           FROM messages
           WHERE room_id = ? AND seq > ? AND agent_id != ?`,
        )
        .get(agentId, agentId, roomId, from, agentId) as {
        c: number;
        mn: number | null;
        mx: number | null;
        d: number | null;
      };
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { next: number };
      const info = this.db
        .prepare(
          `INSERT INTO messages (room_id, seq, agent_id, format, priority, body, body_len, mentions, reply_to_seq, reply_to_agent, supersedes_seq, client_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          roomId,
          next,
          agentId,
          format,
          opts.priority === true ? 1 : 0,
          body,
          body.length, // exact UTF-16; readers use it when the fetch is capped
          mentionsJson,
          replyToSeq,
          replyToAgent,
          supersedesSeq,
          clientMessageId,
        );
      // Own rows are never returned by catch_up, so leaving a cursor behind an
      // own-only suffix made every 5s poll (and every 500ms blocking probe) walk
      // that suffix forever. If crossing found peers after `from`, its MAX is
      // the room's latest peer row; otherwise `from` itself is known safe. Any
      // cursor at/after that floor can move through this own post. This protects
      // caught-up sibling sessions without scanning history once per sibling.
      const safeCursorFloor = crossing.c > 0 ? crossing.mx! : from;
      this.advanceOwnOnlyCursors(roomId, agentId, next, safeCursorFloor);
      // Opt-in crossed previews on an ACCEPTED post, in the same transaction
      // (the poster's own just-inserted row is excluded by agent_id != self).
      let crossedPreview: {
        rows: (MessageRow & { directed: boolean })[];
        remaining: number;
      } | null = null;
      if (crossing.c > 0 && opts.crossedPreviewChars !== undefined) {
        crossedPreview = this.crossedRows(
          roomId,
          from,
          agentId,
          opts.crossedPreviewChars,
          crossing.c,
        );
      }
      // Delivery status belongs to the same transaction as the post. Sampling
      // before INSERT omitted this new unread row from marker_behind; sampling
      // after commit could fail after storing and invite a duplicate retry.
      const recipients =
        mentions !== null && opts.recipientActiveWithinMinutes !== undefined
          ? this.recipientStatus(
              roomId,
              mentions,
              opts.recipientActiveWithinMinutes,
            )
          : undefined;
      return {
        posted: true as const,
        deduplicated: false as const,
        id: Number(info.lastInsertRowid),
        seq: next,
        priority: opts.priority === true,
        ...(clientMessageId !== null
          ? { client_message_id: clientMessageId }
          : {}),
        crossed: crossing.c,
        crossed_directed: crossing.d ?? 0,
        crossed_range:
          crossing.c > 0
            ? { from_seq: crossing.mn!, to_seq: crossing.mx! }
            : null,
        ...(crossedPreview !== null
          ? {
              crossed_messages: crossedPreview.rows,
              ...(crossedPreview.remaining > 0
                ? { crossed_remaining: crossedPreview.remaining }
                : {}),
            }
          : {}),
        ...(recipients !== undefined ? { recipients } : {}),
      };
    });
    // IMMEDIATE acquires the write lock before reading MAX(seq), so concurrent
    // writer processes cannot allocate the same seq.
    return tx.immediate();
  }

  private rowToMessage(r: RawMessage, previewChars?: number): MessageRow {
    // Both the CUT and the reported `length` are in CODEPOINTS now, so
    // preview_chars means the same unit as get_message's max_chars and as the
    // reported length (an emoji counts once). Deciding on codepointLen (the full
    // codepoint count) rather than a UTF-16 length keeps the threshold in the
    // same unit as the cut.
    const truncate =
      previewChars !== undefined && codepointLen(r) > previewChars;
    // A truncated body is returned as a raw (possibly partial) string even for
    // json: a sliced JSON string does not parse, so the caller must fetch the
    // full body with get_message. `truncated`/`length` signal exactly that.
    // A body larger than the fetch cap arrives here already cut; it can never
    // fit the byte budget anyway, so shrinkToFit re-flags it downstream.
    const content = truncate
      ? cutToCodepoints(r.body, previewChars)
      : r.format === "json"
        ? safeParse(r.body)
        : r.body;
    return {
      seq: r.seq,
      from: r.agent_id,
      from_type: r.from_type,
      from_role: r.from_role,
      format: r.format,
      ...(r.priority > 0 ? { priority: true as const } : {}),
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
      ...(truncate ? { truncated: true, length: codepointLen(r) } : {}),
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
      stub.length = codepointLen(r); // codepoints, consistent with get_message
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
   * Pull rows off a query one at a time and STOP once enough RAW body has
   * accumulated to fill maxBytes, so peak memory is ~maxBytes + one row instead
   * of limit x per-row-cap (a page of 100 legal 400k bodies used to
   * materialize ~40 MB to return one message). Serialized size is always >=
   * raw size, so stopping at maxBytes raw guarantees boundByBytes still has
   * enough rows to fill the exact serialized budget; it never under-fetches.
   * Always keeps at least the first row (paging must progress even when the
   * head alone is oversized). The SQL LIMIT still bounds the row count for
   * many-tiny-message pages. Draining/breaking the iterator closes it before
   * the caller runs further queries in the same transaction.
   */
  private fetchBounded<T extends { body: string; mentions?: string | null }>(
    stmt: Database.Statement,
    params: unknown[],
    maxBytes: number,
  ): { rows: T[]; exhausted: boolean } {
    const rows: T[] = [];
    let used = 0;
    const it = stmt.iterate(...params) as IterableIterator<T>;
    let res = it.next();
    // exhausted = the query was fully drained (rows holds EVERY matching row).
    // false = we stopped on the raw-byte budget with more rows behind us.
    let exhausted = true;
    while (!res.done) {
      rows.push(res.value);
      // Charge body AND mentions: an empty-body row can still carry a huge
      // mentions list, so counting body alone let 500 empty-body/max-mention
      // rows materialize ~10 MB to return one stub.
      used +=
        (res.value.body ? res.value.body.length : 0) +
        (res.value.mentions ? res.value.mentions.length : 0);
      res = it.next();
      if (used >= maxBytes) {
        // Grab ONE more row past the budget (if any) as a SENTINEL, then stop.
        // The sentinel lets boundByBytes see that more rows remain. The
        // raw-size stop assumes serialized >= raw, which BREAKS when preview_chars
        // or a compact JSON reparse shrinks rows below their raw size: then
        // boundByBytes can fit EVERY fetched row (sentinel included), so
        // `exhausted:false` is the callers' only "more" signal in that case.
        // But the sentinel may itself be the LAST matching row, in which case
        // nothing remains and exhausted must stay TRUE -- else a shrink that
        // fits the sentinel emits a false "more remain" (a spurious empty next
        // page). PEEK one further row to decide, discarding it (paging resumes
        // from the last RETURNED row, so the peek is re-fetched, never skipped).
        // Peak memory stays ~2x maxBytes.
        if (!res.done) {
          rows.push(res.value);
          exhausted = it.next().done === true;
        }
        if (it.return) it.return();
        break;
      }
    }
    return { rows, exhausted };
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
   * Fetch one message. Bodies are returned up to maxChars per call; page a
   * longer body with `offset` (advance by the returned `next_offset`). A
   * partial view carries truncated/length/offset/next_offset markers, and a
   * sliced json body is returned as a raw partial string, not a parsed object.
   *
   * offset, length and next_offset are CODEPOINT counts (= UTF-16 units for
   * BMP text; they diverge only for astral characters). The window is fetched
   * with SQLite substr, so memory is bounded by maxChars regardless of offset
   * or the body's true size (up to ~1 GB) -- a deep page no longer
   * materializes the whole prefix in JS -- and a codepoint window never splits
   * a surrogate pair.
   */
  getMessage(
    roomId: number,
    seq: number,
    offset = 0,
    maxChars = DEFAULT_MAX_BYTES,
  ): (MessageRow & { next_offset?: number }) | undefined {
    if (!Number.isFinite(offset) || Math.abs(offset) > Number.MAX_SAFE_INTEGER) {
      throw new Error("get_message offset must be a finite safe number");
    }
    if (!Number.isFinite(maxChars)) {
      throw new Error("get_message max_chars must be finite");
    }
    const off = Math.max(0, Math.floor(offset));
    const cap = Math.min(
      MAX_GET_MESSAGE_CHARS,
      Math.max(1, Math.floor(maxChars)),
    );
    // Envelope (author, reply preview, flags) with a 1-char body: cheap and
    // independent of body size.
    const env = this.getRawMessage(roomId, seq, 1);
    if (!env) return undefined;
    // Total length as a scalar + ONLY the requested window. length(body) and
    // substr(body, off+1, cap) both operate in codepoints; substr materializes
    // at most `cap` codepoints in JS no matter how deep the offset is.
    const win = this.db
      .prepare(
        `SELECT length(body) AS total, substr(body, ?, ?) AS body
         FROM messages WHERE room_id = ? AND seq = ?`,
      )
      .get(off + 1, cap, roomId, seq) as
      | { total: number; body: string | null }
      | undefined;
    if (!win) return undefined;
    const total = win.total ?? 0;
    let chunk = win.body ?? "";
    // Serialized-size correction: maxChars caps RAW characters, but JSON
    // escaping inflates control-heavy bodies up to 6x on the wire (100k NULs
    // would serialize past 600k -- though NUL is now rejected at write). Shrink
    // until the serialized slice fits ~maxChars; next_offset is recomputed from
    // the ACTUAL returned chunk, so the walk stays exact.
    // Never shrink away the first complete codepoint. With maxChars=1 an
    // astral character necessarily occupies two UTF-16 units on the JSON wire,
    // but returning it is the only progress-safe interpretation of SQLite's
    // one-CODEPOINT window; shrinking it to "" made next_offset repeat forever.
    const firstCodepointUnits = (chunk.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    while (
      chunk.length > firstCodepointUnits &&
      JSON.stringify(chunk).length - 2 > cap
    ) {
      const ratio = cap / (JSON.stringify(chunk).length - 2);
      chunk = safeCut(
        chunk,
        Math.min(chunk.length - 1, Math.max(1, Math.floor(chunk.length * ratio))),
      );
    }
    // Codepoints consumed by this slice (bounded, so counting is cheap).
    let consumed = 0;
    for (const _ of chunk) consumed++;
    const partial = off > 0 || off + consumed < total;
    if (!partial) {
      // Whole body in hand: parse json / return the string normally.
      return this.rowToMessage({ ...env, body: chunk, body_len: total });
    }
    // Build the envelope without parsing the (possibly huge) body.
    const base = this.rowToMessage({ ...env, body: "", body_len: 0 });
    return {
      ...base,
      content: chunk,
      // truncated means "there is more BEYOND this slice", so the final page of
      // an offset walk reports false and pagers terminate instead of spinning.
      truncated: off + consumed < total,
      length: total,
      offset: off,
      next_offset: off + consumed,
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
    // marker_behind baseline. Read alongside the rows without a transaction:
    // this is a liveness heuristic, not an invariant, and the method already
    // runs autocommit.
    const { latest } = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?",
      )
      .get(roomId) as { latest: number };
    const rows = this.db
      .prepare(
        `SELECT agent_id, last_read_seq, left_at,
                (strftime('%s','now') - strftime('%s', last_seen)) AS idle_seconds,
                EXISTS(SELECT 1 FROM wait_leases wl
                       WHERE wl.room_id = memberships.room_id
                         AND wl.agent_id = memberships.agent_id
                         AND wl.expires_at > datetime('now')) AS watching
         FROM memberships
         WHERE room_id = ? AND agent_id IN (${placeholders})`,
      )
      .all(roomId, ...ids) as {
      agent_id: string;
      last_read_seq: number;
      left_at: string | null;
      idle_seconds: number | null;
      watching: number;
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
          marker_behind: null,
          watching: false,
        };
      }
      const present = r.left_at === null;
      const isWatching = r.watching === 1;
      const active =
        present &&
        (isWatching ||
          (r.idle_seconds !== null && r.idle_seconds <= threshold));
      return {
        id,
        status: present ? (active ? "active" : "idle") : "left",
        present,
        idle_seconds: r.idle_seconds,
        last_read_seq: r.last_read_seq,
        marker_behind: Math.max(0, latest - r.last_read_seq),
        watching: isWatching,
      };
    });
  }

  /**
   * Cross-agent pending-work view: for every PRESENT membership, the unread
   * messages from others directed at that member (mentions, or replies to its
   * messages), one row per (agent, room), oldest pending first (the most
   * starved recipient leads). This is the read a supervisor polls to decide
   * whom to wake; my_mentions is self-scoped and cannot answer it. Markers
   * are identity-level (a lagging private session's cursor is invisible
   * cross-agent, so an agent can be further behind than reported), and
   * idle_seconds is per room membership, matching list_agents. The directed
   * predicate is inlined rather than directedAt(): that helper binds one
   * FIXED id, and here the id varies per membership row. Fetches limit+1 to
   * report truncation without a tail COUNT. Keyset paging makes a bounded
   * supervisor sweep possible; room_id is the final tie-breaker because one
   * agent can have same-second pending rows in several rooms. Read-only.
   */
  pendingDirected(limit = 50, after?: PendingCursor): {
    pending: {
      agent_id: string;
      room_id: number;
      room_name: string;
      directed_unread: number;
      oldest_seq: number;
      oldest_unix: number;
      idle_seconds: number | null;
      last_read_seq: number;
    }[];
    truncated: boolean;
    size_trimmed: boolean;
    next_after?: PendingCursor;
  } {
    const lim = Math.max(1, Math.floor(limit));
    const cursorClause = after
      ? `WHERE oldest_unix > @oldest_unix
           OR (oldest_unix = @oldest_unix AND agent_id > @agent_id)
           OR (oldest_unix = @oldest_unix AND agent_id = @agent_id
               AND room_id > @room_id)`
      : "";
    const statement = this.db.prepare(
      `WITH pending_rows AS (
         SELECT mb.agent_id AS agent_id, mb.room_id AS room_id, r.name AS room_name,
                COUNT(*) AS directed_unread,
                MIN(g.seq) AS oldest_seq,
                MIN(CAST(strftime('%s', g.created_at) AS INTEGER)) AS oldest_unix,
                (strftime('%s','now') - strftime('%s', mb.last_seen)) AS idle_seconds,
                mb.last_read_seq AS last_read_seq
         FROM memberships mb
         JOIN rooms r ON r.id = mb.room_id
         CROSS JOIN messages g INDEXED BY idx_messages_directed_candidates
         WHERE mb.left_at IS NULL
           AND g.room_id = mb.room_id
           AND g.seq > mb.last_read_seq
           AND g.agent_id != mb.agent_id
           AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)
           AND (g.reply_to_agent = mb.agent_id OR EXISTS (
             SELECT 1 FROM json_each(g.mentions) j
             WHERE j.type = 'text' AND CAST(j.value AS TEXT) = mb.agent_id
           ))
         GROUP BY mb.agent_id, mb.room_id
       )
       SELECT * FROM pending_rows
       ${cursorClause}
       ORDER BY oldest_unix ASC, agent_id ASC, room_id ASC
       LIMIT @limit`,
    );
    const bindings = after
      ? { ...after, limit: lim + 1 }
      : { limit: lim + 1 };
    const rows = statement.all(bindings) as {
      agent_id: string;
      room_id: number;
      room_name: string;
      directed_unread: number;
      oldest_seq: number;
      oldest_unix: number;
      idle_seconds: number | null;
      last_read_seq: number;
    }[];
    const rowLimited = rows.length > lim;
    const candidates = rowLimited ? rows.slice(0, lim) : rows;
    const { rows: pending, sizeTrimmed } = fitRows(
      candidates,
      LIST_ROW_BUDGET,
    );
    const truncated = rowLimited || sizeTrimmed;
    const last = pending[pending.length - 1];
    return {
      pending,
      truncated,
      size_trimmed: sizeTrimmed,
      ...(truncated && last
        ? {
            next_after: {
              oldest_unix: last.oldest_unix,
              agent_id: last.agent_id,
              room_id: last.room_id,
            },
          }
        : {}),
    };
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
    // cap+1 rows to detect (without a separate COUNT) that more were available,
    // but memory-bound via fetchBounded so 500 large replies do not all
    // materialize (~50 MB) just to trim to the thread budget: it stops after
    // ~budget raw body plus a sentinel. When it stops by SIZE, replies_capped
    // may under-report (byte_limited then carries "more replies exist"); when
    // replies are small it fetches the full cap+1 and reports capping exactly.
    const { rows, exhausted } = this.fetchBounded<RawMessage & { depth: number }>(
      this.db.prepare(
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
      ),
      [{ room: roomId, root: seq, maxDepth, lim: cap + 1 }],
      Math.max(STUB_ALLOWANCE, remaining),
    );

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
    // If fetchBounded stopped on the raw-byte budget (exhausted:false), replies
    // were left unfetched even when boundByBytes fit everything it got (a
    // preview_chars cut shrank them all): flag byte_limited so the omission is
    // never silent. get_thread has no reply-offset param; the recourse is
    // get_thread on a reply seq, which byte_limited signals is needed.
    byteLimited = byteLimited || !exhausted;
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
   * Non-advancing unread probe for the blocking wait: EXACTLY catchUp's
   * predicate (seq > cursor AND agent_id != self, the cursor resolved through
   * the same session selector), minus the fetch and the advance. Any drift
   * between this predicate and catchUp's makes the wait loop spin (a positive
   * probe whose advancing read returns nothing). Autocommit reads: under WAL
   * they take a shared lock, so a 500ms cadence never contends for the write
   * lock the way catchUp's IMMEDIATE transaction would. Throws when the
   * membership is gone (room deleted mid-wait), same as catchUp.
   */
  unreadProbe(
    roomId: number,
    agentId: string,
    sessionId: string | null,
  ): number {
    const cursor = this.getCursor(roomId, agentId, sessionId);
    if (!cursor) throw new Error("not a member of this room");
    // A wait only needs a yes/no wake signal. COUNT(*) rescanned the complete
    // unread tail twice per second per wait (including a large self-authored
    // tail that never advances); the room/seq index lets this stop at one row.
    return this.db
      .prepare(
        `SELECT 1 FROM messages
         WHERE room_id = ? AND seq > ? AND agent_id != ? LIMIT 1`,
      )
      .get(roomId, cursor.last_read_seq, agentId)
      ? 1
      : 0;
  }

  /**
   * Bounded per-room unread summary for one agent: every room the agent is
   * present in (rooms this session soft-left are muted) holding unread
   * messages from others, with total `unread` and `directed` (aimed at the
   * agent) counts, most-directed first. Feeds both my_mentions' by_room arm
   * and catch_up's rooms_with_unread disclosure on an empty read. Session
   * awareness matches my_mentions: with a sessionId, each room baselines off
   * that session's OWN private cursor where one exists (COALESCE to the
   * identity marker). excludeRoomId drops the room just read (catch_up's
   * summary lists OTHER rooms). Fetches limit+1 to report truncation without
   * a tail COUNT. Read-only, so it is safe inside deferred and immediate
   * transactions alike.
   */
  unreadByRoom(
    agentId: string,
    sessionId: string | null,
    limit: number,
    excludeRoomId?: number,
  ): {
    rooms: { room_id: number; name: string; unread: number; directed: number }[];
    truncated: boolean;
  } {
    // '' never collides with a real session id (same convention as myMentions).
    const sessionKey = sessionId ?? "";
    const lim = Math.max(1, Math.floor(limit));
    const excl = excludeRoomId !== undefined ? " AND g.room_id != ?" : "";
    // Placeholders in SQL text order: the directedAt pair (SELECT), the
    // membership join, the session-marker key, the author exclusion, the
    // presence key, the optional room exclusion, then the LIMIT.
    const params: (string | number)[] = [
      agentId,
      agentId,
      agentId,
      sessionKey,
      agentId,
      sessionKey,
    ];
    if (excludeRoomId !== undefined) params.push(excludeRoomId);
    params.push(lim + 1);
    const rows = this.db
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
           AND NOT EXISTS (SELECT 1 FROM session_presence sp
                           WHERE sp.room_id = g.room_id AND sp.agent_id = mb.agent_id
                             AND sp.session_id = ? AND sp.left_at IS NOT NULL)${excl}
         GROUP BY g.room_id, r.name
         ORDER BY directed DESC, unread DESC, g.room_id ASC
         LIMIT ?`,
      )
      .all(...params) as {
      room_id: number;
      name: string;
      unread: number;
      directed: number;
    }[];
    const truncated = rows.length > lim;
    return { rooms: truncated ? rows.slice(0, lim) : rows, truncated };
  }

  /**
   * Unread messages (seq > last_read_seq), oldest first; normally ADVANCES the
   * read marker over returned peer rows plus any following own-only suffix,
   * never across an undelivered peer row. The explicit priorityOnly mode
   * is deliberately LOSSY backlog triage: it returns priority OR directed rows
   * and advances over lower-priority rows through a disclosed cutoff. Directed
   * rows always qualify so advancing cannot silently erase my_mentions items.
   *
   * unreadSummary (its sessionId is the RAW process nonce, my_mentions-style,
   * not this room's cursor selector): on an EMPTY read, include a bounded
   * rooms_with_unread summary of every OTHER room holding unread, computed in
   * the SAME snapshot as the empty determination -- across two separate
   * queries a message arriving in this room could make the read report
   * "empty" while the summary lists this very room.
   */
  catchUp(
    roomId: number,
    agentId: string,
    limit: number,
    previewChars?: number,
    maxBytes: number = DEFAULT_MAX_BYTES,
    sessionId: string | null = null,
    unreadSummary: {
      sessionId: string | null;
      priorityOnly?: boolean;
    } | null = null,
  ): {
    messages: MessageRow[];
    new_last_read_seq: number;
    remaining: number;
    advanced: boolean;
    byte_limited?: boolean;
    lossy?: true;
    priority_only?: true;
    skipped_count?: number;
    qualifying_remaining?: number;
    cutoff_seq?: number;
    rooms_with_unread?: {
      room_id: number;
      name: string;
      unread: number;
      directed: number;
    }[];
    rooms_with_unread_truncated?: boolean;
  } {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < MIN_CATCH_UP_RESULT_BUDGET ||
      maxBytes > MAX_BULK_RESULT_CHARS
    ) {
      throw new Error(
        `catch_up result budget must be an integer from ${MIN_CATCH_UP_RESULT_BUDGET} to ${MAX_BULK_RESULT_CHARS} serialized characters`,
      );
    }
    // MCP validates a positive limit, but protect direct ChatStore callers as
    // well. In priority-only mode LIMIT 0 plus the lossy cutoff would otherwise
    // advance the marker without returning the qualifying message.
    if (!Number.isFinite(limit)) {
      throw new Error("catch_up limit must be finite");
    }
    const pageLimit = Math.min(
      MAX_CATCH_UP_ROWS,
      Math.max(1, Math.floor(limit)),
    );
    // Advancing path: read the cursor, fetch, and advance inside one IMMEDIATE
    // transaction so a concurrent same-identity call serializes behind it and
    // reads the updated cursor instead of returning overlapping messages.
    // The byte bound trims BEFORE the advance, so the cursor never covers an
    // undelivered peer row (it may later normalize across own rows, which are
    // never returned): a response the client rejects as oversized can no
    // longer strand a peer message behind an advanced marker.
    const tx = this.db.transaction(() => {
      const cursor = this.getCursor(roomId, agentId, sessionId);
      if (!cursor) throw new Error("not a member of this room");
      const from = cursor.last_read_seq;
      const priorityOnly = unreadSummary?.priorityOnly === true;
      // Captured under the same IMMEDIATE snapshot as the filtered scan. Own
      // rows count toward the cutoff but never toward skipped/remaining.
      const snapshotLatest = priorityOnly
        ? (
            this.db
              .prepare(
                "SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?",
              )
              .get(roomId) as { latest: number }
          ).latest
        : from;
      const priorityPredicate = `(g.priority > 0 OR ${directedAt("g")})`;
      const pageSql = priorityOnly
        ? `SELECT ${messageCols(maxBytes)} FROM ${MESSAGE_FROM}
           WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
             AND ${priorityPredicate}
           ORDER BY g.seq ASC LIMIT ?`
        : `SELECT ${messageCols(maxBytes)} FROM ${MESSAGE_FROM}
           WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
           ORDER BY g.seq ASC LIMIT ?`;
      const pageParams = priorityOnly
        ? [roomId, from, agentId, agentId, agentId, pageLimit]
        : [roomId, from, agentId, pageLimit];
      const { rows, exhausted } = this.fetchBounded<RawMessage>(
        this.db.prepare(pageSql),
        pageParams,
        maxBytes,
      );
      // Exact envelope reserve so the WHOLE response honors maxBytes, not
      // just the messages array. The floor never engages at the schema's
      // 1000-char minimum; it is the stub allowance boundByBytes can honor.
      const { messages, byteLimited } = this.boundByBytes(
        rows,
        previewChars,
        Math.max(
          STUB_ALLOWANCE,
          maxBytes -
            (priorityOnly ? PRIORITY_CATCH_UP_ENVELOPE : CATCH_UP_ENVELOPE),
        ),
        (r, pc) => this.rowToMessage(r, pc),
      );
      let lastSeq =
        messages.length > 0
          ? messages[messages.length - 1].seq
          : priorityOnly
            ? snapshotLatest
            : from;
      // Ordinary catch_up never returns own rows. Move across an own-only
      // suffix now, stopping immediately before the next undelivered peer row.
      // This makes an empty historical self-tail a one-time scan instead of a
      // permanent hot path for the poller and blocking wait.
      if (!priorityOnly) {
        lastSeq = this.ownOnlyFloor(roomId, agentId, lastSeq);
      }
      let skippedCount = 0;
      let qualifyingRemaining = 0;
      if (priorityOnly) {
        qualifyingRemaining = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM messages g
               WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
                 AND ${priorityPredicate}`,
            )
            .get(
              roomId,
              lastSeq,
              agentId,
              agentId,
              agentId,
            ) as { c: number }
        ).c;
        // If every qualifying row in the snapshot was delivered, consume the
        // trailing low-priority chatter too; otherwise priority-only would
        // leave the very backlog it exists to discard. A row/byte cut leaves
        // later qualifying rows unread, so stop at the last delivered one.
        if (qualifyingRemaining === 0) lastSeq = snapshotLatest;
        skippedCount = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM messages g
               WHERE g.room_id = ? AND g.seq > ? AND g.seq <= ?
                 AND g.agent_id != ? AND NOT ${priorityPredicate}`,
            )
            .get(
              roomId,
              from,
              lastSeq,
              agentId,
              agentId,
              agentId,
            ) as { c: number }
        ).c;
      }
      if (lastSeq > from) {
        this.setCursor(roomId, agentId, sessionId, lastSeq);
      }
      // Empty read: same-snapshot disclosure of where the traffic actually
      // is. Emitted even when no other room has unread ([]): that positively
      // answers "is anything anywhere?", the question an empty read raises.
      const UNREAD_SUMMARY_MAX = 20;
      let summary:
        | {
            rooms: {
              room_id: number;
              name: string;
              unread: number;
              directed: number;
            }[];
            truncated: boolean;
          }
        | null = null;
      if (unreadSummary !== null && messages.length === 0) {
        const fetched = this.unreadByRoom(
          agentId,
          unreadSummary.sessionId,
          UNREAD_SUMMARY_MAX,
          roomId,
        );
        // The v0.9 summary was appended after catch_up had already spent the
        // entire page budget. Twenty legal, control-heavy room names could
        // inflate a declared 1k response past 25k. Bound the summary within
        // the same result budget, using the same measured-fit/name-halving
        // pattern as my_mentions.by_room.
        const roomBudget =
          maxBytes -
          (priorityOnly
            ? PRIORITY_CATCH_UP_SUMMARY_ENVELOPE
            : CATCH_UP_SUMMARY_ENVELOPE);
        const fitted = fitRows(fetched.rooms, roomBudget);
        const rooms = fitted.rows;
        let truncated = fetched.truncated || fitted.sizeTrimmed;
        if (rooms.length === 1 && JSON.stringify(rooms).length > roomBudget) {
          let entry = { ...rooms[0] };
          while (
            JSON.stringify([entry]).length > roomBudget &&
            entry.name.length > 0
          ) {
            entry = {
              ...entry,
              name: safeCut(entry.name, Math.floor(entry.name.length / 2)),
            };
          }
          rooms[0] = entry;
          truncated = true;
        }
        summary = { rooms, truncated };
      }
      return {
        messages,
        new_last_read_seq: lastSeq,
        remaining: this.unreadCount(roomId, lastSeq, agentId),
        advanced: lastSeq > from,
        ...(priorityOnly
          ? {
              lossy: true as const,
              priority_only: true as const,
              skipped_count: skippedCount,
              qualifying_remaining: qualifyingRemaining,
              cutoff_seq: lastSeq,
            }
          : {}),
        // !exhausted: fetchBounded stopped on the raw budget with rows behind
        // it that a preview/JSON shrink could otherwise hide. `remaining` is the
        // authoritative "more unread" count here, but keep byte_limited honest.
        ...(byteLimited || !exhausted ? { byte_limited: true } : {}),
        ...(summary !== null ? { rooms_with_unread: summary.rooms } : {}),
        ...(summary?.truncated ? { rooms_with_unread_truncated: true } : {}),
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
      // Fetch ONE more than `limit` so a page cut by the ROW limit (not the
      // byte budget) is detectable. Without the probe, my_mentions was the only
      // bulk reader with no "more remain" signal when exactly `limit` directed
      // messages fit inside the byte budget: an agent paging on byte_limited
      // (the documented signal) then silently under-read its own inbox.
      const { rows: fetched, exhausted } = this.fetchBounded<
        RawMessage & { gid: number; room_id: number; room_name: string }
      >(
        this.db.prepare(
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
             AND NOT EXISTS (SELECT 1 FROM session_presence sp
                             WHERE sp.room_id = g.room_id AND sp.agent_id = mb.agent_id
                               AND sp.session_id = ? AND sp.left_at IS NOT NULL)
           ORDER BY g.id ASC LIMIT ?`,
        ),
        [agentId, sessionKey, afterId, agentId, agentId, agentId, sessionKey, limit + 1],
        maxBytes,
      );
      const hasExtra = fetched.length > limit;
      const rows = hasExtra ? fetched.slice(0, limit) : fetched;

      // total_directed: a SCALAR aggregate over all present, not-this-session-left
      // rooms -- NOT a materialized per-room array reduced in JS (an agent in
      // 100k unread rooms otherwise cloned and sorted the whole set). The
      // NOT EXISTS mutes a room THIS session left even while a twin keeps the
      // identity present. Placeholders: the membership join, the session-marker
      // key, the author exclusion, the directedAt pair, then the presence key.
      const { td } = this.db
        .prepare(
          `SELECT COUNT(*) AS td FROM messages g
           JOIN memberships mb ON mb.room_id = g.room_id
                AND mb.agent_id = ? AND mb.left_at IS NULL
           LEFT JOIN session_markers sm ON sm.room_id = g.room_id
                AND sm.agent_id = mb.agent_id AND sm.session_id = ?
           WHERE g.seq > COALESCE(sm.last_read_seq, mb.last_read_seq)
             AND g.agent_id != ?
             AND ${directedAt("g")}
             AND NOT EXISTS (SELECT 1 FROM session_presence sp
                             WHERE sp.room_id = g.room_id AND sp.agent_id = mb.agent_id
                               AND sp.session_id = ? AND sp.left_at IS NOT NULL)`,
        )
        .get(agentId, sessionKey, agentId, agentId, agentId, sessionKey) as {
        td: number;
      };
      const total_directed = td;

      // by_room: fetch only the TOP rooms by directed count in SQL (bounded
      // memory), most-directed first, then trim to the byte budget. The query
      // lives in unreadByRoom (shared with catch_up's rooms_with_unread) and
      // carries the same session-aware muting and cursor baselines.
      const BY_ROOM_MAX = 4000;
      const byRoomFetch = this.unreadByRoom(agentId, sessionId, BY_ROOM_MAX);
      let byRoom = byRoomFetch.rooms;
      // Rooms past BY_ROOM_MAX (the least-directed) were dropped -- flag it.
      const roomLimitHit = byRoomFetch.truncated;
      const roomBudget = Math.floor(maxBytes / 3);
      // Trim off the end (least-directed rooms, already SQL-ordered) with the
      // LINEAR fitRows, not an O(n^2) re-serialize-per-pop loop. It always keeps
      // at least one row, so the single-entry name-halving below still handles a
      // lone oversized room.
      const trimmed = fitRows(byRoom, roomBudget);
      byRoom = trimmed.rows;
      let by_room_truncated = trimmed.sizeTrimmed || roomLimitHit;
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
      // More remain when the byte budget cut the page (byteLimited),
      // fetchBounded stopped on the raw budget with rows unfetched (!exhausted),
      // OR a further directed row existed beyond `limit` (hasExtra on a full
      // page). The last case is the row-limit cut that used to have no signal;
      // next_after_id has advanced, so paging with after_id delivers the rest.
      const more =
        byteLimited || !exhausted || (hasExtra && messages.length === limit);
      const next_after_id =
        messages.length > 0 ? rows[messages.length - 1].gid : afterId;
      return {
        messages,
        total_directed,
        next_after_id,
        by_room: byRoom,
        ...(by_room_truncated ? { by_room_truncated: true } : {}),
        ...(more ? { byte_limited: true } : {}),
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
    const { rows, exhausted } = this.fetchBounded<RawMessage>(
      this.db.prepare(
        `SELECT ${messageCols(maxBytes)} FROM ${MESSAGE_FROM}
         WHERE ${where} ORDER BY g.seq DESC LIMIT ?`,
      ),
      [...params, limit],
      maxBytes,
    );
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
      // !exhausted: fetchBounded stopped on the raw budget with older rows
      // unfetched (a preview/JSON shrink could otherwise hide them). has_more is
      // the authoritative "older exist" signal (page via before_seq); keep
      // byte_limited honest too.
      ...(byteLimited || !exhausted ? { byte_limited: true } : {}),
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
   * reachable; next_offset points at the first match not returned.
   *
   * ORDER BY rank, g.id: the g.id tie-break makes the order TOTAL and stable
   * (bare `rank` left equal-scoring rows in an arbitrary, run-varying order, so
   * offset paging could repeat or skip them within a snapshot). Paging is still
   * only coherent against a fixed corpus: a better-ranked message inserted
   * BETWEEN pages shifts everything down by one, which no offset scheme over a
   * relevance sort can avoid; callers wanting exactly-once delivery should page
   * in one burst.
   */
  searchMessages(
    roomId: number,
    query: string,
    limit: number,
    offset = 0,
  ): { matches: MessageRow[]; byte_limited?: boolean; next_offset?: number } {
    const off = Math.max(0, Math.floor(offset));
    // Fetch one MORE than asked: a full `limit` page does not by itself prove
    // more exist, so the extra row is the definitive "there is a next page"
    // probe (a page of exactly `limit` matches used to emit a false
    // next_offset that returned nothing).
    const { rows, exhausted } = this.fetchBounded<RawMessage>(
      this.db.prepare(
        `SELECT ${messageCols(DEFAULT_MAX_BYTES)}
         FROM messages_fts f
         JOIN messages g ON g.id = f.rowid
         LEFT JOIN agents a ON a.id = g.agent_id
         LEFT JOIN messages p ON p.room_id = g.room_id AND p.seq = g.reply_to_seq
         WHERE f.body MATCH ? AND g.room_id = ?
         ORDER BY rank, g.id LIMIT ? OFFSET ?`,
      ),
      [query, roomId, limit + 1, off],
      DEFAULT_MAX_BYTES,
    );
    const hasExtra = rows.length > limit;
    const page = hasExtra ? rows.slice(0, limit) : rows;
    const { messages, byteLimited } = this.boundByBytes(
      page,
      undefined,
      DEFAULT_MAX_BYTES - SEARCH_ENVELOPE,
      (r, pc) => this.rowToMessage(r, pc),
    );
    // More remain if the byte bound cut the page, a genuine extra match exists
    // beyond `limit`, OR fetchBounded stopped on the raw byte budget with
    // matches unfetched (!exhausted) -- the last case is invisible to
    // byteLimited when a compact JSON reparse shrinks matches below their raw
    // size, which silently dropped rows with no next_offset before.
    const more =
      byteLimited || !exhausted || (hasExtra && messages.length === limit);
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
      // Reconcile presence too (reap crashed sessions' aged rows, recompute
      // memberships.left_at) so a prune also refreshes who is present.
      this.gcSessionPresence(roomId);
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

  /** Hard-delete a room and all of its messages and memberships. Throws a
   *  clean "already deleted" error if another process removed it first,
   *  instead of reporting a false success with zero counts. */
  deleteRoom(roomId: number): { messages: number; members: number } {
    const tx = this.db.transaction(() => {
      this.requireRoom(roomId);
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
      this.db.prepare("DELETE FROM session_presence WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM claims WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM wait_leases WHERE room_id = ?").run(roomId);
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
    assertStorable(key, "claim key");
    assertMaxLen(key, "claim key", 500);
    assertStorable(note, "claim note");
    assertMaxLen(note, "claim note", 2000);
    const tx = this.db.transaction(() => {
      // Same deleted-room window as postMessage: fail cleanly, not with a
      // raw FK error from the claims INSERT.
      this.requireRoom(roomId);
      const row = this.db
        .prepare(
          `SELECT agent_id, note,
                  strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at,
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
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at
           FROM claims WHERE room_id = ? AND key = ?`,
        )
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
      this.requireRoom(roomId);
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

  /** Active (unexpired) claims in a room, KEYSET-paged by key: pass the prior
   *  page's `next_key` back as `afterKey` for the next page. Keyset, NOT OFFSET,
   *  because a claim expiring (and being pruned) between pages shifts every
   *  OFFSET after it and skips a still-live claim; `key > afterKey` is immune to
   *  that (keys are unique per room and are the sort key). Notes are cut to
   *  listing previews and the whole response is trimmed to a serialized-size
   *  budget. Expired rows are pruned in passing; `total` is the active count. */
  listClaims(
    roomId: number,
    limit = 200,
    afterKey = "",
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
    next_key?: string;
    size_trimmed?: boolean;
  } {
    const PREVIEW = 300;
    const lim = Math.max(1, Math.floor(limit));
    const tx = this.db.transaction(() => {
      this.requireRoom(roomId);
      this.db
        .prepare(
          "DELETE FROM claims WHERE room_id = ? AND expires_at <= datetime('now')",
        )
        .run(roomId);
      // Fetch one MORE than asked to detect a further page without a tail COUNT.
      // key > afterKey is the keyset cursor; afterKey need not still exist (a
      // plain string comparison), so a since-expired cursor key is harmless.
      const rows = this.db
        .prepare(
          `SELECT key, agent_id AS holder,
                  substr(note, 1, ${PREVIEW}) AS note,
                  CASE WHEN length(note) > ${PREVIEW} THEN 1 ELSE 0 END AS note_cut,
                  strftime('%Y-%m-%dT%H:%M:%SZ', expires_at) AS expires_at,
                  (strftime('%s', expires_at) - strftime('%s', 'now')) AS expires_in_seconds
           FROM claims WHERE room_id = ? AND key > ? ORDER BY key LIMIT ?`,
        )
        .all(roomId, afterKey, lim + 1) as {
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
      const hasMore = rows.length > lim;
      const page = hasMore ? rows.slice(0, lim) : rows;
      const mapped = page.map((r) => {
        const { note_cut, ...rest } = r;
        return { ...rest, ...(note_cut ? { note_truncated: true } : {}) };
      });
      const { rows: claims, sizeTrimmed } = fitRows(mapped, LIST_ROW_BUDGET);
      // More remain if the byte budget cut the page OR a further row existed
      // beyond `limit`. next_key is the LAST RETURNED claim's key -- the keyset
      // cursor for the next page; omitted once the page is exhausted.
      const more = sizeTrimmed || (hasMore && claims.length === page.length);
      const next_key =
        more && claims.length > 0 ? claims[claims.length - 1].key : undefined;
      return {
        claims,
        total,
        ...(next_key !== undefined ? { next_key } : {}),
        ...(sizeTrimmed ? { size_trimmed: true } : {}),
      };
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
  // Codepoint-based cut/threshold (parity with preview_chars) so an emoji-heavy
  // reply preview is not cut at half its visible length. flat is at most ~101
  // codepoints (from a 101-codepoint reply_preview), so the spread is cheap.
  return [...flat].length > 100 ? cutToCodepoints(flat, 100) + "..." : flat;
}
