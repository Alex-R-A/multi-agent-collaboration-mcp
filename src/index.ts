#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ChatStore, SQLITE_MAX_LENGTH } from "./db.js";

const store = new ChatStore();

// Absolute path to the background poller, resolved from this compiled file
// (dist/index.js -> ../scripts/wait-for-updates.sh) so it is correct regardless
// of the launching process's working directory.
const POLLER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "wait-for-updates.sh",
);

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
  opts: { room?: string; mentionsOnly?: boolean } = {},
): string {
  let cmd = `bash ${shq(POLLER)} --agent ${shq(agentId)}`;
  if (opts.room !== undefined) cmd += ` --room ${shq(opts.room)}`;
  if (opts.mentionsOnly) cmd += ` --mentions-only`;
  return cmd;
}
const POLLER_CMD = `${pollerCmd("<your_agent_id>")} [--mentions-only]`;

const INSTRUCTIONS = `Shared chat room for AI agents, backed by one SQLite file; each agent runs its own copy of this server, and the file is the coordination channel. Your identity and active room are remembered for the session.

Typical flow: list_rooms -> join_room (capture the returned agent_id if you did not supply one; read the pinned intro) -> list_agents -> catch_up (consumes the backlog, advances your read marker) or read_history (no marker change) -> post_message. Tag participants with "to"; reference earlier messages with reply_to_seq. catch_up never returns your own posts (use read_history/search_messages for those) and is THE room sync, always unfiltered. my_mentions is the cross-room inbox of unread messages directed at you (mentions and replies): a peek that never moves markers; entries clear when you read their room; page with after_id = next_after_id. Its by_room also reports each room's TOTAL unread, so an empty inbox with nonzero by_room unread means rooms have traffic, not silence.

Name rooms for their TOPIC (kebab-case, e.g. 'auth-refactor-review'), never for participants or generic labels: list_rooms names are how agents find rooms.

Bulk reads are byte-bounded (~100k serialized). byte_limited:true = more remain (catch_up/read_history: call again; my_mentions: pass after_id). Oversized bodies arrive truncated:true with length; page them via get_message offset. post_message returns crossed (messages from others you had NOT read when posting): if > 0, catch_up before acting, contradicting messages may have landed while you wrote. Before exclusive work, claim a key like "file:src/db.ts": exactly one claimant wins; release_claim when done; claims expire after their TTL, so a crashed holder cannot block forever. Correct yourself with post_message supersedes_seq on your own earlier message; readers see superseded_by on it. Running MULTIPLE sessions under one agent_id? Pass cursor:'private' to join_room for an independent read position (the default 'shared' splits the backlog once across sessions: right for work queues, wrong for independent views).

To wait for activity without busy-looping tool calls, run this poller as a BACKGROUND task; it exits 0 when there is something new (its exit is your notification) with a one-line JSON status (unread, unread_mentions), or exits after --timeout with nothing new:

  ${POLLER_CMD}

Prefer the poller_cmd string join_room returns, or call the wait_for_messages tool: both hand back this command pre-quoted for your exact agent id (hand-substituting an id containing quote characters breaks the shell quoting). The poller is a background SCRIPT, not a blocking tool: run the command as a background task. Default scope is ALL rooms you are present in; --room <id|name> scopes to one. catch_up first so your markers are the baseline; your own posts never wake it; --mentions-only fires only on messages directed at you. Options: --interval <sec> (default 5), --timeout <sec> (default 1200; 0 = never), --since <seq> (baseline override; requires --room). Exit codes: 0 updates, 124 timeout, 2 error. cursor:'private' note: the poller reads IDENTITY-level markers (the MAX across twin sessions); a lagging private session should use --room with --since = its own last_read_seq from whoami.`;

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
      // still shield this session's cursors from the GC.
      store.touchSessionMarkers(session.agentId, SESSION_NONCE);
    }
  } catch {
    // Liveness is best-effort: a briefly-locked database must not fail the
    // tool call this touch piggybacks on (pure reads included). lastTouchMs
    // already advanced, so failures back off to the next interval.
  }
}

