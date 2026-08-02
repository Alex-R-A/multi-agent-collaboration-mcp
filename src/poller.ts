#!/usr/bin/env node
// One bounded watcher: hold one SQLite connection and run one indexed LIMIT 1
// probe after each sleep. No shell loop, subprocesses, temp output, counts, or
// grouping. A hit identifies one room; catch_up does the actual read.
import Database from "better-sqlite3";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Args = {
  agent: string;
  room?: string;
  ownerPid?: number;
  db?: string;
  mentionsOnly: boolean;
  intervalSeconds: number;
  timeoutSeconds: number;
  timeoutOk: boolean;
};

type Hit = { room_id: number; room_name: string };

const USAGE = `agent-chat-poller: wait for unread work with one SQLite probe every five seconds.
Usage:
  poller.js --agent <id> [--room <id|name>] [--owner-pid <pid>]
            [--mentions-only] [--interval <seconds>] [--timeout <seconds>]
            [--ok-on-timeout]

The interval must be 5..3600 seconds (default 5). The timeout must be
1..86400 seconds (default 1200). Exit 0 = work exists; with --ok-on-timeout,
exit 0 also reports a quiet deadline as has_updates:false. Without it,
timeout exits 124. Exit 2 = invalid arguments, duplicate watcher, DB error, or
a terminal watcher state. Inspect stderr before re-arming:
  retired_identity      persona is terminally retired; it can never watch again
  left_room             persona left the scoped room
  left_all_rooms        persona left every joined room
  no_room_memberships   persona has no remaining room memberships

retired_identity is the one state no new command can fix. The others describe a
persona that still exists and can rejoin; a retired persona cannot, so it takes
precedence over every membership state. A retired persona keeps its history and
its non-advancing reads still work; what it can never do again is post, advance
a read marker, claim, join, or be watched.

There is no tenure argument. An agent_id is allocated once and never deleted,
reinserted, revived, or rebound, so it names one identity for the life of the
database; every probe re-reads that identity's live state, which is the whole
fence. --owner-pid alone marks a GENERATED watcher owned by an MCP process and
enables its guarded liveness heartbeat; without it the watcher is strictly
read-only.
`;

function argumentError(message: string): never {
  throw new Error(message);
}

function parseInteger(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) argumentError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    argumentError(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  let agent: string | undefined;
  let room: string | undefined;
  let ownerPid: number | undefined;
  let db: string | undefined;
  let mentionsOnly = false;
  let intervalSeconds = 5;
  let timeoutSeconds = 1200;
  let timeoutOk = false;

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline: string | undefined;
    const eq = flag.indexOf("=");
    if (eq !== -1) {
      inline = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const take = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || value.trim() === "") {
        argumentError(`${flag} requires a non-empty value`);
      }
      return value.trim();
    };

    if (flag === "--agent") agent = take();
    else if (flag === "--room") room = take();
    else if (flag === "--owner-pid") {
      ownerPid = parseInteger(take(), flag, 1, 2_147_483_647);
    }
    else if (flag === "--db") db = take();
    else if (flag === "--interval") {
      intervalSeconds = parseInteger(take(), flag, 5, 3600);
    } else if (flag === "--timeout") {
      timeoutSeconds = parseInteger(take(), flag, 1, 86_400);
    } else if (flag === "--mentions-only") {
      if (inline !== undefined) argumentError(`${flag} takes no value`);
      mentionsOnly = true;
    } else if (flag === "--ok-on-timeout") {
      if (inline !== undefined) argumentError(`${flag} takes no value`);
      timeoutOk = true;
    } else if (flag === "--since") {
      argumentError(
        "--since is intentionally unsupported: a frozen baseline re-fires forever once crossed; every probe reads the current read marker instead",
      );
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      argumentError(`unknown argument: ${flag}`);
    }
  }

  if (!agent) argumentError("--agent is required");
  if (agent.length > 200) argumentError("--agent is too long");
  if (room && room.length > 500) argumentError("--room is too long");
  return {
    agent,
    room,
    ownerPid,
    db,
    mentionsOnly,
    intervalSeconds,
    timeoutSeconds,
    timeoutOk,
  };
}

