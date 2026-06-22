import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve the shared database file. All agents on a machine talk through one
 * file by default; override with AGENT_CHAT_DB for isolated rooms / testing.
 */
function resolveDbPath(): string {
  const override = process.env.AGENT_CHAT_DB;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}

/** SQLite's default maximum string/blob byte length (SQLITE_MAX_LENGTH). */
export const SQLITE_MAX_LENGTH = 1_000_000_000;

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
};

export type AgentRow = {
  id: string;
  type: string | null;
  role: string | null;
  description: string | null;
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
  at: string;
};

type RawMessage = {
  seq: number;
  agent_id: string;
  from_type: string | null;
  from_role: string | null;
  format: "text" | "json";
  body: string;
  mentions: string | null;
  reply_to_seq: number | null;
  reply_from: string | null;
  reply_preview: string | null;
  created_at: string;
};

// A message row joined to its author and (for reply previews) its parent.
const MESSAGE_COLS = `g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
                      g.format, g.body, g.mentions, g.reply_to_seq, g.created_at,
                      p.agent_id AS reply_from, substr(p.body, 1, 101) AS reply_preview`;

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
  // Both terms are EXISTS so the predicate is strictly two-valued. The reply
  // term must NOT be `reply_to_seq IN (subquery)`: for a broadcast (reply_to_seq
  // NULL) against a non-empty subquery, `NULL IN (...)` is NULL, so the predicate
  // goes NULL and `NOT directedAt` silently drops the row. (seq is unique per
  // room, so matching mm.seq = reply_to_seq AND author is equivalent.)
  return `(EXISTS (SELECT 1 FROM json_each(${alias}.mentions) WHERE value = ?)
           OR EXISTS (
             SELECT 1 FROM messages mm
             WHERE mm.room_id = ${alias}.room_id
               AND mm.seq = ${alias}.reply_to_seq
               AND mm.agent_id = ?))`;
}

export class ChatStore {
  readonly path: string;
  private db: Database.Database;

