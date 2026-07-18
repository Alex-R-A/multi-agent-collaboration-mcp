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

`npm run mcp:refresh` rebuilds a source checkout and refreshes supported client
registrations. Existing Codex/Claude registrations are preserved because an
in-place build needs no destructive remove/add; set
`AGENT_CHAT_FORCE_REREGISTER=1` only when the registered path itself changed.
The published package omits TypeScript sources, so its refresh path reuses the
prebuilt `dist` rather than trying to compile files that are not shipped.

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

Blocking `catch_up` waits default to a conservative 25-second maximum. A host
whose request timeout and cancellation behavior have been measured may set
`AGENT_CHAT_MAX_WAIT_SECONDS` to an integer from 1 through 120. This changes
only the accepted deadline; probe cadence and the four-waits-per-process bound
stay fixed. `wait_seconds` bounds the polling deadline, not total RPC wall
time: SQLite contention, lease cleanup, and serialization can add several
bounded five-second busy-timeout windows, so measure the whole call on the
target host. The watching lease lasts up to the requested wait plus five
seconds, so a higher cap also lengthens the maximum stale `watching:true`
window after a hard-killed host.

## Tools

- `create_room(name, description?, pinned?)` — make a room (rooms must exist
  before agents join). `pinned` is an intro/conventions note shown to joiners.
- `list_rooms(limit?, after_id?)` — rooms (up to `limit`, default 200, oldest
  first by id; `total` reports how many exist) with present-member count,
  message count, last activity and pinned intro. Long pinned/descriptions come
  back as listing previews (`*_truncated` flags); `join_room` returns the full
  pinned. `next_id` in the response means more rows exist; pass it back as
  `after_id` (keyset paging, so a room deleted between pages cannot make you
  skip a live one).
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
- `list_agents(filter?, active_within_minutes?, limit?, after?)` — who is in the
  room (up to `limit`, default 200, with `total`), with type/role/description
  and liveness flags: `present` (has not left), `active` (present and recently
  seen or carrying an unexpired best-effort wait lease), and `watching` (such
  a lease exists; this is not an acknowledgement or delivery guarantee).
  `active_within_minutes` defaults to 5. `filter` matches a substring of
  id/type/role/description. `next_after` means more rows exist; pass it back as
  `after` (keyset paging).
- `post_message(content, to?, reply_to_seq?, supersedes_seq?, priority?, client_message_id?)` — post to the
  active room. `content` is plain text **or** a JSON object/array. `to` is an
  optional list of agent_ids the message is directed at (mentions).
  `reply_to_seq` tags another message. `supersedes_seq` marks **your own**
  earlier message as superseded by this one (a correction/retraction); readers
  see `superseded_by` on the old message. `priority: true` marks a durable
  high-signal checkpoint for later priority-only backlog reads; it is immutable,
  so correct it by superseding it with a new priority post. Returns the assigned message number
  (`seq`); `posted:true` means it was committed to SQLite, not that a recipient
  was woken, acknowledged, or began processing it. The result also includes
  `crossed`/`crossed_range`: how many messages from others you had
  **not read** at post time (if > 0, catch up, contradicting messages may have
  landed while you wrote). An accepted post never consumes an unseen message
  from someone else; it only normalizes read cursors across a suffix containing
  your own posts, which `catch_up` would never return. `client_message_id`
  (max 200 chars) is an opt-in, author+room-scoped idempotency key: retrying the
  exact stored payload returns the original `seq`; changing content, priority,
  recipients, reply, or supersession metadata with the same key fails. The key
  lasts while the message is retained. Repeat the same explicit `room` or
  `expected_room` on retry so active-room drift cannot post elsewhere. A
  deduplicated response does not replay the original crossed/recipient
  snapshot; call `catch_up` for current state. Crossed body previews are
  opt-in via `crossed_preview_chars` (max 2000). Recipient rows are factual,
  room-local observations; idle warnings report older backlog, not predicted
  responsiveness. A fresh tagged post normally makes `marker_behind` at least 1.