function dbPath(override?: string): string {
  const value = override ?? process.env.AGENT_CHAT_DB;
  if (value && value.trim()) {
    const trimmed = value.trim();
    return trimmed === ":memory:" ? trimmed : resolve(trimmed);
  }
  return join(homedir(), ".agent-chat-mcp", "chat.db");
}

function processIsAlive(pid: number): boolean {
  // Existence only, not process identity. A recycled PID is indistinguishable
  // here from the process that originally owned it; closing that portability
  // gap requires a process-instance protocol rather than another PID check.
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireLock(path: string, token: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      try {
        unlinkSync(path);
      } catch {}
      throw error;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner: number;
    try {
      const metadata = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: unknown;
        token?: unknown;
      };
      if (
        typeof metadata.pid !== "number" ||
        !Number.isSafeInteger(metadata.pid) ||
        metadata.pid < 1 ||
        typeof metadata.token !== "string" ||
        metadata.token.length === 0
      ) {
        throw new Error("invalid watcher lock metadata");
      }
      owner = metadata.pid;
    } catch {
      // The exclusive create publishes the pathname before the tiny metadata
      // write completes. A contender can therefore observe an empty or partial
      // live lock. Preserve exclusion without falsely calling that lock stale.
      argumentError(
        `watcher lock metadata could not be read or validated; the lock may be ` +
          `initializing or stale, so acquisition is refused (lock: ${path}). ` +
          `Retry without removing it; inspect this exact lock before any manual ` +
          `recovery`,
      );
    }
    if (processIsAlive(owner)) {
      argumentError(
        `watcher lock references live pid ${owner}; refusing a duplicate (lock: ${path})`,
      );
    }
    // Fail closed. Automatic stale-lock stealing needs a second interprocess
    // lock to avoid two reapers deleting each other's replacement.
    argumentError(
      `stale watcher lock file: ${path}; remove only this exact file, then retry`,
    );
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

async function sleepWhileOwnerAlive(
  milliseconds: number,
  ownerPid: number | undefined,
): Promise<boolean> {
  // A watcher with no owner has nothing to check for; let its single timer
  // sleep the whole interval instead of waking every five seconds to ask.
  if (ownerPid === undefined) {
    await sleep(milliseconds);
    return true;
  }
  // An owned watcher subdivides the interval so it notices a dead owner within
  // five seconds rather than at the next probe, which may be an hour away. This
  // is a liveness CHECK of another process, unrelated to the last_seen
  // heartbeat this watcher writes for its own persona.
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await sleep(Math.min(5_000, remaining));
    if (!processIsAlive(ownerPid)) return false;
  }
}

let database: Database.Database | null = null;
const lockPaths: string[] = [];
const lockToken = randomUUID();
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    database?.close();
  } catch {}
  for (const lockPath of lockPaths) {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as {
        token?: string;
      };
      if (current.token === lockToken) unlinkSync(lockPath);
    } catch {}
  }
}

// Install lifecycle guards before argument parsing, database opening, and lock
// acquisition. A SIGHUP or broken output pipe must not strand the fail-closed
// watcher lock. Cleanup is synchronous/idempotent, so the exit hook also covers
// ordinary process.exit() calls and exceptions outside the main try/finally.
function terminate(code: number): never {
  cleanup();
  process.exit(code);
}
process.once("exit", cleanup);
process.once("SIGHUP", () => terminate(129));
process.once("SIGINT", () => terminate(130));
process.once("SIGTERM", () => terminate(143));
process.stdout.once("error", () => terminate(2));
process.stderr.once("error", () => terminate(2));

