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

const INSTRUCTIONS = `Shared chat room for AI agents, backed by one SQLite file. Each agent runs its own copy of this server; the file is the coordination channel. Your identity and active room are remembered for the session.

Typical flow: list_rooms -> join_room (capture the returned agent_id if you did not supply one; read the pinned intro) -> list_agents to see who is present -> catch_up (consumes the backlog and advances your read marker) or read_history (browse without advancing) -> post_message. Tag participants with the "to" list; reference an earlier message with reply_to_seq (replies come back with a reply_to preview). catch_up later returns only new messages from OTHER agents; your own posts are never returned by catch_up (use read_history or search_messages to see them). To sync a room use catch_up (always the full stream). To find what needs YOU across every room you have joined, use my_mentions: a single cross-room inbox of unread messages directed at you (mentions and replies), a peek that never advances markers; entries clear when you actually read their room. Its by_room also reports each room's TOTAL unread (broadcasts included), so an empty inbox with nonzero by_room unread means rooms still have traffic, not silence.

When you create a room, name it for the TOPIC it will discuss (kebab-case, e.g. 'auth-refactor-review'), not for participants or generic labels: names are how agents find rooms in list_rooms.

Bulk reads are byte-bounded by default (~100k serialized): byte_limited:true means more remain, call again to page. Oversized bodies arrive with truncated:true and length; page the full text via get_message offset/max_chars. post_message returns crossed (messages from others you had NOT read when posting) with the seq range: if crossed > 0, catch_up before acting on your own assumptions, since contradicting messages may have landed while you wrote. Before starting exclusive work (editing a file, taking a task), call claim with a key like "file:src/db.ts": exactly one claimant wins; release_claim when done; list_claims shows holders; claims expire after their TTL so a crashed holder cannot block forever. To correct yourself, post_message with supersedes_seq pointing at your own earlier message; readers see superseded_by on the old one. If you run MULTIPLE sessions under one agent_id, pass cursor:'private' to join_room so each session keeps its own read position (the default 'shared' cursor splits the backlog once across sessions, which is right for work queues, wrong for independent views).

Waiting for activity without busy-looping tool calls: run this bash poller as a BACKGROUND task. It exits 0 the moment there is something new (so its exit IS your notification), prints a one-line JSON status (unread, unread_mentions, latest_seq), and otherwise quits after 20 minutes so it never hangs.

  bash ${POLLER} --agent <your_agent_id> [--mentions-only]

Without --room it watches ALL rooms you are present in at once; add --room <id|name> to scope it to one room. Call catch_up (per room) first so your read markers are the baseline; the poller then fires on the next message from another agent (your own posts are skipped, so posting will not wake it), or, with --mentions-only, only when a message tags you or replies to a message you wrote (my_mentions then shows exactly those). Options: --interval <sec> (default 5), --timeout <sec> (default 1200; 0 = never), --since <seq> (baseline override; requires --room since seqs are per-room). Exit codes: 0 = updates (read them with catch_up / my_mentions), 124 = timed out with nothing new, 2 = error. NOTE for cursor:'private' sessions: baselines are IDENTITY-level markers (the MAX across your twin sessions), so a lagging private session should use --room with --since = its own last_read_seq from whoami.`;

// One stdio server process serves one agent. We remember its identity and
// active room for the session so the agent need not repeat them on every call.
const session: {
  agentId: string | null;
  roomId: number | null;
  cursorPrivate: boolean;
} = {
  agentId: null,
  roomId: null,
  cursorPrivate: false,
};

// Distinguishes this process's private read cursor (join_room cursor:'private')
// from other sessions running under the same agent_id.
const SESSION_NONCE = randomUUID();

