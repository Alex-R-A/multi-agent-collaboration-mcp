# Connection-Bound LLM Identity and Human Nickname Design

Status: proposed implementation specification, no implementation has been
applied.

Prepared on 2026-07-27 against repository commit `67509be`.

This document supersedes the persona creation, resume/takeover, runtime
attachment, model-transition, and human-name recommendations in
`AI Chat MCP Product Friction and Design Direction.md`. Until implementation,
`README.md` and `docs/Installation.md` remain authoritative descriptions of the
running product. After implementation, they must be rewritten to this contract.
This document does not supersede unrelated messaging, role, retention,
listener, or host-wake decisions.

## Purpose and decision posture

The required result is a clean-break identity system in which a nickname
belongs to one MCP stdio server process incarnation and one exact
brand/model/version tuple. A second CLI process must receive a different
nickname even when it runs from the same directory, uses the same client brand,
and can read the first process's project memory. A process that explicitly
identifies with a changed tuple must receive a new nickname and permanently
retire its old one.

Human participants need the same accidental-collision protection. A user enters
a base name such as `alex`; the viewer allocates and displays a canonical
nickname such as `human-alex-1`. Another independent viewer entering the same
base receives `human-alex-2`.

The strongest case against persisting an MCP connection identifier is that the
existing process-local session already distinguishes server processes.
Persisting another identifier adds a database field that becomes stale after a
hard crash and must never be mistaken for liveness or authentication. That
counter-case survives. The recommendation remains to persist the association
because the required behavior explicitly calls for a database-enforced,
inspectable connection-to-nickname mapping. This call should be reversed if
database inspectability is not required.

The strongest case against numbered human nicknames is that the number looks
like ownership while the viewer remains unauthenticated. A crafted local request
can self-assert a known `human-alex-1` unless the system adds a browser
credential. That counter-case also survives. Numbering is still recommended
because it prevents independent browsers from accidentally collapsing onto one
agent row. It is not an authentication mechanism.

The strongest case for terminally retiring a human identity during Change name
is that its abandoned membership and cursor can otherwise remain indefinitely.
That approach is unsafe in the current threat model. The web API has no
credential proving that a caller owns the supplied canonical ID, so a
server-side rename endpoint would let any caller who knows `human-alex-1`
retire it across every room. This specification therefore keeps human leave and
rename reversible. Authentication would be the evidence needed to reconsider
terminal human retirement.

The strongest case against retaining retired LLM memberships is that an
identity which can never return does not need a role, cursor, or departed roster
row. Deleting memberships would reduce query changes and storage. The counter-case
is that memberships are the only durable record of room participation,
`joined_at`, room role, and final read position for a participant that never
posted. This specification preserves that existing history with soft leave and
changes pruning so terminal identities do not block it. This call should flip
to membership deletion if historical departed-member visibility is explicitly
rejected.

The strongest case against releasing claims during retirement is that a model
transition or graceful process exit does not prove external work has stopped.
Immediate release can permit overlapping work. The counter-cost is that a
terminal identity cannot release its own claim and the current maximum TTL can
block another participant for 86,400 seconds. This specification deletes the
retired LLM's claims and does not transfer them. This call is contested.
Evidence of real work that must keep exclusivity after its persona disappears
would flip it to expiry-only cleanup.

## Costs and reasons not to implement

The expected costs are:

- The `agents` table gains connection, retirement, and human-allocation fields
  plus two partial unique indexes.

- Each first LLM identification and each human allocation takes an `IMMEDIATE`
  SQLite transaction. Tuple reuse remains one indexed lookup.

- Retirement updates every membership and deletes every claim and wait lease
  owned by that identity. Membership cleanup can use the existing agent-leading
  index. Claim and wait-lease deletion currently scan their complete tables
  because neither has an agent-leading index. Transitions are expected to be
  rare, and the cost is unmeasured. Do not add two write-taxing cleanup indexes
  without a benchmark showing these scans matter.

- Every process restart and human rename creates another permanent agent row.
  Message authorship requires those rows to remain, so the agent table grows.

- The HTML viewer needs separate base-name and canonical-ID state, plus durable
  allocation idempotency state. This is more state than the current single
  self-chosen name.

- A hard-killed process can leave a stale connection association and present
  memberships because no shutdown transaction ran. Those memberships can
  inflate member counts, receive directed pending work, appear as an idle
  participant, and block non-forced pruning indefinitely. Claims and wait
  leases remain until their existing expiry behavior removes them. The
  connection identifier cannot solve liveness.

- Human Change name remains a multi-request browser workflow. Durable
  allocation idempotency and the ghost ledger make retries recoverable, but an
  abandoned browser identity can still leave present or unread membership state
  indefinitely.

- No new dependency is required.

The primary reason not to implement is that process-local binding alone would
solve the immediate accidental takeover with less storage. That smaller design
does not meet the requested inspectable database association. The secondary
reason is that human numbering solves accidental collision only; it should be
removed if users expect it to provide ownership or cross-device identity
without adding authentication.

No performance comparison is claimed. The proposed paths do not exist yet, so
there is nothing meaningful to benchmark.

## Settled requirements

- The deployment starts with a new empty database.

- Old chats, personas, memberships, messages, claims, and credentials are
  deleted. They are not migrated, imported, inspected, translated, aliased, or
  exposed through a compatibility path.

- `resume_word` is removed from the schema, MCP API, responses, instructions,
  tests, and documentation.

- `resume_persona` is removed. It is not retained as an alias or deprecated
  compatibility tool.

- A caller cannot submit an `agent_id`, connection ID, password, resume token,
  or nickname when identifying as an LLM.

- Each MCP stdio server process generates its own random UUID. The value is a
  process-incarnation nonce generated by this server, not an identifier supplied
  by MCP or the client.

- One process incarnation can have at most one current LLM nickname.

- A different process incarnation always receives a different LLM nickname,
  even for the same tuple and working directory.

- The LLM identity tuple is self-reported `brand`, `model`, and `version`.
  These are strings. The server does not claim to verify them.

- Tuple comparison uses the stored trimmed strings exactly. It does not perform
  case folding, provider aliases, version parsing, or numeric coercion.

- `version` remains text end to end. A known version `5.0` must be sent and
  stored as the string `"5.0"`, not the JSON number `5.0`, which serializes as
  `5`. A caller whose official version is exactly `5` must not invent `.0`.

- Re-identifying one process with the exact same tuple reuses the current
  nickname.

- Re-identifying one process with any changed tuple field creates a new
  nickname and terminally retires the old nickname.

- Returning from tuple A to tuple B and later back to tuple A creates three
  distinct nicknames. A retired nickname is never reactivated.

- The existing `runtime_epoch` fence remains. Connection binding does not
  replace transaction-time epoch checks.

- The lowercase `human-` prefix is reserved for HTML human participants.

- Every human canonical ID has a numeric suffix, including the first identity
  for a base name.

- Human identities are never terminally retired by Change name or leave. The
  old canonical ID remains a valid cooperative identity after its memberships
  are soft-left.

- Human identity remains cooperative and self-asserted. The design prevents
  accidental name sharing, not deliberate impersonation.

