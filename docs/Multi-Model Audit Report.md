# Multi-Model Audit Report

Audit started from clean commit `bac290d` on `main`. The requested work covers two audit-and-fix rounds. Each round uses five independent reviewers at `ultra`: `gpt-6.1-sol`, `gpt-5.6-sol`, `gpt-6.1-terra`, `gpt-6-astra`, and `gpt-6-sol`. All five selectors were accepted by the built-in launcher. The separate supervisor service was unavailable.

Both rounds use the unchanged [audit prompt](Multi-Model%20Audit%20Prompt.md), SHA-256 `acfa43feb77e6161d9bd8e2ddb012bfa95b5d03d61eb293b33ecf2e51c716abf`. Reviewers initially have read-only assignments. The coordinator checks findings, deduplicates root causes, reviews implementation diffs, and runs verification. Tests and reproductions use isolated databases; no live chat database is used.

## First round

All five independent reviews completed. Eleven distinct defects or efficiency problems survived counterchecks. A further fast-completion ordering defect was reproduced during lifecycle implementation. The following fixes are implemented.

| Finding | Trigger and impact | Fix | Evidence |
| --- | --- | --- | --- |
| Human post retries duplicate committed messages | The server commits a post but its HTTP response is lost. Sending the retained draft again inserts a second message. | Keep one UUID per intended send and deduplicate exact payloads with the existing message-id index. Edited payloads and deliberate new sends get new IDs. | Actual client function, HTTP server, SQLite, and a proxy dropping a response after commit; isolated Chrome UI also retained one row after retry and created another for a deliberate identical send. |
| Returning to a room leaves already-sent text in the composer | Send in A, switch to B and back to A, then receive the successful response. The old visit guard prevents composer cleanup. | Clear an unchanged same-room/same-identity draft independently of the visit guard. Keep stream/search/follow changes visit-scoped. | Controlled client scheduling plus actual Chrome input, send, and room-selection events. Edited drafts survived another room round trip. |
| Successful-response JSON failures become false success | An incomplete or malformed HTTP 200 body resolves to an empty object. A read response can poison the marker and bypass gap protection. | Propagate successful-body parse/abort errors. Validate marker responses and existing markers before reads. | Before/after actual-function regressions for malformed bodies, body-reading aborts, invalid markers, and marker bootstrap recovery. |
| Reordered read acknowledgements regress browser state | A newer acknowledgement sets marker 2400, then an older response replaces it with 400. A trimmed window falsely appears gapped and read receipts stall. | Validate and max-merge automatic and explicit read acknowledgements for the captured room/identity. | Controlled reverse completion of actual automatic and mark-all handlers, including identity changes. |
| Mentions-only room summaries undercount unread | A room has one broadcast and one directed message. Global unread is two, but the room summary reports one. | Filter firing groups with HAVING while counting all unread peer messages. | Real CLI regression failed with room unread one before the fix and passed with two afterward. |
| Completed turns silently suppress pending delivery | A worker turn completes without advancing the durable chat cursor. The delivery key prevents every future attempt. | Retry under the existing two-attempt bound and report persistent unread work. | Real ChatStore with controlled worker completion; regressions also cover failed turns, in-flight work, and consumed work. |
| Normal dispatcher retains unused lifetime history | Completed messages, commands, turns, and dispatch records accumulate after their consumers are gone. | Stop unused normal-mode diagnostic collection after bootstrap and release unreferenced completed turns. Preserve self-test records. | Repeated-turn regression leaves normal-mode collections empty after settlement; referenced and self-test records remain available. No RSS benchmark was performed. |
| App Server exit leaves request timers alive | Initialization fails immediately, but rejected requests leave a 30-second timer keeping the dispatcher alive. | Cancel pending request timers when failing/closing the client. | Reviewer measured 30,073 ms on original code. Coordinator ran timer assertions and real-main failure tests after the fix. |
| App Server death is not supervised | Missing executable emits an unhandled error; post-bootstrap child exit leaves an incapable dispatcher running. | Propagate one terminal lifecycle failure, reject current/future requests, stop polling, and clean up waits and the child. | Missing-executable and post-bootstrap-exit fixtures execute the actual main path and terminate nonzero without the old hang. |
| Message paging scans full body length twice | Each body page fetches length in the envelope, then repeats length in the slice query. | Reuse the fetched codepoint count. | Full-method before/after benchmark and equivalent results, plus small-cap astral/control-character reconstruction and terminal-page checks. |
| Each dispatcher aggregates unrelated agents' pending work | Every tick pages the global pending view before filtering one worker in JavaScript. | Add an optional agent predicate before aggregation and use it in the dispatcher. Preserve the global tool behavior and keyset ordering. | Full-sweep benchmark, real database pagination regressions, and query plans showing the agent membership index replaces the global membership scan. |
| Fast turn completion leaves a completed turn active | Completion notification arrives before the start response; the response then reinstates the completed active turn. | Keep a completed turn idle when its delayed start response arrives. | Actual worker regression verifies the next directed delivery starts a new turn instead of steering the completed one. |

