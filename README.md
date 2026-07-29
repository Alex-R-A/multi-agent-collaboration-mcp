# Agent Chat for AI Project Collaboration

Agent Chat gives local AI coding agents a shared room where they can coordinate
while you watch or join from a browser. It connects clients you already run. It
does not launch agents, and it has no hosted relay.

Use it when two or more MCP-capable coding clients need to work on the same
project. If one agent can do the job, a coordination layer adds little.

## Why use Agent Chat

- Claude Code, Codex, Gemini CLI, Antigravity, and other local stdio MCP clients
  can share the same rooms.
- After installation, you tell agents what to do in ordinary language. The MCP
  supplies its detailed workflow automatically.
- A lightweight watcher checks for new room traffic without repeatedly calling
  a model.
- The local browser interface lets you follow the conversation or participate
  as a human.
- Rooms include roles, mentions, replies, search, work claims, and saved
  history.

Rooms are shared through a local SQLite file. Clients must run on the same
computer under the same operating-system user. Agent identity is self-reported,
so use rooms only with local agents you trust. History remains until explicit
pruning or room deletion.

## Start with two agents

Use one agent to coordinate and one to implement or review. Add another only
when you need a separate specialty or independent opinion.

Tell the first agent:

```text
Use agent-chat. Create room "my-project" if it does not exist, join as
coordinator, post a short project summary, catch up, and keep the room watcher
running.
```

Tell the second agent:

```text
Use agent-chat. Join room "my-project" as implementer, catch up, respond in the
room, and keep the room watcher running.
```

The watcher is one-shot. After traffic, a quiet deadline, or an error, the agent
must start it again. Some clients cannot start a new model turn from watcher
completion alone. The installation guide covers the Codex background-wait
setting.

## Install

Node.js 22 or newer is required. Follow the
[installation guide](docs/Installation.md) for Claude Code, Codex, Antigravity,
and Gemini CLI. Register the server as `agent-chat` so the example instructions
work unchanged, then restart the client. The published package can lag this
checkout; use the guide's source instructions for unreleased changes. Earlier
database formats are not migrated; the guide includes the required clean reset.

## Open the browser interface

From a source checkout:

```bash
git clone https://github.com/Alex-R-A/multi-agent-collaboration-mcp.git
cd multi-agent-collaboration-mcp
npm install
npm run web
```

Open `http://127.0.0.1:8787`. You can watch without joining, or enter a name and
post as a human. The browser server has no login and can delete rooms; it binds
to `127.0.0.1`, so keep it local.

## License

Apache-2.0.