## Explicit non-goals

- The server does not attempt to detect an in-place model switch that does not
  call the identification tool again. The probe established that a model switch
  inside one Claude Code session keeps the same MCP process and process UUID.

- The connection UUID is not authentication, authorization, a secret, a client
  model identifier, or proof that a process is alive.

- Request IDs, progress tokens, tool-use IDs, PID, working directory, and client
  name are not substitutes for the process UUID.

- No nickname is recoverable from a new MCP process. Restarting creates a new
  process UUID and therefore a new nickname.

- No successor redirects, nickname aliases, automatic mention forwarding, or
  automatic reply forwarding are added.

- No automatic all-room handoff message is posted. The replacement response may
  list old rooms, but the new persona joins and posts only through explicit
  calls.

- No provider registry or universal model-version grammar is introduced.
  Versions can contain decimals, dates, suffixes, and multiple components.

- No browser credential, account, cookie-based identity, or cross-device human
  recovery is introduced.

- No timeout reaper infers that an idle MCP process is dead. An idle live CLI
  and a crashed CLI cannot be distinguished safely from connection UUID alone.

## Observed MCP connection evidence

The connection probe at `scripts/connection-probe.mjs` generates one UUID when
its Node process starts and reports the information visible at initialization
and on each tool call.

Owner-supplied Claude Code results established:

| Observation | First Claude process | Second Claude process |
| --- | --- | --- |
| Process-generated UUID | Began `9af0690e` | Began `bfc0d91c` |
| PID | `93967` | `94428` |
| Repeated calls | Same UUID and PID | Same UUID and PID |
| Model switch followed by calls | Not tested in this process | Same UUID and PID, call count advanced from 2 to 4 |
| MCP transport session ID | `null` | `null` |
| Client-reported name | `claude-code` | `claude-code` |

The fields that changed between calls were observation time, JSON-RPC request
ID, progress token, Claude tool-use ID, and the probe's call counter. They are
request identifiers, not connection identifiers.

The evidence supports these conclusions:

- One stdio server process is a useful connection boundary for the supported
  CLI deployment.

- Separate CLI sessions start separate server processes and can be told apart
  by server-generated UUIDs.

- The MCP SDK did not supply a stdio transport session ID in these runs.

- Client information identifies Claude Code and its version, not the active
  model.

- The server cannot detect the tested in-place model switch without a new
  self-identification call.

This evidence is bounded to the tested Claude Code stdio behavior. An HTTP or
multi-client transport would require a transport-supplied per-session identity
or an explicit authenticated client token. A single process-global UUID would
be wrong for such a transport.

## Terminology

| Term | Meaning |
| --- | --- |
| Connection nonce | A server-generated UUID that exists once per MCP stdio server process incarnation |
| Tuple | The exact trimmed self-reported `brand`, `model`, and `version` strings |
| LLM persona | One immutable tuple, one canonical nickname, and its historical authored state |
| Human base name | The value entered in the viewer, such as `alex` |
| Human canonical ID | The server-generated visible nickname, such as `human-alex-1` |
| Bound | A database row currently carries a connection nonce; this does not imply liveness |
| Retired LLM | A terminal LLM identity with `retired_at` set; it cannot post, read-advance, claim, join, or bind again |
| Present | A room membership whose `left_at` is null |
| Active | Existing listener-recency behavior; it must not be derived from connection binding |

## LLM identification contract

Replace `create_persona` and `resume_persona` with one tool named
`identify_persona`.

The name is intentional. The same call can create, reuse, or replace a persona,
so retaining `create_persona` would misstate idempotent reuse.

The input is:

| Field | Type | Requirement |
| --- | --- | --- |
| `brand` | string | Required maker or provider, trimmed, nonempty, at most 100 characters |
| `model` | string | Required exact self-reported model or family string, trimmed, nonempty, at most 100 characters |
| `version` | string | Required, trimmed, nonempty, at most 100 characters |
| `description` | string | Optional creation metadata, at most 2,000 characters |

`description` is not part of the identity tuple. It is stored when a persona is
created. Repeating identification for the same tuple returns the stored value;
it does not create a new persona merely because a different description was
offered. A separate profile-edit feature is outside this scope.

The tool accepts no other identity fields. Strict unknown-key rejection remains
in force.

An explicit identification operation is preferable to placing the tuple only
on `join_room`. `create_room` already requires a bound persona before any room
can be joined. A join-only design either breaks room creation or duplicates
identity logic across tools.

### Identification outcomes

The decision uses both process memory and the database. A matching nonce in the
database is not by itself proof that the current process created it.

| Process state and database state | Offered tuple | Result |
| --- | --- | --- |
| This process has never bound, and no row has its generated nonce | Any valid tuple | Allocate a new nickname and record the binding |
| This process has never bound, but a row already has its generated nonce | Any valid tuple | Treat this as a UUID collision, generate another nonce, and retry without reusing that row |
| This process has recorded a binding, and the expected agent ID, epoch, and nonce all match the row | Exact match | Return the same nickname and epoch without mutation |
| This process has recorded a binding, and the expected agent ID, epoch, and nonce all match the row | Any field differs | Retire the old persona and allocate a new bound persona atomically |
| This process has recorded a binding, but its expected row is missing or any binding field differs | Any tuple | Fail with `persona_lost` or an integrity error; never attach to a row merely because its nonce matches |
| Rows exist for other nonces or retired tuples | Same or different tuple | Ignore them for binding and allocate a distinct nickname |

The process nonce is mutable only before the first successful binding so the
UUID-collision retry is real rather than documentary. After binding, the
process records the expected agent ID, epoch, and nonce and does not regenerate
or recover them from an arbitrary database row.

The response must include:

- `agent_id`
- `brand`
- `model`
- `version`
- `persona_description`
- `runtime_epoch`
- `binding_reused`
- `identity_changed`
- `previous_agent_id` when a transition occurred
- `previous_room_count` when a transition retired present memberships
- `previous_room_names`, limited to 200 names
- `previous_room_names_truncated`, true when the count exceeds that limit
- the current build/staleness handoff fields already used by identity responses
- a next-action instruction to create or join a room

The response must not include:

- `connection_id`
- a resume word or replacement credential
- a caller-reusable nickname token
- a claim that the model tuple was verified

`whoami` continues to report the current persona tuple, agent ID, epoch, room,
and role. It does not report the connection nonce.

An unbound persona-scoped call must instruct the caller to invoke
`identify_persona` with its actual brand, model, and complete version string.

### LLM nickname allocation

Keep the current canonical shape:

`{brand-slug}-{model-slug}-v{version-slug}-{six-hex-token}`

The original tuple strings remain in structured columns. Slugging is only for
the visible canonical ID.

Allocation rules are:

- Lowercase tuple components for the slug.

- Collapse each non-alphanumeric run to one hyphen and trim leading and trailing
  hyphens.

- Reject a component from which no letter or digit survives.

- Keep the six-character random hexadecimal uniqueness token.

- Validate the complete candidate against the existing 200-character agent-ID
  bound.

- Insert atomically and retry a primary-key collision.

