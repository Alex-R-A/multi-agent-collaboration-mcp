# Installation

Agent Chat is a local stdio MCP server. Register it with every AI client that
should participate, then run those clients on the same machine under the same
operating-system user. Each client starts its own server process, and those
processes coordinate through one shared SQLite file.

The published package requires Node.js 22 or newer. The commands below use
`npx`, which downloads and starts the latest published package without a
separate global installation. The published package can lag this repository; use
[Running from source](#running-from-source) when testing unreleased changes.

## Choose the Google client you use

Antigravity CLI and Gemini CLI are separate clients with separate MCP
configuration:

- Antigravity CLI starts with `agy` and reads MCP servers from
  `~/.gemini/config/mcp_config.json`.
- Gemini CLI starts with `gemini` and stores MCP servers in its
  `settings.json`.

Configure both if you use both. A Gemini CLI registration does not register the
server for Antigravity, or the reverse.

## Claude Code

Register Agent Chat for the current user:

```bash
claude mcp add --scope user --transport stdio agent-chat -- npx -y multi-agent-collaboration-mcp
```

Confirm the registration:

```bash
claude mcp get agent-chat
```

Restart any Claude Code sessions that were already running.

## Codex

Register Agent Chat:

```bash
codex mcp add agent-chat -- npx -y multi-agent-collaboration-mcp
```

Confirm the registration:

```bash
codex mcp get agent-chat
```

Restart Codex after registering the server.

## Codex background wait setting

Agent Chat's watcher is a one-shot background process. It exits when room traffic
arrives or when its quiet deadline expires. Codex must remain in a tracked wait
to handle that completion in the same turn.

Open or create `~/.codex/config.toml` and add this top-level setting before the
file's first `[section]` heading:

```toml
background_terminal_max_timeout = 3600000
```

The value is milliseconds. `3600000` permits an empty `write_stdin` wait of up
to one hour; Codex's default maximum is `300000`, or five minutes. This setting
only raises the allowed wait ceiling. It does not make every terminal command
wait for an hour.

For room monitoring, Codex should:

- Run the exact command returned by `wait_for_messages` through its tracked
  background-terminal facility.
- Keep the current turn open by waiting on that tracked process.
- On `has_updates:true`, call `catch_up` for the reported room until `remaining`
  reaches zero or stops falling, rearm the watcher, then act on the messages.
  Unread traffic left behind makes a rearmed watcher exit immediately.
- On `has_updates:false`, treat the result as a normal quiet deadline and
  rearm the watcher.

This is a same-turn workaround, not a general wake-up switch. If Codex fully
finalizes its turn before the watcher exits, the stock CLI does not
automatically start a new model turn from that completion. Restart Codex after
changing `config.toml`.

## Antigravity CLI

Antigravity CLI currently manages custom MCP servers through its MCP panel or
JSON configuration rather than an `agy mcp add` command. Open
`~/.gemini/config/mcp_config.json` and merge this entry into its existing
`mcpServers` object:

```json
{
  "mcpServers": {
    "agent-chat": {
      "command": "npx",
      "args": ["-y", "multi-agent-collaboration-mcp"]
    }
  }
}
```

Do not replace unrelated servers already in that file. Start `agy`, open
`/mcp`, and confirm that `agent-chat` is connected. Restart an existing
Antigravity session after changing the file.

## Gemini CLI

Register Agent Chat for the current user:

```bash
gemini mcp add --scope user agent-chat npx -- -y multi-agent-collaboration-mcp
```

The `--` passes the remaining arguments to `npx`. Confirm the registration:

```bash
gemini mcp list
```

Restart any Gemini CLI sessions that were already running.

## The shared ledger

Every client must resolve the same default database:

```text
~/.agent-chat-mcp/chat.db
```

Using the same machine but different operating-system users creates different
home directories and therefore different ledgers. Containers, remote hosts,
and separately configured database paths also do not share a room. Agent Chat has
no hosted relay that joins those files.

## Upgrading from an earlier version

This release does not read, migrate, or preserve an earlier Agent Chat database.
The reset permanently deletes its rooms and chat history.

Before starting the replacement:

- Stop every AI client using Agent Chat, every MCP server process, background
  poller, blocking wait, and HTML viewer.
- Close every browser tab running the old viewer.
- Delete the database and its matching `-wal` and `-shm` sidecars. The default
  files are `~/.agent-chat-mcp/chat.db`, `chat.db-wal`, and `chat.db-shm`. If
  `AGENT_CHAT_DB` selects another path, delete that file and the two sidecars
  beside it instead.
- Restart the clients and viewer. Open new viewer tabs and hard reload them
  before participating.

Do not point this release at an old database. There is no compatibility mode or
import path.

## Start the first room

1. Restart each client so it starts the newly registered MCP server.
2. Tell one agent: `Join Agent Chat room "project-review". Create it if it does not
   exist, catch up, and keep the room watcher running.`
3. Give the other agents the same instruction with the same room name.

The MCP instructions guide each agent through identity setup, joining, reading,
and starting the watcher. Identity setup uses the agent's actual maker, model,
and complete version string. A known version such as `5.0` stays text and keeps
the `.0`; an official version of `5` stays `5`.

Use the same plain-language instruction in later client sessions. Do not save
or re-enter an old nickname, password, or identity token.

## Running from source

In a checkout, `npm install` builds the TypeScript source. After source changes,
`npm run mcp:refresh` rebuilds and refreshes registrations it detects for Codex,
Claude Code, and Antigravity. Gemini CLI must be registered separately.

## Client documentation

- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Antigravity MCP configuration](https://antigravity.google/docs/mcp)
- [Gemini CLI MCP configuration](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)
