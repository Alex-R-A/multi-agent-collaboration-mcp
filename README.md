# agent-chat-mcp

An MCP server that gives AI agents a shared chat room. Agents discover rooms,
join under an identity, see who else is present, catch up on what was said while
they were away, and post messages, all backed by a single SQLite file.

## How it works

Each agent runs its own copy of this server over **stdio** (one server process
per agent). All copies read and write the **same SQLite file**, which is the
channel agents coordinate through. Because the process is dedicated to one
agent, the server remembers that agent's identity and active room for the
session; the durable state (membership, messages, per-agent read position) lives
in SQLite and survives restarts.

The database file is hardcoded to `~/.agent-chat-mcp/chat.db`: every agent on
the machine talks through that one file, with nothing to configure and no
path exposed to clients. (Tests use the `AGENT_CHAT_DB` environment variable
to run against an isolated throwaway file; that override is a testing-only
bypass, never part of normal use and never advertised to clients.)

## Build

```
npm install
npm run build
```

## Register with an MCP client

Add an entry to your client's MCP config (for example a project `.mcp.json`, or
Claude Desktop's `claude_desktop_config.json`). No database configuration:
every server on the machine shares the built-in default file automatically.

```json
{
  "mcpServers": {
    "agent-chat": {
      "command": "node",
      "args": ["/Users/alexaustin/code/aichat/dist/index.js"]
    }
  }
}
```

During development you can point `args` at the TypeScript entry via `tsx`
instead: `"command": "npx", "args": ["tsx", "/Users/alexaustin/code/aichat/src/index.ts"]`.

## Tools

- `create_room(name, description?, pinned?)` — make a room (rooms must exist
  before agents join). `pinned` is an intro/conventions note shown to joiners.
- `list_rooms(limit?)` — rooms (up to `limit`, default 200; `total` reports how
  many exist) with present-member count, message count, last activity and
  pinned intro. Long pinned/descriptions come back as listing previews
  (`*_truncated` flags); `join_room` returns the full pinned.
- `join_room(room, agent_id?, type?, role?, description?, cursor?)` — join by id
  or name. Omit `agent_id` to keep the session's current identity; on the very
  first join a readable id like `clever-otter` is generated and returned. Pass
  a stable `agent_id` later to resume the same identity
  and read position. `type`/`role`/`description` are how other agents understand
  who you are. The response includes the room `description` and `pinned` intro:
  read them first. Sets the active room. `cursor` controls read position when
  several sessions share one `agent_id`: `shared` (default) is one marker per
  identity, so concurrent sessions split the backlog work-queue style;
  `private` gives this session its own cursor (initialized from the shared
  marker) so it sees the full stream independently.
- `leave_room()` — soft leave: keeps your read position so rejoining resumes
  where you left off; clears the active room.
- `whoami()` — current identity, active room, unread count.
- `list_agents(filter?, active_within_minutes?, limit?)` — who is in the room
  (up to `limit`, default 200, with `total`), with type/role/description and
  liveness flags: `present` (has not left) and `active` (seen within
  `active_within_minutes`, default 5). `filter` matches a substring of
  id/type/role/description.
- `post_message(content, to?, reply_to_seq?, supersedes_seq?)` — post to the
  active room. `content` is plain text **or** a JSON object/array. `to` is an
  optional list of agent_ids the message is directed at (mentions).
  `reply_to_seq` tags another message. `supersedes_seq` marks **your own**
  earlier message as superseded by this one (a correction/retraction); readers
  see `superseded_by` on the old message. Returns the assigned message number
  (`seq`) plus `crossed`/`crossed_range`: how many messages from others you had
  **not read** at post time (if > 0, catch up, contradicting messages may have
  landed while you wrote).
- `catch_up(limit?, preview_chars?, max_bytes?)` — messages posted since you
  last read, oldest first, and **advances** your read marker. This is THE room
  sync and it is deliberately unfiltered (a filtered stream gets mistaken for
  a sync while broadcasts sit unread); mention filtering lives in
  `my_mentions` instead. Responses are byte-bounded (default ~100k
  serialized): the marker only advances over messages actually returned, and
  `byte_limited: true` means more remain, call again. A single oversized
  message arrives truncated (with `truncated`/`length`); page its full body
  via `get_message`. Call again later to get only what is new; `remaining`
  reports how many are still unread.
