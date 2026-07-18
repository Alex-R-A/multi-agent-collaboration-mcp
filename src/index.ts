#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  ServerNotification,
  ServerRequest,
  ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ChatStore,
  DEFAULT_MAX_BYTES,
  MAX_CLIENT_MESSAGE_ID_CHARS,
  MAX_CROSSED_PREVIEW_CHARS,
  MAX_MESSAGE_BODY_BYTES,
  MIN_CATCH_UP_RESULT_BUDGET,
} from "./db.js";
import {
  BoundedLineTransform,
  MAX_MCP_FRAME_BYTES,
} from "./bounded-lines.js";
import { stringifyWellFormedJson } from "./unicode.js";

// The watcher is a sibling entry. Production executes compiled poller.js;
// `npm run dev` executes the TypeScript sibling through the already-installed
// tsx CLI instead of returning the nonexistent src/poller.js path.
const THIS_MODULE = fileURLToPath(import.meta.url);
const MODULE_DIR = dirname(THIS_MODULE);
const POLLER_COMMAND = THIS_MODULE.endsWith(".ts")
  ? [
      process.execPath,
      createRequire(import.meta.url).resolve("tsx/cli"),
      join(MODULE_DIR, "poller.ts"),
    ]
  : [process.execPath, join(MODULE_DIR, "poller.js")];

// Single-quote paths for the copy-pasteable poller command: double quotes
// would let a path containing $() or backticks execute when pasted into a
// shell. Embedded single quotes are escaped with the '\'' idiom.
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The exact background-poller invocation for a known agent id, safe to run
 * verbatim: every value is shell-quoted (self-asserted ids may contain
 * quotes, spaces, or $(), which a hand-substituted placeholder cannot
 * survive). ONE hardcoded database is the rule: the poller resolves the same
 * built-in default on its own, and the testing-only override (AGENT_CHAT_DB /
 * --db) is deliberately NEVER advertised to clients -- a client must not
 * learn from any tool text that another database is possible.
 */
function pollerCmd(
  agentId: string,
  opts: {
    room?: string;
    mentionsOnly?: boolean;
    session?: string;
    timeoutSec?: number;
    intervalSec?: number;
  } = {},
): string {
  let cmd = `${POLLER_COMMAND.map(shq).join(" ")} --agent ${shq(agentId)}`;
  // Generated commands belong to this MCP session. If the client reconnects
  // and this server exits, its old session-nonce watcher retires within five
  // seconds instead of accumulating until a long timeout. Direct CLI commands
  // can omit --owner-pid when independent lifetime is intentional.
  cmd += ` --owner-pid ${shq(String(process.pid))}`;
  if (opts.room !== undefined) cmd += ` --room ${shq(opts.room)}`;
  // Both scoped and all-room watches resolve this session's CURRENT cursor on
  // every probe. Never bake a point-in-time --since value into a restartable
  // command: once crossed, that stale baseline fires forever.
  if (opts.session !== undefined) {
    cmd += ` --session ${shq(opts.session)}`;
  }
  // Baked-in loop knobs, so callers stop hand-editing the command string
  // (the historical -32602 friction: the values LOOK like tool params).
  if (opts.timeoutSec !== undefined) {
    cmd += ` --timeout ${shq(String(opts.timeoutSec))}`;
  }
  if (opts.intervalSec !== undefined) {
    cmd += ` --interval ${shq(String(opts.intervalSec))}`;
  }
  // Generated commands treat an expected quiet deadline as successful
  // completion. `has_updates` in stdout distinguishes timeout from a hit;
  // direct legacy CLI invocations without this flag retain exit 124.
  cmd += ` --ok-on-timeout`;
  if (opts.mentionsOnly) cmd += ` --mentions-only`;
  return cmd;
}
/** A client that abandons a request without delivering cancellation can leave
 * the server able to advance a marker into an undeliverable response. Keep the
 * safe default below even pessimistic host deadlines; longer waits are an
 * explicit deployment choice, bounded by a small hard ceiling. */