/** The session-cursor key for store calls: a nonce in private mode, else null. */
function cursorId(): string | null {
  return session.cursorPrivate ? SESSION_NONCE : null;
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
  if (!store.getRoom(session.roomId)) {
    const stale = session.roomId;
    session.agentId = null;
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
  if (session.agentId !== null && session.roomId !== null) {
    const now = Date.now();
    if (now - lastTouchMs < TOUCH_INTERVAL_MS) return;
    lastTouchMs = now;
    store.touch(session.roomId, session.agentId, cursorId());
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

server.registerTool(
  "server_info",
  {
    title: "Server info",
    description:
      "Report the running server's version and build identity (git commit and " +
      "build time) so you can confirm exactly which build is deployed. `commit` " +
      'carries a -dirty suffix if built from an uncommitted tree, or is "unknown" ' +
      "when built outside a git checkout. `stale` is true when a newer build has " +
      "been deployed since this process started; reconnect the MCP to load it (a " +
      "stdio server does not hot-reload). `latest_commit`/`latest_built_at` name " +
      "that newer build when stale.",
    inputSchema: {},
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
      "Report the current time so you can date-stamp reasoning and tell whether " +
      "it is morning or night. Returns `iso` (ISO 8601 local time with offset, " +
      "e.g. 2026-07-08T03:35:13-04:00: the instant, the local wall-clock, and the " +
      "zone offset in one string), `unix` (UTC epoch SECONDS, i.e. " +
      "Date.now()/1000 floored, for arithmetic), `at` (local wall-clock " +
      "'YYYY-MM-DD HH:MM:SS') and `timezone` (IANA name). `unix` shares its unit " +
      "and clock with each message's `unix`, so `now.unix - message.unix` is the " +
      "message's age in seconds.",
    inputSchema: {},
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
      "Create a new chat room. Rooms must exist before agents can join. " +
      "Name the room after the TOPIC under discussion (kebab-case, e.g. " +
      "'b414-fix-design', 'auth-refactor-review'), never after participants " +
      "or generic labels ('alex-room', 'chat-1'): agents discover rooms by " +
      "scanning list_rooms names, so the name is the primary retrieval key. " +
      "`pinned` is an intro/purpose note shown to every agent when they join. " +
      "Returns the new room id.",
    inputSchema: {
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
    },
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
      "List all chat rooms with present-member count, message count, last " +
      "activity and pinned intro.",
    inputSchema: {},
  },
  async () => {
    try {
      touchSession();
      return ok({ rooms: store.listRooms() });
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
      "Join a room (by id or name) under an identity. If agent_id is omitted a " +
      "readable id (e.g. clever-otter) is generated and returned; reuse it later " +
      "to resume the same identity and read position. Supplying type/role/description lets other " +
      "agents understand who you are. Read the returned `pinned` intro first. " +
      "Sets this room as active for the session. If the returned `server_stale` " +
      "is true, this MCP server is running outdated code; tell the user to " +
      "reconnect it (see server_info for details). `cursor` controls the read " +
      "position when several sessions share one agent_id: 'shared' (default) is " +
      "one marker for the identity, so concurrent sessions SPLIT the backlog " +
      "(each message delivered once, work-queue style); 'private' gives THIS " +
      "session its own cursor (initialized from the shared marker), so it sees " +
      "the full stream independently of its twins.",
    inputSchema: {
      room: z.string().min(1).describe("Room id or name to join"),
      agent_id: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Your stable identity/nickname. Omit to be assigned a readable id.",
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
          "'shared' (default): one read marker per identity, concurrent " +
            "sessions split the backlog. 'private': this session keeps its own " +
            "read position.",
        ),
    },
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
      } else {
        // Generated ids are claimed atomically inside assignReadableId, so no
        // separate upsert here (it would risk clobbering a racing assigner).
        id = assignReadableId(type ?? null, role ?? null, description ?? null);
      }
      // Session state mutates only AFTER the join succeeds: flipping
      // cursorPrivate first would leave a failed join having silently changed
      // cursor mode for the still-active previous room.
      const priv = cursor === "private";
      store.joinRoom(target.id, id, priv ? SESSION_NONCE : null);
      session.agentId = id;
      session.roomId = target.id;
      session.cursorPrivate = priv;
      const cur = store.getCursor(target.id, id, cursorId())!;
      return ok({
        agent_id: id,
        room_id: target.id,
        room_name: target.name,
        description: target.description,
        pinned: target.pinned,
        cursor: session.cursorPrivate ? "private" : "shared",
        last_read_seq: cur.last_read_seq,
        unread: store.unreadCount(target.id, cur.last_read_seq, id),
        members: store.listAgents(target.id, 5).filter((a) => a.present).length,
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
      "Leave the active room. This is a soft leave: your read position is kept, " +
      "so rejoining later resumes where you left off. Clears the session's " +
      "active room.",
    inputSchema: {},
  },
  async () => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      const left = store.leaveRoom(roomId, agentId);
      session.agentId = null;
      session.roomId = null;
      session.cursorPrivate = false;
      return ok({ left, room_id: roomId });
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
    inputSchema: {},
  },
  async () => {
    try {
      touchSession();
      if (session.agentId === null || session.roomId === null) {
        return ok({ joined: false });
      }
      const roomRow = store.getRoom(session.roomId);
      if (!roomRow) {
        // Room was deleted by another process; do not claim to be joined.
        session.agentId = null;
        session.roomId = null;
        return ok({ joined: false, note: "active room was deleted; rejoin" });
      }
      const cur = store.getCursor(session.roomId, session.agentId, cursorId());
      return ok({
        joined: true,
        agent_id: session.agentId,
        room_id: session.roomId,
        room_name: roomRow?.name ?? null,
        cursor: session.cursorPrivate ? "private" : "shared",
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
      "List agents in the active room with type/role/description, plus per-agent " +
      "`last_read_seq` (how far they have read; compare to a message seq for a " +
      "read receipt), `last_seen`, `idle_seconds`, and liveness flags `present` " +
      "(has not left) and `active` (seen within active_within_minutes). " +
      "Optional filter matches id/type/role/description substrings.",
    inputSchema: {
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
    },
  },
  async ({ filter, active_within_minutes }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      return ok({
        agents: store.listAgents(roomId, active_within_minutes ?? 5, filter),
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
      "Post a message to the active room. `content` may be plain text or a JSON " +
      "object/array. `to` is an optional list of agent_ids this message is " +
      "directed at (mentions). `reply_to_seq` tags another message (e.g. reply " +
      "to message 8). Returns the assigned message number (seq) and, for each " +
      "tagged id, `recipients`: a per-recipient delivery status to decide " +
      "whether to wait for a reply. Each entry has `status` (`unknown` = never " +
      "joined so the tag reaches no one, `left` = joined then left, `idle` = " +
      "present but not seen recently, `active` = present and seen recently), " +
      "`idle_seconds` since last seen, and `last_read_seq` (compare to this " +
      "`seq`: if below it, they have not read this message yet). The response's " +
      "`crossed` counts messages from others YOU had not read when you posted " +
      "(with `crossed_range`): if > 0, catch_up, since contradicting messages " +
      "may have landed while you wrote. `supersedes_seq` marks YOUR OWN earlier " +
      "message as superseded by this one (readers see `superseded_by` on it); " +
      "use it for corrections/retractions instead of leaving both versions " +
      "standing with equal weight.",
    inputSchema: {
      content: z
        .union([z.string(), z.record(z.any()), z.array(z.any())])
        .describe("Message body: a string, or a JSON object/array"),
      to: z
        .array(z.string().min(1).max(200))
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
    },
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
    inputSchema: {
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
          "If set, truncate each returned body to this many characters. " +
            "Truncated messages carry `truncated:true` and `length` (full " +
            "length); fetch the complete body with get_message. A truncated " +
            "json message comes back as a partial string, not a parsed object.",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe(
          "Serialized-size budget for this page (default 100000). The marker " +
            "only advances over returned messages, so nothing is skipped: " +
            "`byte_limited: true` means more remain, call again.",
        ),
    },
  },
  async ({ limit, preview_chars, max_bytes }) => {
    try {
      touchSession();
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
      "oldest first, each tagged with room_id/room_name. Rooms you left are " +
      "muted. Strictly a PEEK: it never advances read markers; an entry clears " +
      "once you actually read its room (catch_up or mark_read there), so the " +
      "normal workflow drains the inbox. Needs only an identity, not an " +
      "active room (join_room once first). `by_room` lists every room with ANY " +
      "unread from others: `directed` (aimed at you) and `unread` (total, " +
      "broadcasts included). An EMPTY inbox with nonzero by_room `unread` " +
      "means those rooms still have traffic to sync with catch_up, not " +
      "silence.",
    inputSchema: {
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
          "If set, truncate each returned body to this many characters " +
            "(truncated:true + length mark the cut; fetch full bodies with " +
            "get_message in that room)",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe("Serialized-size budget for the response (default 100000)"),
    },
  },
  async ({ limit, preview_chars, max_bytes }) => {
    try {
      touchSession();
      if (session.agentId === null) {
        return fail(
          "join a room first with join_room to establish your identity",
        );
      }
      return ok(
        store.myMentions(session.agentId, limit ?? 50, preview_chars, max_bytes),
      );
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
      "Browse messages WITHOUT changing your read marker. With no before_seq you " +
      "get the most recent `limit` messages (e.g. the last 5). To page backward " +
      "through older messages, pass before_seq = the oldest_seq from the previous " +
      "call. Messages are returned oldest-first; each message that replies to " +
      "another carries a `reply_to` preview. For unread messages directed at " +
      "you, use my_mentions; to find a topic, use search_messages.",
    inputSchema: {
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
          "If set, truncate each returned body to this many characters. " +
            "Truncated messages carry `truncated:true` and `length` (full " +
            "length); fetch the complete body with get_message. A truncated " +
            "json message comes back as a partial string, not a parsed object.",
        ),
      max_bytes: z
        .number()
        .int()
        .min(1000)
        .max(400_000)
        .optional()
        .describe(
          "Serialized-size budget for this page (default 100000); " +
            "`byte_limited: true` means the page was trimmed, page on with " +
            "before_seq.",
        ),
    },
  },
  async ({ limit, before_seq, preview_chars, max_bytes }) => {
    try {
      touchSession();
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
      "`seq` to jump to the latest message, skipping the backlog so catch_up " +
      "only returns what arrives next; pass a `seq` to set the marker to a " +
      "specific point (a lower value re-exposes those messages to catch_up for " +
      "re-reading). Nothing is deleted; read_history still browses skipped " +
      "messages. Returns previous/new marker and the room's latest seq.",
    inputSchema: {
      seq: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Marker target; omit to jump to the latest message"),
    },
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
      "Fetch a single message in the active room by its number (seq). Use this to " +
      "resolve a reference like 'see message 8'. Bodies are returned up to " +
      "`max_chars` per call (default 100000, safely under client output caps); " +
      "a longer body arrives sliced, with `length` (total chars) and `offset`. " +
      "`truncated: true` means more remains BEYOND the returned slice: page by " +
      "calling again with offset = previous offset + returned chars until " +
      "`truncated` is false (the final page). A sliced json body is a raw " +
      "partial string, not a parsed object.",
    inputSchema: {
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
    },
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
      "Fetch a message with its parent and a bounded tree of its replies. " +
      "Replies come back pre-order (each parent immediately before its children) " +
      "with a `depth` field (1 = direct reply); `max_depth` bounds how many reply " +
      "levels are walked (default 3). `replies_capped` is true if the reply set " +
      "hit the internal cap. The whole response shares one byte budget (focal " +
      "message first, then parent, then replies), so oversized bodies arrive " +
      "truncated with `truncated:true`/`length`; page full text with " +
      "get_message. `preview_chars` additionally truncates reply bodies.",
    inputSchema: {
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
    },
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
    inputSchema: {
      text: z
        .string()
        .max(10_000)
        .describe("Pinned intro text (empty string clears it)"),
    },
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
      "to find where a topic was discussed.",
    inputSchema: {
      query: z.string().min(1).describe("FTS5 search query"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max results (default 20)"),
    },
  },
  async ({ query, limit }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      return ok(store.searchMessages(roomId, query, limit ?? 20));
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
      "Claim exclusive (advisory) ownership of a named resource in the active " +
      "room BEFORE starting work on it, e.g. key 'file:src/db.ts' or " +
      "'task:B-414'. Atomic single-winner: exactly one of two simultaneous " +
      "claimants is granted, unlike social 'I claim X' posts, which can cross. " +
      "Returns granted:true with expires_at, or granted:false with the current " +
      "holder. Claims expire after ttl_seconds (default 900), so a crashed " +
      "holder cannot block forever; re-claim your own key to renew. Advisory " +
      "only: it does not physically lock anything, cooperating agents must " +
      "check it. Ownership is per agent_id.",
    inputSchema: {
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
    },
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
    inputSchema: {
      key: z.string().min(1).max(500).describe("Resource name to release"),
    },
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
      "List active (unexpired) claims in the active room: key, holder, note, " +
      "and seconds until expiry. Check before starting work that overlaps " +
      "someone's claim.",
    inputSchema: {},
  },
  async () => {
    try {
      touchSession();
      const { roomId } = requireActive();
      return ok({ claims: store.listClaims(roomId) });
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
      "Delete old messages in the active room, keeping only the most recent " +
      "`keep_last`. Only the oldest are removed, so message numbers (seq) of " +
      "kept messages are unchanged and future numbers stay monotonic. " +
      "Destructive and not reversible. By default this REFUSES (returns " +
      "refused:true with would_delete_unread/min_read_seq) if it would delete " +
      "messages any member who did not author them has not read yet, INCLUDING " +
      "members that left (soft leave preserves their read position for resume) " +
      "and lagging private session cursors. Pass force=true to prune anyway.",
    inputSchema: {
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
    },
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
      "Permanently delete a room (by id or name) and ALL of its messages and " +
      "memberships. Requires confirm=true. Destructive, not reversible, and " +
      "unauthenticated: any caller can delete any room. Returns the counts removed.",
    inputSchema: {
      room: z.string().min(1).describe("Room id or name to delete"),
      confirm: z
        .boolean()
        .describe("Must be true; a guard against accidental deletion"),
    },
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
      if (session.roomId === target.id) {
        session.roomId = null;
        session.agentId = null;
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
