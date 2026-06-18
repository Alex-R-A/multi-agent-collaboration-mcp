#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChatStore } from "./db.js";

const store = new ChatStore();

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
  return { agentId: session.agentId, roomId: session.roomId };
}

const server = new McpServer({
  name: "agent-chat-mcp",
  version: "0.1.0",
});

server.registerTool(
  "create_room",
  {
    title: "Create room",
    description:
      "Create a new chat room. Rooms must exist before agents can join. Returns the new room id.",
    inputSchema: {
      name: z.string().min(1).describe("Unique room name"),
      description: z
        .string()
        .optional()
        .describe("What this room is for"),
    },
  },
  async ({ name, description }) => {
    try {
      if (store.resolveRoom(name)) {
        return fail(`a room named "${name}" already exists`);
      }
      const room = store.createRoom(name, description ?? null);
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
      "List all chat rooms with member count, message count and last activity.",
    inputSchema: {},
  },
  async () => {
    try {
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
      "agents understand who you are. Sets this room as active for the session.",
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
      const target = store.resolveRoom(room);
      if (!target) {
        return fail(
          `no room "${room}". Use list_rooms to see options or create_room to make one.`,
        );
      }
      const id = agent_id && agent_id.trim().length > 0 ? agent_id.trim() : randomUUID();
      store.upsertAgent(id, type ?? null, role ?? null, description ?? null);
      store.joinRoom(target.id, id);
      session.agentId = id;
      session.roomId = target.id;
      const membership = store.getMembership(target.id, id)!;
      return ok({
        agent_id: id,
        room_id: target.id,
        room_name: target.name,
        last_read_seq: membership.last_read_seq,
        unread: store.unreadCount(target.id, membership.last_read_seq),
        members: store.listAgents(target.id).length,
      });
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
      if (session.agentId === null || session.roomId === null) {
        return ok({ joined: false });
      }
      const membership = store.getMembership(session.roomId, session.agentId);
      const rooms = store.listRooms().find((r) => r.id === session.roomId);
      return ok({
        joined: true,
        agent_id: session.agentId,
        room_id: session.roomId,
        room_name: rooms?.name ?? null,
        last_read_seq: membership?.last_read_seq ?? 0,
        unread: store.unreadCount(session.roomId, membership?.last_read_seq ?? 0),
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
      "List agents present in the active room with their type/role/description. " +
      "Optional filter matches id/type/role/description substrings.",
    inputSchema: {
      filter: z
        .string()
        .optional()
        .describe("Substring to match against id/type/role/description"),
    },
  },
  async ({ filter }) => {
    try {
      const { roomId } = requireActive();
      return ok({ agents: store.listAgents(roomId, filter) });
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
      "object/array. Optionally set reply_to_seq to tag another message " +
      "(e.g. reply to message 8). Returns the assigned message number (seq).",
    inputSchema: {
      content: z
        .union([z.string(), z.record(z.any()), z.array(z.any())])
        .describe("Message body: a string, or a JSON object/array"),
      reply_to_seq: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("seq of a message in this room you are replying to"),
    },
  },
  async ({ content, reply_to_seq }) => {
    try {
      const { agentId, roomId } = requireActive();
      if (reply_to_seq !== undefined && !store.getMessage(roomId, reply_to_seq)) {
        return fail(`reply_to_seq ${reply_to_seq} does not exist in this room`);
      }
      const isText = typeof content === "string";
      const body = isText ? (content as string) : JSON.stringify(content);
      const format = isText ? "text" : "json";
      const { seq } = store.postMessage(
        roomId,
        agentId,
        body,
        format,
        reply_to_seq ?? null,
      );
      return ok({ seq, format, reply_to_seq: reply_to_seq ?? null });
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
      "Return messages posted since you last read (seq > your last_read marker), " +
      "oldest first, and ADVANCE your read marker. The system remembers your " +
      "position, so call this again later to get only what is new. Use limit to " +
      "page through a large backlog; `remaining` tells you how many are still unread.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max messages to return this call (default 50)"),
    },
  },
  async ({ limit }) => {
    try {
      const { agentId, roomId } = requireActive();
      const result = store.catchUp(roomId, agentId, limit ?? 50);
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
      "call. Messages are returned oldest-first.",
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
    },
  },
  async ({ limit, before_seq }) => {
    try {
      const { roomId } = requireActive();
      return ok(store.readHistory(roomId, limit ?? 50, before_seq));
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
      const { roomId } = requireActive();
      const msg = store.getMessage(roomId, seq);
      if (!msg) return fail(`no message ${seq} in this room`);
      return ok(msg);
    } catch (e) {
      return fail(asMessage(e));
    }
  },
);

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
