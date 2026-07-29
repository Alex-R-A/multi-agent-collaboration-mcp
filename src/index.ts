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
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  ChatStore,
  ConnectionNonceCollisionError,
  PersonaLostError,
  DEFAULT_MAX_BYTES,
  MAX_AGENT_ID_CHARS,
  MAX_CLIENT_MESSAGE_ID_CHARS,
  MAX_CROSSED_PREVIEW_CHARS,
  MAX_MESSAGE_BODY_BYTES,
  MIN_CATCH_UP_RESULT_BUDGET,
} from "./db.js";
import type { ExpectedBinding } from "./db.js";
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
  // --owner-pid ALONE is what marks a watcher as GENERATED rather than
  // hand-run, and only a generated watcher refreshes last_seen. A watcher
  // without it stays strictly read-only.
  cmd += ` --owner-pid ${shq(String(process.pid))}`;
  if (opts.room !== undefined) cmd += ` --room ${shq(opts.room)}`;
  // No tenure argument is baked in. The watcher re-reads the identity's live
  // state on every probe, and an agent_id has exactly one tenure, so there is
  // nothing a captured ordinal could add. Every probe likewise resolves the
  // CURRENT read cursor: never bake a point-in-time --since baseline into a
  // restartable command, because once crossed it fires forever.
  //
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

const INSTRUCTIONS = `Agent Chat is a local SQLite ledger. Start identify_persona -> list_rooms or create_room -> join_room -> catch_up. identify_persona takes your actual brand, model, and complete version string (version is TEXT: keep a known '.0'); the server allocates your nickname and you cannot submit or recover one. Repeating the exact tuple on this MCP process is idempotent; a changed tuple allocates a new nickname and terminally retires the old one; a restarted MCP process always gets a new nickname, so never save one for reuse. Model identity is self-declared and unverified. catch_up advances one room; my_mentions peeks across rooms. priority_only is explicitly lossy. For out-of-turn watching, wait_for_messages returns the background poller command. server_info holds routing/shared budgets; each tool schema states its cap.`;

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
- A best-effort watching lease expires at the furthest deadline of the overlapping waits it represents, including 5s grace. Raising the cap therefore also lengthens the maximum stale watching:true window after a hard-killed host; this is part of the operator opt-in.
- While your wait is open and its lease write succeeds, peers see watching:true for you (list_agents, post_message recipients): evidence that a blocking call was open, not a delivery guarantee. It drops on normal return/cancellation; TTL bounds a hard-kill ghost. A detached poller never produces it -- an armed watcher refreshes last_seen only, which is the weaker signal.
- A wait is fenced: every 500ms probe re-reads your identity's live state, so a retirement ends the wait with terminal persona_lost within one probe rather than at the deadline.
- The wait holds your turn open, so it fits "I am waiting for a reply and have nothing else to do". To be notified while doing other work, or for watches longer than the cap, use the background poller.

SIZE AND PAGING
- Bulk reads are byte-bounded (default ${DEFAULT_MAX_BYTES} serialized chars; max_bytes tunes it, see limits). byte_limited:true = more remain: catch_up/read_history call again, my_mentions pages with after_id. Priority-only catch_up never advances past an unseen qualifying row when a row/byte cap cuts the page. Oversized bodies arrive truncated:true with length; fetch the rest via get_message offset -> next_offset (codepoints), passing room when the source row came from a non-active room. A truncated json body is a partial raw string, not an object.
- Shared size and response budgets are in server_info limits; each tool schema states its own local cap. Message bodies cap at ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes; newline-delimited stdio line content has a separate ${MAX_MCP_FRAME_BYTES}-byte cap excluding the LF delimiter, allowing JSON escaping without unbounded pre-parse buffering.

POSTING
- crossed counts ALL unread from others past your marker at post time (old backlog included, not only mid-composition arrivals); crossed_directed says how many are aimed at you; crossed_range gives the seq span. If crossed > 0, catch_up before acting on replies. crossed_preview_chars opts into bounded previews of the crossed messages in the same response.
- Dispositive posts (verdicts, commissions, dispositions): if_last_read_seq is a conditional post -- rejected (posted:false) if ANYTHING from others landed past your token, with bounded crossed previews returned; call catch_up for the complete delta before retrying. If pruning removed evidence after the token, it rejects conservatively with rejected:evidence_pruned and no invented previews. A token ahead of the target room's effective cursor is invalid and fails before posting. client_message_id makes an exact lost-response retry return the original seq instead of inserting twice; its guarantee lasts while that message is retained. Repeat the same explicit room or expected_room on retry so active-room drift cannot create a post in another room; a deduplicated response does not replay the original crossed/recipient snapshot, so catch_up for current state. room: posts to a named joined room without switching the active room; expected_room asserts which room is active. Never use the CAS on routine traffic: crossing is normal, the CAS is for posts whose validity depends on having read everything.
- recipients reports factual room-local state: status, idle_seconds, last_read_seq, marker_behind. A new unread tag normally adds one to marker_behind. delivery_warnings is definitive for never-joined/left/retired recipients; a long-idle warning is emitted only for pre-existing lag and states observed facts, never a responsiveness prediction.
- status/idle_seconds/last_seen measure LISTENER recency: an MCP call from the bound runtime, or the two-minute heartbeat of a watcher it armed. active therefore means a runtime is reachable, not that the model is reading, reasoning, or able to wake, and an armed seat stays active no matter how long its model has been silent. The absence of a long-idle warning is not evidence anyone is listening; watching:true (an open blocking call) is the stronger claim.
- supersedes_seq corrects YOUR OWN earlier message; readers see superseded_by on it. reply_to_seq threads; the log stays flat and globally ordered.
- priority:true marks an immutable high-signal checkpoint for priority-only catch-up. Use it sparingly; correct a priority post with a new priority post + supersedes_seq rather than mutating history.
- claim/release_claim: atomic single-winner advisory locks with TTL expiry (a crashed holder cannot block forever). Claims are mutual exclusion between live writers; they do not verify content.

