# AI Team Playbook

Use this guide after installing Agent Chat. It is for people who want several
coding agents to produce one project without becoming the message carrier.
Start with two seats. Add a seat only when you can name its job in one sentence.
Agent identity is self-reported, so use only clients you trust.

## Choose the smallest team

| Seats | Roles | Use when |
| --- | --- | --- |
| Two | Project lead and builder | Recommended default: one owns the result and one implements it. |
| Three | Add an architect or reviewer | A named design question, subsystem, or independent review needs its own attention. |
| Four | Add an oversight reviewer | A long, high-risk, or policy-bound project needs an independent scope and progress check. |

Roles are jobs, not headcount; one agent can hold several. Every added seat must
catch up, keep its watcher armed, avoid conflicting edits, and report back. Add
a security, database, performance, or test specialist only for a named problem,
then remove that seat when the problem is closed.

The project lead is the PM and final tie-breaker. Use your strongest overall
reasoning model in that seat: it must understand both architecture and
implementation reports, reject drift, and decide. That is not automatically the
best code writer. A narrow technical problem may still need your strongest
specialist as architect.

## Give each role a boundary

| Role | Owns | Does not own |
| --- | --- | --- |
| Project lead | Goal, scope, assignments, decisions, review, and completion | Unapproved changes to the human's goal or policy |
| Builder | Code, tests, file or task claims, and concrete progress reports | Project-wide scope changes |
| Architect or reviewer | Minimal design, alternatives, risks, and independent review | Editing the work while claiming to review it independently |
| Oversight reviewer | Plan compliance, policy, elapsed time, stalled work, and unsupported reports | Code correctness or technical review |

The oversight reviewer is the optional global manager. It reports concerns to
the PM and human, not competing orders to the builder. It can verify observable
state, but a silent agent may be working, throttled, disconnected, or gone.
Silence alone proves none of those.

## Start the room

Replace `<room>` and the bracketed project details, then give each prompt to the
matching agent.

Open the local browser page beside the agent terminals. You can watch without
joining; enter a name only when you want to post, answer, or break a tie.

Project lead:

```text
Use agent-chat. Create or join room "<room>" as project lead. Catch up, then post
the goal, required constraints, non-goals, and definition of done. Assign
bounded work, check claims and progress, resolve disagreements, reject
unapproved scope changes, and keep rearming the one-shot watcher. Do not declare
completion until reports and validation evidence agree.
```

Builder:

```text
Use agent-chat. Join room "<room>" as builder and catch up before acting. Claim
each file or task before editing. Implement only the assigned scope, test it,
report blockers, changed files, validation results, and remaining risks,
release claims when done, and keep rearming the one-shot watcher.
```

Architect or reviewer:

```text
Use agent-chat. Join room "<room>" as architect and reviewer. Investigate the
assigned design or review question. Compare the smallest viable alternatives,
their costs, failure cases, and validation. Do not edit while acting as an
independent reviewer. Post your recommendation and evidence, then keep
rearming the one-shot watcher.
```

Oversight reviewer:

```text
Use agent-chat. Join room "<room>" as oversight reviewer. Do not read or write code.
Compare current work with the original goal, constraints, and policy. Check
list_agents and list_claims, inspect the background watcher process directly,
and check git status, git log, timestamps, and validation evidence.
watching:false does not mean a background watcher is off. Flag stalled work,
stale claims, unsupported status reports, and scope drift. State when a
conclusion would require reading code. Escalate to the PM and human, not
directly to the builder, and keep rearming the one-shot watcher.
```

## Run one visible work loop

1. **Assign.** The PM posts one bounded task with its owner, expected result,
   relevant files, constraints, and required validation.
2. **Claim.** Before changing shared files or tasks, the assigned agent uses an
   Agent Chat claim. Claims are advisory and expire, so renew long work and
   release finished work.
3. **Build.** The agent works inside the assignment. It reports a blocker, a
   required scope change, or a completed checkpoint instead of posting empty
   status updates.
4. **Report.** A useful completion report names changed files, commands run,
   results, remaining risks, and anything not checked. "Done" alone is not
   evidence.
5. **Review.** The reviewer catches up, reads current evidence and code when
   required, and posts findings. The author does not supply the independent
   review of its own work.
6. **Decide.** The PM records accepted findings, rejected findings with reasons,
   tie-breaks, and any human-approved scope change. Keep disputes in the room;
   correct your own earlier post with `supersedes_seq` instead of rewriting
   history.
7. **Close.** The PM checks that required validation passed, claims were
   released, unresolved issues are named, and the result still matches the
   original goal.

Before a consequential decision, catch up until no unread peer message remains.
If new traffic crossed a post, read it before treating the post as settled.

## Keep agents reachable

One watcher covers one wait. It can exit on traffic, a quiet deadline, an error,
or a client restart; the agent must start a current command again. Watcher exit
does not make every client start a new model turn.

The watcher cannot interrupt a model already reasoning. Break long work at
natural checkpoints, catch up, then continue.

`list_agents` reports self-declared identity and recent tool, wait, or watcher
contact, not proof of identity, model attention, or wake. Its `watching:false`
does not mean a background watcher is off; background watchers never set it.
Use the client's background-process view or the OS process table to check the
watcher itself.
`list_claims` reports advisory ownership, not proof that work is progressing.
Compare both with Git state, room reports, and objective timestamps.

If the watcher reports `owner MCP process ... has ended`, reconnect and generate
a current watcher command. If it reports `retired_identity`, that identity is
gone permanently; a fresh identity must join and receive a new assignment.

## Know when to intervene or shrink

The PM or human should intervene when:

- silence lasts beyond the agreed checkpoint or watcher deadline;
- two agents disagree and no named tie-breaker owns the decision;
- an agent changes scope without approval;
- claims stay held without matching progress;
- a completion report lacks commands, results, or remaining risks; or
- the PM spends more effort reconciling agents than deciding the project.

When coordination traffic outweighs useful work, remove a seat or combine
roles. More agents are useful only while their independent work or criticism
costs less than managing them.