// Build identity, stamped into dist/build-info.json by scripts/stamp-build.mjs at
// build time so server_info pins the exact deployed binary. Reading git at runtime
// would report the source HEAD instead, masking an edited-but-not-rebuilt dist,
// which is precisely the skew this exists to surface. Falls back when absent.
const BUILD: { version: string; commit: string; built_at: string } = (() => {
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
 * hot-reloads). Compares built_at, which advances on every rebuild, including
 * same-commit dirty rebuilds. No client UI surfaces serverInfo.version, so this
 * in-band flag is the only way an agent learns it is running old code.
 */
function buildStatus(): {
  stale: boolean;
  latest_commit: string | null;
  latest_built_at: string | null;
} {
  let latest: { commit: string; built_at: string } | null = null;
  try {
    latest = JSON.parse(
      readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    );
  } catch {
    latest = null;
  }
  const stale =
    latest !== null && latest.built_at !== "" && latest.built_at > BUILD.built_at;
  return {
    stale,
    latest_commit: latest?.commit ?? null,
    latest_built_at: latest?.built_at ?? null,
  };
}

const server = new McpServer(
  {
    name: "agent-chat-mcp",
    version: BUILD.version,
  },
  { instructions: INSTRUCTIONS },
);

// Every inputSchema below is z.object(...).strict(): UNKNOWN keys are
// rejected, not silently stripped. Stripping turned typos into different
// operations -- mark_read({sequence:0}) marked the whole backlog read,
// post_message({too:[...]}) posted without its recipients. The SDK passes
// Zod schema instances through to its own validator, so strictness reaches
// the wire (and additionalProperties:false reaches the advertised schema).

server.registerTool(
  "server_info",
  {
    title: "Server info",
    description:
      "Report this server's version and build identity (git commit, build " +
      "time). `stale:true` = a newer build was deployed since this process " +
      "started; reconnect the MCP to load it (stdio servers do not " +
      "hot-reload); `latest_commit`/`latest_built_at` name it. `commit` gets " +
      "a -dirty suffix for uncommitted builds.",
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
        stale: status.stale,
        latest_commit: status.latest_commit,
        latest_built_at: status.latest_built_at,
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
      "List chat rooms (oldest first, up to `limit` from `offset`; `total` " +
      "reports how many exist) with present-member count, message count, last " +
      "activity and pinned intro. Long pinned/descriptions are listing previews " +
      "(*_truncated flags); join_room returns the full pinned. `truncated:true` " +
      "= more rows exist (by limit, offset, or a serialized-size cut); page " +
      "with offset.",
    inputSchema: z
      .object({
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max rooms to return (default 200)"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Skip this many rooms (paging; default 0)"),
      })
      .strict(),
  },
  async ({ limit, offset }) => {
    try {
      touchSession();
      const off = offset ?? 0;
      const { rooms, total, size_trimmed } = store.listRooms(limit ?? 200, off);
      const more = off + rooms.length < total || !!size_trimmed;
      return ok({
        rooms,
        total,
        ...(more ? { truncated: true } : {}),
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
      room: z.string().min(1).describe("Room id or name to join"),
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
      store.joinRoom(target.id, id, priv ? SESSION_NONCE : null);
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
        poller_cmd: pollerCmd(id),
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
      const left = store.leaveRoom(roomId, agentId);
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
      "List agents in the active room (up to `limit` from `offset`, `total` " +
      "rides along): type/role/description, `last_read_seq` (read receipt: " +
      "compare to a message seq), `last_seen`, `idle_seconds`, `present` (has " +
      "not left), `active` (seen within active_within_minutes). Long " +
      "descriptions are listing previews (description_truncated). " +
      "`truncated:true` = more rows exist; page with offset.",
    inputSchema: z.object({
      filter: z
        .string()
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
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Skip this many agents (paging; default 0)"),
    }).strict(),
  },
  async ({ filter, active_within_minutes, limit, offset }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const off = offset ?? 0;
      const { agents, total, size_trimmed } = store.listAgents(
        roomId,
        active_within_minutes ?? 5,
        filter,
        limit ?? 200,
        off,
      );
      const more = off + agents.length < total || !!size_trimmed;
      return ok({
        agents,
        total,
        ...(more ? { truncated: true } : {}),
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
      "Post to the active room. `content` is text or a JSON object/array; " +
      "`to` = agent_ids the message is directed at (mentions); `reply_to_seq` " +
      "tags an earlier message. Returns the assigned `seq` plus, per tagged " +
      "id, `recipients`: `status` (unknown = never joined, the tag reaches no " +
      "one; left; idle; active), `idle_seconds`, and `last_read_seq` (below " +
      "this seq = they have not read it yet). `crossed` counts messages from " +
      "others YOU had not read at post time (`crossed_range`): if > 0, " +
      "catch_up, contradicting messages may have landed while you wrote. " +
      "`supersedes_seq` marks YOUR OWN earlier message as corrected (readers " +
      "see `superseded_by` on it) instead of leaving both versions standing.",
    inputSchema: z.object({
      content: z
        .union([z.string(), z.record(z.any()), z.array(z.any())])
        .describe("Message body: a string, or a JSON object/array"),
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
    }).strict(),
  },
  async ({ content, to, reply_to_seq, supersedes_seq }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      const isText = typeof content === "string";
      const body = isText ? (content as string) : JSON.stringify(content);
      if (Buffer.byteLength(body, "utf8") > SQLITE_MAX_LENGTH) {
        return fail(
          `message body exceeds the SQLite maximum of ${SQLITE_MAX_LENGTH} bytes`,
        );
      }
      const mentions = to && to.length > 0 ? dedupe(to) : null;
      // Compute recipient status BEFORE inserting, so a failure here cannot
      // report an error for a message that was already stored.
      const recipients = mentions
        ? store.recipientStatus(roomId, mentions, 5)
        : [];
      const { seq, crossed, crossed_range } = store.postMessage(
        roomId,
        agentId,
        body,
        isText ? "text" : "json",
        mentions,
        reply_to_seq ?? null,
        supersedes_seq ?? null,
        cursorId(),
      );
      return ok({
        seq,
        format: isText ? "text" : "json",
        to: mentions,
        reply_to_seq: reply_to_seq ?? null,
        supersedes_seq: supersedes_seq ?? null,
        crossed,
        crossed_range,
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
      "Return messages from OTHER agents posted since you last read (seq > your " +
      "last_read marker), oldest first, and ADVANCE your read marker so the " +
      "next call only returns what is new; `remaining` reports how many are " +
      "still unread. Your own messages are never returned here (use " +
      "read_history/search_messages to see them). This is THE room sync and it " +
      "is unfiltered by design; to find what is directed at you across every " +
      "room, use my_mentions (a cross-room inbox that never moves markers).",
    inputSchema: z.object({
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
          "Serialized-size budget per page (default 100000). The marker " +
            "advances only over returned messages; byte_limited:true = more " +
            "remain, call again.",
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
  async ({ limit, preview_chars, max_bytes, mentions_me, after_seq }) => {
    try {
      touchSession();
      // Reject, never strip: a v0.5 caller sending mentions_me expected a
      // non-advancing filtered peek; silently running an ADVANCING full sync
      // instead would eat its unread backlog.
      if (mentions_me !== undefined || after_seq !== undefined) {
        return fail(
          "mentions_me/after_seq were removed in v0.6.0: catch_up is now " +
            "always the full room sync and ADVANCES your marker. For messages " +
            "directed at you use my_mentions (cross-room inbox, never advances " +
            "markers, pages with after_id). This call was rejected instead of " +
            "silently changing semantics.",
        );
      }
      const { agentId, roomId } = requireActive();
      const result = store.catchUp(
        roomId,
        agentId,
        limit ?? 50,
        preview_chars,
        max_bytes,
        cursorId(),
      );
      return ok(result);
    } catch (e) {
      return fail(asMessage(e));
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
            "mark the cut; full body via get_message in that room)",
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
  "wait_for_messages",
  {
    title: "Wait for new messages (background poller)",
    description:
      "Get the exact shell command to WATCH for new messages without " +
      "busy-looping tool calls. IMPORTANT: this tool does NOT block or wait " +
      "itself; it RETURNS a `command` (a background poller script) for you to " +
      "run. Launch that `command` as a BACKGROUND shell task: it exits 0 the " +
      "moment a new message arrives (that exit is your signal to catch_up), " +
      "124 if it times out with nothing new, 2 on error. Needs an identity " +
      "(join_room first). Watches EVERY room you are present in unless `room` " +
      "scopes it to one. Set mentions_only to fire only on messages that " +
      "mention you or reply to you. (join_room also returns this same command " +
      "as poller_cmd.)",
    inputSchema: z
      .object({
        room: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Scope the watch to one room (id or name); default watches every " +
              "room you are present in",
          ),
        mentions_only: z
          .boolean()
          .optional()
          .describe("Fire only when a message mentions you or replies to you"),
      })
      .strict(),
  },
  async ({ room, mentions_only }) => {
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
      });
      return ok({
        command,
        run_as: "background shell task (do not wait for it inline)",
        how_to:
          "Run `command` in the background. It exits 0 when something new " +
          "arrives, 124 on timeout with nothing new, 2 on error; re-launch it " +
          "after each hit to keep watching. On exit 0, an unscoped watch does " +
          "NOT tell you WHICH room fired: use my_mentions (the cross-room " +
          "inbox) or catch_up in each joined room -- a plain catch_up only " +
          "reads your ACTIVE room, which may not be the one that woke the " +
          "poller. A --room-scoped watch fires only for that room, but a plain " +
          "catch_up still reads your ACTIVE room, so join_room the watched room " +
          "first (or use my_mentions) to read what woke it.",
        exit_codes: {
          "0": "new messages -> my_mentions or catch_up the right room",
          "124": "timed out, nothing new",
          "2": "error",
        },
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
      "(codepoints). A sliced json body is a raw partial string.",
    inputSchema: z.object({
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
  async ({ seq, offset, max_chars }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const msg = store.getMessage(roomId, seq, offset ?? 0, max_chars);
      if (!msg) return fail(`no message ${seq} in this room`);
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
      "truncated:true with length; page full text via get_message.",
    inputSchema: z.object({
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
  async ({ seq, max_depth, preview_chars }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const thread = store.getThread(roomId, seq, max_depth ?? 3, preview_chars);
      if (!thread) return fail(`no message ${seq} in this room`);
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
      query: z.string().min(1).describe("FTS5 search query"),
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
      "Returns granted:true with expires_at, or granted:false with the " +
      "holder. Claims expire after ttl_seconds (default 900); re-claim your " +
      "own key to renew. Advisory only: nothing is physically locked, " +
      "cooperating agents must check. Ownership is per agent_id.",
    inputSchema: z.object({
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
  async ({ key, ttl_seconds, note }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      return ok(
        store.claimResource(roomId, key, agentId, ttl_seconds ?? 900, note ?? null),
      );
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
      "released by anyone; an active claim only by its holder.",
    inputSchema: z.object({
      key: z.string().min(1).max(500).describe("Resource name to release"),
    }).strict(),
  },
  async ({ key }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      return ok(store.releaseClaim(roomId, key, agentId));
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
      "List active (unexpired) claims in the active room (up to `limit`, " +
      "`total` active count rides along): key, holder, note (listing preview, " +
      "note_truncated flags a cut), and seconds until expiry. Check before " +
      "starting work that overlaps someone's claim. `next_key` present = more " +
      "rows exist; page by passing it back as `after_key` (keyset paging, so a " +
      "claim expiring between pages cannot make you skip a live one).",
    inputSchema: z
      .object({
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
  async ({ limit, after_key }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const { claims, total, next_key, size_trimmed } = store.listClaims(
        roomId,
        limit ?? 200,
        after_key ?? "",
      );
      return ok({
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
      room: z.string().min(1).describe("Room id or name to delete"),
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
  const id = `agent-${randomUUID().slice(0, 8)}`;
  store.tryCreateAgent(id, type, role, description);
  return id;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport: do not write to stdout; it carries the JSON-RPC stream.
  process.stderr.write(`agent-chat-mcp ready (db: ${store.path})\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${asMessage(e)}\n`);
  process.exit(1);
});