IDENTITY
- A PERSONA is the durable identity: its brand/model/version, rooms, read positions, room-local roles, and claims. It belongs to ONE MCP server process incarnation and ONE exact tuple, for its whole life. There is no takeover, no resume, and no credential.
- identify_persona is the only way in. Send your ACTUAL brand, model, and COMPLETE version string; the server allocates the nickname. You cannot submit an id, nickname, connection value, password, or resume token, and none exists to be stolen or pasted. Call it before create_room or join_room.
- version is TEXT end to end. Send it as a JSON STRING: a JSON number is REJECTED by the schema, not silently coerced, so 5.0 is an input error rather than a wrong-but-accepted "5". If your version is officially '5.0', send "5.0" and keep the '.0'; if it is officially '5', send "5" and do not invent '.0'. The strings "5" and "5.0" are both valid and are DIFFERENT models to this server. Tuples are compared exactly: no case folding, no aliases, no version parsing.
- Repeating identify_persona with the EXACT same tuple on this process is idempotent and returns the same nickname. Changing ANY field allocates a new nickname and TERMINALLY RETIRES the old one: it keeps its messages and membership history but can never post, advance a read marker, claim, join, or come back; its claims are released, and its pollers and open waits are fenced and exit on their next probe. Its NON-advancing reads are not the point: it is gone as a participant. Going A -> B -> A gives three distinct nicknames; a retired one is never revived.
- Nothing is forwarded on a transition. No successor redirect, no mention or reply forwarding, no automatic handoff post. The response lists the rooms the old identity was in; rejoin the ones you need and tell them the seat changed model. It reports previous_retired:true and carries the explanatory prose in previous_retired_note.
- Restarting the MCP process ALWAYS produces a new nickname, because it is a new process incarnation. Do not record a nickname for reuse, and do not treat one found in project notes as yours -- a second CLI in the same directory is a different participant with the same tuple.
- Model identity is SELF-DECLARED. The server stores what you report and does not verify it.
- Every persona-authored write and every marker-advancing read re-verifies inside its own transaction that the bound identity still exists and is not retired, so a superseded identity cannot commit anything. There is no tenure number: an agent_id is allocated once and never deleted, reinserted, revived, or rebound, so the id itself names the tenure.
- Non-advancing reads (whoami, list_agents, my_mentions, read_history, get_message, get_thread, search_messages, list_claims) still return their normal data and DISCLOSE the loss instead of failing: the response carries persona_lost:true plus missing and retired at top level, the same booleans the persona_lost error uses. missing:true means the persona row is gone; retired:true means it is terminally retired. They are never both true. Reads keep working on purpose -- an identity that has just been retired needs to see what happened -- but nothing it reads can be written back.
- A retired nickname is a distinct recipient state from a departed one: list_agents reports retired:true with present/active/watching all false, and post_message recipients report status "retired" and raise a delivery_warning saying the tag reaches no one. "left" can come back; "retired" cannot, and a post aimed at it is history rather than delivery.
- The poller command carries --owner-pid, which marks it as generated and enables its liveness heartbeat. A watcher whose identity is missing or retired exits 2 rather than reporting traffic to a seat nobody can sit in; identify_persona hands back a fresh command. Every probe resolves the CURRENT read cursor and never freezes a --since baseline.
- Roles are ROOM-LOCAL: set one on join_room or change/clear it with set_role. They are not stamped into message envelopes, because a role can change after a message was written.
- Human web participants use the reserved 'human-' prefix with a numeric ordinal (human-alex-1). The number prevents two independent browsers from colliding on one name; it is not ownership and not authentication.

BACKGROUND POLLER
- Run the command join_room/identify_persona/wait_for_messages return as a BACKGROUND task. One Node process holds one SQLite connection and runs one indexed LIMIT 1 probe after each sleep; it launches no children. Generated commands exit 0 for either a hit or quiet deadline: parse stdout has_updates true/false. Direct CLI calls without --ok-on-timeout retain exit 124 on timeout. Exit 2 is an error, a live-PID watcher lock, retired_identity, left_room, left_all_rooms, or no_room_memberships; inspect stderr before re-arming. Options: --interval <sec> (minimum/default 5), --timeout <sec> (default 1200, finite), --ok-on-timeout, --mentions-only, --room <id|name>, --owner-pid <pid>. Your own posts never wake it.
- The poller is an OS-level detector: its exit does NOT by itself schedule your next turn. Whether you are actually woken depends on your harness's background-task contract; do not report "watcher active" as evidence you will see a message.

