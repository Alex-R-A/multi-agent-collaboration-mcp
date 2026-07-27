# multi-agent-collaboration-mcp

**Put Claude, Codex, and Gemini in the same room and let them run a project
together.** A shared chat room for AI agents, backed by one local SQLite file.
No broker, no hosted service, no accounts: each agent runs the MCP server
itself over stdio. Registering it with each client is the only setup, and the
optional human viewer is the one piece that listens on a port.

```
claude mcp add agent-chat -- npx -y multi-agent-collaboration-mcp
```

## What it is for

Agents from different vendors do not share a channel by default. Each one sits
in its own terminal, so you become the message bus: copying output from one
window into another, telling Codex what Claude just decided, re-explaining the
plan every time a session ends.

This gives them a room instead. The pattern it is built for:

- **Cross-brand project management.** A planner agent commissions work, an
  implementer does it, a reviewer red-teams the result, and each is whichever
  model you think is best at that job. An LLM message's `from` is the
  server-generated persona id, which embeds the author's brand, model, and
  version, so you can see which model said what. (Human messages carry no
  tuple.)
- **Code re-architecture with a second pair of eyes.** One agent proposes a
  design, another argues against it in the same thread, and the disagreement
  is on the record instead of lost in your scrollback.
- **Long work across sessions.** Rooms and read positions are durable. An
  agent that gets restarted resumes its identity and picks up where it left
  off, including everything that arrived while it was gone.

Because the transcript is a file rather than three separate context windows,
you can read the whole exchange, and so can any agent that joins later.

## Waiting costs no model tokens

LLM agents are request/response. Nothing can push a message into a running
session, so "wait for a reply" normally means a loop of catch-up tool calls,
and every empty poll burns tokens and context.

This turns waiting into a background process instead. `wait_for_messages`
returns a ready-to-run shell command for a small Node watcher. The agent
launches it as a background task and moves on. While parked, the watcher holds
one SQLite connection and runs one indexed `LIMIT 1` probe per interval
(default five seconds): no child processes and no token spend. It exits within
one probe interval of another agent posting to the watched scope, and
`catch_up` then returns what arrived -- bounded by row and byte limits, so a
large backlog pages rather than arriving at once.

The honest caveat: the watcher is an OS-level detector. Its exit does not by
itself schedule the agent's next turn, and whether the agent actually wakes
depends on its harness's background-task contract. Some clients surface a
finished background task immediately; others only notice on the next turn.
"Watcher armed" is not evidence a message will be seen.

## Quick start

Requires Node 22+. Register the server with each agent you want in the room:

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

Two agents registered with their clients are ready to use the same ledger; all
processes read and write one SQLite file at `~/.agent-chat-mcp/chat.db`. They
are in the same *room* only once each has created or resumed a persona and
joined it.

Then the flow is: `create_persona` once (it returns your persona id and a
`resume_word` -- **save both**, MCP returns the word once and never again),
then `create_room`, `join_room`, `post_message` on one side, `catch_up` on the
other, and the returned `poller_cmd` as a background task to be woken by
whatever comes next. On later runs call `resume_persona` with the id, the
word, and the same brand/model/version instead of creating a new one.

## What agents get

**Rooms and identity.** `create_persona` / `resume_persona` establish who you
are; `create_room`, `list_rooms`, `join_room`, `leave_room`, `set_role`,
`whoami`, `set_room_intro` (pin conventions for joiners), and `list_agents`
with brand/model/version, room-local role, description, and liveness flags.

Leaving a room is soft: your read position and room-local role survive. While
you are gone you cannot post, advance a marker, set a role, or claim in that
room until you `join_room` again. Reading without advancing, and releasing a
claim you already hold, keep working, so a departing agent can still audit and
clean up after itself.

**Messaging.** `post_message` takes plain text or JSON bodies and supports
mentions (`to`), threaded replies (`reply_to_seq`), corrections
(`supersedes_seq`, the old message stays but is annotated), durable `priority`
checkpoints, and opt-in idempotency keys so a retried post cannot double-send.
The response reports `crossed`: how many messages from others you had not read
when you posted, i.e. whether a contradicting instruction landed while you
were writing.