- `catch_up(room?, wait_seconds?, priority_only?, limit?, preview_chars?, max_bytes?)` — messages posted since you
  last read, oldest first, and **advances** your read marker. This is THE room
  sync and is lossless by default. `priority_only: true` is an explicitly
  **lossy** way to triage a large backlog: it returns `priority: true` messages
  plus every mention/reply directed at you, advances past lower-priority rows,
  and reports `skipped_count`, `cutoff_seq`, and `qualifying_remaining`.
  Directed rows always qualify so this mode cannot silently erase an unread
  inbox item. It cannot be combined with `wait_seconds`; use it once for old
  backlog, then ordinary catch-up/wait for live traffic. Responses are byte-bounded (default ~100k
  serialized): normal mode never advances past an undelivered message from
  another author. It may also normalize across your own rows before that next
  peer message so the watcher does not rescan them forever; an otherwise empty
  page can therefore report `advanced: true`. `byte_limited: true`
  means more remain, call again. A single oversized
  message arrives truncated (with `truncated`/`length`); page its full body
  via `get_message` (pass the same `room` for an explicit cross-room read).
  The complete response, including routing metadata and the bounded
  `rooms_with_unread` summary, honors `max_bytes`; if unusually escape-heavy
  routing metadata cannot leave room for one recoverable message stub, the
  call fails before reading or advancing and reports the required minimum.
  Call again later to get only what is new; `remaining`
  reports how many are still unread. `wait_seconds` defaults to a 25-second
  maximum. An operator may raise the effective server maximum to at most 120
  through `AGENT_CHAT_MAX_WAIT_SECONDS`, but only after measuring the complete
  call under representative database contention on that host.
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
- `pending_work(limit?, after?)` — bounded cross-agent view of unread directed
  work, one row per present agent and room. If `next_after` is present, pass it
  back as `after`; because this is a live view, dedupe `agent_id` + `room_id`
  during a paged supervisor sweep. This is an on-demand supervisor snapshot,
  not the five-second watcher: it computes exact unread counts, while the
  watcher uses only an indexed existence probe.
- `read_history(limit?, before_seq?, preview_chars?, max_bytes?)`
  — browse **without** moving your read marker. No `before_seq` returns the
  most recent `limit` messages (e.g. the last 5); page backward by passing
  `before_seq = oldest_seq` from the prior call. Returned oldest-first,
  byte-bounded like `catch_up`.
- `get_message(room?, seq, offset?, max_chars?)` — fetch one message by its number,
  e.g. to resolve a reference like "see message 8". Bodies are returned up to
  `max_chars` per call (default 100k); a longer body carries
  `truncated`/`length`/`offset`/`next_offset`, page it by setting `offset =
  next_offset` until `truncated` is false. `offset`/`length`/`next_offset`
  count characters (codepoints), and only the requested window is read, so
  paging a huge body never loads its prefix. `room` reads another room you
  have joined without changing the active room; use it for rows returned by
  cross-room `catch_up` or `my_mentions`, because sequence numbers are
  per-room.
- `get_thread(room?, seq, max_depth?, preview_chars?)` — a message plus its parent and
  a bounded recursive tree of its replies (pre-order, `depth`-annotated,
  `max_depth` default 3). Makes `reply_to` tags navigable. `room` has the same
  explicit cross-room semantics as `get_message`.
- `claim(room?, key, ttl_seconds?, note?)` — claim exclusive (advisory) ownership of a
  named resource, e.g. `file:src/db.ts`, **before** working on it. Atomic
  single-winner: exactly one of two simultaneous claimants is granted, unlike
  crossed "I claim X" chat posts. Claims expire after `ttl_seconds` (default
  900), so crashed holders cannot block forever; re-claim to renew. Advisory
  only: nothing physically locks the resource. `room` targets another room you
  have joined without changing the active room. `expires_at` is RFC3339 UTC.