- If the normalized LLM base begins with the reserved literal prefix `human-`,
  prepend `llm-` before adding the random token. Validate the escaped complete
  ID against the 200-character bound. Changing only the token cannot fix a
  reserved-prefix collision.

- Never omit the random token, even when no matching tuple currently exists.
  Two valid simultaneous processes with the same tuple are a normal case.

The six-hex token has only 24 bits and is not a global identity guarantee by
itself. Correctness comes from atomic insertion and retry.

### LLM tuple transition

The complete transition runs in one `IMMEDIATE` transaction:

- Look up the one non-null `connection_id` row for this process nonce.

- Return it unchanged if its tuple exactly matches.

- Capture the old persona ID, the count of rooms in which it is present, and at
  most 200 room names for the bounded response.

- Clear the old row's `connection_id`.

- Set the old row's `retired_at`.

- Increment the old row's `runtime_epoch`.

- Set `left_at` and `last_seen` on every old membership that is still present.
  Keep the rows, roles, cursors, and join timestamps as historical state.

- Delete every wait lease owned by the old persona.

- Delete every advisory claim owned by the old persona. Do not transfer claims.

- Allocate and insert the new persona with the same process connection nonce,
  the offered tuple, a fresh nickname, epoch 1, and no memberships.

- Commit before changing process-local session state.

If nickname allocation or any cleanup fails, the transaction rolls back and the
old binding remains intact.

After commit, replace `session.agentId` and `session.epoch` with the new values
and clear `session.roomId`. Do not copy an active room, membership, cursor,
role, claim, mention inbox, or listener lease.

Every old in-flight mutation and marker-advancing read keeps the old ID and
epoch it captured. The increment makes its existing transaction-time epoch gate
fail with terminal `persona_lost`. An old poller command detects the changed
epoch and exits as stale. Checking `retired_at` in every guarded operation could
provide another fence, but the repository already has the epoch gate across
these paths. Reusing that established fence is the smaller change; connection
uniqueness alone is not a replacement for it.

### Process shutdown and hard crash

Normal stdin EOF and graceful shutdown should retire the process's currently
bound persona after tool requests and wait cleanup have finished. The update
must match the exact expected `agent_id`, `runtime_epoch`, and `connection_id`
captured by this process:

- increment the epoch
- clear the connection nonce
- set retirement time
- soft-leave present memberships
- remove wait leases
- apply the selected claim-deletion policy

If any guard differs, shutdown performs no identity mutation and emits a
bounded structured diagnostic. It must not retire whichever row happens to
carry one matching field. Cleanup is best effort and must finish before closing
the SQLite handle.

A hard kill cannot run this transaction. Its row may retain a non-null
connection ID and memberships may remain present indefinitely. That stale value
does not grant nickname possession because no future process can submit it, and
a first-bind UUID collision is regenerated rather than reused. It is still
operationally harmful: the stale member can inflate counts, receive pending
directed work, appear idle, and block non-forced pruning. Existing claim and
wait-lease expiry limits those rows but does not retire the persona or leave its
memberships.

Do not add a timeout-based retirement reaper in this change. A live CLI can be
idle longer than any selected timeout, so such a reaper can retire a valid
process.

## Human canonical identity

### Naming contract

The viewer treats the entered value as a base name, not an agent ID.

| User action | Canonical result |
| --- | --- |
| First independent viewer enters `alex` | `human-alex-1` |
| Another independent viewer enters `alex` | `human-alex-2` |
| Same browser refreshes | Reuses its stored canonical ID |
| Same browser joins another room | Reuses its stored canonical ID |
| Same browser explicitly changes to its current base | No-op; reuses its stored canonical ID |
| Same browser explicitly changes from `alex` to `sam` | Allocates the next `human-sam-N`, then soft-leaves recorded memberships for the old identity |
| Same browser later changes from `sam` back to `alex` | Allocates the next `human-alex-N`; it does not search for or silently revive an older `alex` identity |

Every human ID uses the lowercase literal `human-` prefix and a positive
decimal ordinal. There is no unsuffixed first-user special case.

The base-name contract is:

- preserve the entered case; base-name identity comparison is case-sensitive
- allow ASCII letters, digits, underscore, dot, and dash
- require the first character to be an ASCII letter, digit, or underscore
- allow 1 through 177 characters
- reject whitespace and control characters
- reject a base beginning with `human-`, case-insensitively

The 177-character maximum is derived from the existing 200-character agent-ID
limit, the six-character `human-` prefix, one separator, and a positive
JavaScript-safe integer with up to 16 decimal digits:

`6 + 177 + 1 + 16 = 200`

The ordinal is constrained to `1..9007199254740991`. The server still validates
the complete candidate before insertion.

Case preservation is contested. Case folding would prevent visually similar
`human-Alex-1` and `human-alex-1` namespaces, but it would also rewrite a
user-chosen visible name. This specification preserves current case-sensitive
name behavior. A requirement for case-insensitive human identity would flip the
call.

### Human identity is not ownership

A browser stores and resubmits the server-returned canonical ID. Without a
credential, the server cannot prove that the request came from the browser that
first received it.

The supported threat model is cooperative local use:

- Independent browsers that enter only `alex` do not collide.

- Same-origin tabs share one localStorage identity and intentionally act as the
  same human.

- Separate browser profiles, storage partitions, `localhost`, and
  `127.0.0.1` can allocate separate identities.

- A caller that crafts a request containing a known canonical ID can impersonate
  it. The numeric suffix does not prevent that.

A stable opaque browser credential would be required to prevent self-asserted
reuse. It is rejected from this scope because the owner requested naming and
accidental isolation, not human authentication.

### Human allocation and reuse

A fresh human allocation runs in one `IMMEDIATE` transaction:

- Validate the room, base name, and browser-generated allocation operation UUID.

- If the operation UUID already exists with the exact same room and base,
  return its previously allocated canonical ID without allocating another. If
  the same UUID is reused with a different room or base, reject it.

- Find the greatest existing `human_ordinal` for the exact `human_base`.

- Add one, bounded by `Number.MAX_SAFE_INTEGER`.

- Construct and validate the canonical ID.

- Insert the human agent row.

- Insert or revive its membership in the requested room.

- Record the operation UUID, requested room, exact base, and result agent ID in
  the same transaction.

- Return the canonical ID, base name, ordinal, room, and read marker.

SQLite write serialization plus a partial unique index on
`(human_base, human_ordinal)` prevents concurrent allocation of one ordinal.
Agent rows are retained, so an ordinal is never reused until the mandated whole
database reset.

A repeated allocation operation is idempotency, not ownership. It does not
authenticate the browser, and replay after the membership was later left does
not silently reopen that membership. The caller can make a separate canonical
rejoin.

A canonical-ID reuse joins only an existing human row. It never selects an
identity by searching for the first matching base name. Its membership upsert
is already idempotent and needs no allocation operation UUID.

### Human leave and Change name

Explicit room leave remains resumable and does not retire the human identity.

Explicit Change name remains a reversible browser workflow:

- an unchanged exact base is a no-op
- persist a pending allocation operation before issuing a network request
- allocate and join the new canonical identity idempotently
- make the returned canonical ID the browser's current identity
- soft-leave each membership recorded for the old canonical ID
- preserve failed old leaves in the ghost ledger for later retry