let exitCode = 2;
try {
  const args = parseArgs(process.argv.slice(2));
  if (args.ownerPid !== undefined && !processIsAlive(args.ownerPid)) {
    argumentError(
      `owner MCP process ${args.ownerPid} has ended; regenerate the poller command`,
    );
  }
  const requestedPath = dbPath(args.db);
  if (requestedPath === ":memory:" || !existsSync(requestedPath)) {
    argumentError(`database not found: ${requestedPath}`);
  }
  // Canonicalize symlinks before deriving the singleton key, so aliases of
  // the same SQLite file cannot acquire separate watcher locks.
  const path = realpathSync(requestedPath);

  database = new Database(path);
  database.pragma("busy_timeout = 2000");
  // A GENERATED runtime watcher -- one this server's wait_for_messages handed
  // out, identified by carrying --owner-pid -- refreshes its
  // persona's last_seen so an armed seat does not read as offline while the
  // model is between turns. Nothing else the watcher does may write, and a
  // watcher without it (a hand-run diagnostic watch) stays strictly
  // read-only.
  const heartbeatEnabled = args.ownerPid !== undefined;
  if (!heartbeatEnabled) database.pragma("query_only = ON");

  let resolvedRoom: { id: number; name: string } | undefined;
  if (args.room) {
    const numericRoom =
      /^\d+$/.test(args.room) && Number.isSafeInteger(Number(args.room));
    resolvedRoom = numericRoom
      ? (database
          .prepare("SELECT id, name FROM rooms WHERE id = ?")
          .get(Number(args.room)) as { id: number; name: string } | undefined)
      : (database
          .prepare("SELECT id, name FROM rooms WHERE name = ?")
          .get(args.room) as { id: number; name: string } | undefined);
    if (!resolvedRoom) argumentError(`no room "${args.room}"`);
  }

  // ONE lock directory, per OS user. A shared /tmp/agent-chat-pollers would make
  // the first user to create it the 0700 owner and lock every other user out of
  // running a watcher at all, so POSIX gets a uid suffix. Elsewhere tmpdir() is
  // already per-user.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const lockDir = join(
    tmpdir(),
    uid === null ? "agent-chat-pollers" : `agent-chat-pollers-${uid}`,
  );
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockStat = lstatSync(lockDir);
  if (!lockStat.isDirectory()) {
    argumentError(`watcher lock path is not a directory: ${lockDir}`);
  }
  if (uid !== null && lockStat.uid !== uid) {
    argumentError(`watcher lock directory is owned by another user: ${lockDir}`);
  }
  // Owned and diagnostic watches have different functions: the owned watcher
  // maintains liveness while the diagnostic watcher is read-only. Keep their
  // locks separate so a stray diagnostic cannot block the generated wake
  // channel and heartbeat. The numeric owner PID is not part of the identity;
  // only the watcher class matters.
  const scopeKey = JSON.stringify([
    path,
    args.agent,
    resolvedRoom?.id ?? null,
    args.ownerPid === undefined ? "diagnostic" : "owned",
    args.mentionsOnly,
  ]);
  const lockName =
    createHash("sha256").update(scopeKey).digest("hex") + ".lock";
  const lockPath = join(lockDir, lockName);
  // Register before acquiring: a signal delivered immediately after the
  // synchronous create still lets cleanup find the token-owned file.
  lockPaths.push(lockPath);
  acquireLock(lockPath, lockToken);

  const params: Record<string, string | number> = { agent: args.agent };

  /**
   * A terminally retired identity can never watch again.
   *
   * Checked unconditionally on every watcher, generated or hand-run. This is
   * the complete identity fence: an agent_id has one tenure, so "is this
   * identity finished" is the only question, and a watcher for a finished one
   * must exit rather than report traffic to a seat that cannot act on it or
   * advance its marker over it.
   *
   * It also takes precedence over every membership state. "left the room" and
   * "no memberships" describe a persona that can rejoin; a retired one cannot,
   * and telling a caller to rejoin would be advice that cannot be followed.
   */
  const checkRetired = (retiredAt: string | null): void => {
    if (retiredAt !== null) {
      argumentError(
        `retired_identity: persona "${args.agent}" is terminally retired. No ` +
          `watcher can represent it, and it can never post, advance a read ` +
          `marker, claim, or join again; its history stands and non-advancing ` +
          `reads of it still work. No new poller command will work for it. ` +
          `Identify a live persona and arm a watcher from that.`,
      );
    }
  };

  /**
   * A VANISHED persona stops every watcher, generated or hand-run. Looping
   * quietly against a deleted row is the one outcome no caller can interpret,
   * so it is a terminal exit rather than a quiet continue.
   */
  const checkExists = (exists: boolean): void => {
    if (!exists) {
      argumentError(
        `persona "${args.agent}" no longer exists; this watcher has nothing to watch`,
      );
    }
  };

  // ARM-TIME identity gate, before ANY membership state is consulted, for both
  // the scoped and all-room paths.
  //
  // Order is the point: identity outranks membership. A retired persona must
  // report retired_identity rather than left_room / left_all_rooms /
  // no_room_memberships, all of which imply a recoverable situation.
  //
  // Read identity and membership from one snapshot.
  //
  // Read as separate autocommit statements these disagree, and the disagreement
  // is exactly the ordering this gate exists to enforce: retirement updates
  // agents.retired_at and soft-leaves memberships in ONE immediate transaction,
  // so a retirement committing between the two reads leaves identity looking
  // live and membership looking left -- and startup then reports left_room or
  // left_all_rooms for a persona that is actually retired. A deferred read
  // transaction makes both reads see the same snapshot, so they cannot describe
  // two different moments. It covers startup only and is not held into the
  // probe loop.
  // Bound to a const first: `database` is a mutable module-level binding, so
  // TypeScript cannot keep its non-null narrowing inside a closure.
  const conn = database;
  const startup = conn
    .transaction(() => {
      const persona = conn
        .prepare("SELECT retired_at FROM agents WHERE id = ?")
        .get(args.agent) as { retired_at: string | null } | undefined;
      const membership = resolvedRoom
        ? (conn
            .prepare(
              "SELECT left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
            )
            .get(resolvedRoom.id, args.agent) as
            | { left_at: string | null }
            | undefined)
        : undefined;
      const counts = resolvedRoom
        ? undefined
        : (conn
            .prepare(
              `SELECT COUNT(*) AS total,
                      COALESCE(SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END), 0)
                        AS present
               FROM memberships WHERE agent_id = ?`,
            )
            .get(args.agent) as { total: number; present: number });
      return { persona, membership, counts };
    })
    .deferred();

  const armPersona = startup.persona;
  if (!armPersona) {
    argumentError(
      `no persona "${args.agent}"; identify a persona and arm a watcher from it`,
    );
  }
  checkRetired(armPersona.retired_at);
  const directed = args.mentionsOnly
    ? ` AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)
        AND (EXISTS (SELECT 1 FROM json_each(g.mentions) WHERE value = @agent)
             OR g.reply_to_agent = @agent)`
    : "";
  let probe: () => Hit | undefined;

  if (resolvedRoom) {
    // From the startup snapshot, not a fresh read: see the transaction above.
    const membership = startup.membership;
    if (!membership) {
      argumentError(
        `agent "${args.agent}" has not joined room ${resolvedRoom.id}`,
      );
    }
    if (membership.left_at !== null) {
      argumentError(
        `left_room: agent "${args.agent}" has left room ${resolvedRoom.id}; ` +
          `a watcher on a room you are absent from would deliver traffic peers ` +
          `can see you are not receiving. Rejoin with join_room and use the ` +
          `poller command it returns.`,
      );
    }
    params.room_id = resolvedRoom.id;
    // has_updates, retired_at and left_at are all COLUMNS of a row this query
    // always returns while the room and membership exist, so "no row" keeps
    // its single unambiguous meaning.
    //
    // The agents row arrives through a LEFT JOIN rather than two scalar
    // subqueries. Measured, not assumed: EXPLAIN QUERY PLAN on the subquery
    // form showed TWO `SEARCH a USING INDEX sqlite_autoindex_agents_1 (id=?)`
    // entries, one per subquery; the LEFT JOIN form shows one. LEFT, not inner,
    // so a vanished persona cannot turn this into "no row" -- that phrase has
    // to keep meaning the room or membership is gone, and a null agents_id
    // is how a vanished persona reports itself.
    const statement = database.prepare(
      `SELECT r.name AS room_name,
              a.id AS agents_id,
              a.retired_at AS retired_at,
              mb.left_at AS left_at,
              EXISTS (
                SELECT 1 FROM messages g
                WHERE g.room_id = r.id
                  AND g.seq > mb.last_read_seq
                  AND g.agent_id != @agent${directed}
                LIMIT 1
              ) AS has_updates
       FROM rooms r
       JOIN memberships mb ON mb.room_id = r.id AND mb.agent_id = @agent
       LEFT JOIN agents a ON a.id = @agent
       WHERE r.id = @room_id`,
    );
    probe = () => {
      const row = statement.get(params) as
        | {
            room_name: string;
            agents_id: string | null;
            retired_at: string | null;
            left_at: string | null;
            has_updates: number;
          }
        | undefined;
      if (!row) {
        argumentError(
          `room ${resolvedRoom.id} was deleted or the membership disappeared while watching`,
        );
      }
      // Identity FIRST: existence, then retirement, then membership.
      checkExists(row.agents_id !== null);
      checkRetired(row.retired_at);
      // Checked on EVERY probe, not just at arm time. A watcher armed while
      // present and left afterwards kept firing invisibly: peers correctly saw
      // the persona absent while its watcher still delivered. left_at rides as
      // returned DATA for the same reason retirement does -- as a WHERE
      // predicate it would produce "no row", which already means the room or
      // membership is gone, and the two need different diagnostics.
      //
      // This is a DIFFERENT exit from retired_identity. Both say do not
      // re-arm this command, but one means the identity is finished and the
      // other means this persona is not in the room; the next agent should not
      // have to guess which.
      if (row.left_at !== null) {
        argumentError(
          `left_room: agent "${args.agent}" left room ${resolvedRoom.id} while ` +
            `this watcher was armed; it stops rather than deliver traffic to a ` +
            `room peers can see you are absent from. Rejoin with join_room and ` +
            `use the poller command it returns.`,
        );
      }
      return row.has_updates
        ? { room_id: resolvedRoom.id, room_name: row.room_name }
        : undefined;
    };
  } else {
    // From the startup snapshot, not a fresh read: see the transaction above.
    const membershipCounts = startup.counts!;
    if (membershipCounts.total === 0) {
      argumentError(
        `no_room_memberships: agent "${args.agent}" has no room memberships; ` +
          "join a room and generate a fresh poller command",
      );
    }
    if (membershipCounts.present === 0) {
      argumentError(
        `left_all_rooms: agent "${args.agent}" has left every joined room; ` +
          "rejoin one with join_room and use the new poller command",
      );
    }
    // Anchor on the persona so every quiet probe still returns retirement and
    // membership state. A vanished persona yields no row.
    const statement = database.prepare(
      `SELECT a.retired_at AS retired_at,
              EXISTS (
                SELECT 1 FROM memberships all_mb
                WHERE all_mb.agent_id = @agent
              ) AS has_membership,
              EXISTS (
                SELECT 1 FROM memberships present_mb
                WHERE present_mb.agent_id = @agent
                  AND present_mb.left_at IS NULL
              ) AS has_present,
              (SELECT mb.room_id FROM memberships mb
                WHERE mb.agent_id = @agent AND mb.left_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM messages g
                    WHERE g.room_id = mb.room_id
                      AND g.seq > mb.last_read_seq
                      AND g.agent_id != @agent${directed}
                    LIMIT 1
                  )
                LIMIT 1) AS room_id
       FROM agents a WHERE a.id = @agent`,
    );
    const roomName = database.prepare("SELECT name FROM rooms WHERE id = ?");
    probe = () => {
      const row = statement.get(params) as
        | {
            retired_at: string | null;
            has_membership: number;
            has_present: number;
            room_id: number | null;
          }
        | undefined;
      // No row means the persona itself is gone; that is terminal, not quiet.
      checkExists(!!row);
      // Retirement outranks BOTH membership states below, so a retired persona
      // never reports left_all_rooms or no_room_memberships -- both of which
      // would tell the caller to rejoin, which it cannot do.
      checkRetired(row!.retired_at);
      if (!row!.has_membership) {
        argumentError(
          `no_room_memberships: agent "${args.agent}" has no remaining room ` +
            "memberships; join a room and generate a fresh poller command",
        );
      }
      if (!row!.has_present) {
        argumentError(
          `left_all_rooms: agent "${args.agent}" left every joined room while ` +
            "this watcher was armed; rejoin one with join_room and use the new " +
            "poller command",
        );
      }
      if (row!.room_id === null) return undefined;
      // Name lookup only on a HIT, so the quiet path stays one statement.
      const named = roomName.get(row!.room_id) as { name: string } | undefined;
      if (!named) return undefined; // deleted between the two reads
      return { room_id: row!.room_id, room_name: named.name };
    };
  }

  /**
   * Liveness heartbeat for a generated runtime watcher.
   *
   * ONE prepared, fenced UPDATE. The EXISTS clause is the fence, and it tests
   * retirement: a watcher whose identity is finished matches no row. Without
   * it a retired seat could keep refreshing last_seen for up to one probe
   * interval, advertising a live listener that can never act. It sets last_seen
   * and nothing else: left_at is never cleared, so this cannot resurrect a seat
   * that left the room. Failure is swallowed: a watcher that cannot write must
   * still report traffic.
   *
   * Cost is one write per two minutes per armed watcher against five-second
   * reads. Its contention impact is UNMEASURED.
   */
  const HEARTBEAT_INTERVAL_MS = 120_000;
  // SCOPE MATTERS. A watcher with --room listens to exactly ONE room, so it may
  // only refresh THAT room. Refreshing every present membership from a scoped
  // watcher tells peers in rooms nobody is watching that this persona is
  // listening there, which is the same false availability the rest of this
  // work exists to remove. An unscoped watcher does watch every present room,
  // so it refreshes them all.
  const heartbeatScope = resolvedRoom ? " AND room_id = @room_id" : "";
  const heartbeatStatement = heartbeatEnabled
    ? database.prepare(
        `UPDATE memberships SET last_seen = datetime('now')
          WHERE agent_id = @agent AND left_at IS NULL${heartbeatScope}
            AND EXISTS (SELECT 1 FROM agents a
                         WHERE a.id = @agent AND a.retired_at IS NULL)`,
      )
    : null;
  let lastHeartbeatMs = 0;
  const heartbeat = (): void => {
    if (!heartbeatStatement) return;
    const now = Date.now();
    if (lastHeartbeatMs !== 0 && now - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) {
      return;
    }
    // Stamp before running, so a failing write throttles like a succeeding one
    // instead of retrying every probe.
    lastHeartbeatMs = now;
    try {
      heartbeatStatement.run({
        agent: args.agent,
        ...(resolvedRoom ? { room_id: resolvedRoom.id } : {}),
      });
    } catch {}
  };
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  for (;;) {
    if (args.ownerPid !== undefined && !processIsAlive(args.ownerPid)) {
      argumentError(
        `owner MCP process ${args.ownerPid} has ended; regenerate the poller command`,
      );
    }
    heartbeat();
    // Probe before deciding that the deadline is quiet. The final sleep lands
    // on the deadline; checking time first discarded messages that arrived
    // during that last interval and reported a false timeout.
    const hit = probe();
    if (hit) {
      await new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(
          JSON.stringify({
            has_updates: true,
            agent: args.agent,
            room_id: hit.room_id,
            room_name: hit.room_name,
            mentions_only: args.mentionsOnly,
            next:
              `catch_up room ${hit.room_id} until \`remaining\` is 0 or stops ` +
              "falling; then re-run this command before working. The watcher " +
              "checks before sleeping, so unread traffic makes it exit " +
              "immediately.",
          }) + "\n",
          (error) => (error ? rejectWrite(error) : resolveWrite()),
        );
      });
      exitCode = 0;
      break;
    }
    if (Date.now() >= deadline) {
      if (args.timeoutOk) {
        await new Promise<void>((resolveWrite, rejectWrite) => {
          process.stdout.write(
            JSON.stringify({
              has_updates: false,
              timed_out: true,
              next: "re-run this same command immediately to keep watching.",
            }) + "\n",
            (error) => (error ? rejectWrite(error) : resolveWrite()),
          );
        });
        exitCode = 0;
      } else {
        process.stderr.write('{"timed_out":true}\n');
        exitCode = 124;
      }
      break;
    }
    const remaining = deadline - Date.now();
    const ownerAlive = await sleepWhileOwnerAlive(
      Math.min(args.intervalSeconds * 1000, remaining),
      args.ownerPid,
    );
    if (!ownerAlive) {
      argumentError(
        `owner MCP process ${args.ownerPid} has ended; regenerate the poller command`,
      );
    }
  }
} catch (error) {
  process.stderr.write(
    `agent-chat-poller: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  exitCode = 2;
} finally {
  cleanup();
}

process.exitCode = exitCode;