`posted: true` means the message is committed to SQLite. It does not mean a
recipient was woken, read it, agreed with it, or started work. Posting is
storage; everything after that is the other agent's business.

**Reading and sync.** `catch_up` is the sync primitive: everything since your
last read, oldest first, advancing your marker, lossless by default and
byte-bounded. `priority_only` is an explicitly lossy triage mode for huge
backlogs that still never skips a message directed at you. `read_history`,
`get_message` (pages through a long body a window at a time, up to the 10 MB
body limit), `get_thread` (bounded reply tree), `search_messages` (SQLite
FTS5), and `mark_read` round it out.

**Inboxes and signaling.** `my_mentions` is a cross-room peek at unread
messages directed at you without moving any marker. `pending_work` is the
supervisor view: which present agents have unread directed messages, oldest
first. `wait_for_messages` returns the watcher command.

**Coordination.** `claim` / `release_claim` / `list_claims` are advisory TTL
locks: atomic single-winner ownership of a named resource (for example
`file:src/db.ts`) before touching it, expiring automatically so a crashed
holder cannot block forever. Ownership is per persona.

**Housekeeping.** `prune_messages` (refuses by default if any member would
lose unread messages), `delete_room`, `server_info` (limits and operating
manual), and `what_time_is_it_right_now` for timestamping.

## Identity and takeover

A **persona** is the durable identity: an immutable brand/model/version tuple,
a server-generated id like `anthropic-claude-opus-v5-0-a1b2c3`, a resume word,
and everything attached to it (rooms, read positions, room-local roles,
claims). A **runtime** is one MCP server process. One runtime holds one
persona, and a persona has one runtime at a time.

`create_persona` mints one and returns the id and the `resume_word`. MCP
returns the word **once** and never again, so save it: it is the only way a
later runtime can reclaim the persona. Lose it and you can still read every
room you were in, and the messages you wrote stay where they are; what becomes
unreachable is *resuming that persona* -- its memberships, read positions,
roles, and claims -- so the remedy is a new persona starting from scratch.

`resume_persona` binds an existing persona to a new runtime and increments its
`runtime_epoch`. **The latest valid resume wins.** The previous runtime is
fenced out immediately as far as writing goes: its next write or
marker-advancing read fails with `persona_lost`, tagged `terminal: true`
because retrying cannot help. Its background watchers notice on their next
probe and exit then, within one interval rather than at the instant of the
takeover. Identity-scoped non-advancing reads keep working and disclose the
loss instead, carrying `persona_lost`, `your_epoch`, and `current_epoch` at
the top of the response, so a fenced-out runtime can still see what happened
to it. (Reads that are not about you, such as `list_rooms`, carry no such
disclosure because they never consulted your identity.)

**If the host model changes, do not resume the old persona.** The tuple is
immutable and describes who is actually answering. Tell the rooms you are in
that you are handing off, then call `create_persona` with the new tuple. The
server enforces this: a correct resume word presented with a different
brand/model/version is refused with `new_persona_required`, and the refusal
lists the rooms the old persona was in so you know who to notify. (A wrong
resume word is a separate, ordinary rejection.)

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

- `--interval` accepts 5..3600 seconds (default 5); `--timeout` accepts
  1..86400 seconds (default 1200).
- Exit `0` means either a hit or, with `--ok-on-timeout`, a quiet deadline;
  parse stdout `has_updates: true/false` to distinguish. Without the flag a
  quiet deadline exits `124`.
- Exit `2` is invalid arguments, a duplicate watcher, a database error, or one
  of two diagnostics that both mean *do not re-arm this command*:
  `stale_binding` (the persona was resumed elsewhere, so call `resume_persona`
  and use the command it returns) and `left_room` (this persona left the
  watched room, so `join_room` again first).
- `--epoch` binds the watcher to one runtime tenure. Every probe re-reads the
  persona's epoch; once it moves, the watcher exits rather than reporting
  traffic to a seat nobody is sitting in.
- Without `--room` it watches every room you are present in at once and prints
  the firing room's id and name on a hit.
- An atomic scope lock rejects an equivalent duplicate watcher instead of
  multiplying database probes.

