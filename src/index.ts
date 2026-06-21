#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

Typical flow: list_rooms -> join_room (capture the returned agent_id if you did not supply one; read the pinned intro) -> list_agents to see who is present -> catch_up (consumes the backlog and advances your read marker) or read_history (browse without advancing) -> post_message. Tag participants with the "to" list; reference an earlier message with reply_to_seq (replies come back with a reply_to preview). catch_up later returns only new messages from OTHER agents; your own posts are never returned by catch_up (use read_history or search_messages to see them).

Waiting for activity without busy-looping tool calls: run this bash poller as a BACKGROUND task. It exits 0 the moment there is something new (so its exit IS your notification), prints a one-line JSON status (unread, unread_mentions, latest_seq), and otherwise quits after 20 minutes so it never hangs.

  bash ${POLLER} --room <id|name> --agent <your_agent_id> [--mentions-only]

Call catch_up first so your read marker is the baseline; the poller then fires on the next message from another agent (your own posts are skipped, so posting will not wake it), or, with --mentions-only, only when a message tags you. Options: --interval <sec> (default 5), --timeout <sec> (default 1200; 0 = never), --since <seq> (baseline override). Exit codes: 0 = updates (read them with catch_up), 124 = timed out with nothing new, 2 = error.`;

// One stdio server process serves one agent. We remember its identity and
// active room for the session so the agent need not repeat them on every call.
const session: { agentId: string | null; roomId: number | null } = {
  agentId: null,
  roomId: null,
};

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

/** Mark the active agent as alive on any tool invocation. */
function touchSession(): void {
  if (session.agentId !== null && session.roomId !== null) {
    store.touch(session.roomId, session.agentId);
  }
}

const server = new McpServer(
  {
    name: "agent-chat-mcp",
    version: "0.4.4",
  },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  "create_room",
  {
    title: "Create room",
    description:
      "Create a new chat room. Rooms must exist before agents can join. " +
      "`pinned` is an intro/purpose note shown to every agent when they join. " +
      "Returns the new room id.",
    inputSchema: {
      name: z.string().min(1).describe("Unique room name"),
      description: z.string().optional().describe("What this room is for"),
      pinned: z
        .string()
        .optional()
        .describe("Pinned intro/conventions shown to joiners"),
    },
  },
  async ({ name, description, pinned }) => {
    try {
      touchSession();
      if (store.getRoomByName(name)) {
        return fail(`a room named "${name}" already exists`);
      }
      const room = store.createRoom(name, description ?? null, pinned ?? null);
      return ok({ room_id: room.id, name: room.name });
    } catch (e) {
      return fail(asMessage(e));
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
      "UUID is generated and returned; reuse it later to resume the same " +
      "identity and read position. Supplying type/role/description lets other " +
      "agents understand who you are. Read the returned `pinned` intro first. " +
      "Sets this room as active for the session.",
    inputSchema: {
      room: z.string().min(1).describe("Room id or name to join"),
      agent_id: z
        .string()
        .optional()
        .describe("Your stable identity/nickname. Omit to be assigned a UUID."),
      type: z
        .string()
        .optional()
        .describe("Agent type, e.g. 'claude', 'codex', 'gpt'"),
      role: z
        .string()
        .optional()
        .describe("Your role in the room, e.g. 'reviewer', 'planner'"),
      description: z
        .string()
        .optional()
        .describe("Short description of who you are / what you do"),
    },
  },
  async ({ room, agent_id, type, role, description }) => {
    try {
      touchSession();
      const target = store.resolveRoom(room);
      if (!target) {
        return fail(
          `no room "${room}". Use list_rooms to see options or create_room to make one.`,
        );
      }
      const id =
        agent_id && agent_id.trim().length > 0 ? agent_id.trim() : randomUUID();
      store.upsertAgent(id, type ?? null, role ?? null, description ?? null);
      store.joinRoom(target.id, id);
      session.agentId = id;
      session.roomId = target.id;
      const membership = store.getMembership(target.id, id)!;
      return ok({
        agent_id: id,
        room_id: target.id,
        room_name: target.name,
        description: target.description,
        pinned: target.pinned,
        last_read_seq: membership.last_read_seq,
        unread: store.unreadCount(target.id, membership.last_read_seq, id),
        members: store.listAgents(target.id, 5).filter((a) => a.present).length,
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
      const membership = store.getMembership(session.roomId, session.agentId);
      return ok({
        joined: true,
        agent_id: session.agentId,
        room_id: session.roomId,
        room_name: roomRow?.name ?? null,
        last_read_seq: membership?.last_read_seq ?? 0,
        unread: store.unreadCount(
          session.roomId,
          membership?.last_read_seq ?? 0,
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
      "`seq`: if below it, they have not read this message yet).",
    inputSchema: {
      content: z
        .union([z.string(), z.record(z.any()), z.array(z.any())])
        .describe("Message body: a string, or a JSON object/array"),
      to: z
        .array(z.string().min(1))
        .max(100)
        .optional()
        .describe("agent_ids this message is directed at (mentions); max 100"),
      reply_to_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("seq of a message in this room you are replying to"),
    },
  },
  async ({ content, to, reply_to_seq }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      if (reply_to_seq !== undefined && !store.getMessage(roomId, reply_to_seq)) {
        return fail(`reply_to_seq ${reply_to_seq} does not exist in this room`);
      }
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
      const { seq } = store.postMessage(
        roomId,
        agentId,
        body,
        isText ? "text" : "json",
        mentions,
        reply_to_seq ?? null,
      );
      return ok({
        seq,
        format: isText ? "text" : "json",
        to: mentions,
        reply_to_seq: reply_to_seq ?? null,
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
      "last_read marker), oldest first. Your own messages are never returned here " +
      "(use read_history/search_messages to see them). By default ADVANCES your " +
      "read marker so the next call only returns what is new; `remaining` reports " +
      "how many are still unread. Set mentions_me=true to see only messages " +
      "directed at you; in that mode this is a PEEK that does NOT advance the " +
      "marker (so broadcasts are not skipped). To page through more unread " +
      "mentions than `limit`, call again with after_seq = the `next_after_seq` " +
      "from the previous response until `remaining` is 0.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max messages to return this call (default 50)"),
      mentions_me: z
        .boolean()
        .optional()
        .describe("Only messages whose `to` includes you (peek, no advance)"),
      after_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cursor for mentions_me paging: pass the prior next_after_seq"),
    },
  },
  async ({ limit, mentions_me, after_seq }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      const result = store.catchUp(
        roomId,
        agentId,
        limit ?? 50,
        mentions_me ? agentId : undefined,
        after_seq,
      );
      return ok(result);
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
      "call. Set mentions_me=true to list only messages directed at you (across " +
      "all of history, read or not). Messages are returned oldest-first; each " +
      "message that replies to another carries a `reply_to` preview.",
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
      mentions_me: z
        .boolean()
        .optional()
        .describe("Only messages whose `to` includes you"),
    },
  },
  async ({ limit, before_seq, mentions_me }) => {
    try {
      touchSession();
      const { agentId, roomId } = requireActive();
      return ok(
        store.readHistory(
          roomId,
          limit ?? 50,
          before_seq,
          mentions_me ? agentId : undefined,
        ),
      );
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
      "resolve a reference like 'see message 8'.",
    inputSchema: {
      seq: z.number().int().positive().describe("Message number to fetch"),
    },
  },
  async ({ seq }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const msg = store.getMessage(roomId, seq);
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
      "Fetch a message together with its parent (the message it replied to, if " +
      "any) and its direct replies, oldest first. Makes reply_to tags navigable.",
    inputSchema: {
      seq: z.number().int().positive().describe("Message number to expand"),
    },
  },
  async ({ seq }) => {
    try {
      touchSession();
      const { roomId } = requireActive();
      const thread = store.getThread(roomId, seq);
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
      text: z.string().describe("Pinned intro text (empty string clears it)"),
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
      return ok({ matches: store.searchMessages(roomId, query, limit ?? 20) });
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
      "members that left (soft leave preserves their read position for resume). " +
      "Pass force=true to prune anyway.",
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
