#!/usr/bin/env node
// One bounded watcher: hold one SQLite connection and run one indexed LIMIT 1
// probe after each sleep. No shell loop, subprocesses, temp output, counts, or
// grouping. A hit identifies one room; catch_up does the actual read.
import Database from "better-sqlite3";
import {
  closeSync,
  existsSync,
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
  session?: string;
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
  poller.js --agent <id> [--room <id|name>] [--session <nonce>]
            [--owner-pid <pid>]
            [--mentions-only] [--interval <seconds>] [--timeout <seconds>]
            [--ok-on-timeout]

The interval must be 5..3600 seconds (default 5). The timeout must be
1..86400 seconds (default 1200). Exit 0 = work exists; with --ok-on-timeout,
exit 0 also reports a quiet deadline as has_updates:false. Without it,
timeout exits 124. Exit 2 = invalid arguments, duplicate watcher, or DB error.
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
  let session: string | undefined;
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
    else if (flag === "--session") session = take();
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
        "--since is intentionally unsupported: frozen baselines can re-fire forever; use --session",
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
  if (session && session.length > 500) argumentError("--session is too long");
  return {
    agent,
    room,
    session,
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
    let owner = 0;
    try {
      owner = Number(JSON.parse(readFileSync(path, "utf8")).pid);
    } catch {}
    if (processIsAlive(owner)) {
      argumentError(`an equivalent watcher is already running (pid ${owner})`);
    }
    // Fail closed. Automatic stale-lock stealing needs a second interprocess
    // lock to avoid two reapers deleting each other's replacement.
    argumentError(`stale watcher lock requires removal: ${path}`);
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));

async function sleepWhileOwnerAlive(
  milliseconds: number,
  ownerPid: number | undefined,
): Promise<boolean> {
  // Independent/manual pollers need no five-second owner heartbeat; let their
  // single timer sleep for the requested interval without needless wakeups.
  if (ownerPid === undefined) {
    await sleep(milliseconds);
    return true;
  }
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await sleep(Math.min(5_000, remaining));
    if (ownerPid !== undefined && !processIsAlive(ownerPid)) return false;
  }
}

let database: Database.Database | null = null;
let lockPath: string | null = null;
let lockOwned = false;
const lockToken = randomUUID();
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    database?.close();
  } catch {}
  if (lockOwned && lockPath) {
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
  database.pragma("query_only = ON");

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

  const lockDir = join(tmpdir(), "agent-chat-pollers");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const scopeKey = JSON.stringify([
    path,
    args.agent,
    resolvedRoom?.id ?? null,
    args.session ?? null,
    args.mentionsOnly,
  ]);
  lockPath = join(
    lockDir,
    createHash("sha256").update(scopeKey).digest("hex") + ".lock",
  );
  acquireLock(lockPath, lockToken);
  lockOwned = true;

  const params: Record<string, string | number> = {
    agent: args.agent,
    session: args.session ?? "",
  };
  const directed = args.mentionsOnly
    ? ` AND (g.mentions IS NOT NULL OR g.reply_to_agent IS NOT NULL)
        AND (EXISTS (SELECT 1 FROM json_each(g.mentions) WHERE value = @agent)
             OR g.reply_to_agent = @agent)`
    : "";
  let probe: () => Hit | undefined;

  if (resolvedRoom) {
    const membership = database
      .prepare("SELECT 1 FROM memberships WHERE room_id = ? AND agent_id = ?")
      .get(resolvedRoom.id, args.agent);
    if (!membership) {
      argumentError(
        `agent "${args.agent}" has not joined room ${resolvedRoom.id}`,
      );
    }
    params.room_id = resolvedRoom.id;
    const statement = database.prepare(
      `SELECT r.name AS room_name,
              EXISTS (
                SELECT 1 FROM messages g
                WHERE g.room_id = r.id
                  AND g.seq > CASE WHEN @session = '' THEN mb.last_read_seq
                                   ELSE COALESCE(sm.last_read_seq, mb.last_read_seq) END
                  AND g.agent_id != @agent${directed}
                LIMIT 1
              ) AS has_updates
       FROM rooms r
       JOIN memberships mb ON mb.room_id = r.id AND mb.agent_id = @agent
       LEFT JOIN session_markers sm ON sm.room_id = r.id
            AND sm.agent_id = mb.agent_id AND sm.session_id = @session
       WHERE r.id = @room_id`,
    );
    probe = () => {
      const row = statement.get(params) as
        | { room_name: string; has_updates: number }
        | undefined;
      if (!row) {
        argumentError(
          `room ${resolvedRoom.id} was deleted or the membership disappeared while watching`,
        );
      }
      return row.has_updates
        ? { room_id: resolvedRoom.id, room_name: row.room_name }
        : undefined;
    };
  } else {
    const present = database
      .prepare(
        "SELECT 1 FROM memberships WHERE agent_id = ? AND left_at IS NULL LIMIT 1",
      )
      .get(args.agent);
    if (!present) argumentError(`agent "${args.agent}" is not present in any room`);
    const statement = database.prepare(
      `SELECT mb.room_id AS room_id, r.name AS room_name
       FROM memberships mb
       JOIN rooms r ON r.id = mb.room_id
       LEFT JOIN session_markers sm ON sm.room_id = mb.room_id
            AND sm.agent_id = mb.agent_id AND sm.session_id = @session
       WHERE mb.agent_id = @agent AND mb.left_at IS NULL
         AND (@session = '' OR NOT EXISTS (
           SELECT 1 FROM session_presence sp
           WHERE sp.room_id = mb.room_id AND sp.agent_id = mb.agent_id
             AND sp.session_id = @session AND sp.left_at IS NOT NULL
         ))
         AND EXISTS (
           SELECT 1 FROM messages g
           WHERE g.room_id = mb.room_id
             AND g.seq > CASE WHEN @session = '' THEN mb.last_read_seq
                              ELSE COALESCE(sm.last_read_seq, mb.last_read_seq) END
             AND g.agent_id != @agent${directed}
           LIMIT 1
         )
       LIMIT 1`,
    );
    probe = () => statement.get(params) as Hit | undefined;
  }

  const deadline = Date.now() + args.timeoutSeconds * 1000;
  for (;;) {
    if (args.ownerPid !== undefined && !processIsAlive(args.ownerPid)) {
      argumentError(
        `owner MCP process ${args.ownerPid} has ended; regenerate the poller command`,
      );
    }
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
            '{"has_updates":false,"timed_out":true}\n',
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