The custom-database generated-watcher candidate was withdrawn. The source explicitly treats alternate database routing as testing-only and prohibits advertising it in generated commands; the documented installation uses one default database. Changing that behavior would alter the intended product contract.

## Measured efficiency

Measurements used the original built database module and the updated module against the same disposable SQLite fixture. Five warmed batches alternated execution order. Returned delivery fields and sampled message slices were compared for equality. Idle duration was excluded from delivery comparison because it changes with wall time.

| Workload | Original median | Updated median |
| --- | --- | --- |
| Twenty 1000-codepoint slices of a 5,000,000-byte message | 116.55 ms | 73.97 ms |
| One worker inbox sweep with 400 other pending recipients | 242.38 ms | 0.37 ms |

These are workload-specific results, not production-wide speed guarantees. No CPU-profile or RSS claim is made. The filtered query plan uses `idx_memberships_agent_present` with agent and presence predicates; the unfiltered view retains its original semantics.

## Costs and preserved behavior

Web sends add a pending record per affected room and one indexed lookup per keyed post. Retry identity lasts for the page lifetime, and database deduplication lasts while the original message remains retained. A changed body, reply, or identity is a new intended send. Successful deliberate identical messages remain distinct.

A completed but unconsumed dispatcher turn can receive one repeated notice. Terminal failure is reported after the retry bound. Normal-mode unused diagnostics are discarded; bootstrap output, outstanding delivery state, and self-test observations remain available. Mentions-only wake summaries read broadcasts to report truthful totals; quiet intervals retain their existing wake gate.

No schema changes, migrations, dependencies, or live-data repairs are introduced. Length reuse relies on the supported append/delete message model; an application feature allowing in-place body edits would require revisiting snapshot consistency. Nothing further needs deletion beyond the removed redundant body scan and unused normal-mode histories.

## Verification status

The original baseline passed all 31 test files and 54 Vitest tests. Original lint produced four control-regex warnings and zero errors. The new scope/count checks failed before the source fix; the focused web regression run failed 29 checks before the web fixes. The coordinator independently ran the 16 database/dispatcher tests successfully and linted source, scripts, server, tests, and extracted inline browser JavaScript with the same four baseline warnings and zero errors.

The configured Chrome MCP could not start because its existing profile was locked. An isolated headless Chrome profile was used instead, against a disposable server/database. Real UI events verified lost-response retry deduplication, deliberate repeated sends, successful A-to-B-to-A composer cleanup, and edited-draft preservation. Response loss/delay was controlled at fetch completion; the HTTP proxy regression separately drops a real committed response.

The full first-round post-fix suite passed all 33 files and 105 Vitest tests, including the build. The second audit-and-fix round is pending. Live Codex service behavior, Windows process handling, and exhaustive multi-tab/browser/network interleavings remain unverified. Controlled worker fixtures do not establish all live App Server behavior, and passing tests cannot establish absence of further defects.
