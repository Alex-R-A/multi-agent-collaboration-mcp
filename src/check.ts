#!/usr/bin/env node
// One-shot, read-only probe: does an agent have unread messages (or unread
// messages directed at it: its mentions or replies to its messages)?
// Default scope is ALL rooms the agent is currently present in; pass --room
// to scope to one room (with an optional --since seq baseline; seqs are
// per-room, so --since requires --room).
// Exit 0 = updates exist, 1 = none yet, 2 = error. Prints a JSON status line.
// Diagnostic one-shot. The background watcher is src/poller.ts and keeps one
// connection instead of launching this process on every interval.
//
// The bare --agent baseline is the IDENTITY-level marker
// (memberships.last_read_seq, the MAX across that identity's sessions), which
// can hide a lagging private session's backlog. --session (the process nonce
// the server bakes into poller_cmd) fixes that for the all-rooms watch: each
// room then baselines off that session's OWN private cursor where one exists.
// The manual fallback remains --room with --since = the session's own
// last_read_seq.
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
  session?: string;
  mentionsOnly: boolean;
  wakeOnly: boolean;
};

function fail(msg: string): never {
  process.stderr.write(`agent-chat-check: ${msg}\n`);
  process.exit(2);
}

const USAGE = `agent-chat-check: one-shot, read-only unread probe.
Usage:
  check.js --agent <agent_id> [--session <nonce>] [--mentions-only]   # all rooms
  check.js --room <id|name> --agent <agent_id> [--since <seq>]        # one room
Flags:
  --agent <id>        identity to check; baselines are its read markers
  --room <id|name>    scope to one room (default: every room the agent is in)
  --since <seq>       explicit baseline instead of the read marker (needs --room)
  --session <nonce>   session-aware all-rooms probe: mutes rooms that session
                      left, baselines off its private cursors where they exist
  --mentions-only     count only messages that mention --agent or reply to it
  --help, -h          print this and exit 0
Exit codes: 0 = updates exist (JSON status on stdout; rooms_with_updates names
up to 20 firing rooms on the all-rooms path and
rooms_with_updates_truncated:true means more fired), 1 = nothing new, 2 = error.
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { mentionsOnly: false, wakeOnly: false };
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
    } else if (a === "--wake-only") {
      // Internal poller mode: on a quiet cycle, answer via indexed EXISTS and
      // skip exact counts that no caller will see. Kept out of --help because
      // direct one-shot users should retain the full status object.
      if (inline !== undefined) fail("--wake-only takes no value");
      out.wakeOnly = true;
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
    } else if (a === "--session") {
      // A process nonce that makes the ALL-ROOMS watch session-aware, twice
      // over: rooms the owning session soft-left (a session_presence row with
      // left_at set) are excluded, matching my_mentions, and each room
      // baselines off that session's OWN private cursor where one exists
      // (session_markers is keyed by the same nonce). Without the cursor
      // baseline a private session whose twin read ahead was never woken: the
      // identity marker is the MAX across sessions, so its own unread was
      // invisible here while its catch_up still had messages. Only meaningful
      // with the all-rooms (no --room) path; ignored otherwise.
      out.session = take(a);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
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
        // Session-aware, only when --session is given: exclude rooms this
        // session soft-left (parity with my_mentions), and baseline each room
        // off this session's OWN private cursor where one exists (COALESCE to
        // the identity marker; parity with the session's catch_up).
        const sess = args.session;
        const smJoin = sess
          ? ` LEFT JOIN session_markers sm ON sm.room_id = mb.room_id
                  AND sm.agent_id = mb.agent_id AND sm.session_id = ?`
          : "";
        const baseline = sess
          ? "COALESCE(sm.last_read_seq, mb.last_read_seq)"
          : "mb.last_read_seq";
        const sessClause = sess
          ? ` AND NOT EXISTS (SELECT 1 FROM session_presence sp
               WHERE sp.room_id = mb.room_id AND sp.agent_id = mb.agent_id
                 AND sp.session_id = ? AND sp.left_at IS NOT NULL)`
          : "";
        // Rooms count stays IDENTITY-level: it only distinguishes a doomed
        // watch (identity in no room -> fail) from a live one. A session that
        // left all its rooms while a twin keeps the identity present is NOT
        // doomed -- its session-filtered unread below is simply 0 (exit 1, no
        // updates), never an error.
        const { n: rooms } = db
          .prepare(
            "SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND left_at IS NULL",
          )
          .get(agent) as { n: number };
        if (rooms === 0) return null;
        if (args.wakeOnly) {
          const candidateClause = args.mentionsOnly
            ? ` AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)
                AND ${directedAt("g")}`
            : "";
          const hit = db
            .prepare(
              `SELECT 1 FROM messages g
               JOIN memberships mb ON mb.room_id = g.room_id
                    AND mb.agent_id = ? AND mb.left_at IS NULL${smJoin}
               WHERE g.seq > ${baseline} AND g.agent_id != ?
                 ${candidateClause}${sessClause}
               LIMIT 1`,
            )
            .get(
              ...(sess
                ? args.mentionsOnly
                  ? [agent, sess, agent, agent, agent, sess]
                  : [agent, sess, agent, sess]
                : args.mentionsOnly
                  ? [agent, agent, agent, agent]
                  : [agent, agent]),
            );
          if (!hit) return { rooms, wakeOnlyQuiet: true as const };
        }
        const { c: unread } = db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             JOIN memberships mb ON mb.room_id = g.room_id
                  AND mb.agent_id = ? AND mb.left_at IS NULL${smJoin}
             WHERE g.seq > ${baseline} AND g.agent_id != ?${sessClause}`,
          )
          .get(...(sess ? [agent, sess, agent, sess] : [agent, agent])) as { c: number };
        const { c: unreadMentions } = db
          .prepare(
            `SELECT COUNT(*) AS c FROM messages g
             JOIN memberships mb ON mb.room_id = g.room_id
                  AND mb.agent_id = ? AND mb.left_at IS NULL${smJoin}
             WHERE g.seq > ${baseline} AND g.agent_id != ?
               AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)
               AND ${directedAt("g")}${sessClause}`,
          )
          .get(
            ...(sess
              ? [agent, sess, agent, agent, agent, sess]
              : [agent, agent, agent, agent]),
          ) as { c: number };
        // Which rooms fired: same baseline/muting as the counts, read in the
        // same snapshot. Gated behind an actual wake (quiet interval polls,
        // the overwhelmingly common case, must not pay for the GROUP BY).
        // Placeholders in SQL text order: the directedAt pair (SELECT), the
        // membership join, the session key (if any), the author exclusion,
        // the presence key (if any).
        let roomsWithUpdates:
          | { room_id: number; name: string; unread: number; directed: number }[]
          | null = null;
        let roomsWithUpdatesTruncated = false;
        if (args.mentionsOnly ? unreadMentions > 0 : unread > 0) {
          const mentionsHaving = args.mentionsOnly
            ? " HAVING directed > 0"
            : "";
          const candidateClause = args.mentionsOnly
            ? " AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)"
            : "";
          const grouped = db
            .prepare(
              `SELECT g.room_id AS room_id, r.name AS name, COUNT(*) AS unread,
                      SUM(CASE WHEN ${directedAt("g")} THEN 1 ELSE 0 END) AS directed
               FROM messages g
               JOIN memberships mb ON mb.room_id = g.room_id
                    AND mb.agent_id = ? AND mb.left_at IS NULL${smJoin}
               JOIN rooms r ON r.id = g.room_id
               WHERE g.seq > ${baseline} AND g.agent_id != ?${candidateClause}${sessClause}
               GROUP BY g.room_id, r.name
               ${mentionsHaving}
               ORDER BY directed DESC, unread DESC, g.room_id ASC
               LIMIT 21`,
            )
            .all(
              ...(sess
                ? [agent, agent, agent, sess, agent, sess]
                : [agent, agent, agent, agent]),
            ) as { room_id: number; name: string; unread: number; directed: number }[];
          // The summary drives which rooms callers read next. Silently
          // dropping its tail made firing rooms look quiet; in mentions-only
          // mode, broadcast-only groups did not fire and must not appear.
          roomsWithUpdatesTruncated = grouped.length > 20;
          roomsWithUpdates = roomsWithUpdatesTruncated
            ? grouped.slice(0, 20)
            : grouped;
        }
        return {
          rooms,
          unread,
          unreadMentions,
          roomsWithUpdates,
          roomsWithUpdatesTruncated,
        };
      })
      .deferred();
    if (counts === null) fail(`agent "${agent}" is not a member of any room`);
    if ("wakeOnlyQuiet" in counts && counts.wakeOnlyQuiet) {
      db.close();
      process.stdout.write(
        JSON.stringify({
          agent,
          rooms: counts.rooms,
          ...(args.mentionsOnly ? { unread_count_skipped: true } : { unread: 0 }),
          unread_mentions: 0,
          mentions_only: args.mentionsOnly,
          has_updates: false,
        }) + "\n",
      );
      process.exit(1);
    }
    const {
      rooms,
      unread,
      unreadMentions,
      roomsWithUpdates,
      roomsWithUpdatesTruncated,
    } = counts as {
      rooms: number;
      unread: number;
      unreadMentions: number;
      roomsWithUpdates:
        | { room_id: number; name: string; unread: number; directed: number }[]
        | null;
      roomsWithUpdatesTruncated: boolean;
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
        ...(roomsWithUpdates !== null
          ? { rooms_with_updates: roomsWithUpdates }
          : {}),
        ...(roomsWithUpdatesTruncated
          ? { rooms_with_updates_truncated: true }
          : {}),
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

      if (args.wakeOnly) {
        const authorClause = args.agent ? " AND agent_id != ?" : "";
        const directedClause = args.mentionsOnly
          ? ` AND (mentions IS NOT NULL OR reply_to_agent IS NOT NULL)
              AND ${directedAt("messages")}`
          : "";
        const hit = db
          .prepare(
            `SELECT 1 FROM messages
             WHERE room_id = ? AND seq > ?${authorClause}${directedClause}
             LIMIT 1`,
          )
          .get(
            roomId,
            baseline,
            ...(args.agent ? [args.agent] : []),
            ...(args.mentionsOnly && args.agent
              ? [args.agent, args.agent]
              : []),
          );
        if (!hit) return { baseline, wakeOnlyQuiet: true as const };
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
                 AND (mentions IS NOT NULL OR reply_to_agent IS NOT NULL)
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
  if ("wakeOnlyQuiet" in snap && snap.wakeOnlyQuiet) {
    db.close();
    process.stdout.write(
      JSON.stringify({
        room_id: roomId,
        agent: args.agent ?? null,
        baseline_seq: snap.baseline,
        ...(args.mentionsOnly ? { unread_count_skipped: true } : { unread: 0 }),
        unread_mentions: 0,
        mentions_only: args.mentionsOnly,
        has_updates: false,
      }) + "\n",
    );
    process.exit(1);
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
