# Multi-Model Audit Prompt

Independently audit the current checkout of /Users/alexaustin/code/aichat. You are one of five reviewers. The coordinator will verify and fix confirmed findings, then run the identical prompt with the same five models on the updated checkout. Do not read the other reviewers' findings or the audit report before completing your independent analysis. Do not assume earlier audit results remain applicable.

## Authority and boundaries

This is a read-only review assignment. Do not change tracked files. Do not run git commit or git push. Do not spawn additional reviewers. Read applicable instructions. You may run bounded local checks and create disposable reproductions in a temporary directory, which you must remove. Never connect to, modify, prune, reset, delete, or open a writable handle to a user's live chat database. Set AGENT_CHAT_DB to a new temporary path for any process that might use a database; inspect the actual environment-variable contract first. Do not call application MCP tools or send messages to external services. Preserve every existing feature. Report problems, not stylistic preferences or hypothetical extensibility needs.

## Understand the actual system

Inspect package.json, repository status, source structure, test discovery, and the relevant code before asserting behavior. This project is a local SQLite-backed MCP chat service, with database logic in src/db.ts, MCP handling in src/index.ts, watcher/check commands in src/poller.ts and src/check.ts, a browser client in web/index.html, an HTTP server in web/server.mjs, shared Unicode and bounded-line helpers, and development/dispatcher scripts. Trace cross-layer paths rather than treating individual functions in isolation. Read installed dependency source/types when a conclusion depends on its actual API. Built dist files are generated: never edit them. Existing tests and memories are leads, not evidence that current behavior is correct.

## Search priorities

Review all production source, browser behavior, and operational scripts. Prioritize permanent loss, unintended changes, and cross-room or cross-persona mistakes; then races, reliability, and resource consumption. Specifically inspect transaction boundaries, partial success, rollback, read-modify-write, concurrent SQLite connections, room deletion/pruning, foreign keys, messages/mentions/replies, read cursors, unread/directed work and claims. Inspect identity takeover, reconnect, stale ownership, leases, waits, aborts, overlapping calls, timers, lock replacement, signals, process exit, retries, duplicate work, and acknowledgement ordering. In the browser and HTTP layer inspect in-flight requests, room switching/deletion, draft preservation, reply state, stale responses, pagination gaps, UTF-8 streaming, disconnects, body limits, errors, and resource cleanup. In scripts inspect timeout handling, child-process lifetimes, bounded I/O, event parsing, build freshness, and delivery correctness.

Review efficiency without sacrificing features or consistency: full scans, repeated queries, N+1 reads, unnecessary writes/WAL churn, unbounded maps/listeners/buffers, polling costs, avoidable copying/parsing, retained payloads, hot-path synchronous work, and behavior as rooms/messages/connections grow. An optimization must have an observable workload and preserve ordering, cursor semantics, data visibility, and public behavior. Measure before/after when practical; otherwise clearly label expected effects unmeasured. Do not recommend caching or abstractions without evidence that they solve a concrete current cost.

## Evidence standard

For each candidate, trace a reachable trigger through the code to a user-visible consequence. Actively look for the strongest reason it might be correct: validation upstream, SQLite guarantees, serialized operations, deliberate contracts, and cleanup in another layer. Withdraw candidates defeated by that evidence. Distinguish confirmed defects from unverified suspicions. Prefer deterministic reproductions using isolated databases and real implementation paths. Use controlled scheduling/barriers for races; sleeps alone do not prove an interleaving. Do not run destructive probes or exploit chains. A relevant check must fail on broken code and exercise actual implementation, not merely a copied algorithm or a mock. State limitations for source-only conclusions, unsupported platforms, and checks you could not run. A passing suite alone does not prove absence of bugs.

## Required output

Send concise, actionable findings to the coordinator as they become solid, then a final consolidated report. For each finding include:

- Severity, title, and category: correctness, race, data integrity, reliability, or efficiency.
- Exact current source file and line(s), relevant caller/callee, and concrete trigger or interleaving.
- Expected behavior, actual behavior, and user-visible impact.
- Reproduction command or steps and actual observed result, or an explicit source-only/unverified label.
- Why the strongest counterargument does not resolve it, or the evidence still needed.
- Minimum feature-preserving fix, its costs/tradeoffs, and a regression check with one condition that would make the proposed fix wrong.

Deduplicate related symptoms under one root cause. Do not invent a quota of findings. If none remain, list what you inspected and what remains unverified. Include efficiency opportunities separately from correctness defects, and identify anything proposed that can be deleted entirely instead of adding complexity. Do not implement fixes. End your user-facing responses with the required AGENTS.md canary line.