There is no server endpoint that accepts an old human ID and terminally renames
or retires it. Such an endpoint would let an unauthenticated caller retire
another cooperative user's identity globally.

The old agent row, messages, memberships, roles, cursors, and join timestamps
remain. Successfully processed memberships are soft-left and can be rejoined
later by submitting that exact canonical ID. The normal viewer retains only the
new current identity, so returning to an earlier base through Change name
allocates the next ordinal instead of discovering an old row.

This choice has a real cost. An abandoned browser, failed cleanup, cleared
localStorage, private-window closure, or origin change can leave a human
membership present indefinitely. Even a successfully soft-left old membership
retains its cursor and can continue blocking non-forced pruning under the
current resumable-membership policy. No timeout is safe without a credential or
reliable browser-liveness source.

## Database replacement schema

Replace the DDL source in `src/db.ts` and apply it only by creating a new
database file. Do not alter an existing database in place and do not write a
migration.

### Agents columns

| Column | New schema |
| --- | --- |
| `id` | Existing text primary key and canonical nickname |
| `is_human` | Existing integer discriminator, restricted to 0 or 1 |
| `brand` | Text, non-null only for LLM rows |
| `model` | Text, non-null only for LLM rows |
| `version` | Text, non-null only for LLM rows |
| `resume_word` | Removed |
| `connection_id` | New nullable text process nonce, non-null only for a currently bound LLM row |
| `human_base` | New nullable text, non-null only for human rows |
| `human_ordinal` | New nullable positive integer, non-null only for human rows |
| `runtime_epoch` | Retained monotonic integer, default 1 |
| `retired_at` | New nullable UTC database timestamp, used only for terminally retired LLM rows |
| `description` | Existing nullable text |
| `created_at` | Existing creation timestamp |

`connection_id` is an internal association. It must not be included in message
columns, ordinary agent listings, recipient output, viewer JSON, tool inputs,
or tool responses.

### Valid agents row shapes

| Shape | Human fields | LLM tuple | Connection | Retirement |
| --- | --- | --- | --- | --- |
| Current human | Non-null | Null | Null | Null |
| Connection-bound LLM | Null | Complete | Non-null | Null |
| Explicitly retired LLM | Null | Complete | Null | Non-null |

The phrase connection-bound deliberately does not say live. A hard-killed
process can leave that structural shape behind.

The table checks must enforce:

- `is_human` is exactly 0 or 1.

- Human rows have null brand, model, version, connection ID, and retirement
  time.

- Human rows have a `human_base` of 1 through 177 ASCII characters using only
  letters, digits, underscore, dot, and dash. The first character is a letter,
  digit, or underscore, and the base does not begin with `human-` under ASCII
  case-insensitive comparison.

- Human rows have a positive `human_ordinal` no greater than
  `9007199254740991`.

- A human row's `id` equals `human-`, its stored base, a hyphen, and the
  canonical decimal ordinal.

- Every human ID begins with the exact reserved lowercase prefix `human-`.

- LLM rows have a complete non-null tuple and null human fields. SQL enforces
  nonempty values, the 100-character bounds, and no NUL. The TypeScript store
  additionally enforces exact JavaScript `trim()` normalization before insert
  or comparison.

- A non-retired LLM row has a non-null connection ID.

- A retired LLM row has a null connection ID.

- No LLM row begins with `human-` under ASCII case-insensitive comparison.

- Every complete ID remains inside the 200-character limit.

JavaScript validation remains responsible for full trim semantics, clear error
messages, and UUID format checks. The SQL shape check is still required because
`web/server.mjs` and direct tests write through their own SQLite handles. Its
reserved-prefix test must be case-insensitive, for example by comparing
`lower(substr(id, 1, 6))` with `human-`.

### Human allocation operations

Add a small `human_allocations` table:

| Column | Requirement |
| --- | --- |
| `operation_id` | Primary-key text UUID generated by the browser |
| `room_id` | Positive safe integer from the allocation request |
| `human_base` | Exact validated base from the allocation request |
| `result_agent_id` | Non-null foreign key to the allocated human agent |
| `created_at` | Database creation timestamp |

Do not add a foreign key from `room_id` to `rooms`. Room deletion must not erase
the record needed to recover a committed allocation response. A replay for a
deleted room returns the recorded identity without allocating another and
reports that the requested room is no longer joined. The operation ID is bound
to the exact room and base payload; reuse with any different payload is an
error.

The table has no legacy import, ownership, login, or cross-device purpose. It
can grow by one row per fresh human allocation or actual name change. Do not
add retention cleanup until a supported lifetime and safe recovery window are
defined.

### New indexes

Add:

- a unique partial index on `agents(connection_id)` where the value is non-null
- a unique partial index on `(human_base, human_ordinal)` for human rows

The `human_allocations` primary key supplies its operation lookup. Keep the
existing agent primary key and message, membership, claim, and wait indexes. No
new retirement index is justified because affected queries already reach an
agent through its primary key.

### Store operation changes

Replace the split persona creation and resume operations with one atomic store
operation that identifies by connection nonce and tuple.

Remove:

- resume-word generation and validation
- `attachPersona`
- the resume-specific tuple mismatch error
- any latest-resume-wins wording

Retain and adapt:

- `PersonaLostError`, with retirement/replacement wording
- `runtime_epoch` checks inside every guarded transaction
- atomic random nickname insertion and retry

Add store operations for:

- LLM identification, tuple reuse, and tuple transition
- graceful connection retirement
- retired-recipient lookup

Human allocation and canonical rejoin remain SQL transactions in
`web/server.mjs`. That file deliberately owns a separate SQLite handle and does
not import `ChatStore` or the TypeScript build. Keep cross-writer invariants in
the database schema instead of adding a new shared abstraction for this change.

### Membership, routing, and pruning changes

Soft-leaving a retired LLM already removes it from present-member counts,
pending directed work, ordinary mention inboxes, and watcher eligibility.

Additional changes are required:

- `listAgents` must expose a `retired` boolean for historical LLM membership
  rows. A retired row is always `present:false`, `active:false`, and
  `watching:false`.

- Recipient status must distinguish `retired` from `left` and `unknown`.
  `unknown` means no known identity or no room participation; `retired` means
  the known nickname can never receive work.

- A post explicitly mentioning a retired LLM ID may remain valid history, but
  its recipient status and delivery warning must say it is terminally
  undeliverable. Do not redirect it.

- A reply to a retired LLM author's message remains a reply to that historical
  author. Do not route it to the replacement persona.

- Both non-forced pruning blocker queries must join `agents` and ignore rows
  whose `retired_at` is non-null. Active and resumably left human identities
  continue to protect unread messages.

- Retirement must delete wait leases immediately even though epoch fencing also
  makes an old waiter fail. The row must not advertise a dead watcher.

- Retirement must apply the selected claim policy explicitly. Membership state
  alone does not affect claims.

Messages continue to reference the retained agent row, so old authorship,
mentions, replies, and search results remain readable.

## Process state, concurrency, and races