const DEFAULT_WAIT_CAP_SECONDS = 25;
const HARD_WAIT_CAP_SECONDS = 120;
function configuredWaitCapSeconds(): number {
  const raw = process.env.AGENT_CHAT_MAX_WAIT_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_WAIT_CAP_SECONDS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `AGENT_CHAT_MAX_WAIT_SECONDS must be an integer from 1 to ${HARD_WAIT_CAP_SECONDS}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_WAIT_CAP_SECONDS) {
    throw new Error(
      `AGENT_CHAT_MAX_WAIT_SECONDS must be an integer from 1 to ${HARD_WAIT_CAP_SECONDS}`,
    );
  }
  return value;
}
const WAIT_CAP_SECONDS = configuredWaitCapSeconds();
// Validate process-level configuration before opening or migrating the shared
// database. A typo must fail without mutating production state first.
const store = new ChatStore();

const INSTRUCTIONS = `Agent Chat is a local SQLite ledger. Start list_rooms -> join_room -> catch_up. catch_up advances one room; my_mentions peeks across rooms. priority_only is explicitly lossy. For out-of-turn watching, wait_for_messages returns the background poller command. server_info holds routing/shared budgets; each tool schema states its cap.`;

// The layered operating manual, served by server_info: stable reference
// detail that would otherwise bloat every tools/list. Tool descriptions keep
// only their unique semantics and point here.
const MANUAL = `OPERATING MANUAL

ROUTING
- catch_up reads ONE room and ADVANCES your read marker; ordinary calls are lossless and never advance past an undelivered message from another author. Because own posts are never returned, the marker may normalize across an own-only suffix before the next peer row (so an empty page can still say advanced:true). room:<id|name> reads another joined room without changing the active room. Explicit priority_only:true is LOSSY backlog triage: it returns priority:true rows plus every directed mention/reply, advances over lower-priority rows through cutoff_seq, and reports skipped_count + qualifying_remaining. It cannot be combined with wait_seconds. An empty read includes a bounded rooms_with_unread list; inspect rooms_with_unread_truncated before treating it as exhaustive.
- my_mentions: cross-room inbox of unread directed at you (mentions + replies to your messages); never moves markers; entries clear when you read their room; page with after_id = next_after_id; by_room reports each returned room's TOTAL unread; inspect by_room_truncated before treating it as exhaustive.
- read_history browses without moving markers. mark_read moves the marker without reading (omit seq to jump to latest; a LOWER seq re-exposes messages to catch_up).

IN-CALL WAIT
- catch_up wait_seconds (0..${WAIT_CAP_SECONDS} effective max) blocks that one call until a message from another agent lands in the target room, then returns it and advances. The safe default max is 25s; an operator may set AGENT_CHAT_MAX_WAIT_SECONDS up to 120 only after measuring end-to-end behavior on that host. wait_seconds bounds the polling deadline, not total RPC wall time: SQLite contention, lease cleanup, and serialization can add several bounded busy-timeout windows. On timeout: timed_out:true, call_again:true, rooms_with_unread. Normal hit/timeout responses carry waited_ms; cancellation/deletion errors may not.
- The best-effort watching lease expires wait_seconds+5s after it begins. Raising the cap therefore also lengthens the maximum stale watching:true window after a hard-killed host; this is part of the operator opt-in.
- While your wait is open and its lease write succeeds, peers see watching:true for you (list_agents, post_message recipients): evidence that a blocking call was open, not a delivery guarantee. It drops on normal return/cancellation; TTL bounds a hard-kill ghost. A detached poller never produces it.
- The wait holds your turn open, so it fits "I am waiting for a reply and have nothing else to do". To be notified while doing other work, or for watches longer than the cap, use the background poller.

SIZE AND PAGING
- Bulk reads are byte-bounded (default ${DEFAULT_MAX_BYTES} serialized chars; max_bytes tunes it, see limits). byte_limited:true = more remain: catch_up/read_history call again, my_mentions pages with after_id. Priority-only catch_up never advances past an unseen qualifying row when a row/byte cap cuts the page. Oversized bodies arrive truncated:true with length; fetch the rest via get_message offset -> next_offset (codepoints), passing room when the source row came from a non-active room. A truncated json body is a partial raw string, not an object.
- Shared size and response budgets are in server_info limits; each tool schema states its own local cap. Message bodies cap at ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes; the newline-delimited stdio frame has a separate ${MAX_MCP_FRAME_BYTES}-byte wire cap to allow JSON escaping without unbounded pre-parse buffering.

POSTING
- crossed counts ALL unread from others past your marker at post time (old backlog included, not only mid-composition arrivals); crossed_directed says how many are aimed at you; crossed_range gives the seq span. If crossed > 0, catch_up before acting on replies. crossed_preview_chars opts into bounded previews of the crossed messages in the same response.
- Dispositive posts (verdicts, commissions, dispositions): if_last_read_seq is a conditional post -- rejected (posted:false) if ANYTHING from others landed past your token, with bounded crossed previews returned; call catch_up for the complete delta before retrying. If pruning removed evidence after the token, it rejects conservatively with rejected:evidence_pruned and no invented previews. A token ahead of the target room's effective cursor is invalid and fails before posting. client_message_id makes an exact lost-response retry return the original seq instead of inserting twice; its guarantee lasts while that message is retained. Repeat the same explicit room or expected_room on retry so active-room drift cannot create a post in another room; a deduplicated response does not replay the original crossed/recipient snapshot, so catch_up for current state. room: posts to a named joined room without switching the active room; expected_room asserts which room is active. Never use the CAS on routine traffic: crossing is normal, the CAS is for posts whose validity depends on having read everything.
- recipients reports factual room-local state: status, idle_seconds, last_read_seq, marker_behind. A new unread tag normally adds one to marker_behind. delivery_warnings is definitive for never-joined/left recipients; a long-idle warning is emitted only for pre-existing lag and states observed facts, never a responsiveness prediction.
- supersedes_seq corrects YOUR OWN earlier message; readers see superseded_by on it. reply_to_seq threads; the log stays flat and globally ordered.
- priority:true marks an immutable high-signal checkpoint for priority-only catch-up. Use it sparingly; correct a priority post with a new priority post + supersedes_seq rather than mutating history.
- claim/release_claim: atomic single-winner advisory locks with TTL expiry (a crashed holder cannot block forever). Claims are mutual exclusion between live writers; they do not verify content.

MULTIPLE SESSIONS, ONE IDENTITY
- The default shared cursor splits the backlog across concurrent sessions (work-queue style). join_room cursor:'private' gives THIS session an independent read position. The poller command carries --session and resolves that session's current cursor on each probe; it never freezes a --since baseline.

BACKGROUND POLLER
- Run the command join_room/wait_for_messages return as a BACKGROUND task. One Node process holds one SQLite connection and runs one indexed LIMIT 1 probe after each sleep; it launches no children. Generated commands exit 0 for either a hit or quiet deadline: parse stdout has_updates true/false. Direct CLI calls without --ok-on-timeout retain exit 124 on timeout. Exit 2 is an error or equivalent watcher. Options: --interval <sec> (minimum/default 5), --timeout <sec> (default 1200, finite), --ok-on-timeout, --mentions-only, --room <id|name>. Your own posts never wake it.
- The poller is an OS-level detector: its exit does NOT by itself schedule your next turn. Whether you are actually woken depends on your harness's background-task contract; do not report "watcher active" as evidence you will see a message.

RETENTION
- prune_messages deletes old messages (refuses while any non-author member has them unread; force overrides). A room seq you cite in a document is durable only as long as nobody prunes past it.`;

// One stdio server process serves one agent. We remember its identity and
// active room for the session so the agent need not repeat them on every call.
const session: {
  agentId: string | null;
  roomId: number | null;
  // Cursor mode is PER (ROOM, IDENTITY), not per room: a session can switch
  // identities, and a room-only key let identity B's shared join silently
  // clear identity A's private mode -- A's next omitted-cursor rejoin then
  // deleted A's private cursor row and jumped it to the identity marker,
  // making its unread backlog unrecoverable.
  privateRooms: Set<string>;
} = {
  agentId: null,
  roomId: null,
  privateRooms: new Set(),
};

/** Key for the per-(room, identity) private-cursor mode set. \u0000 cannot
 *  appear in an agent id (control chars are rejected), so keys never collide. */
function privKey(roomId: number, agentId: string): string {
  return `${roomId}\u0000${agentId}`;
}

// Distinguishes this process's private read cursor (join_room cursor:'private')
// from other sessions running under the same agent_id.
const SESSION_NONCE = randomUUID();

/** The session-cursor key for ACTIVE-room store calls: the nonce when the
 *  active room was joined with a private cursor UNDER THE CURRENT IDENTITY,
 *  else null. */
function cursorId(): string | null {
  return session.roomId !== null &&
    session.agentId !== null &&
    session.privateRooms.has(privKey(session.roomId, session.agentId))
    ? SESSION_NONCE
    : null;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// Compact (not pretty-printed) JSON: bulk reads run against a hard client
// output cap, and indentation wastes budget that could carry messages.
function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/** Cadence of the non-advancing unread probe during a blocking wait. */
const WAIT_PROBE_INTERVAL_MS = 500;
/** Bound aggregate timer/SQLite pressure when a client accidentally dispatches
 * many blocking catch_up calls in parallel. */
const MAX_CONCURRENT_WAITS = 4;
let activeBlockingWaits = 0;
/** Wait-lease TTL grace past the deadline, covering the final advancing
 *  read; a hard-killed process's lease self-expires this soon after. */
const WAIT_LEASE_GRACE_SECONDS = 5;

/** Sleep that wakes EARLY on abort (never rejects; callers re-check
 *  signal.aborted, which is also the correct behavior for an already-aborted
 *  signal). The listener is removed on normal expiry, so a long-lived signal
 *  does not accumulate one listener per tick. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, Math.max(0, ms));
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireActive(): { agentId: string; roomId: number } {
  if (session.agentId === null || session.roomId === null) {
    throw new Error("join a room first with join_room");
  }
  // The room may have been deleted by another server process; the local session
  // would otherwise stay pointed at it and fail later with a low-level DB error.
  // The identity survives: only the active room is gone.
  if (!store.getRoom(session.roomId)) {
    const stale = session.roomId;
    session.roomId = null;
    throw new Error(
      `active room ${stale} no longer exists (deleted); rejoin with join_room`,
    );
  }
  return { agentId: session.agentId, roomId: session.roomId };
}

/** Resolve an optional explicit joined room without changing the active room.
 * Explicit operations require an established identity and an existing
 * membership, but a soft-left membership remains addressable: naming the room
 * is deliberate and may be needed to inspect history or release old claims. */
function resolveJoinedRoom(room?: string): {
  agentId: string;
  roomId: number;
  roomName: string | null;
} {
  if (room === undefined) {
    const { agentId, roomId } = requireActive();
    return {
      agentId,
      roomId,
      roomName: store.getRoom(roomId)?.name ?? null,
    };
  }
  if (session.agentId === null) {
    throw new Error("join a room first with join_room to establish your identity");
  }
  const target = store.resolveRoom(room);
  if (!target) {
    throw new Error(`no room "${room}". Use list_rooms to see options.`);
  }
  if (!store.getMembership(target.id, session.agentId)) {
    throw new Error(
      `you have never joined room "${target.name}"; join_room it first`,
    );
  }
  return {
    agentId: session.agentId,
    roomId: target.id,
    roomName: target.name,
  };
}

/**
 * Mark the active agent (and its private cursor, if any) alive on tool
 * invocations. Throttled: every tool call otherwise costs a write transaction
 * on the shared file (cross-process lock contention for pure reads like
 * list_rooms). 30s granularity is far inside both consumers' tolerances: the
 * `active` liveness window is minutes and the session GC is days.
 */
let lastTouchMs = 0;
const TOUCH_INTERVAL_MS = 30_000;
function touchSession(): void {
  if (session.agentId === null) return;
  const now = Date.now();
  if (now - lastTouchMs < TOUCH_INTERVAL_MS) return;
  lastTouchMs = now;
  // Always pass the nonce (not cursorId()): the ACTIVE room may be shared
  // while this session holds private cursors in other rooms, and those rows
  // must stay refreshed against the 7-day GC too.
  try {
    if (session.roomId !== null) {
      store.touch(session.roomId, session.agentId, SESSION_NONCE);
    } else {
      // Identity without an active room (post-leave my_mentions polling):
      // still shield this session's cursors AND live presence rows from the GC.
      store.touchSessionAlive(SESSION_NONCE, session.agentId);
    }
  } catch {
    // Liveness is best-effort: a briefly-locked database must not fail the
    // tool call this touch piggybacks on (pure reads included). lastTouchMs
    // already advanced, so failures back off to the next interval.
  }
}

// Cross-room operations capture a target that can differ from mutable active
// session state. Throttle each captured (room, identity) independently: using
// touchSession() in a named-room wait kept refreshing the active room instead.
const capturedTouchMs = new Map<string, number>();
function touchCapturedRoom(roomId: number, agentId: string): void {
  const key = privKey(roomId, agentId);
  const now = Date.now();
  if (now - (capturedTouchMs.get(key) ?? 0) < TOUCH_INTERVAL_MS) return;
  if (!capturedTouchMs.has(key) && capturedTouchMs.size >= 1024) {
    for (const [candidate, touchedAt] of capturedTouchMs) {
      if (now - touchedAt >= TOUCH_INTERVAL_MS) capturedTouchMs.delete(candidate);
    }
    // A pathological stream of unique rooms/identities must not grow this
    // process-lifetime throttle map without bound.
    if (capturedTouchMs.size >= 1024) {
      const oldest = capturedTouchMs.keys().next().value as string | undefined;
      if (oldest !== undefined) capturedTouchMs.delete(oldest);
    }
  }
  capturedTouchMs.set(key, now);
  try {
    // Unlike store.touch(), this requires this exact session's presence row
    // to remain live and therefore cannot resurrect an explicitly left room.
    store.touchSessionRoom(roomId, agentId, SESSION_NONCE);
  } catch {
    // Best-effort heartbeat, matching touchSession().
  }
}

// Build identity, stamped into dist/build-info.json by scripts/stamp-build.mjs at
// build time so server_info pins the exact deployed binary. Reading git at runtime
// would report the source HEAD instead, masking an edited-but-not-rebuilt dist,
// which is precisely the skew this exists to surface. Falls back when absent.
type BuildInfo = {
  version: string;
  commit: string;
  built_at: string;
  artifact_hash?: string;
};
const BUILD: BuildInfo = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    );
  } catch {
    return { version: "0.0.0-dev", commit: "unknown", built_at: "" };
  }
})();

/**
 * Re-read the on-disk build stamp and report whether a NEWER build has been
 * deployed since this process started. If so, this server is stale: the client
 * should reconnect the MCP to load the new code (a stdio server never
 * hot-reloads). Modern stamps compare an executable-artifact hash so rebuilding
 * identical code does not emit a false warning; timestamps remain the fallback
 * for old stamps. No client UI surfaces serverInfo.version, so this in-band
 * flag is the only way an agent learns it is running old code.
 */
function buildStatus(): {
  stale: boolean;
  latest_commit: string | null;
  latest_built_at: string | null;
  latest_artifact_hash: string | null;
} {
  let latest: BuildInfo | null = null;
  try {
    latest = JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    );
  } catch {
    latest = null;
  }
  const runningHash = BUILD.artifact_hash ?? "";
  const latestHash = latest?.artifact_hash ?? "";
  const comparableHashes = runningHash.length > 0 && latestHash.length > 0;
  const stale = comparableHashes
    ? latestHash !== runningHash &&
      latest !== null &&
      latest.built_at > BUILD.built_at
    : latest !== null &&
      latest.built_at !== "" &&
      latest.built_at > BUILD.built_at;
  return {
    stale,
    latest_commit: latest?.commit ?? null,
    latest_built_at: latest?.built_at ?? null,
    latest_artifact_hash: latest?.artifact_hash ?? null,
  };
}

const server = new McpServer(
  {
    name: "agent-chat-mcp",
    version: BUILD.version,
  },
  { instructions: INSTRUCTIONS },
);

// The SDK dispatches every JSON-RPC frame concurrently, then awaits
// safeParseAsync independently for each tool. A later small schema could reach
// its callback before an earlier larger one, scrambling this connection's
// implicit identity/active-room state. Gate only HANDLER STARTS in arrival
// order: release the next ticket immediately after a callback is invoked (its
// synchronous prefix captures all session state), never after a long wait
// resolves. Invalid/unknown/cancelled requests release from the outer finally.
type ToolStartTicket = { before: Promise<void>; release(): void };
type CallToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type CallToolHandler = (
  request: CallToolRequest,
  extra: CallToolExtra,
) => ServerResult | Promise<ServerResult>;

let toolStartTail = Promise.resolve();
const toolStartTickets = new WeakMap<AbortSignal, ToolStartTicket>();
const activeToolRequests = new Set<Promise<ServerResult>>();

function issueToolStartTicket(): ToolStartTicket {
  const before = toolStartTail;
  let resolveNext!: () => void;
  toolStartTail = new Promise<void>((resolve) => {
    resolveNext = resolve;
  });
  let released = false;
  return {
    before,
    release() {
      if (released) return;
      released = true;
      resolveNext();
    },
  };
}

const sdkSetRequestHandler = server.server.setRequestHandler.bind(server.server);
server.server.setRequestHandler = ((
  requestSchema: unknown,
  handler: unknown,
): void => {
  if (requestSchema !== CallToolRequestSchema) {
    Reflect.apply(sdkSetRequestHandler, server.server, [requestSchema, handler]);
    return;
  }
  const sdkHandler = handler as CallToolHandler;
  const orderedOuter: CallToolHandler = (request, extra) => {
    const ticket = issueToolStartTicket();
    toolStartTickets.set(extra.signal, ticket);
    const pending = (async () => {
      try {
        return await sdkHandler(request, extra);
      } finally {
        ticket.release();
        toolStartTickets.delete(extra.signal);
      }
    })();
    activeToolRequests.add(pending);
    void pending.then(
      () => activeToolRequests.delete(pending),
      () => activeToolRequests.delete(pending),
    );
    return pending;
  };
  Reflect.apply(sdkSetRequestHandler, server.server, [
    CallToolRequestSchema,
    orderedOuter,
  ]);
}) as typeof server.server.setRequestHandler;

const sdkRegisterTool = server.registerTool.bind(server);
server.registerTool = ((
  name: string,
  config: unknown,
  callback: unknown,
) => {
  if (typeof callback !== "function") {
    return Reflect.apply(sdkRegisterTool, server, [name, config, callback]);
  }
  const orderedCallback = (...handlerArgs: unknown[]) => {
    const extra = handlerArgs[handlerArgs.length - 1] as CallToolExtra;
    const ticket = toolStartTickets.get(extra.signal);
    if (!ticket) return Reflect.apply(callback, undefined, handlerArgs);
    return (async () => {
      await ticket.before;
      if (extra.signal.aborted) {
        ticket.release();
        return fail("request cancelled before execution");
      }
      let result: unknown;
      try {
        // Every tool handler executes its state-binding prefix synchronously.
        // catch_up's first await comes only after it captures identity/room.
        result = Reflect.apply(callback, undefined, handlerArgs);
      } finally {
        ticket.release();
      }
      return await result;
    })();
  };
  return Reflect.apply(sdkRegisterTool, server, [name, config, orderedCallback]);
}) as typeof server.registerTool;

// Every inputSchema below is z.object(...).strict(): UNKNOWN keys are
// rejected, not silently stripped. Stripping turned typos into different
// operations -- mark_read({sequence:0}) marked the whole backlog read,
// post_message({too:[...]}) posted without its recipients. The SDK passes
// Zod schema instances through to its own validator, so strictness reaches
// the wire (and additionalProperties:false reaches the advertised schema).

// Size caps and byte budgets, published so they are discoverable BEFORE a
// failure instead of via a rejected call. Values mirror the zod schemas and
// store asserts; keep them in sync when either changes.
const LIMITS = {
  message_body_max_bytes: MAX_MESSAGE_BODY_BYTES,
  mcp_stdio_frame_max_bytes: MAX_MCP_FRAME_BYTES,
  bulk_read_default_budget_chars: DEFAULT_MAX_BYTES,
  max_bytes_range: [1000, 400_000],
  get_message_max_chars_range: [100, 400_000],
  wait_seconds_max: WAIT_CAP_SECONDS,
  wait_seconds_default_max: DEFAULT_WAIT_CAP_SECONDS,
  wait_seconds_configurable_hard_max: HARD_WAIT_CAP_SECONDS,
  crossed_preview_chars_max: MAX_CROSSED_PREVIEW_CHARS,
  client_message_id_max_chars: MAX_CLIENT_MESSAGE_ID_CHARS,
  default_page_limits: {
    catch_up: 50,
    read_history: 50,
    my_mentions: 50,
    search_messages: 20,
    listings: 200,
  },
  metadata_caps_chars: {
    room_name: 200,
    room_description: 2000,
    pinned_intro: 10_000,
    agent_id: 200,
    agent_type: 100,
    agent_role: 200,
    agent_description: 2000,
    claim_key: 500,
    claim_note: 2000,
    mentions_per_post: 100,
  },
};

server.registerTool(
  "server_info",
  {
    title: "Server info, limits, and operating manual",
    description:
      `Version ${BUILD.version}: Report this server's version/build identity, ` +
      "shared size/response budgets (`limits`), and the full operating " +
      "manual (`manual`: routing, paging, poller, multi-session cursors). " +
      "Call this once when caps or exact semantics matter. `stale:true` = a " +
      "newer build was deployed since this process started; reconnect the " +
      "MCP to load it (stdio servers do not hot-reload).",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      const status = buildStatus();
      return ok({
        name: "agent-chat-mcp",
        version: BUILD.version,
        commit: BUILD.commit,
        built_at: BUILD.built_at,
        artifact_hash: BUILD.artifact_hash ?? null,
        stale: status.stale,
        latest_commit: status.latest_commit,
        latest_built_at: status.latest_built_at,
        latest_artifact_hash: status.latest_artifact_hash,
        limits: LIMITS,
        manual: MANUAL,
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "what_time_is_it_right_now",
  {
    title: "Current time",
    description:
      "Current time: `iso` (local ISO 8601 with zone offset), `unix` (UTC " +
      "epoch SECONDS), `at` (local 'YYYY-MM-DD HH:MM:SS'), `timezone` (IANA " +
      "name). `unix` matches each message's `unix`, so now.unix - " +
      "message.unix = the message's age in seconds.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      const t = store.currentTime();
      return ok({
        iso: t.iso,
        unix: t.unix,
        at: t.at,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "create_room",
  {
    title: "Create room",
    description:
      "Create a chat room (rooms must exist before agents can join). Name it " +
      "for the TOPIC (kebab-case, e.g. 'auth-refactor-review'), never for " +
      "participants or generic labels: list_rooms names are how agents find " +
      "rooms. `pinned` is an intro shown to every joiner. Returns the room id.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Unique room name; name it for the discussion topic (kebab-case), " +
            "not for participants",
        ),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe("What this room is for"),
      pinned: z
        .string()
        .max(10_000)
        .optional()
        .describe("Pinned intro/conventions shown to joiners"),
    }).strict(),
  },
  async ({ name, description, pinned }) => {
    try {
      touchSession();
      // Room references are resolved id-first (resolveRoom), so an all-digit
      // name would be shadowed by any room with that numeric id -- and
      // delete_room resolves the same way, making the ambiguity destructive.
      if (/^\d+$/.test(name)) {
        return fail(
          "room names cannot be all digits (ambiguous with room ids); " +
            "pick a descriptive kebab-case topic name",
        );
      }
      if (store.getRoomByName(name)) {
        return fail(`a room named "${name}" already exists`);
      }
      const room = store.createRoom(name, description ?? null, pinned ?? null);
      return ok({ room_id: room.id, name: room.name });
    } catch (e) {
      // Two processes can pass the pre-check together; the loser's INSERT
      // hits UNIQUE(rooms.name). Same outcome, friendlier message.
      const msg = asMessage(e);
      if (/UNIQUE constraint failed: rooms\.name/.test(msg)) {
        return fail(`a room named "${name}" already exists`);
      }
      return fail(msg);
    }
  },
);

server.registerTool(
  "list_rooms",
  {
    title: "List rooms",
    description:
      "List chat rooms (oldest first by id, up to `limit`; `total` reports how " +
      "many exist) with present-member count, message count, last activity and " +
      "pinned intro. Long pinned/descriptions are listing previews (*_truncated " +
      "flags); join_room returns the full pinned. `next_id` present = more rows " +
      "exist; page by passing it back as `after_id` (keyset paging, so a room " +
      "deleted between pages cannot make you skip a live one).",
    inputSchema: z
      .object({
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max rooms to return (default 200)"),
        after_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Keyset paging cursor: the prior page's next_id. Returns rooms " +
              "whose id sorts after it.",
          ),
      })
      .strict(),
  },
  async ({ limit, after_id }) => {
    try {
      touchSession();
      const { rooms, total, next_id, size_trimmed } = store.listRooms(
        limit ?? 200,
        after_id ?? 0,
      );
      return ok({
        rooms,
        total,
        ...(next_id !== undefined ? { next_id, truncated: true } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "join_room",
  {
    title: "Join room",
    description:
      "Join a room (id or name) under an identity; sets it active for the " +
      "session. Omit agent_id to keep the session's current identity (on the " +
      "FIRST join a generated readable id is assigned and returned; reuse it " +
      "later to resume the same identity and read position). " +
      "type/role/description tell other agents who you are. Read the returned " +
      "`pinned` intro. `server_stale:true` = this server runs outdated code; " +
      "tell the user to reconnect the MCP. `cursor` (for several sessions " +
      "sharing one agent_id): 'shared' (default) = one marker per identity, " +
      "concurrent sessions SPLIT the backlog (work-queue style); 'private' = " +
      "this session keeps its own cursor (starting from the shared marker) " +
      "and sees the full stream independently.",
    inputSchema: z.object({
      room: z.string().min(1).max(500).describe("Room id or name to join"),
      agent_id: z
        .string()
        .max(200)
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), {
          message: "control characters are not allowed in agent ids",
        })
        // Reject an empty/whitespace-only id when PROVIDED: the handler trims
        // and treats a blank as "omitted" (keep/generate identity), so passing
        // "   " silently did something other than set that id. Omit the field
        // to get that behaviour deliberately; a blank string is an error.
        .refine((s) => s.trim().length > 0, {
          message:
            "agent_id cannot be empty or whitespace-only; omit it to keep or auto-assign an identity",
        })
        .optional()
        .describe(
          "Your stable identity/nickname. Omit to keep the session identity " +
            "(first join: a readable id is generated and returned).",
        ),
      type: z
        .string()
        .max(100)
        .optional()
        .describe("Agent type, e.g. 'claude', 'codex', 'gpt'"),
      role: z
        .string()
        .max(200)
        .optional()
        .describe("Your role in the room, e.g. 'reviewer', 'planner'"),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe("Short description of who you are / what you do"),
      cursor: z
        .enum(["shared", "private"])
        .optional()
        .describe(
          "'shared': one read marker per identity, concurrent sessions split " +
            "the backlog. 'private': this session keeps its own read " +
            "position. Omitted: keeps this session's current mode for the " +
            "room (shared on first join); only an explicit 'shared' discards " +
            "an existing private cursor.",
        ),
    }).strict(),
  },
  async ({ room, agent_id, type, role, description, cursor }) => {
    try {
      touchSession();
      const target = store.resolveRoom(room);
      if (!target) {
        return fail(
          `no room "${room}". Use list_rooms to see options or create_room to make one.`,
        );
      }
      let id: string;
      if (agent_id && agent_id.trim().length > 0) {
        id = agent_id.trim();
        store.upsertAgent(id, type ?? null, role ?? null, description ?? null);
      } else if (session.agentId !== null) {
        // STICKY identity: a session that already established who it is
        // keeps that identity on later joins. Generating a fresh id here
        // forked the session into a second identity whose twin kept its own
        // markers and memberships -- silent state the caller never asked for.
        id = session.agentId;
        store.upsertAgent(id, type ?? null, role ?? null, description ?? null);
      } else {
        // Generated ids are claimed atomically inside assignReadableId, so no
        // separate upsert here (it would risk clobbering a racing assigner).
        id = assignReadableId(type ?? null, role ?? null, description ?? null);
      }
      // Session state mutates only AFTER the join succeeds: flipping cursor
      // mode first would leave a failed join having silently changed the mode
      // for the still-active previous room.
      // Cursor mode is STICKY per (room, identity): an omitted `cursor` keeps
      // this session's existing mode FOR THIS IDENTITY. Treating omission as
      // an explicit 'shared' used to DELETE the session's private cursor on
      // any rejoin, and a room-only key let ANOTHER identity's shared join
      // clear this identity's mode with the same silent-loss outcome. Only an
      // explicit 'shared' downgrades, and only for the identity that joins.
      const key = privKey(target.id, id);
      const priv =
        cursor === "private" ||
        (cursor === undefined && session.privateRooms.has(key));
      store.joinRoom(target.id, id, priv ? SESSION_NONCE : null, SESSION_NONCE);
      if (priv) {
        session.privateRooms.add(key);
      } else {
        session.privateRooms.delete(key);
        // Mode switch hygiene: drop any leftover private row so my_mentions'
        // per-room COALESCE stops using a baseline this session abandoned.
        // (Reached on explicit 'shared', or on omitted-cursor joins where the
        // session held no private mode -- a no-op there.)
        store.clearSessionCursor(target.id, id, SESSION_NONCE);
      }
      session.agentId = id;
      session.roomId = target.id;
      const cur = store.getCursor(target.id, id, cursorId());
      if (!cur) {
        // The room was deleted by another process between our join and this
        // read; same recovery contract as requireActive.
        session.roomId = null;
        return fail(
          `room "${target.name}" was deleted while joining; rejoin with join_room`,
        );
      }
      return ok({
        agent_id: id,
        room_id: target.id,
        room_name: target.name,
        description: target.description,
        pinned: target.pinned,
        cursor: priv ? "private" : "shared",
        last_read_seq: cur.last_read_seq,
        unread: store.unreadCount(target.id, cur.last_read_seq, id),
        members: store.presentCount(target.id),
        // Ready-to-run background poller invocation, shell-quoted for THIS
        // id (see the server instructions for its options and semantics).
        poller_cmd: pollerCmd(id, { session: SESSION_NONCE }),
        // Surface staleness at the session-start checkpoint, where it is seen
        // once without per-call noise. True => this server is running old code;
        // reconnect the MCP. See server_info for the latest commit.
        server_stale: buildStatus().stale,
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "leave_room",
  {
    title: "Leave room",
    description:
      "Soft-leave the active room: your read position is kept, rejoining " +
      "resumes it. Clears the active room; your identity is kept (my_mentions " +
      "and later joins still work).",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      // Pass the process nonce so the leave is SESSION-scoped: it marks THIS
      // session's presence row left and recomputes identity presence, so a live
      // twin (shared or private) is never evicted. Presence is per-session for
      // every mode now, independent of the cursor nonce.
      const left = store.leaveRoom(roomId, agentId, SESSION_NONCE);
      // Keep the identity: the session is still this agent, and my_mentions
      // (memberships elsewhere) must keep working after leaving one room. The
      // room's cursor-mode entry also stays: its private position is preserved
      // for resume (matching leaveRoom keeping the session_markers row).
      session.roomId = null;
      return ok({ left, room_id: roomId, agent_id: agentId });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description: "Report the current session identity, active room and unread count.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      if (session.agentId === null || session.roomId === null) {
        return ok({
          joined: false,
          ...(session.agentId !== null ? { agent_id: session.agentId } : {}),
        });
      }
      const roomRow = store.getRoom(session.roomId);
      if (!roomRow) {
        // Room was deleted by another process; do not claim to be joined.
        // The identity survives.
        session.roomId = null;
        return ok({
          joined: false,
          agent_id: session.agentId,
          note: "active room was deleted; rejoin",
        });
      }
      const cur = store.getCursor(session.roomId, session.agentId, cursorId());
      return ok({
        joined: true,
        agent_id: session.agentId,
        room_id: session.roomId,
        room_name: roomRow?.name ?? null,
        cursor:
          session.privateRooms.has(privKey(session.roomId, session.agentId))
            ? "private"
            : "shared",
        last_read_seq: cur?.last_read_seq ?? 0,
        unread: store.unreadCount(
          session.roomId,
          cur?.last_read_seq ?? 0,
          session.agentId,
        ),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "list_agents",
  {
    title: "List agents in room",
    description:
      "List agents in the active room (up to `limit`; `total` rides along): " +
      "type/role/description, `last_read_seq` (read receipt: compare to a " +
      "message seq), `last_seen`, `idle_seconds`, `present` (has not left), " +
      "`active` (seen within active_within_minutes), `watching` (an open " +
      "blocking catch_up wait: a message now lands in a live turn). Long " +
      "descriptions are listing previews (description_truncated). " +
      "`next_after` present = more rows exist; page by passing it back as " +
      "`after` (keyset paging, so a concurrent join cannot make you skip or " +
      "duplicate an agent).",
    inputSchema: z.object({
      filter: z
        .string()
        .max(500)
        .optional()
        .describe("Substring to match against id/type/role/description"),
      active_within_minutes: z
        .number()
        .positive()
        .max(1440)
        .optional()
        .describe("Window for the `active` flag (default 5 minutes)"),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max agents to return (default 200)"),
      after: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Keyset paging cursor: the prior page's next_after."),
    }).strict(),
  },
  async ({ filter, active_within_minutes, limit, after }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const { agents, total, next_after, size_trimmed } = store.listAgents(
        roomId,
        active_within_minutes ?? 5,
        filter,
        limit ?? 200,
        after,
      );
      return ok({
        agents,
        total,
        ...(next_after !== undefined ? { next_after, truncated: true } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "post_message",
  {
    title: "Post message",
    description:
      "Post text/JSON to the active or explicit joined `room`. Returns `seq`, " +
      "factual recipient state, and `crossed` unread peer traffic for a new " +
      "insert. A deduplicated retry returns the original seq/key only; catch " +
      "up for current state. For a " +
      "dispositive post, use `if_last_read_seq` + `expected_room`; use " +
      "`client_message_id` to deduplicate an exact lost-response retry. " +
      "`crossed_preview_chars` max is 2000. `priority:true` survives explicit " +
      "priority-only backlog triage; `supersedes_seq` corrects your own post.",
    inputSchema: z.object({
      // ONE bare z.custom for all three shapes, deliberately:
      // - NOT z.record / z.object().passthrough(): both rebuild the object by
      //   assignment, and assigning key "__proto__" sets the prototype rather
      //   than an own property, so a top-level "__proto__" key was silently
      //   dropped before storage. z.custom passes the raw parsed value through
      //   (JSON.parse already made "__proto__" a safe own key -- no prototype
      //   pollution), so it round-trips like any other key.
      // - NOT a union with string/array arms: a z.custom arm is DROPPED from
      //   the generated JSON Schema, so tools/list advertised content as only
      //   string|array and schema-validating clients rejected every object
      //   body client-side. A bare z.custom generates an unconstrained schema,
      //   which admits objects; the description carries the contract and this
      //   validator enforces it at runtime.
      content: z
        .custom<string | unknown[] | Record<string, unknown>>(
          (v) =>
            typeof v === "string" ||
            Array.isArray(v) ||
            (typeof v === "object" && v !== null),
          { message: "content must be a string, JSON object, or JSON array" },
        )
        .describe(
          "Message body: a string, or a JSON object/array. Strings and " +
            "object keys must be well-formed Unicode (no lone surrogates).",
        ),
      to: z
        .array(
          z
            .string()
            .min(1)
            .max(200)
            .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), {
              message: "control characters are not allowed in agent ids",
            }),
        )
        .max(100)
        .optional()
        .describe("agent_ids this message is directed at (mentions); max 100"),
      reply_to_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("seq of a message in this room you are replying to"),
      supersedes_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "seq of YOUR OWN earlier message that this message supersedes " +
            "(correction/retraction)",
        ),
      priority: z
        .boolean()
        .optional()
        .describe(
          "Durable high-signal checkpoint for priority-only catch-up. " +
            "Immutable; correct it with a new priority post + supersedes_seq.",
        ),
      client_message_id: z
        .string()
        .min(1)
        .max(MAX_CLIENT_MESSAGE_ID_CHARS)
        .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), {
          message: "control characters are not allowed",
        })
        .optional()
        .describe(
          "Opaque idempotency key for this author+room. Repeating the exact " +
            "stored payload returns the original seq; reusing it for a " +
            "different payload fails. Repeat the same room/expected_room on " +
            "retry. Retained only as long as the message.",
        ),
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Post to a room you have JOINED (id or name) without changing " +
            "the active room. Omitted: the active room.",
        ),
      expected_room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Assert the ACTIVE room is this one (id or name); a mismatch " +
            "rejects the post. For dispositive posts, so the implicit " +
            "active room cannot silently misroute them. Not combinable " +
            "with room.",
        ),
      if_last_read_seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Conditional post (CAS) for dispositive messages: reject if ANY " +
            "message from others carries a seq above this (use your last " +
            "catch_up's new_last_read_seq). A token ahead of this room's " +
            "effective read cursor is invalid and rejected before posting. " +
            "A stale rejection returns posted:false with bounded crossed " +
            "previews; call catch_up for the full delta, then re-send the " +
            "same content with that call's token. Never needed for routine traffic.",
        ),
      crossed_preview_chars: z
        .number()
        .int()
        .positive()
        .max(MAX_CROSSED_PREVIEW_CHARS)
        .optional()
        .describe(
          `Max ${MAX_CROSSED_PREVIEW_CHARS}. When crossed > 0, also return the crossed messages as bounded ` +
            "previews (crossed_messages, per-row directed flag; " +
            "crossed_remaining when the bound cut the list). Posting never " +
            "consumes a crossed peer message: previews remain unread for " +
            "catch_up. An accepted post may normalize the marker only across " +
            "your own rows.",
        ),
    }).strict(),
  },
  async ({
    content,
    to,
    reply_to_seq,
    supersedes_seq,
    room,
    expected_room,
    if_last_read_seq,
    crossed_preview_chars,
    priority,
    client_message_id,
  }) => {
    try {
      touchSession();
      if (room !== undefined && expected_room !== undefined) {
        return fail(
          "pass either room (explicit target) or expected_room (active-room " +
            "assertion), not both",
        );
      }
      let agentId: string;
      let roomId: number;
      let roomName: string | null;
      let selector: string | null;
      if (room !== undefined) {
        // Explicit target: same membership rule as catch_up({room}).
        if (session.agentId === null) {
          return fail(
            "join a room first with join_room to establish your identity",
          );
        }
        agentId = session.agentId;
        const target = store.resolveRoom(room);
        if (!target) {
          return fail(`no room "${room}". Use list_rooms to see options.`);
        }
        if (!store.getMembership(target.id, agentId)) {
          return fail(
            `you have never joined room "${target.name}"; join_room it before posting there`,
          );
        }
        roomId = target.id;
        roomName = target.name;
        selector = session.privateRooms.has(privKey(target.id, agentId))
          ? SESSION_NONCE
          : null;
      } else {
        ({ agentId, roomId } = requireActive());
        roomName = store.getRoom(roomId)?.name ?? null;
        selector = cursorId();
        if (expected_room !== undefined) {
          const expect = store.resolveRoom(expected_room);
          if (!expect || expect.id !== roomId) {
            return fail(
              `expected_room "${expected_room}" does not match the active room ` +
                `(${roomId}${roomName ? ` "${roomName}"` : ""}); nothing was posted. ` +
                "Pass room: to target a specific room, or join_room it first.",
            );
          }
        }
      }
      touchCapturedRoom(roomId, agentId);
      const isText = typeof content === "string";
      // Validate structured strings DURING serialization, before JSON.stringify
      // escapes lone surrogates to harmless-looking ASCII. The store validates
      // the serialized body too, but cannot recover this semantic distinction.
      const body = isText
        ? (content as string)
        : stringifyWellFormedJson(content, "message content");
      if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BODY_BYTES) {
        return fail(
          `message body exceeds the ${MAX_MESSAGE_BODY_BYTES}-byte safety limit`,
        );
      }
      const mentions = to && to.length > 0 ? dedupe(to) : null;
      const res = store.postMessage(
        roomId,
        agentId,
        body,
        isText ? "text" : "json",
        mentions,
        reply_to_seq ?? null,
        supersedes_seq ?? null,
        selector,
        {
          ifLastReadSeq: if_last_read_seq ?? null,
          crossedPreviewChars: crossed_preview_chars,
          recipientActiveWithinMinutes: mentions ? 5 : undefined,
          priority: priority === true,
          clientMessageId: client_message_id ?? null,
        },
      );
      if (!res.posted) {
        if (res.rejected === "evidence_pruned") {
          return ok({
            posted: false,
            rejected: "evidence_pruned",
            room_id: roomId,
            room_name: roomName,
            oldest_retained_seq: res.oldest_retained_seq,
            pruned_through_seq: res.pruned_through_seq,
            retry:
              "messages after that token were pruned, so the server cannot prove the post is still current. " +
              "Call catch_up for this room, then re-send the SAME content with if_last_read_seq set to that " +
              "call's new_last_read_seq (nothing was stored)",
          });
        }
        // CAS reject: a structured non-error result (like claim's
        // granted:false). Nothing was stored; the caller's payload is its
        // own to re-send, so the reject carries the delta, not a draft.
        return ok({
          posted: false,
          rejected: "stale_read",
          room_id: roomId,
          room_name: roomName,
          crossed: res.crossed,
          crossed_directed: res.crossed_directed,
          crossed_range: res.crossed_range,
          crossed_messages: res.crossed_messages,
          ...(res.crossed_remaining !== undefined
            ? { crossed_remaining: res.crossed_remaining }
            : {}),
          retry:
            "call catch_up for this room, review the complete delta, then " +
            "re-send the SAME content with if_last_read_seq set to that " +
            "call's new_last_read_seq (nothing was stored)",
        });
      }
      if (res.deduplicated) {
        return ok({
          posted: true,
          deduplicated: true,
          seq: res.seq,
          room_id: roomId,
          room_name: roomName,
          client_message_id: res.client_message_id,
          note:
            "the original post was already stored; no second row was inserted. " +
            "The original crossed/recipient snapshot is not replayed; call catch_up for current state",
        });
      }
      const { seq, crossed, crossed_directed, crossed_range } = res;
      const recipients = res.recipients ?? [];
      // Loud but factual delivery state. Unknown/left are definitive routing
      // facts. Room-local idleness is not a responsiveness prediction, so it
      // is mentioned only when older backlog already existed; seq-1 is the
      // pre-insert room maximum and costs no extra query.
      const delivery_warnings = recipients.flatMap((r) => {
        if (r.status === "unknown") {
          return [`${r.id}: never joined this room; the tag reaches no one`];
        }
        if (r.status === "left") {
          return [
            r.watching
              ? `${r.id}: left this room; a wait lease is still recorded but may be stale`
              : `${r.id}: left this room; the message waits unread unless they return`,
          ];
        }
        if (r.watching) return [];
        const priorMarkerBehind =
          r.last_read_seq === null ? 0 : Math.max(0, seq - 1 - r.last_read_seq);
        if (
          r.status === "idle" &&
          (r.idle_seconds ?? 0) >= DELIVERY_STALL_SECONDS &&
          priorMarkerBehind > 0
        ) {
          return [
            `${r.id}: no observed activity in this room for ${fmtIdle(r.idle_seconds ?? 0)}; ` +
              `marker was ${priorMarkerBehind} seq behind before this post`,
          ];
        }
        return [];
      });
      return ok({
        posted: true,
        seq,
        room_id: roomId,
        room_name: roomName,
        ...(delivery_warnings.length > 0 ? { delivery_warnings } : {}),
        format: isText ? "text" : "json",
        priority: res.priority,
        ...(res.client_message_id !== undefined
          ? { client_message_id: res.client_message_id }
          : {}),
        to: mentions,
        reply_to_seq: reply_to_seq ?? null,
        supersedes_seq: supersedes_seq ?? null,
        crossed,
        crossed_directed,
        crossed_range,
        ...(res.crossed_messages !== undefined
          ? { crossed_messages: res.crossed_messages }
          : {}),
        ...(res.crossed_remaining !== undefined
          ? { crossed_remaining: res.crossed_remaining }
          : {}),
        recipients,
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "catch_up",
  {
    title: "Catch up on new messages",
    description:
      "Read one active/explicit joined room and ADVANCE its marker. Default is " +
      "lossless; `priority_only:true` is explicit lossy triage that always " +
      `keeps directed rows. \`wait_seconds\` blocks this call (effective max ${WAIT_CAP_SECONDS}; ` +
      "host/client limits may be lower). Empty reads disclose other unread " +
      "rooms. Own posts are skipped; use my_mentions for a cross-room peek.",
    inputSchema: z.object({
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Read a room you have JOINED (id or name) without changing the " +
            "active room; its read marker still advances. Omitted: the " +
            "active room.",
        ),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(WAIT_CAP_SECONDS)
        .optional()
        .describe(
          `Effective max ${WAIT_CAP_SECONDS}. Block until a message from another agent ` +
            "lands in the target room, then return it (marker advances) in " +
            "this same call; 0/omitted = return immediately. On timeout: " +
            "timed_out:true + call_again. Default max: 25. Operators may set " +
            "AGENT_CHAT_MAX_WAIT_SECONDS up to 120 only after measuring the " +
            "host timeout. Waiting holds YOUR turn; use the poller while doing other work.",
        ),
      priority_only: z
        .boolean()
        .optional()
        .describe(
          "LOSSY backlog triage: return priority:true messages plus every " +
            "mention/reply directed at you, and advance past lower-priority " +
            "rows through cutoff_seq. Cannot be combined with wait_seconds.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max messages to return this call (default 50)"),
      preview_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Truncate each body to this many chars; cut bodies carry " +
            "truncated:true + length (for an explicit cross-room read, fetch " +
            "the full body with get_message using the same room). Truncated " +
            "json = partial string, not an object.",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe(
          "Serialized-size budget for the complete response (default 100000). " +
            "Normal mode advances only over returned peer messages and any " +
            "following own-only suffix; priority-only " +
            "mode may also advance over disclosed skipped_count rows. " +
            "byte_limited:true = more remain, call again. An unusually " +
            "escape-heavy room name may require a larger value so the fixed " +
            "routing metadata plus one recoverable message stub can fit.",
        ),
      mentions_me: z
        .boolean()
        .optional()
        .describe("REMOVED in v0.6.0; use my_mentions. Passing it is an error."),
      after_seq: z
        .number()
        .optional()
        .describe("REMOVED in v0.6.0; my_mentions pages with after_id."),
    }).strict(),
  },
  async (
    {
      room,
      wait_seconds,
      priority_only,
      limit,
      preview_chars,
      max_bytes,
      mentions_me,
      after_seq,
    },
    extra,
  ) => {
    const startedMs = Date.now();
    let heldWaitSlot = false;
    try {
      touchSession();
      // Reject, never strip: a v0.5 caller sending mentions_me expected a
      // non-advancing filtered peek; silently running an ADVANCING full sync
      // instead would eat its unread backlog.
      if (mentions_me !== undefined || after_seq !== undefined) {
        return fail(
          "mentions_me/after_seq were removed in v0.6.0: catch_up is now " +
            "a full room sync by default and ADVANCES your marker. For messages " +
            "directed at you use my_mentions (cross-room inbox, never advances " +
            "markers, pages with after_id). This call was rejected instead of " +
            "silently changing semantics.",
        );
      }
      if (priority_only === true && (wait_seconds ?? 0) > 0) {
        return fail(
          "priority_only is lossy backlog triage and cannot be combined with " +
            "wait_seconds; run priority_only once, then use ordinary " +
            "catch_up({wait_seconds}) for live traffic",
        );
      }
      const waitSeconds = wait_seconds ?? 0;
      // Acquire the bounded-wait slot before room resolution or liveness
      // writes. Otherwise a burst of rejected waits aimed at distinct rooms
      // could still perform an unbounded burst of synchronous DB work.
      if (waitSeconds > 0) {
        if (activeBlockingWaits >= MAX_CONCURRENT_WAITS) {
          return fail(
            `at most ${MAX_CONCURRENT_WAITS} blocking catch_up waits may run ` +
              "in one MCP process; wait for one to finish or use the background watcher",
          );
        }
        activeBlockingWaits++;
        heldWaitSlot = true;
      }
      // --- Resolve and CAPTURE, all before the first await. Concurrent
      // dispatch can mutate `session` (identity, active room, cursor modes)
      // while a wait sleeps, so everything below runs off these captured
      // values; the only deliberate re-read of session state is the
      // cursor-mode epoch check (modeFlipped).
      let agentId: string;
      let roomId: number;
      let roomName: string | null;
      let selector: string | null;
      if (room !== undefined) {
        // Cross-room read: the ACTIVE room and its cursor mode stay untouched.
        // Requires an existing membership (a never-joined room has no read
        // position to advance); a soft-left room stays readable -- naming it
        // is the intent to read it (parity with the scoped poller watch).
        if (session.agentId === null) {
          return fail(
            "join a room first with join_room to establish your identity",
          );
        }
        agentId = session.agentId;
        const target = store.resolveRoom(room);
        if (!target) {
          return fail(`no room "${room}". Use list_rooms to see options.`);
        }
        if (!store.getMembership(target.id, agentId)) {
          return fail(
            `you have never joined room "${target.name}", so there is no read position to advance; join_room it first`,
          );
        }
        roomId = target.id;
        roomName = target.name;
        // Cursor selector for the TARGET room. cursorId() answers only for
        // the active room, so it must not be used here.
        selector = session.privateRooms.has(privKey(target.id, agentId))
          ? SESSION_NONCE
          : null;
      } else {
        ({ agentId, roomId } = requireActive());
        roomName = store.getRoom(roomId)?.name ?? null;
        selector = cursorId();
      }
      touchCapturedRoom(roomId, agentId);
      const signal = extra?.signal;
      // max_bytes bounds the COMPLETE JSON text returned to the MCP client,
      // not merely ChatStore.catchUp's inner object. v0.9 added routing fields
      // and v0.10 added wait fields after the store had spent the full budget;
      // an advancing page could then be rejected after its marker committed.
      // Reserve their exact serialized cost BEFORE the advancing transaction.
      const responseIdentity = {
        agent_id: agentId,
        room_id: roomId,
        room_name: roomName,
      };
      const responseMetadataReserve =
        JSON.stringify({
          ...responseIdentity,
          ...(waitSeconds > 0
            ? {
                waited_ms: Number.MAX_SAFE_INTEGER,
                timed_out: true,
                call_again: true,
              }
            : {}),
        }).length - 1; // merging two non-empty objects replaces `}{` with `,`
      const requestedMaxBytes = max_bytes ?? DEFAULT_MAX_BYTES;
      const storeMaxBytes = requestedMaxBytes - responseMetadataReserve;
      if (storeMaxBytes < MIN_CATCH_UP_RESULT_BUDGET) {
        return fail(
          `max_bytes=${requestedMaxBytes} is too small for this room/identity's ` +
            `serialized catch_up metadata; use at least ${
              responseMetadataReserve + MIN_CATCH_UP_RESULT_BUDGET
            } (nothing was read or advanced)`,
        );
      }

      // Identity fields ride on EVERY response so the caller always knows
      // which room (under which identity) this call consumed.
      const respond = (
        result: Record<string, unknown>,
        extraFields: Record<string, unknown> = {},
      ): ToolResult =>
        ok({
          ...responseIdentity,
          ...result,
          ...extraFields,
        });
      const advancingRead = (includeUnreadSummary: boolean) =>
        store.catchUp(
          roomId,
          agentId,
          limit ?? 50,
          preview_chars,
          storeMaxBytes,
          selector,
          // rooms_with_unread on an empty read; the RAW nonce, my_mentions
          // style, so every room baselines off its own cursor mode.
          includeUnreadSummary
            ? {
                sessionId: SESSION_NONCE,
                priorityOnly: priority_only === true,
              }
            : null,
        );
      // Cursor-mode epoch check: a private<->shared rejoin mid-wait re-bases
      // the cursor (an explicit shared rejoin even deletes the private row),
      // so an advancing read after a flip would consume from a DIFFERENT
      // position than this call captured. Abort loudly instead.
      const modeFlipped = (): boolean =>
        (session.privateRooms.has(privKey(roomId, agentId))
          ? SESSION_NONCE
          : null) !== selector;
      const sessionChangedResult = (): ToolResult =>
        respond({
          messages: [],
          session_changed: true,
          call_again: true,
          waited_ms: Date.now() - startedMs,
          note:
            "this room's cursor mode flipped (private/shared rejoin) " +
            "mid-wait; nothing was read or advanced -- call catch_up again " +
            "to read from the current cursor",
        });
      const roomDeletedResult = (): ToolResult =>
        fail(
          `room "${roomName ?? roomId}" was deleted while waiting; nothing was read. list_rooms shows what still exists.`,
        );

      // Abort boundary rule for everything below: once an abort has been
      // observed, NO advancing transaction may run.
      if (signal?.aborted) return respond({ aborted: true });
      // A blocking wait discards an initial empty result. Do not compute its
      // exact cross-room unread summary only to throw it away; the timeout read
      // below includes the summary that is actually returned.
      const first = advancingRead(waitSeconds === 0);
      if (first.messages.length > 0 || waitSeconds === 0) {
        return respond(
          first,
          waitSeconds > 0 ? { waited_ms: Date.now() - startedMs } : {},
        );
      }

      // --- Blocking wait: abort-aware timer, non-advancing read-only probe
      // with catchUp's exact predicate, advancing read only on a hit.
      const deadlineMs = startedMs + waitSeconds * 1000;
      // One lease token per CALL, not per process. Concurrent waits from one
      // MCP process must not overwrite and then delete each other's row.
      const waitLeaseId = `${SESSION_NONCE}:${randomUUID()}`;
      // Presence lease: when its best-effort write succeeds, `watching`
      // records that this call was open. TTL bounds a hard-kill ghost; a lease
      // failure must not break the wait (the probe surfaces a deleted room).
      try {
        store.beginWaitLease(
          roomId,
          agentId,
          waitLeaseId,
          waitSeconds + WAIT_LEASE_GRACE_SECONDS,
        );
      } catch {}
      try {
        while (Date.now() < deadlineMs) {
          await abortableSleep(
            Math.min(WAIT_PROBE_INTERVAL_MS, deadlineMs - Date.now()),
            signal,
          );
          if (signal?.aborted) return respond({ aborted: true });
          // The final advancing read below is the deadline check. Do not start
          // a heartbeat/probe after the requested wait has elapsed: either can
          // consume SQLite's busy timeout and needlessly extend total RPC time.
          if (Date.now() >= deadlineMs) break;
          // Self-throttled heartbeat: a genuinely-waiting agent reads as
          // `active` to peers instead of indistinguishable from a dormant one.
          touchCapturedRoom(roomId, agentId);
          let unread: number;
          try {
            unread = store.unreadProbe(roomId, agentId, selector);
          } catch (e) {
            if (!store.getRoom(roomId)) return roomDeletedResult();
            throw e;
          }
          if (unread === 0) continue;
          if (signal?.aborted) return respond({ aborted: true });
          if (modeFlipped()) return sessionChangedResult();
          let hit;
          try {
            // A probe/read race may make this empty too; its result is discarded,
            // so omit the cross-room exact-count summary here as well.
            hit = advancingRead(false);
          } catch (e) {
            if (!store.getRoom(roomId)) return roomDeletedResult();
            throw e;
          }
          // Cursor normalization may advance across an own-only suffix while
          // returning no messages. That is maintenance, not a wake result.
          if (hit.messages.length > 0) {
            return respond(hit, { waited_ms: Date.now() - startedMs });
          }
          // A shared twin consumed the page between probe and read: keep
          // waiting on the (now advanced) cursor, never refire stale rows.
        }
        if (signal?.aborted) return respond({ aborted: true });
        if (modeFlipped()) return sessionChangedResult();
        let last;
        try {
          last = advancingRead(true);
        } catch (e) {
          if (!store.getRoom(roomId)) return roomDeletedResult();
          throw e;
        }
        return respond(last, {
          waited_ms: Date.now() - startedMs,
          ...(last.messages.length === 0
            ? { timed_out: true, call_again: true }
            : {}),
        });
      } finally {
        try {
          store.endWaitLease(roomId, agentId, waitLeaseId);
        } catch {}
      }
    } catch (e) {
      return fail(asMessage(e));
    } finally {
      if (heldWaitSlot) activeBlockingWaits--;
    }
  },
);

server.registerTool(
  "my_mentions",
  {
    title: "My mentions inbox (all rooms)",
    description:
      "Cross-room INBOX: unread messages directed at you (your @mentions, or " +
      "replies to messages you wrote) across EVERY room you are present in, " +
      "oldest first, tagged room_id/room_name; rooms you left are muted. " +
      "Strictly a PEEK: never advances read markers; an entry clears once you " +
      "read its room (catch_up or mark_read there); page more with after_id = " +
      "next_after_id. Needs an identity, not an active room. `by_room` lists " +
      "every room with ANY unread from others: `directed` (aimed at you) and " +
      "`unread` (total, broadcasts included); an EMPTY inbox with nonzero " +
      "by_room unread means rooms still have traffic to sync, not silence.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max inbox entries to return (default 50)"),
      preview_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Truncate each body to this many chars (truncated:true + length " +
            "mark the cut; fetch the full body with get_message and pass the " +
            "entry's room_id or room_name as room)",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe("Serialized-size budget for the response (default 100000)"),
      after_id: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Paging cursor: the prior response's next_after_id. Paging state " +
            "only; moves no read marker.",
        ),
    }).strict(),
  },
  async ({ limit, preview_chars, max_bytes, after_id }) => {
    try {
      touchSession();
      if (session.agentId === null) {
        return fail(
          "join a room first with join_room to establish your identity",
        );
      }
      // Always pass the nonce: the store's per-room COALESCE uses this
      // session's private cursor exactly where one exists (shared joins clear
      // theirs), so each room gets ITS OWN mode rather than the active room's.
      return ok(
        store.myMentions(
          session.agentId,
          limit ?? 50,
          preview_chars,
          max_bytes,
          SESSION_NONCE,
          after_id ?? 0,
        ),
      );
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "pending_work",
  {
    title: "Pending directed work (all agents)",
    description:
      "Cross-agent view: which PRESENT agents have unread messages directed " +
      "at them (mentions or replies), one row per agent+room, oldest pending " +
      "first with `oldest_seq`/`oldest_unix` and per-room `idle_seconds`. " +
      "For a supervisor deciding whom to wake or nudge; my_mentions answers " +
      "this only for yourself. Read markers are identity-level, so a lagging " +
      "private session can be further behind than shown. `next_after` means " +
      "more rows exist; pass it back as `after`. Pending rows are live, so " +
      "dedupe agent_id+room_id during a paged sweep.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max rows to return (default 50)"),
      after: z
        .object({
          oldest_unix: z.number().int().nonnegative(),
          agent_id: z
            .string()
            .min(1)
            .max(200)
            .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), {
              message: "control characters are not allowed in agent ids",
            }),
          room_id: z.number().int().positive(),
        })
        .strict()
        .optional()
        .describe("Keyset cursor returned as next_after by the prior page"),
    }).strict(),
  },
  async ({ limit, after }) => {
    try {
      touchSession();
      const { pending, truncated, size_trimmed, next_after } =
        store.pendingDirected(limit ?? 50, after);
      return ok({
        pending,
        ...(truncated ? { truncated: true, next_after } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "wait_for_messages",
  {
    title: "Wait for new messages (background poller)",
    description:
      "Return (do not run) one childless background poller command. It watches " +
      "all joined rooms or one `room`; `mentions_only` narrows it. Generated " +
      "commands exit 0 on hit or quiet deadline: parse stdout `has_updates`. " +
      "Use catch_up({wait_seconds}) for an in-turn blocking read.",
    inputSchema: z
      .object({
        room: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Scope the watch to one room (id or name); default watches every " +
              "room you are present in",
          ),
        mentions_only: z
          .boolean()
          .optional()
          .describe("Fire only when a message mentions you or replies to you"),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(86_400)
          .optional()
          .describe(
            "Absolute finite deadline (default 1200). Generated commands " +
              "report a quiet deadline as has_updates:false with exit 0; " +
              "direct CLI without --ok-on-timeout uses exit 124.",
          ),
        interval: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .optional()
          .describe("Seconds between probes (default 5)"),
      })
      .strict(),
  },
  async ({ room, mentions_only, timeout, interval }) => {
    try {
      touchSession();
      const agentId = session.agentId;
      if (agentId === null) {
        return fail(
          "join a room first with join_room to establish your identity, then call this again",
        );
      }
      let roomArg: string | undefined;
      if (room !== undefined) {
        // Resolve to an id and require only that a membership row EXISTS -- not
        // that it is still present. A scoped --room probe (check.ts) baselines
        // off the room's preserved read marker regardless of left_at, and the
        // poller contract deliberately supports watching a room after
        // soft-leaving it ("naming the room is the intent to watch it").
        // Rejecting soft-left here contradicted that and blocked a valid watch.
        // A never-joined room has no marker to baseline from, so that still
        // fails with the real remedy.
        const target = store.resolveRoom(room);
        if (!target) {
          return fail(
            `no room "${room}". Use list_rooms to see options, or omit room to watch all rooms you are in.`,
          );
        }
        const m = store.getMembership(target.id, agentId);
        if (!m) {
          return fail(
            `you have never joined room "${target.name}", so there is no read position to watch from; join_room it first, then call wait_for_messages`,
          );
        }
        roomArg = String(target.id);
      } else if (store.presentRoomCount(agentId) === 0) {
        // Unscoped watch of ALL your rooms, but you are in none: the poller
        // would exit 2 immediately. Say so rather than emit a doomed command.
        return fail(
          "you are not present in any room, so there is nothing to watch; join_room first, or pass a room you have joined",
        );
      }
      const command = pollerCmd(agentId, {
        room: roomArg,
        mentionsOnly: mentions_only,
        session: SESSION_NONCE,
        timeoutSec: timeout,
        intervalSec: interval,
      });
      return ok({
        command,
        run_as: "background process (do not wait for it inline)",
        how_to:
          "Run `command` in the background. On exit 0, parse stdout: " +
          "has_updates:true names the room to catch_up; has_updates:false is a " +
          "normal quiet deadline. Exit 2 is an error/duplicate watcher. Re-arm " +
          "only if still needed. The exit is only an OS signal; whether it " +
          "wakes YOU depends on the harness.",
        exit_codes: {
          "0": "normal completion; inspect stdout has_updates",
          "124": "quiet timeout only for direct CLI without --ok-on-timeout",
          "2": "error or equivalent watcher already running",
        },
        baselined: false,
        single_process: true,
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "read_history",
  {
    title: "Read history",
    description:
      "Browse messages WITHOUT changing your read marker. No before_seq = the " +
      "most recent `limit` messages; page backward with before_seq = the " +
      "prior call's oldest_seq. Oldest-first; replies carry a `reply_to` " +
      "preview. For unread directed messages use my_mentions; to find a " +
      "topic use search_messages.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("How many messages to return (default 50)"),
      before_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Return messages older than this seq (for pagination)"),
      mentions_me: z
        .boolean()
        .optional()
        .describe("REMOVED in v0.6.0; use my_mentions. Passing it is an error."),
      preview_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Truncate each body to this many chars; cut bodies carry " +
            "truncated:true + length (full body via get_message). Truncated " +
            "json = partial string, not an object.",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe(
          "Serialized-size budget per page (default 100000); " +
            "byte_limited:true = trimmed, continue with before_seq.",
        ),
    }).strict(),
  },
  async ({ limit, before_seq, mentions_me, preview_chars, max_bytes }) => {
    try {
      touchSession();
      if (mentions_me !== undefined) {
        return fail(
          "mentions_me was removed from read_history in v0.6.0; use " +
            "my_mentions for the cross-room directed inbox or search_messages " +
            "to find topics.",
        );
      }
      const { roomId } = requireActive();
      return ok(
        store.readHistory(roomId, limit ?? 50, before_seq, preview_chars, max_bytes),
      );
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "mark_read",
  {
    title: "Mark read",
    description:
      "Advance (or rewind) your read marker WITHOUT returning messages. Omit " +
      "`seq` to jump to the latest (skip the backlog); a lower `seq` " +
      "re-exposes messages to catch_up. Nothing is deleted; read_history " +
      "still sees everything. Returns previous/new marker and the latest seq.",
    inputSchema: z.object({
      seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Marker target; omit to jump to the latest message"),
    }).strict(),
  },
  async ({ seq }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      return ok(store.markRead(roomId, agentId, seq, cursorId()));
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "get_message",
  {
    title: "Get one message",
    description:
      "Fetch one message by seq (e.g. to resolve 'see message 8'). Bodies " +
      "return up to `max_chars` per call (escape-heavy bodies return fewer: " +
      "the SERIALIZED slice honors max_chars too); longer ones arrive sliced " +
      "with `length`, `offset`, and `next_offset`. truncated:true = more " +
      "remains BEYOND the slice: call again with offset = next_offset until " +
      "truncated is false. offset/length/next_offset count CHARACTERS " +
      "(codepoints). A sliced json body is a raw partial string. Pass `room` " +
      "when expanding a result from catch_up({room}) or my_mentions; seqs " +
      "are per-room and omission reads the active room.",
    inputSchema: z.object({
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Read a room you have joined (id or name) without changing the " +
            "active room; omit to use the active room",
        ),
      seq: z.number().int().positive().describe("Message number to fetch"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Character offset to start the body slice at (default 0)"),
      max_chars: z
        .number()
        .int()
        .min(100)
        .max(400_000)
        .optional()
        .describe("Max body characters to return (default 100000)"),
    }).strict(),
  },
  async ({ room, seq, offset, max_chars }) => {
    try {
      touchSession();
      const { roomId, roomName } = resolveJoinedRoom(room);
      if (session.agentId !== null) {
        touchCapturedRoom(roomId, session.agentId);
      }
      const msg = store.getMessage(roomId, seq, offset ?? 0, max_chars);
      if (!msg) {
        return fail(`no message ${seq} in room "${roomName ?? roomId}"`);
      }
      return ok(msg);
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "get_thread",
  {
    title: "Get thread",
    description:
      "Fetch a message with its parent and a bounded tree of its replies " +
      "(pre-order, `depth` field, 1 = direct reply; `max_depth` levels, " +
      "default 3; `replies_capped` flags the internal cap). One shared byte " +
      "budget covers message + parent + replies, so oversized bodies arrive " +
      "truncated:true with length; page full text via get_message using the " +
      "same room. Pass `room` for a cross-room result; omission uses the " +
      "active room.",
    inputSchema: z.object({
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Read a room you have joined (id or name) without changing the " +
            "active room; omit to use the active room",
        ),
      seq: z.number().int().positive().describe("Message number to expand"),
      max_depth: z
        .number()
        .int()
        .positive()
        .max(10)
        .optional()
        .describe("Reply levels to walk (default 3, max 10)"),
      preview_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate reply bodies to this many characters"),
    }).strict(),
  },
  async ({ room, seq, max_depth, preview_chars }) => {
    try {
      touchSession();
      const { roomId, roomName } = resolveJoinedRoom(room);
      if (session.agentId !== null) {
        touchCapturedRoom(roomId, session.agentId);
      }
      const thread = store.getThread(roomId, seq, max_depth ?? 3, preview_chars);
      if (!thread) {
        return fail(`no message ${seq} in room "${roomName ?? roomId}"`);
      }
      return ok(thread);
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "set_room_intro",
  {
    title: "Set room intro",
    description:
      "Set or update the pinned intro/conventions for the active room. Pass an " +
      "empty string to clear it. Joiners see this in join_room.",
    inputSchema: z.object({
      text: z
        .string()
        .max(10_000)
        .describe("Pinned intro text (empty string clears it)"),
    }).strict(),
  },
  async ({ text }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const value = text.length > 0 ? text : null;
      store.setPinned(roomId, value);
      return ok({ room_id: roomId, pinned: value });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description:
      "Full-text search of message bodies in the active room, best matches " +
      "first. `query` is FTS5 syntax: bare terms are ANDed; supports OR, NOT, " +
      'quoted "phrases", and prefix* . Use this instead of paging read_history ' +
      "to find where a topic was discussed. `next_offset` present = more " +
      "matches exist (a byte cut or the limit); pass it back as `offset` to " +
      "page the rest.",
    inputSchema: z.object({
      query: z.string().min(1).max(1000).describe("FTS5 search query"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max results (default 20)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Skip this many best matches (prior page's next_offset)"),
    }).strict(),
  },
  async ({ query, limit, offset }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      return ok(store.searchMessages(roomId, query, limit ?? 20, offset ?? 0));
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "claim",
  {
    title: "Claim a resource",
    description:
      "Claim exclusive (advisory) ownership of a named resource BEFORE " +
      "working on it, e.g. 'file:src/db.ts' or 'task:B-414'. Atomic " +
      "single-winner (unlike 'I claim X' chat posts, which can cross). " +
      "Returns granted:true with RFC3339-UTC expires_at, or granted:false with the " +
      "holder. Claims expire after ttl_seconds (default 900); re-claim your " +
      "own key to renew. Advisory only: nothing is physically locked, " +
      "cooperating agents must check. Ownership is per agent_id. Pass room " +
      "to operate in another joined room without changing the active room.",
    inputSchema: z.object({
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Room id or name you have joined; omit to use the active room",
        ),
      key: z
        .string()
        .min(1)
        .max(500)
        .describe("Resource name, e.g. 'file:src/db.ts' or 'task:refactor-x'"),
      ttl_seconds: z
        .number()
        .int()
        .positive()
        .max(86_400)
        .optional()
        .describe("Claim lifetime in seconds (default 900 = 15 minutes)"),
      note: z
        .string()
        .max(2000)
        .optional()
        .describe("What you are doing with it (shown to other agents)"),
    }).strict(),
  },
  async ({ room, key, ttl_seconds, note }) => {
    try {
      touchSession();
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      return ok({
        room_id: roomId,
        room_name: roomName,
        ...store.claimResource(
          roomId,
          key,
          agentId,
          ttl_seconds ?? 900,
          note ?? null,
        ),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "release_claim",
  {
    title: "Release a claim",
    description:
      "Release a claim you hold so others can take it. Expired claims can be " +
      "released by anyone; an active claim only by its holder. Pass room to " +
      "operate in another joined room without changing the active room.",
    inputSchema: z.object({
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Room id or name you have joined; omit to use the active room",
        ),
      key: z.string().min(1).max(500).describe("Resource name to release"),
    }).strict(),
  },
  async ({ room, key }) => {
    try {
      touchSession();
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      return ok({
        room_id: roomId,
        room_name: roomName,
        ...store.releaseClaim(roomId, key, agentId),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "list_claims",
  {
    title: "List claims",
    description:
      "List active (unexpired) claims in the active or named joined room " +
      "without changing the active room (up to `limit`, " +
      "`total` active count rides along): key, holder, note (listing preview, " +
      "note_truncated flags a cut), and seconds until expiry. Check before " +
      "starting work that overlaps someone's claim. `next_key` present = more " +
      "rows exist; page by passing it back as `after_key` (keyset paging, so a " +
      "claim expiring between pages cannot make you skip a live one). " +
      "expires_at is RFC3339 UTC; expires_in_seconds is relative.",
    inputSchema: z
      .object({
        room: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Room id or name you have joined; omit to use the active room",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max claims to return (default 200)"),
        after_key: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Keyset paging cursor: the prior page's next_key. Returns claims " +
              "whose key sorts after it.",
          ),
      })
      .strict(),
  },
  async ({ room, limit, after_key }) => {
    try {
      touchSession();
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      const { claims, total, next_key, size_trimmed } = store.listClaims(
        roomId,
        limit ?? 200,
        after_key ?? "",
      );
      return ok({
        room_id: roomId,
        room_name: roomName,
        claims,
        total,
        ...(next_key !== undefined ? { next_key, truncated: true } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "prune_messages",
  {
    title: "Prune messages",
    description:
      "Delete the oldest messages in the active room, keeping the newest " +
      "`keep_last` (kept seqs and future numbering unchanged). Destructive, " +
      "not reversible. By default REFUSES (refused:true with " +
      "would_delete_unread/min_read_seq) if any non-author member has not " +
      "read a doomed message yet, including members that left and lagging " +
      "private session cursors; force=true prunes anyway.",
    inputSchema: z.object({
      keep_last: z
        .number()
        .int()
        .positive()
        .describe("How many of the newest messages to keep"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Delete even messages a member (present or left) has not read yet",
        ),
    }).strict(),
  },
  async ({ keep_last, force }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      return ok({
        room_id: roomId,
        ...store.pruneMessages(roomId, keep_last, force ?? false),
      });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

server.registerTool(
  "delete_room",
  {
    title: "Delete room",
    description:
      "Permanently delete a room (by id or name) and ALL related data " +
      "(messages, memberships, read positions, claims). Requires " +
      "confirm=true. Destructive, not reversible, unauthenticated: any caller " +
      "can delete any room. Returns the removed counts.",
    inputSchema: z.object({
      room: z.string().min(1).max(500).describe("Room id or name to delete"),
      confirm: z
        .boolean()
        .describe("Must be true; a guard against accidental deletion"),
    }).strict(),
  },
  async ({ room, confirm }) => {
    try {
      touchSession();
      const target = store.resolveRoom(room);
      if (!target) return fail(`no room "${room}"`);
      if (confirm !== true) {
        return fail(`pass confirm:true to delete room ${target.id} ("${target.name}")`);
      }
      const result = store.deleteRoom(target.id);
      // Drop every identity's private-mode entry for the dead room.
      // (Deleting the current element during Set iteration is well-defined.)
      for (const k of session.privateRooms) {
        if (k.startsWith(`${target.id}\u0000`)) session.privateRooms.delete(k);
      }
      if (session.roomId === target.id) {
        session.roomId = null; // identity survives; only the room is gone
      }
      return ok({ deleted_room: target.id, name: target.name, ...result });
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

// Readable identity generation for agents that omit agent_id. Two short word
// lists give ~676 base combinations; a hex suffix (then a UUID fallback)
// guarantees a free id even under collision. The id is claimed atomically via
// tryCreateAgent so concurrent assigners cannot land on the same identity.
const ID_ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "cobalt", "copper", "deft", "eager",
  "fern", "gilded", "hardy", "ivory", "jade", "keen", "lucid", "mellow",
  "nimble", "olive", "prime", "quiet", "rapid", "sable", "teal", "umber",
  "vivid", "warm",
];
const ID_NOUNS = [
  "otter", "falcon", "cedar", "harbor", "lynx", "maple", "comet", "delta",
  "ember", "fjord", "grove", "heron", "inlet", "kite", "larch", "mesa",
  "nimbus", "onyx", "pike", "quartz", "ridge", "summit", "tundra", "vale",
  "willow", "yarrow",
];

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

/** Assign and atomically claim a readable, collision-free agent id. */
function assignReadableId(
  type: string | null,
  role: string | null,
  description: string | null,
): string {
  for (let i = 0; i < 30; i++) {
    const base = `${pick(ID_ADJECTIVES)}-${pick(ID_NOUNS)}`;
    // After a run of plain-name misses, widen the space with a short suffix.
    const id = i < 12 ? base : `${base}-${randomUUID().slice(0, 4)}`;
    if (store.tryCreateAgent(id, type, role, description)) return id;
  }
  // Last resort: keep drawing until an id is actually CLAIMED. Returning an
  // unclaimed id here silently adopted an EXISTING identity (shared read
  // markers and claims); ids are self-asserted, so a collision is improbable
  // but not impossible.
  for (let i = 0; i < 30; i++) {
    const id = `agent-${randomUUID().slice(0, 8)}`;
    if (store.tryCreateAgent(id, type, role, description)) return id;
  }
  throw new Error(
    "could not allocate a generated agent id; pass an explicit agent_id",
  );
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Room-local inactivity threshold for a factual pre-existing-backlog warning.
 * Chosen well past the 5-minute `active` window to avoid routine idle noise. */
const DELIVERY_STALL_SECONDS = 1800;

/** Human-readable idle duration for delivery warnings ("2h05m", "45m", "90s"). */
function fmtIdle(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let shutdownPromise: Promise<void> | null = null;
function shutdown(code: number, message?: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  process.exitCode = code;
  if (message) process.stderr.write(`${message}\n`);
  shutdownPromise = (async () => {
    // Keep a hard bound even if a third-party transport stops honoring close.
    const forcedExit = setTimeout(() => process.exit(code), 3_000);
    try {
      // Transport close synchronously aborts every SDK request signal. Wait for
      // their finally blocks (notably wait-lease deletion) before closing the
      // shared store, so EOF cannot leave a wait alive or advance afterward.
      await server.close().catch(() => undefined);
      await Promise.allSettled([...activeToolRequests]);
      try {
        store.close();
      } catch {}
    } finally {
      clearTimeout(forcedExit);
      process.exit(code);
    }
  })();
  return shutdownPromise;
}

async function main(): Promise<void> {
  // The SDK's stock ReadBuffer has no frame cap and repeatedly concatenates a
  // growing partial line. Feed it complete, size-bounded lines instead: its
  // supported custom-stdin constructor still owns protocol parsing/writes.
  const boundedInput = new BoundedLineTransform();
  boundedInput.once("error", (error) => {
    process.stdin.unpipe(boundedInput);
    process.stdin.pause();
    // A frame this large cannot be parsed safely enough to recover its request
    // id. Close the owned transport and terminate instead of leaving the MCP
    // client waiting on a half-open connection.
    void shutdown(1, `fatal: ${asMessage(error)}`);
  });
  // The SDK's stdio transport does not observe EOF. Closing it here aborts
  // in-flight waits before they can consume a message for a dead client.
  boundedInput.once("end", () => void shutdown(0));
  process.stdout.once("error", (error) => {
    void shutdown(1, `fatal: stdout disconnected: ${asMessage(error)}`);
  });
  process.stderr.once("error", () => void shutdown(1));
  const transport = new StdioServerTransport(boundedInput, process.stdout);
  await server.connect(transport);
  process.stdin.once("error", (error) => boundedInput.destroy(error));
  process.stdin.pipe(boundedInput);
  // stdio transport: do not write to stdout; it carries the JSON-RPC stream.
  process.stderr.write(`agent-chat-mcp ready (db: ${store.path})\n`);
}

main().catch((e) => {
  void shutdown(1, `fatal: ${asMessage(e)}`);
});
