#!/usr/bin/env node
// One-shot, read-only probe: does an agent have unread messages (or unread
// messages directed at it: its mentions or replies to its messages)?
// Default scope is ALL rooms the agent is currently present in; pass --room
// to scope to one room (with an optional --since seq baseline; seqs are
// per-room, so --since requires --room).
// Exit 0 = updates exist, 1 = none yet, 2 = error. Prints a JSON status line.
// Used by scripts/wait-for-updates.sh to poll without touching read markers.
//
// The --agent baseline is the IDENTITY-level marker (memberships.last_read_seq,
// the MAX across that identity's sessions); per-session private cursors are
// keyed by a process-internal nonce this probe cannot see. A private-cursor
// session lagging its twin should pass --since with its own last_read_seq.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { directedAt } from "./db.js";

type Args = {
  room?: string;
  agent?: string;
  since?: number;
  db?: string;
  mentionsOnly: boolean;
};

function fail(msg: string): never {
  process.stderr.write(`agent-chat-check: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { mentionsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    // Accept both `--flag value` and `--flag=value` (the wrapper script
    // accepts the = form for its own flags, so the probe must not reject it).
    let a = argv[i];
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        inline = a.slice(eq + 1);
        a = a.slice(0, eq);
      }
    }
    // Read a flag's value, rejecting missing AND empty/whitespace values: an
    // unset shell variable (`--since "$SEQ"`) used to sail through as
    // Number("") === 0, silently rebasing the watch to seq 0, and
    // `--agent ''` became an identity-less watch that wakes on your own posts.
    const take = (flag: string): string => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) fail(`${flag} requires a value`);
      if (v.trim().length === 0) fail(`${flag} requires a non-empty value`);
      return v;
    };
    if (a === "--mentions-only") {
      if (inline !== undefined) fail("--mentions-only takes no value");
      out.mentionsOnly = true;
    } else if (a === "--room") {
      out.room = take(a);
    } else if (a === "--agent") {
      out.agent = take(a);
    } else if (a === "--since") {
      const v = take(a).trim();
      // Digits only: Number() would also admit "0x10" and "1e3".
      if (!/^\d+$/.test(v)) fail("--since must be a non-negative integer");
      out.since = Number(v);
      // Beyond 2^53 the Number is silently rounded and the comparison runs
      // against a DIFFERENT baseline than the caller passed; no real seq gets
      // anywhere near this, so reject rather than guess.
      if (!Number.isSafeInteger(out.since)) {
        fail("--since is too large to represent exactly");
      }
    } else if (a === "--db") {
      out.db = take(a);
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  return out;
}

function resolveDbPath(override?: string): string {
  // Absolute always: a relative path silently means a different file per cwd.
  // Only the ":memory:" sentinel passes through (URI parsing is not enabled
  // on these opens, so "file:" strings are literal paths).
  const norm = (t: string): string => (t === ":memory:" ? t : resolve(t));
  if (override && override.trim().length > 0) return norm(override.trim());
  const env = process.env.AGENT_CHAT_DB;
  if (env && env.trim().length > 0) return norm(env.trim());
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}

const args = parseArgs(process.argv.slice(2));
if (!args.room && !args.agent) {
  fail("--agent is required (watches all your rooms) unless --room is given");
}
if (args.since !== undefined && args.room === undefined) {
  fail("--since requires --room (seq baselines are per-room)");
}
if (args.mentionsOnly && !args.agent) {
  fail("--mentions-only requires --agent");
}
if (
  args.since !== undefined &&
  (!Number.isInteger(args.since) || args.since < 0)
) {
  fail("--since must be a non-negative integer");
}

const path = resolveDbPath(args.db);
if (!existsSync(path)) fail(`db not found: ${path}`);

// Runtime wrapped so any unexpected DB error exits 2 (error), not 1. Exit 1 is
// reserved for the legitimate "no updates" result; if a throw leaked, Node would
// exit 1 and the poller would misread a broken probe as a quiet room.
try {
  // Read-write open (not readonly): readonly connections to a WAL database fail
  // when the -wal/-shm sidecars are absent. query_only enforces the read-only
  // contract structurally instead of by convention.
  const db = new Database(path);
  db.pragma("busy_timeout = 2000");
  db.pragma("query_only = ON");

  if (!args.room) {
    // All-rooms watch: unread relative to each present membership's marker.
    // All three reads run in one DEFERRED transaction so they see a single
    // snapshot; separate autocommit reads can disagree under concurrent
    // marker updates (e.g. unread=0 alongside nonzero unread_mentions).
    const agent = args.agent;
    if (!agent) fail("--agent is required when watching all rooms");
    const counts = db
      .transaction(() => {
        const { n: rooms } = db
          .prepare(
            "SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND left_at IS NULL",
          )
          .get(agent) as { n: number };
        if (rooms === 0) return null;
        const { c: unread } = db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             JOIN memberships mb ON mb.room_id = g.room_id
                  AND mb.agent_id = ? AND mb.left_at IS NULL
             WHERE g.seq > mb.last_read_seq AND g.agent_id != ?`,
          )
          .get(agent, agent) as { c: number };
        const { c: unreadMentions } = db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             JOIN memberships mb ON mb.room_id = g.room_id
                  AND mb.agent_id = ? AND mb.left_at IS NULL
             WHERE g.seq > mb.last_read_seq AND g.agent_id != ?
               AND ${directedAt("g")}`,
          )
          .get(agent, agent, agent, agent) as { c: number };
        return { rooms, unread, unreadMentions };
      })
      .deferred();
    if (counts === null) fail(`agent "${agent}" is not a member of any room`);
    const { rooms, unread, unreadMentions } = counts as {
      rooms: number;
      unread: number;
      unreadMentions: number;
    };
    db.close();
    const hasUpdates = args.mentionsOnly ? unreadMentions > 0 : unread > 0;
    process.stdout.write(
      JSON.stringify({
        agent,
        rooms,
        unread,
        unread_mentions: unreadMentions,
        mentions_only: args.mentionsOnly,
        has_updates: hasUpdates,
      }) + "\n",
    );
    process.exit(hasUpdates ? 0 : 1);
  }

  // Number.isSafeInteger gate: a numeric ref past 2^53 rounds to a different
  // integer, so a huge --room could watch a neighbouring room's id. Only try
  // the id lookup for exactly-representable integers; else fall to name lookup.
  let room =
    /^\d+$/.test(args.room) && Number.isSafeInteger(Number(args.room))
      ? (db.prepare("SELECT id FROM rooms WHERE id = ?").get(Number(args.room)) as
          | { id: number }
          | undefined)
      : undefined;
  if (!room) {
    room = db.prepare("SELECT id FROM rooms WHERE name = ?").get(args.room) as
      | { id: number }
      | undefined;
  }
  if (!room) fail(`no room "${args.room}"`);
  const roomId = room.id;

  if (args.since === undefined && !args.agent) {
    fail("--agent is required unless --since is given");
  }
  // One DEFERRED transaction = one snapshot for baseline + counts + latest.
  const snap = db
    .transaction(() => {
      let baseline: number;
      if (args.since !== undefined) {
        baseline = args.since;
      } else {
        const m = db
          .prepare(
            "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
          )
          .get(roomId, args.agent) as { last_read_seq: number } | undefined;
        if (!m) return null;
        baseline = m.last_read_seq;
      }

      // Exclude the agent's own messages: posting should not make you "have updates".
      const unread = (
        args.agent
          ? (db
              .prepare(
                "SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND seq > ? AND agent_id != ?",
              )
              .get(roomId, baseline, args.agent) as { c: number })
          : (db
              .prepare(
                "SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND seq > ?",
              )
              .get(roomId, baseline) as { c: number })
      ).c;

      let unreadMentions = 0;
      if (args.agent) {
        unreadMentions = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM messages
               WHERE room_id = ? AND seq > ? AND agent_id != ?
                 AND ${directedAt("messages")}`,
            )
            .get(roomId, baseline, args.agent, args.agent, args.agent) as { c: number }
        ).c;
      }

      const latest = (
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room_id = ?",
          )
          .get(roomId) as { s: number }
      ).s;
      return { baseline, unread, unreadMentions, latest };
    })
    .deferred();
  if (snap === null) {
    fail(
      `agent "${args.agent}" is not a member of room ${roomId}; join first or pass --since`,
    );
  }
  const { baseline, unread, unreadMentions, latest } = snap as {
    baseline: number;
    unread: number;
    unreadMentions: number;
    latest: number;
  };
  db.close();

  const hasUpdates = args.mentionsOnly ? unreadMentions > 0 : unread > 0;
  process.stdout.write(
    JSON.stringify({
      room_id: roomId,
      agent: args.agent ?? null,
      baseline_seq: baseline,
      latest_seq: latest,
      unread,
      unread_mentions: unreadMentions,
      mentions_only: args.mentionsOnly,
      has_updates: hasUpdates,
    }) + "\n",
  );
  process.exit(hasUpdates ? 0 : 1);
} catch (e) {
  fail(`probe failed: ${e instanceof Error ? e.message : String(e)}`);
}