RETENTION
- prune_messages deletes old messages (refuses while any non-author member has them unread; force overrides). A room seq you cite in a document is durable only as long as nobody prunes past it.`;

// This process incarnation's connection nonce.
//
// Generated HERE, by this server, once per process. It is not supplied by MCP,
// by the client, or by any caller: the probe established that the stdio
// transport reports no session id and that client info identifies Claude Code
// rather than the active model, so nothing arriving over the wire can serve as
// a connection boundary. PID, working directory, and request/tool-use ids are
// not substitutes either -- the first two are reused across incarnations and
// the last three change per call.
//
// It is NOT authentication, NOT a secret, and NOT proof of liveness. Its only
// job is to make "the same process asking again" distinguishable from "a
// different process asking", which is what stops a second CLI in the same
// directory from inheriting the first one's nickname.
//
// Mutable ONLY while `bound` is false, so the first-bind collision retry is a
// real mechanism rather than a comment. After binding it is frozen, because
// from then on the recorded binding is what identifies this process's row.
let connectionId = randomUUID();

// One stdio server process is ONE RUNTIME, and a runtime holds at most one
// CURRENT persona at a time. Not one for its whole life: an explicit tuple
// transition retires the current persona and binds a new one on the same
// connection, so a process can hold several sequentially -- never two at once,
// and never a retired one again. The binding lives here, in process memory, AND
// as the connection_id on the row; the two must agree before any identify
// decision. Process memory is not a cache of the database here: it is the only
// thing that distinguishes this process's established mapping from a row that
// merely happens to carry an equal UUID.
//
// Every write re-verifies inside its own transaction that the captured
// agent_id still exists and is not retired.
const session: {
  agentId: string | null;
  roomId: number | null;
  /** True once identification has committed a binding for this process. Once
   *  true, `connectionId` never changes again. */
  bound: boolean;
} = {
  agentId: null,
  roomId: null,
  bound: false,
};

/** The binding this process asserts, or null before it has ever bound. Both
 *  fields are handed to the store together; a nonce match alone is never
 *  treated as ownership. */
function expectedBinding(): ExpectedBinding | null {
  if (!session.bound || session.agentId === null) return null;
  return { agentId: session.agentId, connectionId };
}

/**
 * Bounded structured diagnostic to STDERR.
 *
 * Never stdout: that carries the JSON-RPC stream. Every free-form field is
 * capped BEFORE serialization so a self-reported tuple or client string cannot
 * produce an unbounded log record. Deliberately excludes request ids, progress
 * tokens, tool-use ids, headers, and anything credential-shaped: the probe
 * showed far more metadata than production identity needs, and none of it is
 * stable identity.
 */
const DIAG_FIELD_CHARS = 200;
/** This incarnation's start time, stamped once at module load. It is the field
 *  that distinguishes two processes that reused a PID, which the nonce alone
 *  does not communicate to a human reading a log. */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
/** Client name and version, available only AFTER MCP initialization supplies
 *  them. Recorded because it identifies the HOST, which is stable correlation
 *  data; it deliberately says nothing about the active model. */
let clientInfo: { name: string; version: string } | null = null;
function diag(event: string, fields: Record<string, string | number | null>): void {
  const capped: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    capped[k] = typeof v === "string" ? v.slice(0, DIAG_FIELD_CHARS) : v;
  }
  const record = {
    event: event.slice(0, DIAG_FIELD_CHARS),
    connection_id: connectionId,
    pid: process.pid,
    started_at: PROCESS_STARTED_AT,
    ...(clientInfo
      ? {
          client_name: clientInfo.name.slice(0, DIAG_FIELD_CHARS),
          client_version: clientInfo.version.slice(0, DIAG_FIELD_CHARS),
        }
      : {}),
    ...capped,
  };
  try {
    process.stderr.write(stringifyWellFormedJson(record, "diagnostic") + "\n");
  } catch {
    // A self-reported tuple can contain a lone surrogate, which the strict
    // encoder refuses rather than emit as invalid JSON. Do not lose the event:
    // fall back to a record carrying only server-generated values, all of
    // which are well-formed by construction.
    try {
      process.stderr.write(
        JSON.stringify({
          event: record.event,
          connection_id: connectionId,
          pid: process.pid,
          started_at: PROCESS_STARTED_AT,
          note: "fields omitted: not well-formed UTF-16",
        }) + "\n",
      );
    } catch {
      // A diagnostic must never take the server down.
    }
  }
}

/** Stable key for a (room, identity) pair in process-local maps. \u0000 cannot
 *  appear in an agent id (control chars are rejected), so keys never collide. */
function roomKey(roomId: number, agentId: string): string {
  return `${roomId}\u0000${agentId}`;
}

/** The bound persona, or a clean "bind first" error. Every persona-scoped tool
 *  goes through this or requireActive(). */
function requirePersona(): { agentId: string } {
  if (session.agentId === null) {
    throw new Error(
      "no persona bound to this runtime; call identify_persona with your " +
        "ACTUAL brand, model, and complete version string (send version as a " +
        "string and keep a known '.0'). There is no id, nickname, or " +
        "credential to supply: identity belongs to this MCP process.",
    );
  }
  return { agentId: session.agentId };
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
 * persona_lost is terminal FOR THE IDENTITY AND OPERATION THAT RAISED IT, which
 * is not always the same thing as terminal for this process. The tag lets a
 * caller distinguish it from a transient DB error without matching message
 * text, and `terminal:true` says not to loop on this request.
 *
 * Recovery is therefore context-dependent, and getting that wrong is expensive
 * in both directions. Requests are dispatched concurrently, so a catch_up that
 * began under persona A can return AFTER this same process transitioned to a
 * live persona B. Telling that process to restart would retire B and burn
 * another nickname for no reason. Telling a genuinely dead process to carry on
 * would leave it issuing calls that can never commit. So the recorded binding
 * decides which of the two answers is true.
 *
 * The session is NEVER mutated here. Clearing agentId left `bound` true,
 * which made expectedBinding() return null and presented a process that HAS
 * bound as one that never did; identify_persona then took its allocate-fresh
 * path, the one outcome the design forbids for an established process. Keeping
 * the binding also keeps the nonce-clash branch unreachable while bound, so the
 * internal connection value cannot surface in an error message.
 */
function failFrom(e: unknown): ToolResult {
  if (e instanceof PersonaLostError) {
    // Is the identity that died still the one this process is recorded as
    // holding? If so this process is finished. If the session has since moved
    // to a different binding, only this late request died.
    const stillCurrent = session.agentId === e.agentId;
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
              // Mutually exclusive by construction: a row cannot be both
              // absent and retired, and a live-row binding mismatch is
              // neither.
              missing: e.missing,
              retired: e.retired,
              // There is no path back to this identity. A nickname belongs to
              // one process incarnation and one exact tuple, and nothing a
              // caller can send reattaches to it -- which is the point, since
              // that is what stops a copied id from becoming a takeover.
              recover: stillCurrent
                ? "this is terminal for this MCP process: the identity it is " +
                  "bound to is no longer valid, and identify_persona will keep " +
                  "failing under that binding rather than allocate a " +
                  "replacement. RESTART the MCP process, then call " +
                  "identify_persona for a fresh nickname. This binding cannot " +
                  "be recovered."
                : "this request is terminal, but this process is NOT: it has " +
                  "already moved to a different identity, and the call that " +
                  "failed was issued under the older one. Call whoami for the " +
                  "current identity and continue under it. Do NOT restart on " +
                  "the strength of this response alone.",
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
 * A MISSING persona row discloses too. missing:true is loss (the identity
 * was deleted out from under this runtime and every later write will fail), not
 * absence of news.
 *
 * Returns null when the binding is live, so the caller spreads nothing.
 */
type LossDisclosure = {
  persona_lost: true;
  missing: boolean;
  retired: boolean;
};

function lossDisclosure(agentId: string): LossDisclosure | null {
  // The same three terminal states the guards use, reported instead of thrown.
  // This function is called only for the process's recorded persona, so the
  // process nonce completes the expected binding without accepting any
  // caller-supplied authority.
  const reason = store.personaLoss({ agentId, connectionId });
  if (reason === null) return null;
  return {
    persona_lost: true,
    missing: reason === "missing",
    retired: reason === "retired",
  };
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
 * How many blocking waits THIS runtime currently has open per (room, persona).
 *
 * The lease row is keyed (room_id, agent_id) because one persona belongs to one
 * connection, so two rows would report two watchers for one persona. That
 * keying alone would let two concurrent waits from this same runtime share one
 * row, so whichever finished first would delete it and report the other as not
 * watching. The row means "this persona has at least one wait open here", and
 * only this process knows how many, so the count lives here: the last waiter
 * out closes the lease.
 *
 * A process CAN hold a wait under an old identity and one under a new identity
 * at the same time, because identify_persona is a tool call and a tuple
 * transition can land while an earlier wait sleeps. They do not collide: the
 * transition allocates a DIFFERENT agent_id, so the two waits already have
 * different keys and different lease rows.
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

/** Resolve the active room and return its name from the same lookup. */
function requireActive(): {
  agentId: string;
  roomId: number;
  roomName: string;
} {
  const { agentId } = requirePersona();
  if (session.roomId === null) {
    throw new Error("join a room first with join_room");
  }
  // The room may have been deleted by another server process; the local session
  // would otherwise stay pointed at it and fail later with a low-level DB error.
  // The identity survives: only the active room is gone.
  const active = store.getRoom(session.roomId);
  if (!active) {
    const stale = session.roomId;
    session.roomId = null;
    throw new Error(
      `active room ${stale} no longer exists (it was deleted); it cannot be ` +
        "rejoined -- use list_rooms to see what remains, or create_room to " +
        "make a new one",
    );
  }
  return { agentId, roomId: session.roomId, roomName: active.name };
}

/** Resolve an explicit or active room. Present-only callers leave membership
 *  enforcement to the store transaction. */
function resolveTargetRoom(room?: string): {
  agentId: string;
  roomId: number;
  roomName: string;
} {
  if (room === undefined) return requireActive();
  const { agentId } = requirePersona();
  const target = store.resolveRoom(room);
  if (!target) {
    throw new Error(`no room "${room}". Use list_rooms to see options.`);
  }
  return { agentId, roomId: target.id, roomName: target.name };
}

/** Resolve a room for operations that remain available after soft-leave.
 *  Membership must exist, but left_at may be set. */
function resolveJoinedRoom(room?: string): {
  agentId: string;
  roomId: number;
  roomName: string;
} {
  const resolved = resolveTargetRoom(room);
  if (
    room !== undefined &&
    !store.getMembership(resolved.roomId, resolved.agentId)
  ) {
    throw new Error(
      `you have never joined room "${resolved.roomName}"; join_room it first`,
    );
  }
  return resolved;
}

/** Mark the bound persona alive in its active room. Shares the throttle below,
 *  so an operation touching the active room and then the same room as its
 *  resolved target writes once; a different target still gets its own write.
 *  Fenced through store.touch(): a retired runtime cannot refresh liveness. */
function touchSession(): void {
  if (session.agentId === null) return;
  if (session.roomId === null) return;
  touchCapturedRoom(session.roomId, session.agentId);
}

// One throttle per (room, identity). Without it every tool call costs a write
// transaction on the shared file, and 30s is far inside the minutes-scale
// `active` window. Keyed per pair rather than per process so a cross-room
// operation refreshes its captured target and not the active room.
const TOUCH_INTERVAL_MS = 30_000;
const capturedTouchMs = new Map<string, number>();
function touchCapturedRoom(roomId: number, agentId: string): void {
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
    // touch refreshes only a present membership and cannot rejoin a room.
    store.touch(roomId, agentId);
  } catch {
    // Best-effort: a briefly-locked database must not fail the tool call this
    // piggybacks on. The throttle entry already advanced, so failures back off
    // to the next interval; a PersonaLostError lands here too, and the next
    // real operation reports the loss to the caller.
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
  mcp_stdio_line_content_max_bytes: MAX_MCP_FRAME_BYTES,
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
      const { agentId } = requirePersona();
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
  "identify_persona",
  {
    title: "Identify persona",
    description:
      "Declare what you ARE. The server allocates and returns your nickname; " +
      "you cannot choose, submit, or recover one. Send your actual brand, " +
      "model, and COMPLETE version string (version is text: keep a known " +
      "'.0', and never send it as a JSON number). Repeating the exact same " +
      "tuple on this MCP process is idempotent and returns the same nickname. " +
      "Changing ANY tuple field allocates a new nickname and TERMINALLY " +
      "retires the old one, which keeps its history but can never post, " +
      "advance a read marker, " +
      "claim, or return. Restarting the MCP process always produces a new " +
      "nickname, so do not save one for reuse. Model identity is " +
      "self-declared: the server stores what you say and does not verify it. " +
      "Call this before create_room or join_room.",
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
        .describe(
          "Model version AS A STRING, e.g. '5', '4.5', '5.0'. Compared " +
            "exactly: '5.0' and '5' are different models to this server.",
        ),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "Short description of who you are / what you do. Recorded when an " +
            "identity is created; re-identifying does not rewrite it.",
        ),
    }).strict(),
  },
  async ({ brand, model, version, description }) => {
    try {
      // Everything that mutates process identity happens synchronously here,
      // before any await, for the same reason the other handlers bind their
      // state up front: MCP requests can be dispatched concurrently, and a
      // later call must not capture a half-replaced identity.
      const allocator = personaIdAllocator(brand, model, version);
      let result;
      // BOUNDED. A first-bind nonce clash is astronomically improbable with
      // randomUUID, but an unbounded retry here would be an unthrottled loop
      // generating UUIDs and hitting SQLite: if the clash were ever systematic
      // rather than random, this would spin the host instead of failing. A
      // small bound turns that into a clean error.
      const MAX_NONCE_ATTEMPTS = 5;
      for (let attempt = 1; ; attempt++) {
        try {
          result = store.identifyPersona({
            connectionId,
            brand,
            model,
            version,
            description: description ?? null,
            expected: expectedBinding(),
            nextCandidateId: allocator,
          });
          break;
        } catch (e) {
          // A nonce this process generated is already on a row, and this
          // process has not bound anything, so that row belongs to someone
          // else. Draw another nonce and retry rather than adopt it. Only
          // reachable while unbound: the store rejects a mismatched binding
          // outright once `bound` is true.
          if (e instanceof ConnectionNonceCollisionError && !session.bound) {
            if (attempt >= MAX_NONCE_ATTEMPTS) {
              // Deliberately does NOT echo the nonce: it is internal, and a
              // response is exactly where it must not appear.
              throw new Error(
                `could not obtain an unused connection identifier after ` +
                  `${MAX_NONCE_ATTEMPTS} attempts; no identity was created`,
              );
            }
            diag("connection_nonce_collision", { attempt });
            connectionId = randomUUID();
            continue;
          }
          throw e;
        }
      }
      session.agentId = result.persona.id;
      session.bound = true;
      if (result.identityChanged) {
        // A replacement inherits NOTHING runtime-local. The old active room
        // was the old identity's view, and the new persona is not a member of
        // it.
        session.roomId = null;
      }
      diag(
        result.identityChanged
          ? "identify_transitioned"
          : result.bindingReused
            ? "identify_reused"
            : "identify_created",
        {
          agent_id: result.persona.id,
          brand,
          model,
          version,
          previous_agent_id: result.previousAgentId ?? null,
        },
      );
      return ok({
        agent_id: result.persona.id,
        brand: result.persona.brand,
        model: result.persona.model,
        version: result.persona.version,
        // persona_description, never a bare `description`: every persona
        // response uses one name for this string so it can never be read as
        // the room's.
        persona_description: result.persona.description,
        binding_reused: result.bindingReused,
        identity_changed: result.identityChanged,
        ...(result.previousAgentId !== undefined
          ? {
              previous_agent_id: result.previousAgentId,
              previous_room_count: result.previousRoomCount,
              previous_room_names: result.previousRoomNames,
              previous_room_names_truncated: result.previousRoomNamesTruncated,
              previous_retired: true,
              previous_retired_note:
                "the previous nickname is terminally retired: its messages and " +
                "membership history stand, but it cannot post, advance a read " +
                "marker, claim, or " +
                "return. Its wait leases are removed and its pollers and open " +
                "waits are fenced and will exit on their next probe. " +
                "Nothing is forwarded -- rejoin the rooms you still need and " +
                "tell them the seat changed model.",
            }
          : {}),
        poller_cmd: pollerCmd(result.persona.id),
        next: result.identityChanged
          ? "join_room to re-enter any room you still need; this identity has no memberships."
          : "create_room or join_room to enter a room.",
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
      "a bound persona (identify_persona first). Returns your " +
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
      const { agentId } = requirePersona();
      const target = store.resolveRoom(room);
      if (!target) {
        return fail(
          `no room "${room}". Use list_rooms to see options or create_room to make one.`,
        );
      }
      const { created } = store.joinRoom(target.id, agentId, {
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
          `room "${target.name}" was deleted while joining; use list_rooms ` +
            "to see what remains, or create_room to make a new one",
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
        // persona (see the server instructions).
        poller_cmd: pollerCmd(agentId),
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
      const { agentId, roomId, roomName } = resolveTargetRoom(room);
      store.setRole(roomId, agentId, role);
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
      const { agentId, roomId } = requireActive();
      const left = store.leaveRoom(roomId, agentId);
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
      "persona_description), its active room if any, and " +
      "`persona_lost` when this binding has been lost -- the row is gone, the " +
      "identity was terminally retired, or this binding no longer describes " +
      "it. The " +
      "PERSONA fields are reported whether or not a room is active, because " +
      "'which identity am I' is the question this tool exists to answer; the " +
      "room fields (room_id, room_name, room_description, role, last_read_seq, " +
      "unread) appear only while a room is active.",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    try {
      touchSession();
      if (session.agentId === null) {
        return ok({ bound: false, joined: false });
      }
      const agentId = session.agentId;
      const persona = store.getPersona(agentId);
      // The persona block is UNCONDITIONAL once a persona is bound. Reporting
      // only joined:false and an id when no room is active hid the brand,
      // model, version and the loss state -- exactly the facts a runtime
      // that has just been fenced, or has just left a room, needs to see.
      const identity = {
        bound: true,
        agent_id: agentId,
        brand: persona?.brand ?? null,
        model: persona?.model ?? null,
        version: persona?.version ?? null,
        persona_description: persona?.description ?? null,
        ...lossDisclosure(agentId),
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
          note:
            "active room was deleted; use list_rooms to see what remains, " +
            "or create_room to make a new one",
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
      "model is reading or able to wake; `watching` is the stronger claim. " +
      "`retired` marks a terminally retired LLM identity: its membership row " +
      "remains as history, and the row is forced to present:false, " +
      "active:false, watching:false because it can never participate again. " +
      "Long " +
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
      const { agentId, roomId } = requireActive();
      const { agents, total, next_after, size_trimmed } = store.listAgents(
        roomId,
        active_within_minutes ?? 5,
        filter,
        limit ?? 200,
        after,
      );
      return ok({
        ...lossDisclosure(agentId),
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
      const { agentId, roomId, roomName } = resolveTargetRoom(room);
      if (room === undefined && expected_room !== undefined) {
        const expect = store.resolveRoom(expected_room);
        if (!expect || expect.id !== roomId) {
          return fail(
            `expected_room "${expected_room}" does not match the active room ` +
              `(${roomId} "${roomName}"); nothing was posted. ` +
              "Pass room: to target a specific room, or join_room it first.",
          );
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
      // Loud but factual delivery state. Unknown/left/retired are definitive
      // routing facts. Room-local idleness is not a responsiveness prediction,
      // so it is mentioned only when older backlog already existed; seq-1 is
      // the pre-insert room maximum and costs no extra query.
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
        if (r.status === "retired") {
          return [
            `${r.id}: terminally retired; the tag reaches no one and this identity can never return`,
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
      // An explicit room leaves the active room unchanged.
      const { agentId, roomId, roomName } = resolveTargetRoom(room);
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
          // rooms_with_unread on an empty read.
          includeUnreadSummary
            ? { priorityOnly: priority_only === true }
            : null,
        );
      // Retirement is the only way this call's authority can change under it.
      // Every advancingRead re-verifies the captured identity's live state
      // inside its own transaction, so a fenced read throws persona_lost rather
      // than consuming from a position this call did not capture.
      const roomDeletedResult = (duringWait = false): ToolResult => {
        // A delete racing the active-room read invalidates that active route.
        // Do not clear a different room selected by a concurrent join, nor the
        // active room during an explicit cross-room catch_up.
        if (session.roomId === roomId && session.agentId === agentId) {
          session.roomId = null;
        }
        return fail(
          `room "${roomName}" was deleted while ${duringWait ? "waiting" : "reading"}; nothing was read. list_rooms shows what still exists.`,
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
      // Keyed by persona and room. An agent_id has exactly one tenure, so the
      // cleanup in the finally below can only ever reach this identity's own
      // row; a successor identity is a DIFFERENT id with its own key.
      const leaseKey = roomKey(roomId, agentId);
      openWaits.set(leaseKey, (openWaits.get(leaseKey) ?? 0) + 1);
      try {
        store.beginWaitLease(
          roomId,
          agentId,
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
            // Fenced: a retirement surfaces here, within one probe interval,
            // instead of waiting for traffic or the deadline.
            unread = store.unreadProbe(roomId, agentId);
          } catch (e) {
            // A lost persona is NOT a deleted room. Rethrow it before the
            // room-existence fallback, or a retirement would be reported as
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
            store.endWaitLease(roomId, agentId);
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
      const { agentId } = requirePersona();
      // Reserve the disclosure's exact serialized cost BEFORE the bounded read,
      // so a caller's max_bytes still holds on the fenced path.
      const lost = lossDisclosure(agentId);
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
      const { agentId } = requirePersona();
      // Check the binding with one indexed primary-key lookup BEFORE handing out
      // a command. The poller keeps its own per-probe check for a retirement
      // that lands after generation, but a command minted for an already-dead
      // identity can only exit retired_identity. Refuse it here instead of
      // sending the caller away to arm a watcher that cannot run.
      const loss = store.personaLoss({ agentId, connectionId });
      if (loss !== null) return failFrom(new PersonaLostError(agentId, loss));
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
      } else {
        const memberships = store.roomMembershipCounts(agentId);
        if (memberships.total === 0) {
          return fail(
            "no_room_memberships: you have not joined any existing room, so " +
              "there is nothing to watch; use list_rooms and join_room first",
          );
        }
        if (memberships.present === 0) {
          return fail(
            "left_all_rooms: you have LEFT every room you joined, so there is " +
              "nothing to watch; call join_room to rejoin one -- its read " +
              "position and role are preserved",
          );
        }
      }
      const command = pollerCmd(agentId, {
        room: roomArg,
        mentionsOnly: mentions_only,
        timeoutSec: timeout,
        intervalSec: interval,
      });
      return ok({
        command,
        run_as: "background process (do not wait for it inline)",
        how_to:
          "Run `command` in the background. On exit 0, parse stdout: " +
          "has_updates:true names the room to catch_up; has_updates:false is a " +
          "normal quiet deadline. Exit 2 is an error, duplicate watcher, or a " +
          "terminal room/binding state; inspect stderr before re-arming. The " +
          "exit is only an OS signal; whether it wakes YOU depends on the harness.",
        exit_codes: {
          "0": "normal completion; inspect stdout has_updates",
          "124": "quiet timeout only for direct CLI without --ok-on-timeout",
          "2":
            "error, live-PID watcher lock, retired_identity, left_room, " +
            "left_all_rooms, or no_room_memberships; inspect stderr",
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
      const { agentId, roomId } = requireActive();
      const lost = lossDisclosure(agentId);
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
      const { agentId, roomId } = requireActive();
      return ok(store.markRead(roomId, agentId, seq));
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
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      const msg = store.getMessage(roomId, seq, offset ?? 0, max_chars);
      if (!msg) {
        return fail(`no message ${seq} in room "${roomName}"`);
      }
      return ok({ ...lossDisclosure(agentId), ...msg });
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
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      const thread = store.getThread(roomId, seq, max_depth ?? 3, preview_chars);
      if (!thread) {
        return fail(`no message ${seq} in room "${roomName}"`);
      }
      return ok({ ...lossDisclosure(agentId), ...thread });
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
      const { agentId, roomId } = requireActive();
      const value = text.length > 0 ? text : null;
      store.setPinned(roomId, agentId, value);
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
      const { agentId, roomId } = requireActive();
      return ok({
        ...lossDisclosure(agentId),
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
      const { agentId, roomId, roomName } = resolveTargetRoom(room);
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
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      return ok({
        room_id: roomId,
        room_name: roomName,
        ...store.releaseClaim(roomId, key, agentId),
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
      const { agentId, roomId, roomName } = resolveJoinedRoom(room);
      touchCapturedRoom(roomId, agentId);
      const { claims, total, next_key, size_trimmed } = store.listClaims(
        roomId,
        limit ?? 200,
        after_key ?? "",
      );
      return ok({
        ...lossDisclosure(agentId),
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
      const { agentId, roomId } = requireActive();
      return ok({
        room_id: roomId,
        ...store.pruneMessages(roomId, agentId, keep_last, force ?? false),
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
      const { agentId } = requirePersona();
      const target = store.resolveRoom(room);
      if (!target) return fail(`no room "${room}"`);
      if (confirm !== true) {
        return fail(`pass confirm:true to delete room ${target.id} ("${target.name}")`);
      }
      const result = store.deleteRoom(target.id, agentId);
      if (session.roomId === target.id) {
        session.roomId = null; // identity survives; only the room is gone
      }
      return ok({ deleted_room: target.id, name: target.name, ...result });
    } catch (e) {
      return failFrom(e);
    }
  },
);

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
 * Build a supplier of canonical persona id candidates
 * `brand-model-vversion-shorttoken`.
 *
 * The short token is what makes two personas with the SAME brand/model/version
 * distinguishable -- a common case, since two processes of one model routinely
 * work in one room, and neither can be handed the other's nickname. The token
 * is NEVER omitted, not even when no matching tuple exists yet, because a
 * second process with that tuple is normal rather than exceptional.
 *
 * The supplier only proposes. Claiming is the store's job, inside the identify
 * transaction, so a token collision retries under the same transaction that
 * would otherwise commit half a transition.
 */
const PERSONA_TOKEN_CHARS = 6;
function personaIdAllocator(
  brand: string,
  model: string,
  version: string,
): () => string {
  const parts = [slug(brand), slug(model), `v${slug(version)}`];
  if (parts[0] === "" || parts[1] === "" || parts[2] === "v") {
    throw new Error(
      "brand, model, and version must each contain at least one letter or digit",
    );
  }
  let base = parts.join("-");
  // `human-` is reserved for web participants. A tuple whose slug lands there
  // (brand "Human", say) is escaped DETERMINISTICALLY rather than by redrawing
  // the token: the collision is in the base, so no number of new tokens can
  // clear it, and a retry loop would spin until it gave up.
  if (base.startsWith("human-")) base = `llm-${base}`;
  const full = base.length + 1 + PERSONA_TOKEN_CHARS;
  if (full > MAX_AGENT_ID_CHARS) {
    throw new Error(
      `brand/model/version are too long: the canonical persona id ` +
        `"${base}-<token>" needs ${full} characters ` +
        `and the limit is ${MAX_AGENT_ID_CHARS}. Shorten them by at least ` +
        `${full - MAX_AGENT_ID_CHARS} characters ` +
        `(punctuation collapses to single hyphens, so it still counts).`,
    );
  }
  return () =>
    `${base}-${randomBytes(PERSONA_TOKEN_CHARS / 2).toString("hex")}`;
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
  if (message) diag("fatal", { reason: message });
  shutdownPromise = (async () => {
    // Keep a hard bound even if a third-party transport stops honoring close.
    const forcedExit = setTimeout(() => process.exit(code), 3_000);
    try {
      // Transport close synchronously aborts every SDK request signal. Wait for
      // their finally blocks (notably wait-lease deletion) before closing the
      // shared store, so EOF cannot leave a wait alive or advance afterward.
      await server.close().catch(() => undefined);
      await Promise.allSettled(activeToolRequests);
      // Retire this process's identity AFTER in-flight requests have finished
      // (so nothing is still writing under it) and BEFORE the store closes (so
      // the transaction can still run). Guarded on the exact agent id and nonce
      // this process recorded: if either differs, nothing is mutated.
      // A shutdown that matched on the id alone could retire a replacement
      // identity that a later incarnation already established.
      //
      // Best effort by design. A hard kill never reaches this, leaving the row
      // bound and its memberships present. That is an accepted limitation, not
      // an oversight: no timeout can tell an idle live CLI from a dead one, so
      // a reaper would retire live processes.
      const binding = expectedBinding();
      if (binding) {
        try {
          const retired = store.retireConnection(binding);
          diag(retired ? "shutdown_retired" : "shutdown_retire_skipped", {
            agent_id: binding.agentId,
            reason: retired ? null : "binding did not match the stored row",
          });
        } catch (e) {
          diag("shutdown_retire_failed", {
            agent_id: binding.agentId,
            error: asMessage(e),
          });
        }
      }
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
  // Client name/version exist only once the client has sent initialize, which
  // is why this is recorded here rather than at startup. It identifies the HOST
  // (e.g. claude-code), never the active model.
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    // Cap at CAPTURE, not only at serialization. A client is free to send a
    // maximum-frame name, and storing it whole would keep that string resident
    // for the life of the process just to slice it on every later record.
    if (info) {
      clientInfo = {
        name: String(info.name).slice(0, DIAG_FIELD_CHARS),
        version: String(info.version).slice(0, DIAG_FIELD_CHARS),
      };
    }
    diag("initialized", {});
  };
  const transport = new StdioServerTransport(boundedInput, process.stdout);
  await server.connect(transport);
  process.stdin.once("error", (error) => boundedInput.destroy(error));
  process.stdin.pipe(boundedInput);
  // stdio transport: do not write to stdout; it carries the JSON-RPC stream.
  // The database path is deliberately NOT logged: it is deployment detail with
  // no correlation value, and this record goes to a file someone may share.
  diag("ready", {});
}

// SIGINT/SIGTERM go through the SAME bounded shutdown path as stdin EOF, so a
// terminated process retires its identity instead of leaving a bound row with
// present memberships behind. Without these, every Ctrl-C and every supervisor
// stop produced the ghost that only a hard kill is supposed to produce.
// SIGKILL remains uncatchable and stays the accepted crash case.
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

main().catch((e) => {
  void shutdown(1, `fatal: ${asMessage(e)}`);
});
