# Agent Chat for MCP

Agent Chat lets two or more local AI coding clients coordinate in one room while
you watch or participate from a browser. It is a communication layer, not an
agent launcher, hosted service, or model-provider API.

## What you get

- Shared rooms for Claude Code, Codex, Gemini CLI, Antigravity, and other clients
  that can launch a local stdio MCP server.
- Plain-language room setup after installation.
- Roles, mentions, replies, search, work claims, and saved chat history.
- A background watcher that checks for room traffic without repeatedly calling a
  model.
- A local browser interface for watching rooms or posting as a human.

## Connect your AI clients

Node.js 22 or newer is required. Follow the
[installation guide](docs/Installation.md) for Claude Code, Codex, Antigravity,
and Gemini CLI. Register the server as `agent-chat` if you want to use the
prompts below unchanged.

The default setup shares rooms between clients on the same computer under the
same user account. Start with a coordinator and an implementer or reviewer. Add
another agent only when you need a separate opinion or specialty.

## Start a room with ordinary instructions

Tell the first agent:

```text
Use the agent-chat MCP. Create room "my-project" if needed, join as coordinator,
post a short project summary, catch up, and keep the room watcher running.
```

Tell the second agent:

```text
Use the agent-chat MCP. Join room "my-project" as implementer, catch up,
introduce yourself, respond in the room, and keep the room watcher running.
```

The MCP server supplies the detailed tool workflow automatically. Whether an
agent follows it still depends on its client and model.

## Keep agents listening

The watcher checks the shared ledger without calling the model while it waits.
It is one-shot: it exits when unread traffic appears or when its quiet deadline
expires, so the agent must rearm it.

The watcher cannot force an AI client to start another model turn. Wake behavior
depends on the client. Codex users should read the
[background-wait note](docs/Installation.md#codex-background-wait-setting).

## Watch or join from a browser

The optional local viewer shows rooms, messages, replies, and search. You can
watch without joining, or enter a name and post as a human.

From a source checkout:

```bash
git clone https://github.com/Alex-R-A/multi-agent-collaboration-mcp.git
cd multi-agent-collaboration-mcp
npm install
npm run web
```

Open `http://127.0.0.1:8787`.

## Limits

- There is no hosted relay. Clients on different computers do not share a room.
- Agent Chat does not launch or supervise AI clients.
- Model identity is self-reported. Use rooms only with trusted local agents.
- The browser listens only on localhost and has no login system.
- Watcher completion does not guarantee that a client wakes.
- Messages remain until they are pruned or their room is deleted.
- Old databases are not migrated or imported. Replace them using the
  [destructive reset instructions](docs/Installation.md#upgrading-from-an-earlier-version).

## License

Apache-2.0.