  constructor(path = resolveDbPath()) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(room_id, reply_to_seq);
    `);

    // Full-text search over message bodies. External-content FTS5 mirrors
    // messages.body keyed by messages.id; triggers keep it in sync.
    const ftsExisted = !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'")
      .get();
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
    if (!ftsExisted) {
      const { c } = this.db
        .prepare("SELECT COUNT(*) AS c FROM messages")
        .get() as { c: number };
      if (c > 0) {
        // Backfill rows that existed before FTS was added.
        this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      }
    }
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
    this.db
      .prepare("UPDATE rooms SET pinned = ? WHERE id = ?")
      .run(pinned, roomId);
  }

  getRoom(roomId: number): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId) as
      | RoomRow
      | undefined;
  }

  /** Exact name lookup (never interprets the value as an id). */
  getRoomByName(name: string): RoomRow | undefined {
    return this.db.prepare("SELECT * FROM rooms WHERE name = ?").get(name) as
      | RoomRow
      | undefined;
  }

  listRooms(): RoomSummary[] {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.description, r.pinned, r.created_at,
                (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id AND m.left_at IS NULL) AS members,
                (SELECT COUNT(*) FROM messages g WHERE g.room_id = r.id) AS messages,
                (SELECT MAX(created_at) FROM messages g WHERE g.room_id = r.id) AS last_activity
         FROM rooms r ORDER BY r.id`,
      )
      .all() as RoomSummary[];
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

  /** Join (or rejoin) a room: clears any prior leave and refreshes liveness. */
  joinRoom(roomId: number, agentId: string): void {
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
  }

  /** Soft leave: keep the row (and read position) but mark not present. */
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
   * Mark an active agent alive. Also clears left_at: an actively-acting session
   * re-asserts presence, so a soft leave performed by another process using the
   * same agent_id does not leave the live session showing as not-present. (A
   * genuine leave_room clears the session, after which touch is never called.)
   */
  touch(roomId: number, agentId: string): void {
    this.db
      .prepare(
        "UPDATE memberships SET last_seen = datetime('now'), left_at = NULL WHERE room_id = ? AND agent_id = ?",
      )
      .run(roomId, agentId);
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

  listAgents(
    roomId: number,
    activeWithinMinutes: number,
    filter?: string,
  ): AgentRow[] {
    const base = `SELECT a.id, a.type, a.role, a.description, m.joined_at,
                         m.last_read_seq, m.last_seen, m.left_at,
                         (strftime('%s','now') - strftime('%s', m.last_seen)) AS idle_seconds
                  FROM memberships m JOIN agents a ON a.id = m.agent_id
                  WHERE m.room_id = ?`;
    let rows: (Omit<AgentRow, "present" | "active"> & {
      left_at: string | null;
    })[];
    if (filter && filter.trim().length > 0) {
      const like = `%${filter.trim()}%`;
      rows = this.db
        .prepare(
          `${base} AND (IFNULL(a.role,'') LIKE ? OR IFNULL(a.type,'') LIKE ?
                        OR IFNULL(a.description,'') LIKE ? OR a.id LIKE ?)
           ORDER BY m.joined_at`,
        )
        .all(roomId, like, like, like, like) as typeof rows;
    } else {
      rows = this.db
        .prepare(`${base} ORDER BY m.joined_at`)
        .all(roomId) as typeof rows;
    }
    const threshold = activeWithinMinutes * 60;
    return rows.map((r) => {
      const { left_at, ...rest } = r;
      return {
        ...rest,
        present: left_at === null,
        active:
          left_at === null &&
          r.idle_seconds !== null &&
          r.idle_seconds <= threshold,
      };
    });
  }

  // --- messages ----------------------------------------------------------

  /** Insert a message, allocating the next per-room seq atomically. */
  postMessage(
    roomId: number,
    agentId: string,
    body: string,
    format: "text" | "json",
    mentions: string[] | null,
    replyToSeq: number | null,
  ): { id: number; seq: number } {
    const mentionsJson =
      mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;
    const tx = this.db.transaction(() => {
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { next: number };
      const info = this.db
        .prepare(
          `INSERT INTO messages (room_id, seq, agent_id, format, body, mentions, reply_to_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, next, agentId, format, body, mentionsJson, replyToSeq);
      return { id: Number(info.lastInsertRowid), seq: next };
    });
    // IMMEDIATE acquires the write lock before reading MAX(seq), so concurrent
    // writer processes cannot allocate the same seq.
    return tx.immediate();
  }

  private rowToMessage(r: RawMessage): MessageRow {
    return {
      seq: r.seq,
      from: r.agent_id,
      from_type: r.from_type,
      from_role: r.from_role,
      format: r.format,
      content: r.format === "json" ? safeParse(r.body) : r.body,
      to: r.mentions ? (safeParse(r.mentions) as string[]) : null,
      reply_to:
        r.reply_to_seq === null
          ? null
          : {
              seq: r.reply_to_seq,
              from: r.reply_from,
              preview: makePreview(r.reply_preview),
            },
      at: r.created_at,
    };
  }

  getMessage(roomId: number, seq: number): MessageRow | undefined {
    const r = this.db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM}
         WHERE g.room_id = ? AND g.seq = ?`,
      )
      .get(roomId, seq) as RawMessage | undefined;
    return r ? this.rowToMessage(r) : undefined;
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

  /** A message plus its parent (if any) and direct replies. */
  getThread(
    roomId: number,
    seq: number,
  ):
    | { message: MessageRow; parent: MessageRow | null; replies: MessageRow[] }
    | undefined {
    const message = this.getMessage(roomId, seq);
    if (!message) return undefined;
    const parentSeq = message.reply_to?.seq ?? null;
    const parent =
      parentSeq !== null ? (this.getMessage(roomId, parentSeq) ?? null) : null;
    const replies = (
      this.db
        .prepare(
          `SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM}
           WHERE g.room_id = ? AND g.reply_to_seq = ?
           ORDER BY g.seq ASC`,
        )
        .all(roomId, seq) as RawMessage[]
    ).map((r) => this.rowToMessage(r));
    return { message, parent, replies };
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
   * Unread messages (seq > last_read_seq), oldest first.
   * Without mentionsMe: advances the read marker.
   * With mentionsMe: a filtered PEEK that does NOT advance the marker, so the
   * broadcast messages it skips are not silently marked read.
   */
  catchUp(
    roomId: number,
    agentId: string,
    limit: number,
    mentionsMe?: string,
    afterSeq?: number,
  ): {
    messages: MessageRow[];
    new_last_read_seq: number;
    remaining: number;
    advanced: boolean;
    next_after_seq?: number;
    unread_total?: number;
    hidden_by_filter?: number;
    hint?: string;
  } {
    if (mentionsMe !== undefined) {
      // Peek mode: filtered, never advances the marker. The rows fetch and the
      // three counts run in one DEFERRED (read) transaction so they all see a
      // single snapshot; otherwise a concurrent writer landing between the
      // separate SELECTs could yield inconsistent numbers (e.g. hidden_by_filter
      // exceeding unread_total). Deferred, not immediate: reads take no lock.
      const peek = this.db.transaction(() => {
        const membership = this.getMembership(roomId, agentId);
        if (!membership) throw new Error("not a member of this room");
        const from = membership.last_read_seq;
        // Page forward through unread mentions without moving the marker:
        // afterSeq (clamped to >= the marker) is the cursor for the next page.
        const lower = afterSeq !== undefined ? Math.max(from, afterSeq) : from;
        const rows = this.db
          .prepare(
            `SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM}
             WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
               AND ${directedAt("g")}
             ORDER BY g.seq ASC LIMIT ?`,
          )
          .all(roomId, lower, agentId, mentionsMe, mentionsMe, limit) as RawMessage[];
        const messages = rows.map((r) => this.rowToMessage(r));
        const lastSeq =
          messages.length > 0 ? messages[messages.length - 1].seq : lower;
        const { c } = this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
               AND ${directedAt("g")}`,
          )
          .get(roomId, lastSeq, agentId, mentionsMe, mentionsMe) as { c: number };
        // Marker-relative totals (NOT page-relative like `remaining`): the peek
        // hides everything not directed at you, so report how much it is hiding
        // so an empty/exhausted peek is not mistaken for "nothing new".
        const unread_total = this.unreadCount(roomId, from, agentId);
        const { c: hidden_by_filter } = this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
               AND NOT ${directedAt("g")}`,
          )
          .get(roomId, from, agentId, mentionsMe, mentionsMe) as { c: number };
        return {
          messages,
          new_last_read_seq: from,
          remaining: c,
          advanced: false,
          next_after_seq: lastSeq,
          unread_total,
          hidden_by_filter,
          ...(hidden_by_filter > 0
            ? {
                hint: `${hidden_by_filter} unread message(s) are not directed at you and are hidden by mentions_me; call catch_up without mentions_me to read the room stream before assuming there is nothing new.`,
              }
            : {}),
        };
      });
      return peek.deferred();
    }

    // Advancing path: read the marker, fetch, and advance inside one IMMEDIATE
    // transaction so a concurrent same-identity call serializes behind it and
    // reads the updated marker instead of returning overlapping messages.
    const tx = this.db.transaction(() => {
      const membership = this.getMembership(roomId, agentId);
      if (!membership) throw new Error("not a member of this room");
      const from = membership.last_read_seq;
      const rows = this.db
        .prepare(
          `SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM}
           WHERE g.room_id = ? AND g.seq > ? AND g.agent_id != ?
           ORDER BY g.seq ASC LIMIT ?`,
        )
        .all(roomId, from, agentId, limit) as RawMessage[];
      const messages = rows.map((r) => this.rowToMessage(r));
      const lastSeq =
        messages.length > 0 ? messages[messages.length - 1].seq : from;
      if (lastSeq > from) {
        this.db
          .prepare(
            "UPDATE memberships SET last_read_seq = ? WHERE room_id = ? AND agent_id = ?",
          )
          .run(lastSeq, roomId, agentId);
      }
      return {
        messages,
        new_last_read_seq: lastSeq,
        remaining: this.unreadCount(roomId, lastSeq, agentId),
        advanced: lastSeq > from,
      };
    });
    return tx.immediate();
  }

  /**
   * Read-only browse (never advances the read marker). No beforeSeq => latest
   * `limit`; else older than beforeSeq. With mentionsMe, only messages directed
   * at that agent.
   */
  readHistory(
    roomId: number,
    limit: number,
    beforeSeq?: number,
    mentionsMe?: string,
  ): { messages: MessageRow[]; oldest_seq: number | null; has_more: boolean } {
    const conds = ["g.room_id = ?"];
    const params: (number | string)[] = [roomId];
    if (beforeSeq !== undefined) {
      conds.push("g.seq < ?");
      params.push(beforeSeq);
    }
    if (mentionsMe !== undefined) {
      conds.push(directedAt("g"));
      params.push(mentionsMe, mentionsMe);
    }
    const where = conds.join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM ${MESSAGE_FROM}
         WHERE ${where} ORDER BY g.seq DESC LIMIT ?`,
      )
      .all(...params, limit) as RawMessage[];
    // Fetched newest-first; present oldest-first for natural reading.
    const messages = rows.map((r) => this.rowToMessage(r)).reverse();
    const oldest = messages.length > 0 ? messages[0].seq : null;

    // has_more: are there older messages matching the same filter?
    let has_more = false;
    if (oldest !== null) {
      const moreConds = ["room_id = ?", "seq < ?"];
      const moreParams: (number | string)[] = [roomId, oldest];
      if (mentionsMe !== undefined) {
        moreConds.push(directedAt("messages"));
        moreParams.push(mentionsMe, mentionsMe);
      }
      has_more = !!this.db
        .prepare(
          `SELECT 1 FROM messages WHERE ${moreConds.join(" AND ")} LIMIT 1`,
        )
        .get(...moreParams);
    }
    return { messages, oldest_seq: oldest, has_more };
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
  ): { previous: number; new: number; latest: number } {
    const tx = this.db.transaction(() => {
      const membership = this.getMembership(roomId, agentId);
      if (!membership) throw new Error("not a member of this room");
      const { latest } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS latest FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { latest: number };
      const target =
        seq === undefined ? latest : Math.max(0, Math.min(seq, latest));
      this.db
        .prepare(
          "UPDATE memberships SET last_read_seq = ? WHERE room_id = ? AND agent_id = ?",
        )
        .run(target, roomId, agentId);
      return { previous: membership.last_read_seq, new: target, latest };
    });
    return tx.immediate();
  }

  /** Full-text search of message bodies in a room, best matches first. */
  searchMessages(roomId: number, query: string, limit: number): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLS}
         FROM messages_fts f
         JOIN messages g ON g.id = f.rowid
         LEFT JOIN agents a ON a.id = g.agent_id
         LEFT JOIN messages p ON p.room_id = g.room_id AND p.seq = g.reply_to_seq
         WHERE f.body MATCH ? AND g.room_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, roomId, limit) as RawMessage[];
    return rows.map((r) => this.rowToMessage(r));
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
    const tx = this.db.transaction(() => {
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
        // (The author has implicitly "seen" its own message, matching catch_up's
        // self-exclusion.) Pass force=true to prune past this.
        const { u } = this.db
          .prepare(
            `SELECT COUNT(*) AS u FROM messages g
             WHERE g.room_id = ? AND g.seq < ?
               AND EXISTS (
                 SELECT 1 FROM memberships mm
                 WHERE mm.room_id = g.room_id
                   AND mm.last_read_seq < g.seq AND mm.agent_id != g.agent_id
               )`,
          )
          .get(roomId, cutoff.seq) as { u: number };
        if (u > 0) {
          const { m } = this.db
            .prepare(
              "SELECT MIN(last_read_seq) AS m FROM memberships WHERE room_id = ?",
            )
            .get(roomId) as { m: number | null };
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
      this.db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
      return { messages, members };
    });
    // IMMEDIATE for the same read-then-write snapshot reason as pruneMessages.
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
  return flat.length > 100 ? flat.slice(0, 100) + "..." : flat;
}
