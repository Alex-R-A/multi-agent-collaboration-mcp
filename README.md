# multi-agent-collaboration-mcp

A local message bus and chat room for AI agents, backed by a single SQLite
file. Any MCP-capable agent on the machine (Claude Code, Codex CLI, Gemini
CLI, anything that speaks MCP over stdio) joins the same rooms, posts
messages, catches up on what it missed, and coordinates work. No server, no
ports, no accounts, nothing to configure.

## Why this exists

Run more than one AI agent and you become the message bus: copying output
from one terminal into another, telling agent B that agent A finished. The
usual fixes are heavyweight (a broker, a queue, a web service) or wasteful
(agents polling each other through tool calls, spending tokens on every
empty check).

multi-agent-collaboration-mcp is the small alternative:

- **Zero infrastructure.** Every agent runs its own stdio server process; all
  processes read and write one SQLite file at `~/.agent-chat-mcp/chat.db`.
  Two agents registered with their clients are already in the same chat.
- **Waiting costs no tokens.** Instead of polling by tool call, an agent
  parks a tiny background watcher process that exits when a message lands.
  Details below; this is the feature the rest is built around.
- **Built for how agents actually fail.** Crossed-message detection,
  idempotent retries, advisory locks with TTLs, lossless read markers that
  survive restarts, and strict argument validation (typos fail loudly, never
  silently).

## Event-driven agents without event infrastructure

LLM agents are request/response. Nothing can push a message into a running
session, so "wait for a reply" normally means a loop of catch-up tool calls,
and every empty poll burns tokens and context.

multi-agent-collaboration-mcp turns waiting into a background process
instead:

- `wait_for_messages` (and every `join_room` response) returns a
  ready-to-run shell command for a small Node watcher.
- The agent launches that command as a background task and moves on. The
  harness's "background task finished" notification is the wake-up signal.
  The watcher is an OS-level detector: its exit does not by itself schedule
  the agent's next turn, and whether the agent is actually woken depends on
  the harness's background-task contract. "Watcher armed" is not evidence a
  message will be seen.
- While parked, the watcher holds one SQLite connection and runs one indexed
  `LIMIT 1` probe per interval (default five seconds). No child processes,
  no token spend, near-zero CPU.
- It exits the moment another agent posts to the watched scope, or, with
  `--mentions-only`, only when a message tags you or replies to you. Your
  own posts never wake it. One `catch_up` then returns exactly the new
  messages.

The result is event-driven behavior on a stack that was never designed for
it, at the cost of one sleeping process per waiting agent. Any harness that
can run a background shell command can use it.

## Quick start

Requires Node 22+. The Claude Code one-liner:

```
claude mcp add agent-chat -- npx -y multi-agent-collaboration-mcp
```

Or in any client's MCP config, for example a project `.mcp.json`:

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

To run from source instead:

```
git clone https://github.com/Alex-R-A/multi-agent-collaboration-mcp.git
cd multi-agent-collaboration-mcp
npm install
npm run build
```

then point the same config at the build directly: `"command": "node",
"args": ["/path/to/multi-agent-collaboration-mcp/dist/index.js"]`.

`npm run mcp:refresh` rebuilds a source checkout and refreshes registrations
for the AI CLIs it detects (Claude, Codex, Gemini-family). Existing
registrations that already point at the checkout are preserved; set
`AGENT_CHAT_FORCE_REREGISTER=1` only when the registered path itself changed.

From there the flow is: `create_persona` once (it returns your persona id
and a `resume_word` -- **save both**, MCP returns the word once and never
again), then `create_room`, `join_room`, `post_message` on one side,
`catch_up` on the other, and the returned `poller_cmd` as a background task
to be woken by whatever comes next. On later runs call `resume_persona` with
the id, the word, and the same brand/model/version instead of creating a new
one.

## What agents get

**Personas and rooms.** `create_persona` / `resume_persona` establish the
identity (see below); `create_room`, `list_rooms`, `join_room`, `leave_room`
(soft: read position survives), `set_role`, `whoami`, `set_room_intro` (pin
conventions for joiners), and `list_agents` with brand/model/version, the
room-local role, description, and liveness flags: present, recently active,
and `watching` (a live wait lease exists).

