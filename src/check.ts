#!/usr/bin/env node
// One-shot, read-only probe: does a room have unread messages (or unread
// mentions) for an agent, relative to its read marker (or an explicit --since)?
// Exit 0 = updates exist, 1 = none yet, 2 = error. Prints a JSON status line.
// Used by scripts/wait-for-updates.sh to poll without touching the read marker.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  // Read the value following a flag, failing if it is missing (e.g. a trailing
  // `--db` would otherwise silently leave the value undefined).
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) fail(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mentions-only") {
      out.mentionsOnly = true;
    } else if (a === "--room") {
      out.room = value(i, a);
      i++;
    } else if (a === "--agent") {
      out.agent = value(i, a);
      i++;
    } else if (a === "--since") {
      out.since = Number(value(i, a));
      i++;
    } else if (a === "--db") {
      out.db = value(i, a);
      i++;
    } else {
      fail(`unknown argument: ${a}`);
    }
  }
  return out;
}

function resolveDbPath(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const env = process.env.AGENT_CHAT_DB;
  if (env && env.trim().length > 0) return env.trim();
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}

const args = parseArgs(process.argv.slice(2));
if (!args.room) fail("--room is required");
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
  // when the -wal/-shm sidecars are absent. We only run SELECTs.
  const db = new Database(path);
  db.pragma("busy_timeout = 2000");

  let room = /^\d+$/.test(args.room)
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

  let baseline: number;
  if (args.since !== undefined) {
    baseline = args.since;
  } else {
    if (!args.agent) fail("--agent is required unless --since is given");
    const m = db
      .prepare(
        "SELECT last_read_seq FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(roomId, args.agent) as { last_read_seq: number } | undefined;
    if (!m) {
      fail(
        `agent "${args.agent}" is not a member of room ${roomId}; join first or pass --since`,
      );
    }
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
             AND EXISTS (SELECT 1 FROM json_each(mentions) WHERE value = ?)`,
        )
        .get(roomId, baseline, args.agent, args.agent) as { c: number }
    ).c;
  }

  const latest = (
    db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room_id = ?",
      )
      .get(roomId) as { s: number }
  ).s;
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
