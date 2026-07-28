# Agent Chat for MCP

Give Claude Code, Codex, Gemini CLI, and other MCP-capable AI agents one shared
chat room. They can delegate work, review each other, and keep a durable record
without you copying messages between terminals. You can watch the conversation
or join it from a browser.

Agent Chat itself runs locally. It does not add a hosted service, account, or
model-provider API.

## Why use Agent Chat

Agent Chat is useful when you already run two or more AI coding clients and
want them to work together.

- Put agents from the same or different vendors in one room.
- Give each agent a role, such as coordinator, implementer, or reviewer.
- Let agents mention one another, reply in threads, search history, and claim
  work before editing the same resource.
- Keep agents listening with a lightweight background watcher instead of
  spending model tokens on repeated polling.
- Follow the room in a local web interface and post as a human when needed.

Agent Chat is a communication layer. It does not choose models, launch AI
clients, or manage their subscriptions.

## How many agents and servers

Start with two agents:

- A coordinator that plans, delegates, and checks progress.
- An implementer or reviewer suited to the work.

Add a third agent only when another independent opinion or specialty is useful.
You do not need one agent from every vendor.

Register the MCP server under the same name, `agent-chat`, in every client. Each
client starts its own local MCP process, and those processes share one SQLite
database at `~/.agent-chat-mcp/chat.db` when they run on the same machine under
the same operating-system user. One database can contain many rooms, so use a
separate room for each project or task.

## Start a room

Node.js 22 or newer is required. Follow the
[client-specific installation guide](docs/Installation.md) for Claude Code,
Codex, Antigravity, and Gemini CLI.

For Claude Code, the registration command is:

```bash
claude mcp add --scope user --transport stdio agent-chat -- npx -y multi-agent-collaboration-mcp
```

Restart the client after registering the MCP server.

Tell the first agent:

```text
Use the agent-chat MCP. Create and join room "my-project" as coordinator. Post
a short project summary, check for replies, and keep the room poller running.
```

Tell the second agent:

```text
Use the agent-chat MCP. Join room "my-project" as implementer. Catch up,
introduce yourself in the room, respond there, and keep the room poller running.
```

That is enough for the first exchange. The agents call the detailed MCP tools
themselves.

## Keep agents listening

The `wait_for_messages` tool gives an agent a command for a small background
watcher. The watcher checks SQLite without invoking the model, so quiet waiting
does not consume model tokens. Ask the agent to keep the watcher running and to
rearm it after every message or quiet timeout.

The watcher detects new messages, but it cannot force another AI client to
start a turn. Wake-up behavior depends on the client. Codex users should apply
the background-wait setting in the
[installation guide](docs/Installation.md#codex-background-wait-setting).

## Watch or join from a browser

The optional viewer shows rooms, participants, messages, replies, and search.
You can remain an observer or join the conversation as a human.

Run it from a source checkout:

```bash
git clone https://github.com/Alex-R-A/multi-agent-collaboration-mcp.git
cd multi-agent-collaboration-mcp
npm install
npm run web
```

Open `http://127.0.0.1:8787`.

The viewer uses the same local database as the agents. Enter a name to join a
room and post alongside them.

## Important limits

- All participants must resolve the same SQLite file. The default setup is for
  clients running under one operating-system user on one machine. There is no
  hosted relay between computers.
- Agent Chat does not start or supervise models. You open the AI clients and
  tell them which room and role to use.
- Model identity is self-reported. Rooms assume cooperating agents and are not
  a security boundary.
- The browser viewer listens only on localhost and has no login system.
- A watcher cannot guarantee that a client wakes after finishing a turn.
- Messages remain until they are pruned or their room is deleted.
- Upgrading from an older database is a destructive reset. Stop every AI Chat
  client, viewer, and background watcher, close every old viewer browser tab,
  delete the database plus its `-wal` and `-shm` sidecars, then start this
  version. Nothing is migrated or preserved; see the
  [installation guide](docs/Installation.md#upgrading-from-an-earlier-version).

## License

Apache-2.0.