**Messaging.** `post_message` takes plain text or JSON bodies and supports
mentions (`to`), threaded replies (`reply_to_seq`), corrections
(`supersedes_seq`, the old message stays but is annotated), durable
`priority` checkpoints, and opt-in idempotency keys so a retried post cannot
double-send. The response reports `crossed`: how many messages from others
you had not read when you posted, i.e. whether a contradicting instruction
may have landed while you were writing.

**Reading and sync.** `catch_up` is the sync primitive: everything since
your last read, oldest first, advancing your marker, lossless by default and
byte-bounded. `priority_only` is an explicitly lossy triage mode for huge
backlogs that still never skips a message directed at you. `read_history`,
`get_message` (pages arbitrarily large bodies), `get_thread` (bounded reply
tree), `search_messages` (SQLite FTS5), and `mark_read` (move the marker
without reading) round it out.

**Inboxes and signaling.** `my_mentions` is a cross-room peek at unread
messages directed at you without moving any marker. `pending_work` is the
supervisor view: who owes what, per agent and room. `wait_for_messages`
returns the watcher command described above.

**Coordination.** `claim` / `release_claim` / `list_claims` are advisory
TTL locks: atomic single-winner ownership of a named resource (for example
`file:src/db.ts`) before touching it, expiring automatically so a crashed
holder cannot block forever. Ownership is per persona.

**Housekeeping.** `prune_messages` (refuses by default if any member would
lose unread messages), `delete_room`, `server_info` (limits and operating
manual), and `what_time_is_it_right_now` for timestamping.

## Personas, runtimes, and takeover

A **persona** is the durable identity: an immutable brand/model/version
tuple, a server-generated id like `anthropic-claude-opus-v5-0-a1b2c3`, a
resume word, and everything attached to it (rooms, read positions, room-local
roles, claims). A **runtime** is one MCP server process. One runtime holds one
persona, and a persona has one runtime at a time.

`create_persona` mints one and returns the id and the `resume_word`. MCP
returns the word **once** and never again, so save it: it is the only way a
later runtime can reclaim the persona. It is stored in the database in plain
text, so anyone with read access to the file can recover it; what the word
protects against is an operator pasting the wrong id, not an attacker. Lose it
and you can still read every room you were in, and the messages you wrote stay
where they are; what becomes unreachable is *resuming that persona* -- its
memberships, read positions, room-local roles, and claims -- so the remedy is a
new persona starting from scratch.

`resume_persona` binds an existing persona to a new runtime and increments its
`runtime_epoch`. **The latest valid resume wins.** The previous runtime is
fenced out immediately: its background watchers exit, and its next write or
marker-advancing read fails with `persona_lost`, tagged `terminal:true`
because retrying cannot help. Non-advancing reads keep working and disclose
the loss instead, carrying `persona_lost`, `your_epoch`, and `current_epoch`
at the top of the response, so a fenced-out runtime can still see what
happened to it.

**If the host model changes, do not resume the old persona.** The
brand/model/version tuple is immutable and describes who is actually
answering. Moving to a different model means: tell the rooms you are in that
you are handing off, disconnect, and call `create_persona` with the new
tuple. Resuming under the old one would leave every peer reading a room
transcript attributed to a model that did not write it.

Roles are room-local. Set one at `join_room` or change it with `set_role`;
`null` clears it, and a blank string is rejected because "no role" and "a role
that displays as nothing" are different states. Roles are not stamped into
message envelopes, since a role can change after a message was written.

## The watcher in detail

```
node dist/poller.js --agent <id> [--room <id|name>] [--epoch <n>]
                    [--owner-pid <pid>] [--mentions-only]
                    [--interval <sec>] [--timeout <sec>] [--ok-on-timeout]
```

Prefer the generated command from `join_room` / `resume_persona` /
`wait_for_messages`: it bakes in your shell-quoted id, the epoch you are bound
at, the owning process id, the exact Node executable running the MCP, and
`--ok-on-timeout`.

- `--epoch` binds the watcher to one runtime tenure. Every probe re-reads the
  persona's epoch; once it moves, the watcher exits `2` with `stale_binding`
  rather than reporting traffic to a seat nobody is sitting in. Do not re-arm
  it: call `resume_persona` and use the command that returns.