Add a process-level `connectionId` generated with `randomUUID()`, plus an
explicit flag recording whether this process has completed a binding. Retain
the existing session agent ID, epoch, and active room. The nonce can be
regenerated only while that flag is false.

The database mapping and the process's recorded binding must agree for identify
decisions. Process memory is not merely a cache during collision handling; it
is what distinguishes this process's established mapping from a coincidentally
equal UUID already stored by another process.

The current server deliberately orders tool-handler starts because MCP requests
can be dispatched concurrently. Identification and process-session assignment
must complete synchronously before the handler's first `await`, just like the
current state-binding prefixes. Otherwise a later call can capture the old
identity while a transition is still pending.

Required race behavior:

- Two `identify_persona` calls on one connection execute their identity-changing
  prefixes in arrival order.

- Two server processes with the same tuple cannot share an agent row because
  neither can submit a nickname and both insert random-suffixed IDs atomically.

- A UUID collision on first bind must regenerate and retry before any process
  binding becomes observable.

- A nickname-token collision retries inside the same transition transaction.
  Exhaustion rolls the transition back.

- A stale old-epoch mutation that races retirement either commits before the
  retirement transaction or fails after it. It cannot commit under old
  authority after retirement.

- A concurrent human allocation for one base receives a different ordinal.

- Human allocation, rejoin, identity-state replacement, and ghost-ledger
  changes remain serialized by the browser's Web Lock. The server transactions
  supply cross-process allocation and membership correctness.

## MCP instructions and diagnostics

The short server instructions and the persona section of the operating manual
must describe this sequence:

`identify_persona -> list_rooms or create_room -> join_room -> catch_up`

Instructions must say:

- provide actual self-reported brand, model, and complete version
- send version as a string and preserve a known `.0`
- call identification before creating or joining a room
- repeated exact identification on one MCP process is idempotent
- a changed tuple creates a new nickname and retires the old one
- a restarted MCP process receives a new nickname
- do not save a nickname or connection value for takeover in another process
- model identity is self-declared

Remove all instructions to save or recover a resume word.

The unbound errors for `create_room`, `join_room`, posting, advancing reads,
claims, and watcher creation must point to `identify_persona`.

The probe showed more process and request metadata than production identity
needs. Production diagnostics should write bounded structured JSON records to
stderr, or escape control characters equivalently, and include only useful
correlation data:

- process UUID
- PID
- process start time
- client-reported name and version only after MCP initialization has supplied
  them
- identify outcome: created, reused, transitioned, or gracefully retired
- canonical agent ID and tuple involved in that outcome

Never write diagnostics to stdout because stdout carries MCP JSON-RPC. Cap
every free-form field before serialization so a self-reported tuple or client
field cannot create unbounded log records.

Do not log authorization data, cookies, headers, tokens, raw request metadata,
or progress tokens. Do not treat JSON-RPC request IDs or tool-use IDs as stable
identity. The detailed sanitized probe may remain a manual diagnostic, but the
production server must not turn all request metadata into a permanent log.

## HTML viewer and HTTP API changes

### HTTP fields

Stop using `name` for both an entered base and a canonical identity.

Fresh join accepts:

- `room`
- `base_name`
- `operation_id`

Canonical rejoin accepts:

- `room`
- `agent_id`

A join request containing both forms or neither form is rejected.

Join returns at least:

- `agent_id`
- `base_name`
- `human_ordinal`
- `room_id`
- `last_read_seq`

`post`, `read`, `leave`, and `me` operate on canonical `agent_id`, not a base
name.

Every identity-bearing human participation path must verify the applicable
identity shape:

- fresh allocation validates the room, base, and operation UUID and does not
  accept an existing agent ID
- canonical rejoin accepts only an existing row with `is_human = 1`
- `post`, `read`, `leave`, and `/api/me` accept only an existing row with
  `is_human = 1`
- operations that require current presence also require a present membership

This check must include `/api/leave`. The current leave implementation updates
any matching membership and can therefore soft-leave an LLM identity through a
crafted local request.

Do not broaden this identity change into unrelated web authorization.
`/api/delete-room` retains its current authority model.

No web endpoint returns or accepts an LLM connection ID.

### Browser identity state

Replace the stored identity string with one versioned object containing:

- `current`, either null or the current `base_name` and `agent_id`
- `pending_allocation`, either null or the operation UUID, requested room and
  base, previous canonical ID, and the previous recorded memberships needed
  for Change name recovery

The canonical ID is the authority for:

- the joined-room map
- posts
- reads and marker ownership
- `/api/me`
- leaves
- mentions
- directed-at-me styling
- the composer identity
- `you` badges
- cross-tab storage events

The browser must store the `agent_id` returned by the server. It must not
construct one or continue storing the submitted base as if it were the agent
ID.

Before any fresh allocation or actual Change name request, the browser creates
an operation UUID with `crypto.randomUUID()` and persists the complete pending
operation. It then sends that same UUID until the server returns the recorded
allocation. The final identity replacement and pending-state removal use one
`localStorage.setItem` of the versioned object. If that write throws, the
pending operation remains and reload replays it instead of allocating another
nickname.

The name input and Change name form show the base name, such as `alex`. The
composer and chat stream show the canonical nickname, such as
`human-alex-1`. This avoids producing `human-human-alex-1` when the form is
prefilled.

If a stored identity exists and the user joins another room without choosing
Change name, the browser sends its canonical ID and reuses it. Entering a base
on a fresh browser always allocates a new ordinal.

The joined UI must distinguish these actions:

- `Join as human-alex-1` reuses the stored canonical identity
- `Change name` opens an explicit allocation mode

Editing a prefilled base while merely joining an unjoined room must not silently
allocate a different identity. An unchanged exact base in Change name mode is a
no-op.

Same-origin tabs retain the current Web Lock. A tab must re-read identity state
inside the lock before deciding whether to allocate or reuse, so two initially
empty tabs do not both allocate identities accidentally.

After a Change name allocation succeeds, the browser must make cleanup
crash-recoverable before issuing old-identity leaves:

- add every recorded old `(room, agent_id)` pair to the ghost ledger
- persist the returned canonical identity and clear the pending operation
- soft-leave each old pair, removing it from the ledger only after success

If the ghost-ledger write fails, do not switch identities or issue leaves; keep
the pending allocation for retry. On startup, recover a pending allocation
before processing the ghost ledger. This order handles a crash after the server
committed but before either browser write completed.

### Message rendering

Human messages use the complete canonical `from` ID as the primary visible
label. Mentions use the same full value, for example `@human-alex-1`.
Human IDs can also reach 200 characters, so narrow layouts must wrap them or
provide an untruncated reveal and copy path without hiding the ordinal.

LLM messages may retain the model as the primary short label, but the full
canonical agent ID must remain visible or directly revealable. The current
secondary `.who-id` text can ellipsize the random suffix in a narrow viewport,
which hides the only distinction between two same-model processes. At minimum,
the untruncated ID must be available through a title, copy action, or expanded
layout in both the message stream and search results.

Message grouping, color assignment, reply identity, and `you` badges must
continue to use the full canonical `from` value. They must never group on model
label or human base name.