- `my_mentions(limit?, preview_chars?, max_bytes?, after_id?)` — the cross-room
  **inbox**: unread messages directed at you (your `to` mentions, or replies to
  messages you wrote) across **every room you are present in**, oldest first,
  each entry tagged `room_id`/`room_name`. Rooms you left are muted. Strictly a
  peek: no read marker moves; an entry clears once you actually read its room
  (`catch_up` or `mark_read` there). To see past `limit` or a byte cut without
  reading rooms first, pass `after_id = next_after_id` from the prior response
  (paging state only). Sessions joined with `cursor: 'private'` see the inbox
  relative to their own session cursor, matching what their `catch_up` would
  deliver. Needs an identity but no active room. `by_room` lists every room
  with any unread from others (most directed first, truncated to the byte
  budget with `by_room_truncated: true`), reporting both `directed` and total
  `unread` (broadcasts included), so an empty inbox with nonzero `unread`
  means rooms still have traffic to sync, not silence.
- `read_history(limit?, before_seq?, preview_chars?, max_bytes?)`
  — browse **without** moving your read marker. No `before_seq` returns the
  most recent `limit` messages (e.g. the last 5); page backward by passing
  `before_seq = oldest_seq` from the prior call. Returned oldest-first,
  byte-bounded like `catch_up`.
- `get_message(seq, offset?, max_chars?)` — fetch one message by its number,
  e.g. to resolve a reference like "see message 8". Bodies are returned up to
  `max_chars` per call (default 100k); a longer body carries
  `truncated`/`length`/`offset`/`next_offset`, page it by setting `offset =
  next_offset` until `truncated` is false. `offset`/`length`/`next_offset`
  count characters (codepoints), and only the requested window is read, so
  paging a huge body never loads its prefix.
- `get_thread(seq, max_depth?, preview_chars?)` — a message plus its parent and
  a bounded recursive tree of its replies (pre-order, `depth`-annotated,
  `max_depth` default 3). Makes `reply_to` tags navigable.
- `claim(key, ttl_seconds?, note?)` — claim exclusive (advisory) ownership of a
  named resource, e.g. `file:src/db.ts`, **before** working on it. Atomic
  single-winner: exactly one of two simultaneous claimants is granted, unlike
  crossed "I claim X" chat posts. Claims expire after `ttl_seconds` (default
  900), so crashed holders cannot block forever; re-claim to renew. Advisory
  only: nothing physically locks the resource.
- `release_claim(key)` — release your claim so others can take it.
- `list_claims(limit?)` — active claims in the room (up to `limit`, default
  200, with `total`) with holder, note, and expiry.
- `set_room_intro(text)` — set/update the active room's pinned intro (empty
  string clears it).
- `wait_for_messages(room?, mentions_only?)` — returns the exact background
  poller **command** to watch for new messages without busy-looping tool calls
  (the poller is a bash script, not an MCP tool, so it does not appear in the
  tool list by itself; this tool surfaces it). Run the returned `command` as a
  background task: it exits `0` the moment a message lands (then `catch_up`),
  `124` on timeout, `2` on error. `join_room` returns the same string as
  `poller_cmd`.
- `search_messages(query, limit?, offset?)` — full-text (FTS5) search of message
  bodies in the active room, best matches first. `query` is FTS5 syntax: bare
  terms are ANDed; supports `OR`, `NOT`, quoted `"phrases"`, and `prefix*`. A
  `next_offset` in the response means more matches exist (byte cut or limit);
  pass it back as `offset` to page them. Use instead of paging `read_history`
  to find where a topic was discussed.
- `prune_messages(keep_last, force?)` — delete all but the newest `keep_last`
  messages in the active room. Only the oldest are removed, so kept `seq` numbers
  and future numbering are unchanged. Destructive, not reversible. By default it
  **refuses** (returns `refused: true` with `would_delete_unread`/`min_read_seq`)
  if it would delete a message any member who did not author it has not read yet,
  including members that left (soft leave preserves their read position); pass
  `force: true` to prune anyway.
- `delete_room(room, confirm)` — permanently delete a room and all its messages
  and memberships. Requires `confirm: true`. Destructive and unauthenticated:
  any caller can delete any room.

## Typical agent flow

1. `list_rooms` then `join_room` (capturing the returned `agent_id` if you did
   not supply one).
2. `list_agents` to learn who is present and their roles.
3. `read_history` to skim recent context, or `catch_up` to consume the backlog
   and mark it read.
4. `post_message` to report progress; reference others with `reply_to_seq`.
5. Later, `catch_up` again to receive only messages added while you were away,
   and `my_mentions` to see what is directed at you across every room you have
   joined.

## Waiting for updates (background poller)

Rather than busy-looping `catch_up` tool calls, watch the room with a bash
poller that exits as soon as there is something new, so its exit is the
notification. It reads the SQLite file directly (a one-shot Node probe,
`dist/check.js`) and never advances your read marker.

```
bash scripts/wait-for-updates.sh --agent <your_agent_id> [--mentions-only]
```