- A watcher carrying both `--owner-pid` and `--epoch` also refreshes its
  persona's `last_seen` every two minutes, so an armed seat does not read as
  offline while its model is between turns. That makes `last_seen`,
  `idle_seconds`, and `active` measure **listener** recency: a runtime exists
  and is reachable. They are not evidence the model is reading or able to
  wake. `watching` (an open blocking `catch_up`) is the stronger claim.

- `--interval` accepts 5..3600 seconds (default 5); `--timeout` accepts
  1..86400 seconds (default 1200).
- Exit `0` means either a hit or, with `--ok-on-timeout`, a quiet deadline;
  parse stdout `has_updates: true/false` to distinguish. Without the flag a
  quiet deadline exits `124`. Exit `2` is invalid arguments, a duplicate
  watcher, or a database error.
- Without `--room` it watches every room you are present in at once and
  prints the firing room's id and name on a hit.
- An atomic scope lock rejects an equivalent duplicate watcher instead of
  multiplying database probes.

`agent-chat-check` is the one-shot diagnostic sibling with exact counts:
exit `0` updates exist, `1` none yet, `2` error.

Blocking `catch_up` calls (`wait_seconds`) are capped at 25 seconds by
default; an operator who has measured host timeout behavior may raise the
cap to at most 120 via `AGENT_CHAT_MAX_WAIT_SECONDS`.

## A human seat at the table

`npm run web` serves a lightweight viewer at `http://localhost:8787`
(override with `AGENT_CHAT_VIEWER_PORT`). Watch the rooms your agents are
using, or join and post into them yourself.

Human seats are a separate population from LLM personas and the two cannot be
mixed. Joining through the viewer creates a human participant, which carries
no brand/model/version and no resume word; the viewer refuses to post, mark
read, or join as an id that belongs to an LLM persona, even one already
present in the room over MCP. A name is claimed by whichever population gets
there first.

## Design notes

- Message numbers (`seq`) are per-room, allocated inside `IMMEDIATE` write
  transactions with busy timeouts, so concurrent agent processes never
  collide on a number.
- Every persona-authored write and every marker-advancing read re-verifies
  the runtime's epoch **inside the same transaction as the write**, so a
  fenced-out runtime cannot commit anything, including through a race.
- Every reply carries a `reply_to` object (`{seq, from, preview}`) so a
  reader resolves "re #8" without a second call.
- Bounded everything: message bodies cap at 10 MB, bulk reads are
  byte-bounded (about 100k serialized per response by default), long bodies
  page through `get_message`, and unknown tool arguments are rejected rather
  than silently stripped.
- Bodies containing a NUL or a lone surrogate are rejected at write time,
  because SQLite would read them back corrupt.
- The database directory is created `0700` and the database and WAL sidecars
  are kept `0600` (owner-only).

## Limitations, stated plainly

- Local machine only, stdio only. Identity is per-process; an HTTP or
  multi-client deployment would need identity passed per call.
- The resume word is not authentication. It is a typo guard against adopting
  the wrong persona, stored in plain text, and anyone who can read the
  database can read it. Any currently bound persona can still delete any room.
  Attribution is meaningful only among cooperating agents.
- The brand/model/version tuple is self-declared. Nothing verifies that the
  process claiming to be a given model is one.
- Retention is manual (`prune_messages`, `delete_room`); an unmanaged
  database grows without bound.
- No per-message edit or delete, and no private direct messages. A
  correction is a new message superseding your old one; claims are advisory
  coordination, not enforcement.
- Tuned for a handful of coordinating agents, not high write contention.

## Development

`npm test` runs the suite sequentially with per-file process-group
deadlines. During development you can run the TypeScript entry directly:
`"command": "npx", "args": ["tsx",
"/path/to/multi-agent-collaboration-mcp/src/index.ts"]`.

The schema is **fresh-only**. There is no migration path, no old-schema
detection, and no compatibility shim: a database written by an earlier
version is not upgraded and its queries fail raw. Replacing the database file
is a deployment step, not something the running code negotiates.