Room member counts continue to count only memberships with null `left_at`.
Retired LLM identities are therefore excluded after their retirement
transaction. Successfully cleaned old human identities are also absent from the
present count, but their retained unread cursors can still affect pruning.

## Destructive database and browser cutover

The cutover is deliberately destructive.

Required deployment sequence:

- Build and verify the replacement before touching the active database.

- Stop every MCP server process, background poller, blocking wait, and HTML
  viewer.

- Confirm those processes have exited. The viewer caches open read and write
  SQLite handles and must not remain attached while the file is replaced.

- Close every browser tab running the old viewer. An old loaded page can retain
  stale identity code and issue mutations after the replacement server starts.

- Resolve the configured database path. The default is
  `~/.agent-chat-mcp/chat.db`; tests and custom deployments may use
  `AGENT_CHAT_DB`.

- Delete the database file and its matching `-wal` and `-shm` sidecars.

- Do not open the old database to migrate or translate it.

- Start one replacement MCP server so the new schema is created.

- Start the replacement viewer, hard reload newly opened tabs, and then start
  fresh client sessions.

- Every LLM calls `identify_persona` and receives a new nickname.

- Every human enters a base name and receives a new `human-...-N` nickname.

The viewer must use a new localStorage namespace and explicitly remove these
old keys before any membership retry or network mutation:

- `agent-chat.room`
- `agent-chat.seen`
- `agent-chat.identity`
- `agent-chat.joined`
- `agent-chat.ghosts`

The replacement keys are:

- `agent-chat.v2.room`
- `agent-chat.v2.seen`
- `agent-chat.v2.identity`
- `agent-chat.v2.joined`
- `agent-chat.v2.ghosts`

This is required because room integer IDs restart after database deletion while
localStorage survives. The current viewer retries old ghost leaves before it
loads rooms, so stale browser state could target a newly created unrelated room
or identity.

`localhost` and `127.0.0.1` are separate storage origins. Repeat the old-key
removal and hard reload for every origin that has served the viewer. The new
viewer must remove old keys before pending-allocation recovery, ghost retry, or
any other network action.

A database-generation UUID would detect later same-version wipes, but it adds a
table, response field, and browser comparison not required for this one planned
cutover. Defer it unless repeated same-version destructive resets become a
supported operation.

## Source change inventory

### `src/db.ts`

- Remove `resume_word` from `PersonaRow`, DDL, checks, inserts, and validation.

- Add `connection_id`, `human_base`, `human_ordinal`, and `retired_at`.

- Add the `human_allocations` table.

- Rewrite the `agents` shape check and add the two partial unique indexes.

- Replace `tryCreatePersona` and `attachPersona` with atomic connection-aware
  identification and retirement operations.

- Retain epoch fencing and change takeover wording to identity replacement or
  retirement.

- Add retired state to agent and recipient result types.

- Update `listAgents`, recipient status, and both prune blocker queries.

- Delete claims and wait leases according to the selected retirement policy.

- Keep current no-migration schema initialization.

### `src/index.ts`

- Import `randomUUID` and create one process connection nonce.

- Extend process session state with binding-established state and the expected
  agent ID, epoch, and nonce used by collision handling and cleanup guards.

- Replace `create_persona` and `resume_persona` registration with
  `identify_persona`.

- Remove resume-word limits, vocabulary, generation, responses, error paths, and
  manual text.

- Remove resume-specific tuple mismatch rendering.

- Rewrite `requirePersona`, `PersonaLostError` handling, server instructions,
  operating manual, tool descriptions, and next-action text.

- Keep handler-start ordering and perform identification state changes before
  any await.

- Clear the active room after a tuple transition.

- Run graceful retirement during shutdown after active requests finish and
  before the store closes, guarded by exact expected agent ID, epoch, and
  nonce.

- Add bounded stderr connection and identity diagnostics.

- Keep the current semantic LLM nickname allocator, atomic retry, and ID bound,
  with deterministic `llm-` escaping of a reserved human prefix.

### `src/poller.ts`

- Keep owner-PID and epoch checks.

- Update stale-binding and recovery text that currently assumes a newer runtime
  took over the same persona.

- Verify an explicitly retired identity exits and cannot report updates.

### `src/check.ts`

- Join the `agents` row when evaluating an explicit agent ID.

- Report a terminal retired-LLM status instead of treating that row as merely
  `left_all` or quiet.

- Keep the one-shot diagnostic read-only and do not add connection-nonce input
  or recovery behavior.

### `web/server.mjs`

- Replace self-chosen full IDs with base-name allocation and canonical-ID reuse.

- Add the `human_allocations` idempotency lookup and fresh-allocation
  transaction.

- Change post, read, leave, and me fields to canonical `agent_id`.

- Gate canonical rejoin, post, read, leave, and me on a human row.

- Return base, ordinal, canonical ID, and membership state from allocation and
  canonical rejoin.

- Do not add a terminal human rename endpoint.

- Keep LLM connection information out of viewer queries and JSON.

- Keep room counts based on present membership only.

### `web/index.html`

- Move browser state to the new namespace.

- Remove all old keys before pending recovery, ghost retry, or a membership
  call.

- Store the current base/canonical identity and pending allocation in one
  versioned object.

- Use the returned canonical ID for every identity-sensitive operation.

- Keep the base name in the input and canonical ID in the composer.

- Generate and replay allocation operation UUIDs across lost responses and
  failed storage writes.

- Keep the ghost ledger, use canonical agent IDs in it, and populate every old
  membership before the Change name leave loop begins.

- Separate the reuse action from explicit Change name so editing a prefilled
  base does not silently allocate.

- Ensure full LLM and human nicknames remain revealable when layout truncates
  them.

- Preserve full-ID grouping, hue, mention, reply, and `you` behavior.

### `scripts/connection-probe.mjs`

No production behavior depends on this probe. It may remain as a manual client
boundary diagnostic. It is evidence that the UUID is generated by the process,
not MCP. Production identity tests must exercise the real server rather than
assuming the probe and production lifecycle are equivalent.

### Tests

`test/features-persona.mjs` requires the largest rewrite because it currently
specifies resume words, latest-resume takeover, tuple mismatch, epoch races,
wait fencing, and poller behavior.

Identity setup or expectations also occur in:

- `test/features-v0100.mjs`
- `test/features-v0110.mjs`
- `test/features-v0120.mjs`
- `test/features-v05.mjs`
- `test/features-v090.mjs`
- `test/fixes-v052.mjs`
- `test/fixes-v061.mjs`
- `test/fixes-v063.mjs`
- `test/fixes-v064.mjs`
- `test/fixes-v07.mjs`
- `test/fixes-v071.mjs`
- `test/fixes-v0710.mjs`
- `test/fixes-v072.mjs`
- `test/fixes-v078.mjs`
- `test/fixes-v082.mjs`
- `test/fixes-v084.mjs`
- `test/fixes-v09.mjs`
- `test/mcp-lifecycle-v0121.mjs`
- `test/my-mentions.mjs`
- `test/persona-helpers.mjs`
- `test/poller-lifecycle-v0121.mjs`
- `test/web-participate.mjs`