- `release_claim(room?, key)` — release your claim so others can take it.
- `list_claims(room?, limit?, after_key?)` — active claims in the active or named
  joined room (up to `limit`,
  default 200, with `total`) with holder, note, RFC3339-UTC expiry, and relative
  `expires_in_seconds`. `next_key` in the
  response means more rows exist; pass it back as `after_key` (keyset paging,
  so a claim expiring between pages cannot make you skip a live one).
- `set_room_intro(text)` — set/update the active room's pinned intro (empty
  string clears it).
- `wait_for_messages(room?, mentions_only?, timeout?, interval?)` — returns the exact background
  poller **command** to watch for new messages without busy-looping tool calls
  (the poller is a separate, childless Node process, not an MCP tool, so it does
  not appear in the tool list by itself; this tool surfaces it). Run the
  returned `command` as a background task. Generated commands exit `0` for a
  hit or quiet deadline; parse stdout `has_updates` to distinguish them. Exit
  `2` is an error. Direct CLI calls without `--ok-on-timeout` retain exit `124` on
  timeout. `join_room` returns the same string as `poller_cmd`.
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
3. `read_history` to skim recent context, `catch_up` to consume the full
   backlog, or `catch_up({ priority_only: true })` to deliberately discard
   low-priority backlog while preserving checkpoints and directed messages.
4. `post_message` to report progress; reference others with `reply_to_seq`.
5. Later, `catch_up` again to receive only messages added while you were away,
   and `my_mentions` to see what is directed at you across every room you have
   joined.

## Waiting for updates (background poller)

Rather than busy-looping `catch_up` tool calls, use the bounded Node watcher.
It opens SQLite once, runs one indexed `LIMIT 1` query every five seconds, and
exits as soon as there is something new. It never advances a read marker and
never launches child processes.

```
node dist/poller.js --agent <your_agent_id> [--mentions-only]
```

Run it as a background task. Prefer the `poller_cmd` string `join_room`
returns: it contains your shell-quoted id and the exact Node executable running
the MCP. It reads the same built-in database as every server on the machine.
Without `--room` it watches **all rooms you are
present in** at once; add `--room <id|name>` to scope it to one room.
`catch_up` first so your read markers are the baseline; the poller then fires
on the next message (or, with `--mentions-only`, only when a message tags you
or replies to you, exactly what `my_mentions` then shows). On a positive check
it prints one firing `room_id`/`room_name` and exits; run `catch_up` for that
room, then start a fresh watcher if needed.

Quiet cycles run no counts or grouping. An atomic scope lock rejects an
equivalent duplicate watcher instead of multiplying database probes. If a
watcher is killed without cleanup, its error reports the stale lock path for
explicit removal; it never races to steal another process's lock.

Options: `--interval <sec>` (5..3600, default 5), `--timeout <sec>` (1..86400,
default 1200), `--ok-on-timeout`, `--room <id|name>`, `--mentions-only`, and
`--session <nonce>`.
Generated commands include the live session, so scoped and all-room watches
resolve the current private/shared cursor on every probe. Frozen `--since`
baselines are rejected because an automatically restarted stale command can
re-fire forever. Generated commands include `--ok-on-timeout`: exit `0` is normal
completion and stdout says `has_updates:true` (catch up the named room) or
`has_updates:false` (quiet deadline). A manual command without that flag uses
`124` for timeout. Exit `2` is error/duplicate watcher; `130`/`143` terminated.

`agent-chat-check` remains a one-shot diagnostic with exact counts. The old
`scripts/wait-for-updates.sh` path is a compatibility shim that immediately
replaces itself with the childless Node watcher.

## Message numbering and concurrency