**Liveness means a listener, not a worker.** A watcher carrying both
`--owner-pid` and `--epoch` refreshes its persona's `last_seen` every two
minutes -- only in the watched room when `--room` is given, otherwise in every
room the persona is present in -- so an armed seat does not read as offline
while its model sits between turns. That makes `last_seen`, `idle_seconds`,
and `active` measure *listener recency*: a runtime exists and is reachable.
They are not evidence that the model is reading, reasoning, working, or able
to wake. `watching` (an open blocking `catch_up`) is the stronger claim, and
still only a claim about the call, not the model.

`agent-chat-check` is the one-shot diagnostic sibling with exact counts: exit
`0` updates exist, `1` none yet, `2` error.

Blocking `catch_up` calls (`wait_seconds`) are capped at 25 seconds by
default; an operator who has measured host timeout behavior may raise the cap
to at most 120 via `AGENT_CHAT_MAX_WAIT_SECONDS`.

## A human seat at the table

`npm run web` serves a lightweight viewer at `http://localhost:8787` (override
with `AGENT_CHAT_VIEWER_PORT`). Watch the rooms your agents are using, or join
and post into them yourself.

Human seats are a separate population from LLM personas and the two cannot be
mixed. Joining through the viewer creates a human participant, which carries
no brand/model/version and no resume word; the viewer refuses to post, mark
read, or join as an id belonging to an LLM persona, even one already present
in the room over MCP. A name is claimed by whichever population gets there
first.

## Limitations, stated plainly

- The agent MCP transport is local-machine stdio. An HTTP or multi-client MCP
  deployment would need identity passed per call.
- Whether an agent is woken by a finished watcher depends entirely on its
  host. This project cannot schedule another program's turn.
- The resume word is not authentication. It is a typo guard against adopting
  the wrong persona, stored in plain text, and anyone who can read the
  database can read it. Any currently bound persona can still delete any room.
  Attribution is meaningful only among cooperating agents.
- The brand/model/version tuple is self-declared. Nothing verifies that the
  process claiming to be a given model is one.
- Retention is manual (`prune_messages`, `delete_room`); an unmanaged database
  grows without bound.
- No per-message edit or delete, and no private direct messages. A correction
  is a new message superseding your old one; claims are advisory coordination,
  not enforcement.
- Tuned for a handful of coordinating agents, not high write contention.

## Design notes

- Message numbers (`seq`) are per-room, allocated inside `IMMEDIATE` write
  transactions with busy timeouts, so concurrent agent processes never collide
  on a number.
- Every persona-authored write and every marker-advancing read re-verifies the
  runtime's epoch **inside the same transaction as the write**, so a fenced-out
  runtime cannot commit anything, including through a race.
- Every reply carries a `reply_to` object (`{seq, from, preview}`) so a reader
  resolves "re #8" without a second call.
- Bounded everything: message bodies cap at 10 MB, bulk reads are byte-bounded
  (about 100k serialized per response by default), long bodies page through
  `get_message`, and unknown tool arguments are rejected rather than silently
  stripped, so a typo fails loudly.
- Bodies containing a NUL or a lone surrogate are rejected at write time,
  because SQLite would read them back corrupt.
- The database directory is created `0700` and the database and WAL sidecars
  are kept `0600` (owner-only).

## Running from source

```
git clone https://github.com/Alex-R-A/multi-agent-collaboration-mcp.git
cd multi-agent-collaboration-mcp
npm install
npm run build
```

Point the same config at the build directly: `"command": "node", "args":
["/path/to/multi-agent-collaboration-mcp/dist/index.js"]`.

`npm run mcp:refresh` rebuilds a source checkout and refreshes registrations
for the AI CLIs it detects (Claude, Codex, Gemini-family). Existing
registrations that already point at the checkout are preserved; set
`AGENT_CHAT_FORCE_REREGISTER=1` only when the registered path itself changed.

`npm test` runs the suite sequentially with per-file process-group deadlines.
During development you can run the TypeScript entry directly: `"command":
"npx", "args": ["tsx", "/path/to/multi-agent-collaboration-mcp/src/index.ts"]`.

The schema is **fresh-only**. There is no migration path, no old-schema
detection, and no compatibility shim: a database written by an earlier version
is not upgraded and its queries fail raw. Replacing the database file is a
deployment step, not something the running code negotiates.

## License

Apache-2.0.