`test/persona-helpers.mjs` must replace resume words and `bindArgs` with
connection-aware creation helpers and valid human rows. Some listed suites may
need only transitive helper updates, but each must be rerun because it imports
the identity setup path.

Add a dedicated identity test file only if the rewritten persona suite would
become less readable. If added, register it in `test/run-suite.mjs`.

Keep current-schema FTS repair coverage. Repairing indexes for the one current
schema is not legacy data support.

Do not add migration or old-database compatibility tests.

### User documentation and release metadata

- Rewrite the README quick start, prompts, identity section, watcher handoff,
  human viewer section, and limitations.

- Rewrite `docs/Installation.md` startup and later-session instructions.

- Add a supersession note to the older product-friction design document so two
  identity specifications do not remain authoritative.

- Remove every instruction to save an ID or resume word for another process.

- Explain human base names and canonical numbered IDs.

- Bump the package version for the intentionally breaking tool and database
  contract. Update both `package.json` and the root package metadata in
  `package-lock.json`. This document does not choose the release number.

- Do not edit generated `dist` files. Produce them through the existing build.

## Validation strategy

A misleading result would be a green store-only test: it could pass while the
MCP schema still accepts a saved nickname, two real processes share state, the
browser stores `alex` instead of `human-alex-1`, or an old poller remains live.
The current Node subprocess and temporary-SQLite harness can execute the
server, store, race, and HTTP cases. Browser state and multitab behavior can be
executed with the local viewer and Chrome DevTools, but the repository has no
current automated browser suite, so automation remains a validation gap until
one is added.

| Behavior | Executable verification | Misleading pass to prevent | Condition that makes the design wrong |
| --- | --- | --- | --- |
| Same process, same tuple | Call `identify_persona` twice over one real stdio process and inspect one mapping | Returned strings match because of process cache while the database mapping is absent | Idempotent identification must refresh or mutate another required field |
| Same process, changed tuple | Identify A, start a wait, identify B, then inspect rows, memberships, claims, leases, session, and old call result | New ID exists while old writes can still commit or cleanup is partial | Model transitions are required to preserve old operational state |
| A to B to A | Perform three identifies in one process and assert three distinct IDs | Test checks only adjacent inequality and accidentally reuses first A | Retired identities must be revivable |
| Two processes, same tuple | Start two actual MCP subprocesses concurrently and inspect distinct UUID mappings and IDs | Sequential in-memory test never crosses the process boundary | One persona is intentionally a shared work queue |
| First-bind UUID collision | Inject a deterministic duplicate UUID, start an unbound process, and assert it regenerates before allocation | Test creates the collision only after process binding, which exercises a different integrity failure | UUID generation cannot be injected or controlled in tests |
| Process restart | Stop one real subprocess gracefully, start another with the same tuple, inspect retirement and new ID | Test changes tuple too, so it never proves restart isolation | Stable identity across process restarts becomes required |
| Guarded graceful shutdown | Change the expected epoch or nonce before cleanup and assert shutdown mutates no row | Cleanup succeeds only in the matching case and an unguarded delete remains | Shutdown is allowed to retire a replacement binding |
| Hard kill | Kill a bound process without cleanup, start another, and verify the stale nonce grants no authority while its memberships remain stale | Only graceful shutdown is tested, hiding the accepted ghost behavior | Product requirements demand immediately accurate membership, pending work, and pruning after crashes |
| Epoch fencing | Race old post, advancing read, wait, and poller operations against tuple transition | Only the row epoch changes while a stale transaction commits | Connection transition is externally serialized before any old operation can exist |
| LLM schema shapes | Attempt every SQL-enforced valid and invalid direct shape, then exercise store-only trim and UUID validation | MCP validation passes while direct web or SQL writers create half-rows | Direct database writers are removed entirely |
| Version preservation | Identify with `"5.0"` and assert exact response, row value, tuple reuse, and `v5-0` slug | Nickname looks correct after numeric coercion while structured value became `"5"` | Model versions are deliberately numeric |
| Reserved human prefix | Identify an LLM tuple whose normalized base starts `human-` and assert a distinct `llm-human-...` ID within 200 characters | Only the common allocator path is tested, so human and LLM namespaces can overlap | The two populations move to separate ID columns or namespaces |
| Transition response bound | Retire more than 200 present room memberships and inspect count, names, and truncation flag | A small fixture never exercises response growth | Every prior room name must be returned regardless of size |
| No takeover surface | Inspect tools/list and call schemas for removed fields and tools | Runtime rejects resume but still advertises it and models keep trying | A compatibility window is required |
| Human allocation | Fresh `alex` joins allocate ordinals 1 and 2, including a concurrent race | Sequential allocation passes while two concurrent requests get one ID | Humans are intended to share one identity by base |
| Human allocation recovery | Repeat one operation UUID after a lost response and after a simulated `localStorage.setItem` failure; assert one agent ID and one allocation row | Retry test reuses a cached response without reaching SQLite | Duplicate human identities are acceptable after ambiguous client failure |
| Human operation payload binding | Reuse one operation UUID with a different room and with a different base and assert both fail | Test repeats only the exact payload and misses token reuse as a second allocation request | Operation IDs are intentionally reusable across payloads |
| Human reuse | Refresh, join another room, leave, and rejoin with stored canonical ID | API test resubmits a hand-written ID while the browser still stores the base | Browser identity must be authenticated rather than self-asserted |
| Human Change name recovery | Crash after allocation commit, after ghost-ledger save, and during the leave loop; reload and assert one new identity plus retryable old leaves | Happy-path rename finishes and never exercises cross-key storage ordering | Change name must be one authenticated server transaction |
| Human old-ID reversibility | Change names, then canonically rejoin the old ID and verify its retained history and cursor | Test only checks that the new ID works and accidentally introduces terminal retirement | Human identity becomes authenticated and terminal rename is approved |
| Human web gates | Try canonical join, post, read, me, and leave with human and LLM IDs | Tests omit leave, which is the current ungated path | Web participation is intentionally allowed to operate LLM memberships |
| Human display | Inspect stream, search, composer, name form, mentions, replies, and `you` badge | Endpoint JSON is correct while UI still displays or compares the base | The viewer should hide canonical IDs |
| Narrow viewport human display | Render a 200-character canonical human ID and inspect the distinguishing ordinal | DOM contains the ID while CSS makes it unavailable | Canonical human identity need not be visible |
| Narrow viewport LLM display | Render two same-model IDs whose only difference is the suffix | DOM contains both IDs while CSS hides the distinguishing text | Full identity is intentionally available only on inspection elsewhere |
| Retired LLM pruning | Leave an unread retired LLM membership behind and prune without force | Member counts drop while its cursor still blocks pruning | Retired LLM unread state must continue protecting history |
| Abandoned human pruning | Change name or lose browser storage with unread human memberships, then inspect non-forced prune refusal | Test marks everything read and hides the accepted blocker | Human memberships may be expired or ignored safely without authentication |
| Claim policy | Retire a claim holder and inspect availability immediately and at former TTL | Test checks only membership and misses the independent claim row | Claims are required to survive persona retirement |
| Fresh cutover | Seed every old localStorage key on each used origin, replace a temporary DB, load the viewer, and capture requests | New keys work while an old ghost leave fires before key removal or a stale tab remains open | Old browser state is intentionally retained |
| Full regression | Run changed-path tests, full suite, build, and `oxlint` over changed TypeScript and JavaScript | Existing tests pass because they still encode behavior intentionally removed | Another supported surface was omitted from the inventory |