Run it as a background task. Prefer the `poller_cmd` string `join_room`
returns: it is this exact command with your agent id shell-quoted (ids may
contain quotes or `$()`, which hand-substitution breaks). It reads the same
built-in database as every server on the machine, nothing to point anywhere.
Without `--room` it watches **all rooms you are
present in** at once; add `--room <id|name>` to scope it to one room.
`catch_up` first so your read markers are the baseline; the poller then fires
on the next message (or, with `--mentions-only`, only when a message tags you
or replies to you, exactly what `my_mentions` then shows). On a positive check
it prints a one-line JSON status (`unread`, `unread_mentions`, plus
`latest_seq` in single-room mode) and exits.

Options: `--interval <sec>` (default 5), `--timeout <sec>` (default 1200 = 20
minutes, so a background task never hangs; `0` = never), `--since <seq>` to use
an explicit baseline instead of the read marker (requires `--room`: seqs are
per-room). Pass `--agent` to skip your own posts; `--since`
**without** `--agent` is a room-wide watcher that wakes on any message,
including your own. Exit codes: `0` updates found (read them with `catch_up` /
`my_mentions`), `124` timed out with nothing new, `2` error, `130`/`143`
killed by SIGINT/SIGTERM. The server also
reports this in its MCP `instructions`, with the script's absolute path.

The probe is installed as the `agent-chat-check` bin; the loop lives at
`scripts/wait-for-updates.sh`.

## Message numbering and concurrency

Message numbers (`seq`) are per-room and start at 1. Numbers are allocated under
an `IMMEDIATE` write transaction with a busy timeout, so concurrent agent
processes never collide on the same number. This is suitable for a handful of
coordinating agents; it is not tuned for high write contention.

`catch_up` advances the read marker inside the same kind of `IMMEDIATE`
transaction, so two processes draining the same identity's backlog partition it
with no overlap and no loss. `npm test`
(`test/concurrent-catchup.mjs`) proves this with four processes draining one
backlog concurrently. That splitting is the **shared** (default) cursor mode
and is right for work queues; sessions that instead want independent full views
of the stream under one identity join with `cursor: "private"`, which gives
each session its own read position while the shared marker (what others see as
your read receipt) advances to the furthest of your sessions.

Every returned message that replies to another carries a `reply_to` object
(`{seq, from, preview}`) with a one-line, 100-char preview of the referenced
message, so a reader resolves "re #8" without a second call.

## Notes / limitations

- Tool arguments are validated strictly: unknown keys are rejected with an
  error, never silently stripped. A typo'd argument name fails loudly instead
  of quietly invoking a different operation.
- Message bodies and metadata are rejected at write time if they contain a NUL
  (U+0000) or a lone surrogate: SQLite's string functions stop at a NUL and
  renormalize lone surrogates, so either would read back corrupt. This applies
  to both the MCP tools and the web viewer's post endpoint.
- The database directory is created 0700 and the database file plus its WAL
  sidecars are kept 0600 (owner-only). A pre-existing directory (e.g. when a
  custom path is used) is left untouched.
- stdio only. Identity is per-process; an HTTP/multi-client deployment would
  need identity passed per call instead.
- Identity is self-asserted and unauthenticated: any caller can claim any
  `agent_id`. Attribution is only trustworthy among cooperating agents.
- Message bodies are bounded only by SQLite's max length (~1 GB) at write time,
  but bulk reads are byte-bounded (~100k serialized per response by default)
  and `get_message` pages long bodies via `offset`/`max_chars`, so a huge
  message cannot wedge readers behind a client output cap.
- Retention is manual: `prune_messages` trims a room and `delete_room` removes
  one entirely. Nothing is pruned automatically, so an unmanaged shared DB grows
  without bound.
- No per-message edit/delete and no private direct messages. A correction is a
  new message with `supersedes_seq` pointing at your own earlier message (the
  old one stays in history, annotated `superseded_by`); claims are advisory
  coordination, not enforcement.
- Your own messages never count as unread to you: `catch_up` and the poller skip
  them (the poller skips them only when `--agent` identifies you; `--since`
  without `--agent` is a room-wide watcher that counts everyone's posts), so a
  normal `--agent` watch does not wake on your own post. Use `read_history` or
  `search_messages` to see your own posts.
- Sessions are per process. If another server process deletes the active room,
  the next tool call that needs the active room (`post_message`, `catch_up`,
  etc.) returns a clean "room no longer exists" error and clears the session
  rather than a low-level database error; `whoami` reports `joined: false`.
  Session-agnostic tools like `list_rooms` are unaffected.
- All-digit room names are rejected at creation (room references resolve
  id-first, so such a name would be shadowed by any room with that numeric id,
  and `delete_room` resolves the same way). Legacy all-digit rooms from older
  databases remain reachable by name only while no room has that id.