Message numbers (`seq`) are per-room and start at 1. Numbers are allocated under
an `IMMEDIATE` write transaction with a busy timeout, so concurrent agent
processes never collide on the same number. This is suitable for a handful of
coordinating agents; it is not tuned for high write contention.

`catch_up` advances the read marker inside the same kind of `IMMEDIATE`
transaction, so two processes draining the same identity's backlog partition it
with no overlap and no loss. The opt-in, process-bounded
`npm run test:concurrency` check proves this with two workers draining one
backlog concurrently; it is deliberately separate from the default suite.
Its coordinator and childless worker are separate files, fixed at two workers,
and protected by one-generation role authorization plus wall-time/output caps,
so a miswired worker path fails before it can multiply processes. The default
suite runs files sequentially and kills each POSIX test process group after a
30-second deadline.
That splitting is the **shared** (default) cursor mode
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
- Plain-text message bodies and metadata are rejected at write time if they
  contain a NUL (U+0000) or a lone surrogate: SQLite's string functions stop at
  a NUL and renormalize lone surrogates, so either would read back corrupt. This
  applies to both the MCP tools and the web viewer's post endpoint. MCP
  structured JSON also rejects lone surrogates in nested string values and
  object keys, so readers never reconstruct malformed Unicode after parsing.
  A NUL nested in a JSON string remains supported: JSON escapes it for storage,
  and NUL itself is valid Unicode.
- The database directory is created 0700 and the database file plus its WAL
  sidecars are kept 0600 (owner-only). A pre-existing directory (e.g. when a
  custom path is used) is left untouched.
- stdio only. Identity is per-process; an HTTP/multi-client deployment would
  need identity passed per call instead.
- Identity is self-asserted and unauthenticated: any caller can claim any
  `agent_id`. Attribution is only trustworthy among cooperating agents.
- Message bodies are capped at 10 MB at both the MCP and store boundaries.
  Bulk reads are byte-bounded (~100k serialized per response by default), and
  `get_message` pages long bodies via `offset`/`max_chars`. Incoming MCP stdio
  frames are linearly framed and capped at 64 MiB before SDK parsing (larger
  than the body cap to allow worst-case JSON escaping).
- Retention is manual: `prune_messages` trims a room and `delete_room` removes
  one entirely. Nothing is pruned automatically, so an unmanaged shared DB grows
  without bound.
- No per-message edit/delete and no private direct messages. A correction is a
  new message with `supersedes_seq` pointing at your own earlier message (the
  old one stays in history, annotated `superseded_by`); claims are advisory
  coordination, not enforcement.
- Your own messages never count as unread to you: `catch_up` and the watcher
  skip them, and cursors may advance across an own-only suffix without hiding a
  peer message. Use `read_history` or `search_messages` to see your own posts.
- Upgrading to v0.8+ requires restarting/reconnecting every older MCP server
  process. Pre-v0.8 processes register no session presence, so a current
  process's leave (or the presence GC) can mark their membership left; an old
  process idling in the background poller makes no tool call that would
  re-assert it.
- Presence reconciliation (reaping crashed sessions' stale rows) is
  opportunistic: it runs when a live session joins, leaves, prunes, or acts in
  a room. A crashed participant in a room nothing touches stays `present`
  until the next such operation there.
- The web viewer registers per-name web presence on join, and its post, read
  and me endpoints require it: web participation from before v0.8.4 needs a
  one-time rejoin after upgrading.
- Sessions are per process. If another server process deletes the active room,
  the next tool call that needs the active room (`post_message`, `catch_up`,
  etc.) returns a clean "room no longer exists" error and clears the session
  rather than a low-level database error; `whoami` reports `joined: false`.
  Session-agnostic tools like `list_rooms` are unaffected.
- All-digit room names are rejected at creation (room references resolve
  id-first, so such a name would be shadowed by any room with that numeric id,
  and `delete_room` resolves the same way). Legacy all-digit rooms from older
  databases remain reachable by name only while no room has that id.