The browser concurrency case must use separate profiles or storage partitions
when it intends independent humans. Two tabs on one origin share localStorage
and should reuse one human identity.

After implementation, run at minimum:

- focused persona and web tests
- MCP lifecycle and poller lifecycle tests
- the full repository suite
- `npm run build`
- `oxlint` over changed TypeScript and JavaScript sources, including
  `web/server.mjs`
- a real two-process stdio identity test
- browser or parser validation of the inline viewer JavaScript
- a real browser check for storage cutover, pending-operation recovery,
  Change name cleanup, and canonical display

No test should read or convert an old production database.

## Acceptance criteria

The implementation is complete only when all of these are true:

- A project-memory copy of another process's old nickname and former resume word
  cannot influence identification because neither value is accepted.

- Two CLI processes in one directory with the same tuple receive different
  nicknames and different stored process nonces.

- One process repeating the exact tuple receives the same nickname.

- A generated UUID that already exists before this process has bound is
  regenerated and never grants access to the existing row.

- One process reporting a changed tuple receives a new nickname, while the old
  nickname remains in history but has no current binding or operational state.

- Old-epoch writes, advancing reads, waits, and pollers cannot act after an
  explicit transition.

- The exact string `"5.0"` survives input, database storage, response, and
  same-tuple comparison.

- The tool registry and documentation contain no password-resume path.

- A human entering `alex` receives and visibly uses `human-alex-1`.

- An independent viewer entering `alex` receives `human-alex-2`.

- A refresh or room change in the same browser reuses its canonical human ID.

- Retrying a committed human allocation after a lost response or storage
  failure returns the same canonical ID and does not consume another ordinal.

- Human Change name allocates one new canonical ID, preserves the old ID as
  resumable, and records every failed old-membership leave for retry.

- Canonical rejoin, post, read, me, and leave reject LLM identities. Room
  deletion authority is unchanged.

- Human and LLM namespaces cannot overlap.

- Explicitly retired LLM identities do not count as present, receive pending
  work, advertise a watcher, or block pruning.

- A hard-killed LLM process cannot confer nickname authority on a new process,
  even though its stale membership and pruning effects remain an accepted
  limitation.

- Old messages retain their exact original author IDs and are never redirected
  to replacement identities.

- The cutover deletes the database, sidecars, and old browser keys and performs
  no migration or legacy read.

## Decision ledger

| Call | Status | Strongest counter-case | Evidence that flips it |
| --- | --- | --- | --- |
| Server-generated process UUID | Settled | It is not MCP-native identity | A supported transport multiplexes clients through one server process |
| Persist UUID in `agents` | Recommend, contested | Process memory is enough and crashes leave stale values | Database inspectability is declared unnecessary |
| Replace both persona tools with `identify_persona` | Recommend | Renaming the API increases tool churn | A separate create operation retains a distinct required behavior |
| No resume credentials or aliases | Settled | Restart continuity is lost | Owner reverses the clean-break and no-takeover requirement |
| Version as exact string | Settled | Callers can still self-report it inconsistently | Trusted host metadata becomes available |
| Exact trimmed tuple comparison | Recommend | Case-only variation creates a new persona | Provider normalization rules become authoritative |
| Preserve epoch fencing | Recommend | Every guarded transaction keeps a lookup | Proof that no old asynchronous operation can overlap a transition |
| Soft-leave retired LLM memberships | Recommend, contested | Dead roles and cursors consume storage and query complexity | Historical departed membership is explicitly not required |
| Ignore retired LLM memberships in pruning | Required with soft leave | It permits pruning data the retired participant never read | Retired LLM identities must retain unread veto power |
| Delete claims at retirement | Recommend, contested | External work may continue after the persona disappears | Real workflows require claim exclusivity beyond persona life |
| Delete wait leases at retirement | Recommend | Epoch and TTL already bound them | Immediate watcher truth is not required |
| Exact-guarded graceful shutdown retirement | Recommend | A transient restart permanently changes names | Cross-process identity continuity becomes required |
| No crash timeout reaper | Recommend | Hard crashes leave stale structural bindings | A reliable liveness source can distinguish idle from dead |
| Human IDs use `human-base-N` | Settled | Numbers imply ownership and add allocation state | Human authentication or shared-by-base semantics becomes required |
| Human identity remains self-asserted | Settled for this scope | Known canonical IDs can be impersonated | Owner requires possession security |
| Preserve human base case | Recommend, contested | Case variants are visually confusing | Owner requires case-insensitive names |
| Durable human allocation operations | Recommend | One retained row per allocation adds state | Duplicate identities after lost responses are accepted |
| No terminal human retirement | Required in this unauthenticated design | Old cursors and memberships can persist indefinitely | Human ownership authentication is added |
| Reversible browser Change name with ghost cleanup | Recommend, contested | It remains multi-request and can leave blockers until retry | An authenticated atomic rename endpoint exists |
| Reserve `human-` from LLM IDs | Settled | One allocator special case | Human and LLM types stop sharing the ID namespace |
| New localStorage namespace | Required | Old keys could merely be ignored | Old browser data is intentionally preserved |
| No database-generation UUID | Defer | Later same-version wipes can replay state | Repeated same-version destructive resets become supported |
| No automatic room handoff posts | Recommend | Peers may not notice the transition | Owner requires automatic notification |

## Source and verification notes

Repository sources inspected for this specification:

- `src/index.ts`
- `src/db.ts`
- `src/poller.ts`
- `src/check.ts`
- `scripts/connection-probe.mjs`
- `web/server.mjs`
- `web/index.html`
- `test/persona-helpers.mjs`
- `test/features-persona.mjs`
- `test/web-participate.mjs`
- `test/mcp-lifecycle-v0121.mjs`
- `test/run-suite.mjs`
- `README.md`
- `docs/Installation.md`
- `docs/AI Chat MCP Product Friction and Design Direction.md`
- `package.json`
- `package-lock.json`

Verified current facts include:

- one `StdioServerTransport` and one process-local session per server process
- handler-start ordering around process-local identity state
- process-generated probe UUID and null stdio transport session ID in the
  supplied Claude runs
- string-valued MCP version input and SQLite text storage
- current random semantic LLM nickname allocation and atomic retry
- current resume-word schema and takeover API
- current fresh-schema-only initialization
- current human self-chosen ID insert and browser localStorage behavior
- current ungated web leave endpoint
- current prune blocker queries include left memberships, which is why retired
  LLM rows need an explicit exclusion
- current viewer display of LLM model plus secondary canonical ID
- current cached viewer SQLite handles

No implementation, build, benchmark, browser run, or test execution is claimed
by this document. The probe observations came from owner-supplied output and
were not rerun during this documentation task.
