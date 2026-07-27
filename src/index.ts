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
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ChatStore,
  ModelTupleMismatchError,
  PersonaLostError,
  DEFAULT_MAX_BYTES,
  MAX_AGENT_ID_CHARS,
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
    epoch?: number;
    timeoutSec?: number;
    intervalSec?: number;
  } = {},
): string {
  let cmd = `${POLLER_COMMAND.map(shq).join(" ")} --agent ${shq(agentId)}`;
  // Generated commands belong to this MCP runtime. If the client reconnects
  // and this server exits, the watcher retires within five seconds instead of
  // accumulating until a long timeout. Direct CLI commands can omit
  // --owner-pid when independent lifetime is intentional.
  //
  // --owner-pid together with --epoch is also what marks a watcher as GENERATED
  // rather than hand-run, and only a generated watcher refreshes last_seen.
  cmd += ` --owner-pid ${shq(String(process.pid))}`;
  if (opts.room !== undefined) cmd += ` --room ${shq(opts.room)}`;
  // Bind the watcher to the epoch that was current when it was generated. This
  // is a SECOND, independent retirement condition, not a restatement of
  // --owner-pid: the runtime that armed the watcher can stay alive and still
  // lose the persona to a later resume, and from that moment the command speaks
  // for a runtime that no longer holds it. The epoch is what lets the watcher
  // notice and exit instead of reporting traffic to a seat nobody is sitting
  // in. Every probe still resolves the CURRENT read cursor:
  // never bake a point-in-time --since baseline into a restartable command,
  // because once crossed it fires forever.
  if (opts.epoch !== undefined) {
    cmd += ` --epoch ${shq(String(opts.epoch))}`;
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
  // direct CLI invocations without this flag retain exit 124.
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
// Validate process-level configuration before opening the shared
// database. A typo must fail without mutating production state first.
const store = new ChatStore();

const INSTRUCTIONS = `Agent Chat is a local SQLite ledger. Start create_persona (first time; SAVE the returned resume_word) or resume_persona -> list_rooms -> join_room -> catch_up. One runtime holds one persona; the latest valid resume takes it over and fences the old runtime, whose next write returns persona_lost. catch_up advances one room; my_mentions peeks across rooms. priority_only is explicitly lossy. For out-of-turn watching, wait_for_messages returns the background poller command. server_info holds routing/shared budgets; each tool schema states its cap.`;

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
- While your wait is open and its lease write succeeds, peers see watching:true for you (list_agents, post_message recipients): evidence that a blocking call was open, not a delivery guarantee. It drops on normal return/cancellation; TTL bounds a hard-kill ghost. A detached poller never produces it -- an armed watcher refreshes last_seen only, which is the weaker signal.
- A wait is fenced: every 500ms probe re-reads your epoch, so a takeover ends the wait with terminal persona_lost within one probe rather than at the deadline.
- The wait holds your turn open, so it fits "I am waiting for a reply and have nothing else to do". To be notified while doing other work, or for watches longer than the cap, use the background poller.

SIZE AND PAGING
- Bulk reads are byte-bounded (default ${DEFAULT_MAX_BYTES} serialized chars; max_bytes tunes it, see limits). byte_limited:true = more remain: catch_up/read_history call again, my_mentions pages with after_id. Priority-only catch_up never advances past an unseen qualifying row when a row/byte cap cuts the page. Oversized bodies arrive truncated:true with length; fetch the rest via get_message offset -> next_offset (codepoints), passing room when the source row came from a non-active room. A truncated json body is a partial raw string, not an object.
- Shared size and response budgets are in server_info limits; each tool schema states its own local cap. Message bodies cap at ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes; the newline-delimited stdio frame has a separate ${MAX_MCP_FRAME_BYTES}-byte wire cap to allow JSON escaping without unbounded pre-parse buffering.

POSTING
- crossed counts ALL unread from others past your marker at post time (old backlog included, not only mid-composition arrivals); crossed_directed says how many are aimed at you; crossed_range gives the seq span. If crossed > 0, catch_up before acting on replies. crossed_preview_chars opts into bounded previews of the crossed messages in the same response.
- Dispositive posts (verdicts, commissions, dispositions): if_last_read_seq is a conditional post -- rejected (posted:false) if ANYTHING from others landed past your token, with bounded crossed previews returned; call catch_up for the complete delta before retrying. If pruning removed evidence after the token, it rejects conservatively with rejected:evidence_pruned and no invented previews. A token ahead of the target room's effective cursor is invalid and fails before posting. client_message_id makes an exact lost-response retry return the original seq instead of inserting twice; its guarantee lasts while that message is retained. Repeat the same explicit room or expected_room on retry so active-room drift cannot create a post in another room; a deduplicated response does not replay the original crossed/recipient snapshot, so catch_up for current state. room: posts to a named joined room without switching the active room; expected_room asserts which room is active. Never use the CAS on routine traffic: crossing is normal, the CAS is for posts whose validity depends on having read everything.
- recipients reports factual room-local state: status, idle_seconds, last_read_seq, marker_behind. A new unread tag normally adds one to marker_behind. delivery_warnings is definitive for never-joined/left recipients; a long-idle warning is emitted only for pre-existing lag and states observed facts, never a responsiveness prediction.
- status/idle_seconds/last_seen measure LISTENER recency: an MCP call from the bound runtime, or the two-minute heartbeat of a watcher it armed. active therefore means a runtime is reachable, not that the model is reading, reasoning, or able to wake, and an armed seat stays active no matter how long its model has been silent. The absence of a long-idle warning is not evidence anyone is listening; watching:true (an open blocking call) is the stronger claim.
- supersedes_seq corrects YOUR OWN earlier message; readers see superseded_by on it. reply_to_seq threads; the log stays flat and globally ordered.
- priority:true marks an immutable high-signal checkpoint for priority-only catch-up. Use it sparingly; correct a priority post with a new priority post + supersedes_seq rather than mutating history.
- claim/release_claim: atomic single-winner advisory locks with TTL expiry (a crashed holder cannot block forever). Claims are mutual exclusion between live writers; they do not verify content.

PERSONAS AND RUNTIMES
- A PERSONA is the durable identity: its brand/model/version, rooms, read positions, room-local roles, and claims. A RUNTIME is one MCP server process. One runtime holds one persona, and a persona has one runtime at a time.
- create_persona mints a persona and returns its id and resume_word. MCP returns the word ONCE and never again; it is the only way a later runtime can take the persona back. Losing it costs RESUMING that persona (its memberships, read markers, roles, claims), not access to any room's history. It exists to stop an operator pasting a wrong id from adopting someone else's persona -- it is not authentication, and it is stored in the database in plain text.
- resume_persona binds an existing persona to this runtime and increments its runtime_epoch. The LATEST valid resume wins: any older runtime is fenced out at once, its background watchers exit, and its next write or advancing read fails with persona_lost (terminal -- retrying cannot help). Re-resuming from the runtime that already holds the persona is a no-op.
- Every persona-authored write and every marker-advancing read re-verifies the runtime's epoch inside its own transaction, so a fenced-out runtime cannot commit anything.
- Non-advancing reads (whoami, list_agents, my_mentions, read_history, get_message, get_thread, search_messages, list_claims) still return their normal data and DISCLOSE the loss instead of failing: the response carries persona_lost:true, your_epoch, and current_epoch at top level, the same three fields the persona_lost error uses. current_epoch:null means the persona row is gone. Reads keep working on purpose -- a fenced-out runtime needs to see what happened -- but nothing it reads can be written back until it resumes.
- The poller command carries --epoch. A watcher whose epoch has moved on exits 2 with stale_binding instead of reporting traffic to a seat nobody is sitting in; resume_persona hands back a fresh command. Every probe resolves the CURRENT read cursor and never freezes a --since baseline.
- brand/model/version are IMMUTABLE and describe what is actually running. Before resuming, check them against the model you actually are right now. If your provider, model, or version has changed, do NOT resume the old persona: create_persona with your real tuple, join the rooms the old persona was in, and tell them the seat changed model and has a new id. Resuming a tuple that no longer describes you posts under a false identifier, and peers read brand/model/version as who is speaking. A correct resume word with a changed tuple is refused with code new_persona_required and lists those rooms; a wrong word is a separate rejection.
- Roles are ROOM-LOCAL: set one on join_room or change/clear it with set_role. They are not stamped into message envelopes, because a role can change after a message was written.

BACKGROUND POLLER
- Run the command join_room/resume_persona/wait_for_messages return as a BACKGROUND task. One Node process holds one SQLite connection and runs one indexed LIMIT 1 probe after each sleep; it launches no children. Generated commands exit 0 for either a hit or quiet deadline: parse stdout has_updates true/false. Direct CLI calls without --ok-on-timeout retain exit 124 on timeout. Exit 2 is an error or equivalent watcher. Options: --interval <sec> (minimum/default 5), --timeout <sec> (default 1200, finite), --ok-on-timeout, --mentions-only, --room <id|name>, --epoch <n>. Your own posts never wake it. Exit 2 with stale_binding means the persona was resumed elsewhere and this watcher is dead: do not re-arm it, resume_persona and use the command it returns.
- The poller is an OS-level detector: its exit does NOT by itself schedule your next turn. Whether you are actually woken depends on your harness's background-task contract; do not report "watcher active" as evidence you will see a message.

RETENTION
- prune_messages deletes old messages (refuses while any non-author member has them unread; force overrides). A room seq you cite in a document is durable only as long as nobody prunes past it.`;

// One stdio server process is ONE RUNTIME, and a runtime holds at most one
// persona. The binding lives here, in process memory, and is deliberately not
// persisted: durability across a restart is the resume word's job, and a second
// persisted holder token would be a second source of truth about who holds the
// persona. `epoch` is the value captured when this runtime bound; every write
// re-verifies it against the stored one inside the write's own transaction.
const session: {
  agentId: string | null;
  epoch: number | null;
  roomId: number | null;
} = {
  agentId: null,
  epoch: null,
  roomId: null,
};

/** Stable key for a (room, identity) pair in process-local maps. \u0000 cannot
 *  appear in an agent id (control chars are rejected), so keys never collide. */
function roomKey(roomId: number, agentId: string): string {
  return `${roomId}\u0000${agentId}`;
}

/** The bound persona, or a clean "bind first" error. Every persona-scoped tool
 *  goes through this or requireActive(). */
function requirePersona(): { agentId: string; epoch: number } {
  if (session.agentId === null || session.epoch === null) {
    throw new Error(
      "no persona bound to this runtime; call create_persona for a new one, " +
        "or resume_persona with an existing id, resume word, and brand/model/version",
    );
  }
  return { agentId: session.agentId, epoch: session.epoch };
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

/**
 * Render an error, tagging the one class callers must treat as TERMINAL.
 *
 * persona_lost is not a retryable failure: another runtime holds the persona
 * now, and every future call under this binding fails the same way. The tag
 * exists so a caller can distinguish it from a transient DB error without
 * matching on message text, and `terminal:true` says explicitly not to loop.
 * The binding is cleared here as well: continuing to hold a dead epoch would
 * make every later call re-derive the same answer more slowly.
 */
function failFrom(e: unknown): ToolResult {
  if (e instanceof PersonaLostError) {
    // Clear ONLY the binding that actually died: same persona AND same epoch.
    // Matching on the id alone let a late error from a superseded epoch wipe a
    // binding this runtime had already re-established. That happens whenever a
    // slow call started before a resume_persona lands after it -- the runtime
    // holds a live epoch, and the stale error tore it down, forcing a
    // pointless second resume.
    if (session.agentId === e.agentId && session.epoch === e.expectedEpoch) {
      session.agentId = null;
      session.epoch = null;
      session.roomId = null;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: e.message,
              code: "persona_lost",
              terminal: true,
              agent_id: e.agentId,
              your_epoch: e.expectedEpoch,
              current_epoch: e.currentEpoch,
              recover:
                "resume_persona with the id, resume word, and brand/model/version " +
                "to take it back, or create_persona for a new identity",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  if (e instanceof ModelTupleMismatchError) {
    // A DISTINCT code from a wrong word, because the remedy is distinct. A
    // wrong word means "find the word"; this means "you are not that
    // participant any more". Rendering both as a generic rejection sent an
    // agent whose model had been upgraded hunting for a credential that was
    // never the problem.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: e.message,
              code: "new_persona_required",
              agent_id: e.agentId,
              persona_model: e.stored,
              your_model: e.offered,
              // The caller has no binding, so it cannot look these up itself.
              // Guidance to notify rooms it cannot name is not guidance.
              persona_rooms: e.rooms,
              recover:
                "call create_persona with your ACTUAL brand/model/version, " +
                "join the rooms listed in persona_rooms, and post there that " +
                "the seat changed model and carries a new persona id. Do NOT " +
                "resume the old tuple: peers read brand/model/version as who " +
                "is speaking, and it would now be wrong.",
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return fail(asMessage(e));
}

/**
 * Loss disclosure for a NON-advancing read.
 *
 * A fenced-out runtime's reads keep WORKING. Failing them would blind the
 * operator at exactly the moment they need to see what happened, and a read
 * carries no authority worth protecting. What such a response must not do is
 * look ordinary, so every persona-scoped tool that advances no marker and
 * writes nothing splices these THREE keys in at top level -- always the same
 * three, under the same names the persona_lost ERROR already uses, so a
 * consumer has one shape to recognize instead of a differently-buried tag per
 * tool. Derivable-but-implicit disclosure does not reach an LLM consumer.
 *
 * A MISSING persona row discloses too. current_epoch:null is loss (the identity
 * was deleted out from under this runtime and every later write will fail), not
 * absence of news.
 *
 * Returns null when the binding is live, so the caller spreads nothing.
 */
type LossDisclosure = {
  persona_lost: true;
  your_epoch: number;
  current_epoch: number | null;
};

function lossDisclosure(agentId: string, epoch: number): LossDisclosure | null {
  const current = store.currentEpoch(agentId);
  return current === epoch
    ? null
    : { persona_lost: true, your_epoch: epoch, current_epoch: current };
}

/** Serialized cost of splicing a disclosure into a response object, charged
 *  against a byte budget exactly the way catch_up reserves its routing
 *  metadata: merging two non-empty objects replaces `}{` with `,`. Disclosure
 *  must not push a bounded read past the budget its caller asked for. */
function disclosureReserve(d: LossDisclosure | null): number {
  return d === null ? 0 : JSON.stringify(d).length - 1;
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

/**
 * How many blocking waits THIS runtime currently has open per (room, persona,
 * epoch).
 *
 * The lease row is keyed (room_id, agent_id) because one persona has one
 * runtime and a takeover must REPLACE the row rather than sit beside it. That
 * keying alone would let two concurrent waits from this same runtime share one
 * row, so whichever finished first would delete it and report the other as not
 * watching. The row means "this persona has at least one wait open here", and
 * only this process knows how many, so the count lives here: the last waiter
 * out closes the lease.
 *
 * The EPOCH is part of this key even though it is not part of the row's key.
 * One process can hold a wait from an old epoch and a wait from a new one at
 * the same time (resume_persona is a tool call, so it can land while an earlier
 * wait sleeps). Sharing a counter across them makes the old wait's exit
 * decrement the new wait's count, and the new wait then closes a lease it does
 * not own -- or, worse, does not close its own. Separate counters keep the two
 * tenures independent; each closes with the epoch it captured, and
 * endWaitLease's epoch guard makes the loser's close a no-op.
 */
const openWaits = new Map<string, number>();

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

function requireActive(): { agentId: string; epoch: number; roomId: number } {
  const { agentId, epoch } = requirePersona();
  if (session.roomId === null) {
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
  return { agentId, epoch, roomId: session.roomId };
}

/** Resolve an optional explicit joined room without changing the active room.
 * Explicit operations require an established identity and an existing
 * membership, but a soft-left membership remains addressable: naming the room
 * is deliberate and may be needed to inspect history or release old claims. */
function resolveJoinedRoom(room?: string): {
  agentId: string;
  epoch: number;
  roomId: number;
  roomName: string | null;
} {
  if (room === undefined) {
    const { agentId, epoch, roomId } = requireActive();
    return {
      agentId,
      epoch,
      roomId,
      roomName: store.getRoom(roomId)?.name ?? null,
    };
  }
  const { agentId, epoch } = requirePersona();
  const target = store.resolveRoom(room);
  if (!target) {
    throw new Error(`no room "${room}". Use list_rooms to see options.`);
  }
  if (!store.getMembership(target.id, agentId)) {
    throw new Error(
      `you have never joined room "${target.name}"; join_room it first`,
    );
  }
  return {
    agentId,
    epoch,
    roomId: target.id,
    roomName: target.name,
  };
}

/**
 * Mark the bound persona alive in its active room on tool invocations.
 * Throttled: every tool call otherwise costs a write transaction on the shared
 * file (cross-process lock contention for pure reads like list_rooms). 30s
 * granularity is far inside the `active` liveness window, which is minutes.
 *
 * EPOCH-FENCED through store.touch(), which is what keeps a fenced-out runtime
 * from refreshing liveness: its PersonaLostError lands in the catch below and
 * the write never happened. A stale read therefore leaves last_seen alone.
 */
let lastTouchMs = 0;
const TOUCH_INTERVAL_MS = 30_000;
function touchSession(): void {
  if (session.agentId === null || session.epoch === null) return;
  if (session.roomId === null) return;
  const now = Date.now();
  if (now - lastTouchMs < TOUCH_INTERVAL_MS) return;
  lastTouchMs = now;
  try {
    store.touch(session.roomId, session.agentId, session.epoch);
  } catch {
    // Liveness is best-effort: a briefly-locked database must not fail the
    // tool call this touch piggybacks on (pure reads included). lastTouchMs
    // already advanced, so failures back off to the next interval. A
    // PersonaLostError lands here too and is CORRECTLY swallowed: the write it
    // guards did not happen, which is the point, and the next real operation
    // reports persona_lost to the caller.
  }
}

// Cross-room operations capture a target that can differ from mutable active
// session state. Throttle each captured (room, identity) independently: using
// touchSession() in a named-room wait kept refreshing the active room instead.
const capturedTouchMs = new Map<string, number>();
function touchCapturedRoom(roomId: number, agentId: string, epoch: number): void {
  const key = roomKey(roomId, agentId);
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
    // Unlike store.touch(), this refreshes only a room whose membership is
    // still PRESENT, so it cannot resurrect an explicitly left room.
    store.touchJoinedRoom(roomId, agentId, epoch);
  } catch {
    // Best-effort heartbeat, matching touchSession().
  }
}

// Build identity, stamped into dist/build-info.json by scripts/stamp-build.mjs at
// build time so server_info pins the exact deployed binary. Reading git at runtime
// would report the source HEAD instead, masking an edited-but-not-rebuilt dist,
// which is precisely the skew this exists to surface.
//
// artifact_hash is part of the CURRENT stamp contract: every stamp this build
// pipeline writes carries one. The only stamp without a hash is no stamp at
// all, which is the unstamped-development case below.
type BuildInfo = {
  version: string;
  commit: string;
  built_at: string;
  artifact_hash: string;
};
const DEV_BUILD: BuildInfo = {
  version: "0.0.0-dev",
  commit: "unknown",
  built_at: "",
  artifact_hash: "",
};
const BUILD: BuildInfo = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    );
  } catch {
    // Running from an unstamped tree (tsx on src/, or dist copied without the
    // stamp). Not a stale deployment, just an unknown one.
    return DEV_BUILD;
  }
})();

/**
 * Re-read the on-disk build stamp and report whether a DIFFERENT build has been
 * deployed since this process started. If so, this server is stale: the client
 * should reconnect the MCP to load the new code (a stdio server never
 * hot-reloads). No client UI surfaces serverInfo.version, so this in-band flag
 * is the only way an agent learns it is running old code.
 *
 * The comparison is HASH-ONLY. built_at exists for human diagnostics and
 * ordering and is deliberately not consulted: a timestamp comparison called
 * every no-change rebuild a new deployment, and a timestamp FALLBACK for
 * hashless stamps only ever fired for stamps this pipeline no longer writes.
 * If either side has no hash, the honest answer is "not stale", because what is
 * actually known is that the deployment cannot be compared.
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
  const stale =
    runningHash.length > 0 && latestHash.length > 0 && latestHash !== runningHash;
  return {
    stale,
    latest_commit: latest?.commit ?? null,
    latest_built_at: latest?.built_at ?? null,
    latest_artifact_hash: latest?.artifact_hash ?? null,
  };
}

/**
 * Build identity for a WATCHER HANDOFF.
 *
 * A poller command is unlike every other response this server produces: the
 * caller takes it OUT of the MCP session and runs it as a separate process
 * against the same database, for up to a day. That process is `dist/poller.js`
 * as it exists ON DISK at launch, not the code this server loaded at startup, so
 * the two can be different builds -- and the handoff is the only moment where
 * saying so costs nothing. Every response carrying a poller_cmd states which
 * build minted it and, when a newer one is on disk, what that one is.
 *
 * The command is returned REGARDLESS of staleness, and nothing here fails on it.
 * Withholding the only out-of-turn watching mechanism because a rebuild landed
 * would trade a working watcher for a warning; the caller is told, and decides.
 *
 * Deliberately NOT a poller protocol version: a version number would be a second
 * compatibility surface to maintain, and the artifact hash already answers the
 * only question anyone can act on -- is the disk the same code I am.
 */
function handoffBuild(): Record<string, unknown> {
  const status = buildStatus();
  return {
    server_build: {
      version: BUILD.version,
      commit: BUILD.commit,
      built_at: BUILD.built_at,
      artifact_hash: BUILD.artifact_hash,
    },
    server_stale: status.stale,
    // Only when there IS a readable stamp to compare against. An absent block
    // means "no newer build is known", which is different from "identical".
    ...(status.latest_artifact_hash !== null
      ? {
          latest_build: {
            commit: status.latest_commit,
            built_at: status.latest_built_at,
            artifact_hash: status.latest_artifact_hash,
          },
        }
      : {}),
    ...(status.stale
      ? {
          reconnect_guidance:
            "a newer build is on disk than this server is running. The command " +
            "above still works -- use it. Reconnect the MCP when convenient so " +
            "the tools and the watcher come from one build (stdio servers do " +
            "not hot-reload).",
        }
      : {}),
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
    agent_id: MAX_AGENT_ID_CHARS,
    persona_brand: 100,
    persona_model: 100,
    persona_version: 100,
    resume_word: 200,
    room_role: 200,
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
      "manual (`manual`: routing, paging, poller, personas and runtimes). " +
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
      return failFrom(e);
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
      return failFrom(e);
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
      const { agentId, epoch } = requirePersona();
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
      const room = store.createRoom(
        name,
        description ?? null,
        pinned ?? null,
        agentId,
        epoch,
      );
      return ok({ room_id: room.id, name: room.name });
    } catch (e) {
      // Two processes can pass the pre-check together; the loser's INSERT
      // hits UNIQUE(rooms.name). Same outcome, friendlier message.
      const msg = asMessage(e);
      if (/UNIQUE constraint failed: rooms\.name/.test(msg)) {
        return fail(`a room named "${name}" already exists`);
      }
      return failFrom(e);
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
      return failFrom(e);
    }
  },
);

server.registerTool(
  "create_persona",
  {
    title: "Create persona",
    description:
      "Create a NEW persona and bind it to this runtime. brand/model/version " +
      "are immutable and identify what you are (e.g. 'anthropic'/'claude-opus'/" +
      "'5'); the server derives the canonical id from them. Returns `agent_id` " +
      "and `resume_word`: SAVE BOTH. The resume word is the only way a later " +
      "runtime can take this persona back with its rooms, read positions, " +
      "roles, and claims intact, and MCP returns it ONCE and never again. " +
      "Losing it does not hide any room's history, which any persona can " +
      "still read; what it costs is RESUMING this persona -- its memberships, " +
      "read markers, roles, and claims -- so the only remedy is a new persona " +
      "starting from scratch. If you already have an id and word, call " +
      "resume_persona instead.",
    inputSchema: z.object({
      brand: z
        .string()
        .min(1)
        .max(100)
        .describe("Who makes you, e.g. 'anthropic', 'openai'"),
      model: z
        .string()
        .min(1)
        .max(100)
        .describe("Model family, e.g. 'claude-opus', 'gpt'"),
      version: z
        .string()
        .min(1)
        .max(100)
        .describe("Model version, e.g. '5', '4.5'"),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe("Short description of who you are / what you do"),
    }).strict(),
  },
  async ({ brand, model, version, description }) => {
    try {
      if (session.agentId !== null) {
        return fail(
          `this runtime already holds persona "${session.agentId}"; one runtime ` +
            "holds one persona. Reconnect the MCP to start a fresh runtime.",
        );
      }
      const { id, resumeWord } = createPersona(
        brand,
        model,
        version,
        description ?? null,
      );
      // A freshly created persona is at epoch 1 by construction (the column
      // default), and this runtime created it, so it is the holder.
      session.agentId = id;
      session.epoch = 1;
      return ok({
        agent_id: id,
        resume_word: resumeWord,
        brand,
        model,
        version,
        // persona_description, never a bare `description`: every persona
        // response uses one name for this string so it can never be read as
        // the room's.
        persona_description: description ?? null,
        runtime_epoch: 1,
        save_this:
          "Store agent_id and resume_word now. resume_word is shown only here " +
          "and cannot be recovered or reset; without it this persona's history " +
          "is unreachable from any future runtime.",
        next: "join_room to enter a room.",
        server_stale: buildStatus().stale,
      });
    } catch (e) {
      return failFrom(e);
    }
  },
);

server.registerTool(
  "resume_persona",
  {
    title: "Resume persona",
    description:
      "Bind an EXISTING persona to this runtime, recovering its rooms, read " +
      "positions, room-local roles, and claims. Requires the agent_id, its " +
      "resume_word, and brand/model/version matching what it was created with. " +
      "The latest valid resume WINS: any older runtime still holding this " +
      "persona is fenced out immediately and its next write fails with " +
      "persona_lost. Re-calling this from the runtime that already holds the " +
      "persona is a no-op and does not fence anything.",
    inputSchema: z.object({
      agent_id: z
        .string()
        .min(1)
        .max(200)
        .describe("The persona id returned by create_persona"),
      resume_word: z
        .string()
        .min(1)
        .max(200)
        .describe("The resume word returned by create_persona"),
      brand: z.string().min(1).max(100).describe("Must match the persona's brand"),
      model: z.string().min(1).max(100).describe("Must match the persona's model"),
      version: z
        .string()
        .min(1)
        .max(100)
        .describe("Must match the persona's version"),
    }).strict(),
  },
  async ({ agent_id, resume_word, brand, model, version }) => {
    try {
      // A runtime may not silently switch personas: binding a second one would
      // leave the first still bound in every caller's mental model while this
      // process quietly acted as someone else.
      if (session.agentId !== null && session.agentId !== agent_id) {
        return fail(
          `this runtime already holds persona "${session.agentId}"; it cannot ` +
            `switch to "${agent_id}". Reconnect the MCP to start a fresh runtime.`,
        );
      }
      // IDEMPOTENT re-attach: this runtime already holds the persona AND its
      // epoch is still current, so there is nothing to take over. Skipping the
      // increment matters -- incrementing here would invalidate this runtime's
      // OWN outstanding pollers and open waits for no reason.
      //
      // ONE row read decides both questions. Asking currentEpoch() and then
      // getPersona() in separate autocommits leaves a window where a takeover
      // lands between them, and the "still current" branch would then answer
      // with this runtime's dead epoch while another runtime already holds the
      // persona -- a false all-clear at the one moment the caller needed the
      // truth. Reading epoch and credentials from the same snapshot removes the
      // window: if the epoch on THIS row is ours, these credentials are the ones
      // that were current when the epoch was.
      const held =
        session.agentId === agent_id && session.epoch !== null
          ? store.getPersona(agent_id)
          : undefined;
      if (held && held.runtime_epoch === session.epoch) {
        // Validate the credentials even though nothing is being taken over. The
        // obvious use of this call is a holder CHECKING that the word it wrote
        // down still works, and returning success without looking would confirm
        // a mistranscribed word -- discovered only after a crash, when it is the
        // one thing that cannot be recovered. Validation here never increments,
        // so a holder can re-verify as often as it likes without fencing itself.
        // Same split as attachPersona: the word is the credential, the tuple is
        // identity. A holder re-verifying with a changed model must get the
        // new_persona_required answer here too, not a credential rejection --
        // this branch is the one a long-running runtime hits most.
        if (held.resume_word !== resume_word) {
          return fail(
            `resume rejected for persona "${agent_id}": the resume word does ` +
              `not match the one it was created with. This runtime still holds ` +
              `the persona -- nothing was fenced -- but this word would NOT ` +
              `recover it later.`,
          );
        }
        if (
          held.brand !== brand ||
          held.model !== model ||
          held.version !== version
        ) {
          return failFrom(
            new ModelTupleMismatchError(
              agent_id,
              {
                brand: held.brand!,
                model: held.model!,
                version: held.version!,
              },
              { brand, model, version },
              store.presentRoomNames(agent_id),
            ),
          );
        }
        return ok({
          agent_id,
          runtime_epoch: session.epoch,
          brand: held.brand,
          model: held.model,
          version: held.version,
          persona_description: held.description,
          reattached: true,
          note:
            "already bound to this runtime; nothing was fenced. The resume " +
            "word and metadata were validated: they will recover this persona.",
          poller_cmd: pollerCmd(agent_id, { epoch: session.epoch }),
          ...handoffBuild(),
        });
      }
      const { epoch, persona } = store.attachPersona({
        id: agent_id,
        resumeWord: resume_word,
        brand,
        model,
        version,
      });
      const previous = session.agentId === agent_id ? session.epoch : null;
      session.agentId = agent_id;
      session.epoch = epoch;
      // The active room does NOT survive a takeover: room membership is durable
      // but "which room am I looking at" is runtime-local state this runtime
      // never had. Rejoin explicitly.
      session.roomId = null;
      return ok({
        agent_id,
        runtime_epoch: epoch,
        brand: persona.brand,
        model: persona.model,
        version: persona.version,
        persona_description: persona.description,
        reattached: false,
        ...(previous !== null ? { previous_epoch: previous } : {}),
        fenced:
          "any runtime holding this persona at an earlier epoch is now fenced " +
          "out; its pollers exit and its next write fails with persona_lost",
        // Old poller commands carry the OLD epoch and will exit as stale. Hand
        // back a live one in the same response so the caller is never left
        // silently deaf holding a command that can no longer fire.
        poller_cmd: pollerCmd(agent_id, { epoch }),
        next: "join_room to enter a room; memberships and read positions are intact.",
        ...handoffBuild(),
      });
    } catch (e) {
      return failFrom(e);
    }
  },
);

server.registerTool(
  "join_room",
  {
    title: "Join room",
    description:
      "Join a room (id or name) and make it active for this runtime. Requires " +
      "a bound persona (create_persona or resume_persona first). Returns your " +
      "persona (brand/model/version, persona_description) alongside the room " +
      "(room_name, room_description, pinned) and your room-local `role`. " +
      "Rejoining RESUMES your read position; `cursor_start` only applies the " +
      "first time you join a given room. `role` is ROOM-LOCAL: it describes " +
      "what you are in this room and does not follow you to others (change or " +
      "clear it later with set_role). Read the returned `pinned` intro. " +
      "`server_stale:true` = this server runs outdated code; tell the user to " +
      "reconnect the MCP.",
    inputSchema: z.object({
      room: z.string().min(1).max(500).describe("Room id or name to join"),
      role: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Your role IN THIS ROOM, e.g. 'reviewer', 'planner'. Omitted: leave " +
            "any existing role unchanged. Use set_role to change or clear it. " +
            "Must be non-blank; null (via set_role) is the only way to say " +
            "'no role'.",
        ),
      cursor_start: z
        .enum(["beginning", "latest"])
        .optional()
        .describe(
          "Where to start reading when this call CREATES the membership: " +
            "'beginning' (default) delivers the room's whole history, 'latest' " +
            "starts from now and skips the backlog. Ignored on a rejoin, which " +
            "always resumes your saved position.",
        ),
    }).strict(),
  },
  async ({ room, role, cursor_start }) => {
    try {
      touchSession();
      const { agentId, epoch } = requirePersona();
      const target = store.resolveRoom(room);
      if (!target) {
        return fail(
          `no room "${room}". Use list_rooms to see options or create_room to make one.`,
        );
      }
      const { created } = store.joinRoom(target.id, agentId, epoch, {
        cursorStart: cursor_start,
        role,
      });
      // Session state mutates only AFTER the join commits: setting it first
      // would leave a failed join having repointed the still-valid previous
      // active room.
      session.roomId = target.id;
      const cur = store.getCursor(target.id, agentId);
      if (!cur) {
        // The room was deleted by another process between our join and this
        // read; same recovery contract as requireActive.
        session.roomId = null;
        return fail(
          `room "${target.name}" was deleted while joining; rejoin with join_room`,
        );
      }
      const persona = store.getPersona(agentId);
      return ok({
        agent_id: agentId,
        // The persona tuple rides on the JOIN response: the room now has a new
        // participant and the first thing everyone (including this runtime)
        // needs is WHICH model just walked in. Same field names as whoami.
        brand: persona?.brand ?? null,
        model: persona?.model ?? null,
        version: persona?.version ?? null,
        persona_description: persona?.description ?? null,
        room_id: target.id,
        room_name: target.name,
        // Named room_description, not `description`: a bare `description` next
        // to persona fields reads as the PERSONA's, and the two are different
        // strings owned by different things.
        room_description: target.description,
        pinned: target.pinned,
        role: store.getRole(target.id, agentId),
        new_membership: created,
        ...(created && cursor_start === "latest"
          ? { cursor_start: "latest", note: "starting from now; backlog skipped" }
          : {}),
        last_read_seq: cur.last_read_seq,
        unread: store.unreadCount(target.id, cur.last_read_seq, agentId),
        members: store.presentCount(target.id),
        // Ready-to-run background poller invocation, shell-quoted for THIS
        // persona and bound to the current epoch (see the server instructions).
        poller_cmd: pollerCmd(agentId, { epoch }),
        // Build identity rides with the command, at the session-start
        // checkpoint where it is seen once without per-call noise.
        ...handoffBuild(),
      });
    } catch (e) {
      return failFrom(e);
    }
  },
);

server.registerTool(
  "set_role",
  {
    title: "Set room role",
    description:
      "Set or CLEAR your role in a room. `role` is required: pass a NON-BLANK " +
      "string to set it, or null to clear it. Roles are room-local, so this " +
      "never touches your role in any other room. Omitting the field is " +
      "rejected rather than treated as a clear, because 'no change' and 'no " +
      "role' are different; an empty string is rejected for the same reason, " +
      "since null is the only way to say 'no role'.",
    inputSchema: z.object({
      role: z
        .string()
        .min(1)
        .max(200)
        .nullable()
        .describe("The new non-blank role, or null to clear it"),
      room: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Set your role in a room you have JOINED (id or name) without " +
            "changing the active room. Omitted: the active room.",
        ),
    }).strict(),
  },
  async ({ role, room }) => {
    try {
      touchSession();
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      store.setRole(roomId, agentId, epoch, role);
      return ok({
        agent_id: agentId,
        room_id: roomId,
        room_name: roomName,
        role,
        cleared: role === null,
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId } = requireActive();
      const left = store.leaveRoom(roomId, agentId, epoch);
      // Keep the persona bound: the runtime is still this persona, and
      // my_mentions (memberships elsewhere) must keep working after leaving one
      // room. The membership row survives too, so its read position and role
      // are intact for a rejoin.
      session.roomId = null;
      return ok({ left, room_id: roomId, agent_id: agentId });
    } catch (e) {
      return failFrom(e);
    }
  },
);

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description:
      "Report this runtime's bound persona (agent_id, brand/model/version, " +
      "persona_description, runtime_epoch), its active room if any, and " +
      "`persona_lost` when a newer runtime has taken the persona over. The " +
      "PERSONA fields are reported whether or not a room is active, because " +
      "'which identity am I' is the question this tool exists to answer; the " +
      "room fields (room_id, room_name, room_description, role, last_read_seq, " +
      "unread) appear only while a room is active.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      if (session.agentId === null || session.epoch === null) {
        return ok({ bound: false, joined: false });
      }
      const agentId = session.agentId;
      const epoch = session.epoch;
      const persona = store.getPersona(agentId);
      // The persona block is UNCONDITIONAL once a persona is bound. Reporting
      // only joined:false and an id when no room is active hid the brand,
      // model, version, epoch and the loss state -- exactly the facts a runtime
      // that has just been fenced, or has just left a room, needs to see.
      const identity = {
        bound: true,
        agent_id: agentId,
        brand: persona?.brand ?? null,
        model: persona?.model ?? null,
        version: persona?.version ?? null,
        persona_description: persona?.description ?? null,
        runtime_epoch: epoch,
        ...lossDisclosure(agentId, epoch),
      };
      if (session.roomId === null) {
        return ok({ ...identity, joined: false });
      }
      const roomRow = store.getRoom(session.roomId);
      if (!roomRow) {
        // Room was deleted by another process; do not claim to be joined.
        // The identity survives.
        session.roomId = null;
        return ok({
          ...identity,
          joined: false,
          note: "active room was deleted; rejoin",
        });
      }
      const cur = store.getCursor(session.roomId, agentId);
      return ok({
        ...identity,
        joined: true,
        room_id: session.roomId,
        room_name: roomRow.name,
        room_description: roomRow.description,
        role: store.getRole(session.roomId, agentId),
        last_read_seq: cur?.last_read_seq ?? 0,
        unread: store.unreadCount(
          session.roomId,
          cur?.last_read_seq ?? 0,
          agentId,
        ),
      });
    } catch (e) {
      return failFrom(e);
    }
  },
);

server.registerTool(
  "list_agents",
  {
    title: "List agents in room",
    description:
      "List agents in the active room (up to `limit`; `total` rides along): " +
      "brand/model/version, room-local `role`, `is_human`, description, " +
      "`last_read_seq` (read receipt: compare to a " +
      "message seq), `last_seen`, `idle_seconds`, `present` (has not left), " +
      "`active` (present and recently seen or carrying an unexpired wait lease), " +
      "`watching` (an unexpired best-effort blocking catch_up wait lease; " +
      "not an acknowledgement or delivery guarantee). `last_seen`/`idle_seconds`/" +
      "`active` measure LISTENER recency -- an MCP call or an armed watcher's " +
      "two-minute heartbeat -- so they say a runtime is reachable, NOT that the " +
      "model is reading or able to wake; `watching` is the stronger claim. Long " +
      "descriptions are listing previews (description_truncated). " +
      "`next_after` present = more rows exist; page by passing it back as " +
      "`after` (keyset paging, so a concurrent join cannot make you skip or " +
      "duplicate an agent).",
    inputSchema: z.object({
      filter: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Substring to match against id/brand/model/version/role/description",
        ),
      active_within_minutes: z
        .number()
        .positive()
        .max(1440)
        .optional()
        .describe(
          "Recent-seen window for `active`; an unexpired wait lease also " +
            "makes a present agent active (default 5 minutes)",
        ),
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
      const { agentId, epoch, roomId } = requireActive();
      const { agents, total, next_after, size_trimmed } = store.listAgents(
        roomId,
        active_within_minutes ?? 5,
        filter,
        limit ?? 200,
        after,
      );
      return ok({
        ...lossDisclosure(agentId, epoch),
        agents,
        total,
        ...(next_after !== undefined ? { next_after, truncated: true } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return failFrom(e);
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
      "insert. `posted:true` means committed to SQLite only, not that a " +
      "recipient was woken, acknowledged, or began processing it. A " +
      "deduplicated retry returns the original seq/key only; catch " +
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
      let epoch: number;
      let roomId: number;
      let roomName: string | null;
      if (room !== undefined) {
        // Explicit target: same membership rule as catch_up({room}).
        ({ agentId, epoch } = requirePersona());
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
      } else {
        ({ agentId, epoch, roomId } = requireActive());
        roomName = store.getRoom(roomId)?.name ?? null;
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
      touchCapturedRoom(roomId, agentId, epoch);
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
        epoch,
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
      //
      // The idle arm measures last_seen, which an ARMED WATCHER refreshes every
      // two minutes. So this warning cannot fire for a seat with a live
      // watcher, however long the model behind it has been silent, and its
      // ABSENCE is not evidence anyone is reading. It is a one-directional
      // signal: when it fires, nothing has touched that seat at all.
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
            `${r.id}: no MCP call or watcher heartbeat in this room for ` +
              `${fmtIdle(r.idle_seconds ?? 0)}; marker was ${priorMarkerBehind} ` +
              `seq behind before this post`,
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
      return failFrom(e);
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
    }).strict(),
  },
  async (
    { room, wait_seconds, priority_only, limit, preview_chars, max_bytes },
    extra,
  ) => {
    const startedMs = Date.now();
    let heldWaitSlot = false;
    try {
      touchSession();
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
      // dispatch can mutate `session` (the persona binding, the active room)
      // while a wait sleeps, so everything below runs off these captured
      // values.
      let agentId: string;
      let epoch: number;
      let roomId: number;
      let roomName: string | null;
      if (room !== undefined) {
        // Cross-room read: the ACTIVE room stays untouched. Requires an
        // existing membership (a never-joined room has no read position to
        // advance); a soft-left room stays readable -- naming it is the intent
        // to read it (parity with the scoped poller watch).
        ({ agentId, epoch } = requirePersona());
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
      } else {
        ({ agentId, epoch, roomId } = requireActive());
        roomName = store.getRoom(roomId)?.name ?? null;
      }
      touchCapturedRoom(roomId, agentId, epoch);
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
          epoch,
          // rooms_with_unread on an empty read.
          includeUnreadSummary
            ? { priorityOnly: priority_only === true }
            : null,
        );
      // A takeover is the only way this call's authority can change under it.
      // Every advancingRead re-verifies the captured epoch inside its own
      // transaction, so a fenced read throws persona_lost rather than consuming
      // from a position this call did not capture.
      const roomDeletedResult = (duringWait = false): ToolResult => {
        // A delete racing the active-room read invalidates that active route.
        // Do not clear a different room selected by a concurrent join, nor the
        // active room during an explicit cross-room catch_up.
        if (session.roomId === roomId && session.agentId === agentId) {
          session.roomId = null;
        }
        return fail(
          `room "${roomName ?? roomId}" was deleted while ${duringWait ? "waiting" : "reading"}; nothing was read. list_rooms shows what still exists.`,
        );
      };

      // Abort boundary rule for everything below: once an abort has been
      // observed, NO advancing transaction may run.
      if (signal?.aborted) return respond({ aborted: true });
      // A blocking wait discards an initial empty result. Do not compute its
      // exact cross-room unread summary only to throw it away; the timeout read
      // below includes the summary that is actually returned.
      let first: ReturnType<typeof advancingRead>;
      try {
        first = advancingRead(waitSeconds === 0);
      } catch (e) {
        if (!store.getRoom(roomId)) return roomDeletedResult();
        throw e;
      }
      if (first.messages.length > 0 || waitSeconds === 0) {
        return respond(
          first,
          waitSeconds > 0 ? { waited_ms: Date.now() - startedMs } : {},
        );
      }

      // --- Blocking wait: abort-aware timer, non-advancing read-only probe
      // with catchUp's exact predicate, advancing read only on a hit.
      const deadlineMs = startedMs + waitSeconds * 1000;
      // Presence lease: when its best-effort write succeeds, `watching`
      // records that this call was open. TTL bounds a hard-kill ghost; a lease
      // failure must not break the wait (the probe surfaces a deleted room).
      // The lease is keyed by persona and carries the epoch CAPTURED here, so
      // the cleanup in the finally below can only ever delete this call's own
      // row -- never one a takeover wrote after fencing this call out.
      const leaseKey = `${roomKey(roomId, agentId)}\u0000${epoch}`;
      openWaits.set(leaseKey, (openWaits.get(leaseKey) ?? 0) + 1);
      try {
        store.beginWaitLease(
          roomId,
          agentId,
          epoch,
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
          touchCapturedRoom(roomId, agentId, epoch);
          let unread: number;
          try {
            // Epoch-fenced: a takeover surfaces here, within one probe
            // interval, instead of waiting for traffic or the deadline.
            unread = store.unreadProbe(roomId, agentId, epoch);
          } catch (e) {
            // A lost persona is NOT a deleted room. Rethrow it before the
            // room-existence fallback, or a takeover would be reported as
            // "the room was deleted".
            if (e instanceof PersonaLostError) throw e;
            if (!store.getRoom(roomId)) return roomDeletedResult(true);
            throw e;
          }
          if (unread === 0) continue;
          if (signal?.aborted) return respond({ aborted: true });
          let hit;
          try {
            // A probe/read race may make this empty too; its result is discarded,
            // so omit the cross-room exact-count summary here as well.
            hit = advancingRead(false);
          } catch (e) {
            if (!store.getRoom(roomId)) return roomDeletedResult(true);
            throw e;
          }
          // Cursor normalization may advance across an own-only suffix while
          // returning no messages. That is maintenance, not a wake result.
          if (hit.messages.length > 0) {
            return respond(hit, { waited_ms: Date.now() - startedMs });
          }
          // The cursor advanced between probe and read (an own-only
          // normalization): keep waiting, never refire stale rows.
        }
        if (signal?.aborted) return respond({ aborted: true });
        let last;
        try {
          last = advancingRead(true);
        } catch (e) {
          if (!store.getRoom(roomId)) return roomDeletedResult(true);
          throw e;
        }
        return respond(last, {
          waited_ms: Date.now() - startedMs,
          ...(last.messages.length === 0
            ? { timed_out: true, call_again: true }
            : {}),
        });
      } finally {
        const remaining = (openWaits.get(leaseKey) ?? 1) - 1;
        if (remaining > 0) {
          openWaits.set(leaseKey, remaining);
        } else {
          openWaits.delete(leaseKey);
          try {
            store.endWaitLease(roomId, agentId, epoch);
          } catch {}
        }
      }
    } catch (e) {
      return failFrom(e);
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
      // my_mentions needs a PERSONA but no active room: it reads across every
      // room the persona is present in, which is exactly what makes it usable
      // after a leave. So the remedy is binding, not joining.
      const { agentId, epoch } = requirePersona();
      // Reserve the disclosure's exact serialized cost BEFORE the bounded read,
      // so a caller's max_bytes still holds on the fenced path.
      const lost = lossDisclosure(agentId, epoch);
      const requested = max_bytes ?? DEFAULT_MAX_BYTES;
      const reserve = disclosureReserve(lost);
      return ok({
        ...lost,
        ...store.myMentions(
          agentId,
          limit ?? 50,
          preview_chars,
          Math.max(MIN_CATCH_UP_RESULT_BUDGET, requested - reserve),
          after_id ?? 0,
        ),
      });
    } catch (e) {
      return failFrom(e);
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
      "this only for yourself. `next_after` means " +
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
      return failFrom(e);
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
      const { agentId, epoch } = requirePersona();
      // Check the binding BEFORE handing out a command. The poller keeps its
      // own per-probe epoch check for a takeover that lands after generation,
      // but a command minted for an already-dead epoch is a command that can
      // only ever exit stale_binding, and returning one sends the caller off to
      // arm a watcher instead of telling it the thing it needs to know.
      const current = store.currentEpoch(agentId);
      if (current !== epoch) {
        return failFrom(new PersonaLostError(agentId, epoch, current));
      }
      let roomArg: string | undefined;
      if (room !== undefined) {
        // PRESENT membership required, not merely an existing row. A watcher on
        // a room this persona has left would deliver traffic peers can see it
        // is not receiving -- delivery and visibility must read the same
        // membership state. A never-joined room fails with its own remedy.
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
        if (m.left_at !== null) {
          return fail(
            `you have LEFT room "${target.name}", so a watcher on it would ` +
              `report traffic to a seat peers can see is empty. Call join_room ` +
              `to rejoin -- your read position and role are preserved -- then ` +
              `use the poller command it returns.`,
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
        epoch,
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
        ...handoffBuild(),
      });
    } catch (e) {
      return failFrom(e);
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
  async ({ limit, before_seq, preview_chars, max_bytes }) => {
    try {
      touchSession();
      const { agentId, epoch, roomId } = requireActive();
      const lost = lossDisclosure(agentId, epoch);
      const requested = max_bytes ?? DEFAULT_MAX_BYTES;
      return ok({
        ...lost,
        ...store.readHistory(
          roomId,
          limit ?? 50,
          before_seq,
          preview_chars,
          Math.max(
            MIN_CATCH_UP_RESULT_BUDGET,
            requested - disclosureReserve(lost),
          ),
        ),
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId } = requireActive();
      return ok(store.markRead(roomId, agentId, epoch, seq));
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId, epoch);
      const msg = store.getMessage(roomId, seq, offset ?? 0, max_chars);
      if (!msg) {
        return fail(`no message ${seq} in room "${roomName ?? roomId}"`);
      }
      return ok({ ...lossDisclosure(agentId, epoch), ...msg });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId, epoch);
      const thread = store.getThread(roomId, seq, max_depth ?? 3, preview_chars);
      if (!thread) {
        return fail(`no message ${seq} in room "${roomName ?? roomId}"`);
      }
      return ok({ ...lossDisclosure(agentId, epoch), ...thread });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId } = requireActive();
      const value = text.length > 0 ? text : null;
      store.setPinned(roomId, agentId, epoch, value);
      return ok({ room_id: roomId, pinned: value });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId } = requireActive();
      return ok({
        ...lossDisclosure(agentId, epoch),
        ...store.searchMessages(roomId, query, limit ?? 20, offset ?? 0),
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId, epoch);
      return ok({
        room_id: roomId,
        room_name: roomName,
        ...store.claimResource(
          roomId,
          key,
          agentId,
          epoch,
          ttl_seconds ?? 900,
          note ?? null,
        ),
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId, epoch);
      return ok({
        room_id: roomId,
        room_name: roomName,
        ...store.releaseClaim(roomId, key, agentId, epoch),
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId, epoch);
      const { claims, total, next_key, size_trimmed } = store.listClaims(
        roomId,
        limit ?? 200,
        after_key ?? "",
      );
      return ok({
        ...lossDisclosure(agentId, epoch),
        room_id: roomId,
        room_name: roomName,
        claims,
        total,
        ...(next_key !== undefined ? { next_key, truncated: true } : {}),
        ...(size_trimmed ? { size_trimmed: true } : {}),
      });
    } catch (e) {
      return failFrom(e);
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
      "read a doomed message yet, including members that left; force=true " +
      "prunes anyway.",
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
      const { agentId, epoch, roomId } = requireActive();
      return ok({
        room_id: roomId,
        ...store.pruneMessages(roomId, agentId, epoch, keep_last, force ?? false),
      });
    } catch (e) {
      return failFrom(e);
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
      const { agentId, epoch } = requirePersona();
      const target = store.resolveRoom(room);
      if (!target) return fail(`no room "${room}"`);
      if (confirm !== true) {
        return fail(`pass confirm:true to delete room ${target.id} ("${target.name}")`);
      }
      const result = store.deleteRoom(target.id, agentId, epoch);
      if (session.roomId === target.id) {
        session.roomId = null; // identity survives; only the room is gone
      }
      return ok({ deleted_room: target.id, name: target.name, ...result });
    } catch (e) {
      return failFrom(e);
    }
  },
);

// Resume-word vocabulary. Two 26-entry word lists plus a 16-bit number give
// 26 * 26 * 65536 = ~44 million combinations, which is ample for the ONLY job
// this word has: making it improbable that an operator who pastes a
// wrong-but-plausible word lands on a persona that is not theirs. It is not a
// secret, not a password, and is stored in plain text -- see create_persona's
// description for the explicit threat model. Every part is drawn from
// randomBytes (a CSPRNG) rather than Math.random, so two personas created in
// the same millisecond do not collide.
const WORD_ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "cobalt", "copper", "deft", "eager",
  "fern", "gilded", "hardy", "ivory", "jade", "keen", "lucid", "mellow",
  "nimble", "olive", "prime", "quiet", "rapid", "sable", "teal", "umber",
  "vivid", "warm",
];
const WORD_NOUNS = [
  "otter", "falcon", "cedar", "harbor", "lynx", "maple", "comet", "delta",
  "ember", "fjord", "grove", "heron", "inlet", "kite", "larch", "mesa",
  "nimbus", "onyx", "pike", "quartz", "ridge", "summit", "tundra", "vale",
  "willow", "yarrow",
];

/** Uniform index into xs, drawn from CSPRNG bytes with rejection sampling so a
 *  non-multiple list length cannot bias the draw. */
function pick<T>(xs: T[]): T {
  const limit = Math.floor(256 / xs.length) * xs.length;
  for (;;) {
    const b = randomBytes(1)[0];
    if (b < limit) return xs[b % xs.length];
  }
}

function makeResumeWord(): string {
  return `${pick(WORD_ADJECTIVES)}-${pick(WORD_NOUNS)}-${randomBytes(2).readUInt16BE(0)}`;
}

/**
 * Normalize one component of a canonical persona id: lowercase, non-alphanumeric
 * runs collapsed to single hyphens, trimmed. "Claude Opus 4.5" -> "claude-opus-4-5".
 * Returns "" when nothing survives, which the caller rejects.
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build and atomically claim the canonical persona id
 * `brand-model-vversion-shorttoken`.
 *
 * The short token is what makes two personas with the SAME brand/model/version
 * distinguishable -- a common case, since two runtimes of one model routinely
 * work in one room. The claim is atomic (INSERT ... ON CONFLICT DO NOTHING) so
 * two processes drawing the same token cannot both believe they own it and
 * collapse onto a single row, sharing its read marker, memberships, and claims.
 */
function createPersona(
  brand: string,
  model: string,
  version: string,
  description: string | null,
): { id: string; resumeWord: string } {
  const parts = [slug(brand), slug(model), `v${slug(version)}`];
  if (parts[0] === "" || parts[1] === "" || parts[2] === "v") {
    throw new Error(
      "brand, model, and version must each contain at least one letter or digit",
    );
  }
  const base = parts.join("-");
  // One fixed token width, so a persona id has one shape and the length check
  // below is exact rather than a bound that holds only while collisions stay
  // rare.
  const TOKEN_CHARS = 6;
  if (base.length + 1 + TOKEN_CHARS > MAX_AGENT_ID_CHARS) {
    throw new Error(
      `brand/model/version are too long: the canonical persona id ` +
        `"${base}-<token>" needs ${base.length + 1 + TOKEN_CHARS} characters ` +
        `and the limit is ${MAX_AGENT_ID_CHARS}. Shorten them by at least ` +
        `${base.length + 1 + TOKEN_CHARS - MAX_AGENT_ID_CHARS} characters ` +
        `(punctuation collapses to single hyphens, so it still counts).`,
    );
  }
  const resumeWord = makeResumeWord();
  for (let i = 0; i < 40; i++) {
    const token = randomBytes(TOKEN_CHARS / 2).toString("hex");
    const id = `${base}-${token}`;
    if (
      store.tryCreatePersona({ id, brand, model, version, resumeWord, description })
    ) {
      return { id, resumeWord };
    }
  }
  throw new Error(
    "could not allocate a persona id after 40 attempts; retry create_persona",
  );
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Room-local inactivity threshold for a factual pre-existing-backlog warning.
 * Chosen well past the 5-minute `active` window to avoid routine idle noise.
 * Measures last_seen, so it detects an UNTOUCHED seat, not a silent model: an
 * armed watcher's two-minute heartbeat keeps a seat below this forever. */
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
      await Promise.allSettled(activeToolRequests);
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
