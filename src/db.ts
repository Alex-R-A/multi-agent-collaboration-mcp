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

export type RoomRow = {
  id: number;
  name: string;
  description: string | null;
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
};

export type MessageRow = {
  seq: number;
  from: string;
  from_type: string | null;
  from_role: string | null;
  format: "text" | "json";
  content: unknown;
  reply_to_seq: number | null;
  at: string;
};

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
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id      INTEGER NOT NULL REFERENCES rooms(id),
        seq          INTEGER NOT NULL,
        agent_id     TEXT NOT NULL REFERENCES agents(id),
        format       TEXT NOT NULL DEFAULT 'text',
        body         TEXT NOT NULL,
        reply_to_seq INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (room_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
    `);
  }

  // --- rooms -------------------------------------------------------------

  createRoom(name: string, description: string | null): RoomRow {
    const info = this.db
      .prepare("INSERT INTO rooms (name, description) VALUES (?, ?)")
      .run(name, description);
    return this.db
      .prepare("SELECT * FROM rooms WHERE id = ?")
      .get(info.lastInsertRowid) as RoomRow;
  }

  listRooms(): RoomSummary[] {
    return this.db
      .prepare(
        `SELECT r.id, r.name, r.description, r.created_at,
                (SELECT COUNT(*) FROM memberships m WHERE m.room_id = r.id) AS members,
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

  joinRoom(roomId: number, agentId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO memberships (room_id, agent_id) VALUES (?, ?)",
      )
      .run(roomId, agentId);
  }

  getMembership(
    roomId: number,
    agentId: string,
  ): { last_read_seq: number } | undefined {
    return this.db
      .prepare(
        "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, agentId) as { last_read_seq: number } | undefined;
  }

  listAgents(roomId: number, filter?: string): AgentRow[] {
    if (filter && filter.trim().length > 0) {
      const like = `%${filter.trim()}%`;
      return this.db
        .prepare(
          `SELECT a.id, a.type, a.role, a.description, m.joined_at, m.last_read_seq
           FROM memberships m JOIN agents a ON a.id = m.agent_id
           WHERE m.room_id = ?
             AND (IFNULL(a.role,'') LIKE ? OR IFNULL(a.type,'') LIKE ?
                  OR IFNULL(a.description,'') LIKE ? OR a.id LIKE ?)
           ORDER BY m.joined_at`,
        )
        .all(roomId, like, like, like, like) as AgentRow[];
    }
    return this.db
      .prepare(
        `SELECT a.id, a.type, a.role, a.description, m.joined_at, m.last_read_seq
         FROM memberships m JOIN agents a ON a.id = m.agent_id
         WHERE m.room_id = ? ORDER BY m.joined_at`,
      )
      .all(roomId) as AgentRow[];
  }

  // --- messages ----------------------------------------------------------

  /** Insert a message, allocating the next per-room seq atomically. */
  postMessage(
    roomId: number,
    agentId: string,
    body: string,
    format: "text" | "json",
    replyToSeq: number | null,
  ): { id: number; seq: number } {
    const tx = this.db.transaction(() => {
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE room_id = ?",
        )
        .get(roomId) as { next: number };
      const info = this.db
        .prepare(
          `INSERT INTO messages (room_id, seq, agent_id, format, body, reply_to_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(roomId, next, agentId, format, body, replyToSeq);
      return { id: Number(info.lastInsertRowid), seq: next };
    });
    // IMMEDIATE acquires the write lock before reading MAX(seq), so concurrent
    // writer processes cannot allocate the same seq.
    return tx.immediate();
  }

  private rowToMessage(r: {
    seq: number;
    agent_id: string;
    from_type: string | null;
    from_role: string | null;
    format: "text" | "json";
    body: string;
    reply_to_seq: number | null;
    created_at: string;
  }): MessageRow {
    return {
      seq: r.seq,
      from: r.agent_id,
      from_type: r.from_type,
      from_role: r.from_role,
      format: r.format,
      content: r.format === "json" ? safeParse(r.body) : r.body,
      reply_to_seq: r.reply_to_seq,
      at: r.created_at,
    };
  }

  getMessage(roomId: number, seq: number): MessageRow | undefined {
    const r = this.db
      .prepare(
        `SELECT g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
                g.format, g.body, g.reply_to_seq, g.created_at
         FROM messages g LEFT JOIN agents a ON a.id = g.agent_id
         WHERE g.room_id = ? AND g.seq = ?`,
      )
      .get(roomId, seq) as Parameters<ChatStore["rowToMessage"]>[0] | undefined;
    return r ? this.rowToMessage(r) : undefined;
  }

  unreadCount(roomId: number, lastReadSeq: number): number {
    const { c } = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND seq > ?",
      )
      .get(roomId, lastReadSeq) as { c: number };
    return c;
  }

  /** Unread messages (seq > last_read_seq), oldest first, advancing the marker. */
  catchUp(
    roomId: number,
    agentId: string,
    limit: number,
  ): { messages: MessageRow[]; new_last_read_seq: number; remaining: number } {
    const membership = this.getMembership(roomId, agentId);
    if (!membership) throw new Error("not a member of this room");
    const from = membership.last_read_seq;
    const rows = this.db
      .prepare(
        `SELECT g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
                g.format, g.body, g.reply_to_seq, g.created_at
         FROM messages g LEFT JOIN agents a ON a.id = g.agent_id
         WHERE g.room_id = ? AND g.seq > ?
         ORDER BY g.seq ASC LIMIT ?`,
      )
      .all(roomId, from, limit) as Parameters<ChatStore["rowToMessage"]>[0][];
    const messages = rows.map((r) => this.rowToMessage(r));
    const newMarker =
      messages.length > 0 ? messages[messages.length - 1].seq : from;
    if (newMarker > from) {
      this.db
        .prepare(
          "UPDATE memberships SET last_read_seq = ? WHERE room_id = ? AND agent_id = ?",
        )
        .run(newMarker, roomId, agentId);
    }
    return {
      messages,
      new_last_read_seq: newMarker,
      remaining: this.unreadCount(roomId, newMarker),
    };
  }

  /** Read-only browse. No beforeSeq => latest `limit`; else older than beforeSeq. */
  readHistory(
    roomId: number,
    limit: number,
    beforeSeq?: number,
  ): { messages: MessageRow[]; oldest_seq: number | null; has_more: boolean } {
    const rows = (
      beforeSeq !== undefined
        ? this.db
            .prepare(
              `SELECT g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
                      g.format, g.body, g.reply_to_seq, g.created_at
               FROM messages g LEFT JOIN agents a ON a.id = g.agent_id
               WHERE g.room_id = ? AND g.seq < ?
               ORDER BY g.seq DESC LIMIT ?`,
            )
            .all(roomId, beforeSeq, limit)
        : this.db
            .prepare(
              `SELECT g.seq, g.agent_id, a.type AS from_type, a.role AS from_role,
                      g.format, g.body, g.reply_to_seq, g.created_at
               FROM messages g LEFT JOIN agents a ON a.id = g.agent_id
               WHERE g.room_id = ?
               ORDER BY g.seq DESC LIMIT ?`,
            )
            .all(roomId, limit)
    ) as Parameters<ChatStore["rowToMessage"]>[0][];
    // Fetched newest-first; present oldest-first for natural reading.
    const messages = rows.map((r) => this.rowToMessage(r)).reverse();
    const oldest = messages.length > 0 ? messages[0].seq : null;
    const has_more =
      oldest !== null &&
      (this.db
        .prepare(
          "SELECT 1 FROM messages WHERE room_id = ? AND seq < ? LIMIT 1",
        )
        .get(roomId, oldest)
        ? true
        : false);
    return { messages, oldest_seq: oldest, has_more };
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
