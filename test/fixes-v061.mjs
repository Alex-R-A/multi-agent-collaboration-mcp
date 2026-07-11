// Regression tests for the v0.6.1 external-review fixes:
// - reply directedness survives pruning of the parent (denormalized author)
// - legacy rows get the denormalized author backfilled at migration
// - my_mentions honors private session cursors
// - my_mentions pages with after_id (no repeating first page)
// - my_mentions bounds by_room within max_bytes
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- reply directedness survives pruning the parent --------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("alice", null, null, null);
  s.upsertAgent("bob", null, null, null);
  s.joinRoom(r, "alice");
  s.joinRoom(r, "bob");
  s.postMessage(r, "alice", "parent that will be pruned", "text", null, null); // seq 1
  for (let i = 0; i < 7; i++) s.postMessage(r, "bob", "filler " + i, "text", null, null); // 2..8
  s.postMessage(r, "bob", "late reply to alice", "text", null, 1); // seq 9, directed at alice
  const pruned = s.pruneMessages(r, 5, true); // deletes seq < 5, incl. the parent
  check("prune removed the parent", pruned.deleted === 4, pruned);
  const inbox = s.myMentions("alice", 50);
  check(
    "reply stays directed at alice after its parent was pruned",
    inbox.messages.length === 1 && inbox.messages[0].seq === 9,
    inbox.messages.map((m) => m.seq),
  );
  const alpha = inbox.by_room.find((x) => x.room_id === r);
  check("by_room still counts it as directed", alpha && alpha.directed === 1, alpha);
  s.close();
}

// --- migration backfills reply_to_agent on legacy rows -----------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-backfill-"));
  const dbPath = join(dir, "t.db");
  {
    const s = new ChatStore(dbPath);
    const r = s.createRoom("r", null, null).id;
    s.upsertAgent("a", null, null, null);
    s.upsertAgent("b", null, null, null);
    s.joinRoom(r, "a");
    s.joinRoom(r, "b");
    s.postMessage(r, "a", "root", "text", null, null);
    s.close();
  }
  // Simulate a legacy reply row written by a build without the column.
  const raw = new Database(dbPath);
  raw
    .prepare(
      "INSERT INTO messages (room_id, seq, agent_id, format, body, reply_to_seq) VALUES (1, 2, 'b', 'text', 'legacy reply', 1)",
    )
    .run();
  raw.close();
  const s = new ChatStore(dbPath); // migrate() backfills
  const inbox = s.myMentions("a", 50);
  check(
    "legacy reply backfilled and directed at the parent author",
    inbox.messages.length === 1 && inbox.messages[0].seq === 2,
    inbox.messages.map((m) => m.seq),
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- private session cursors respected by the inbox --------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("twin", null, null, null);
  s.upsertAgent("other", null, null, null);
  s.joinRoom(r, "twin", "S1");
  s.joinRoom(r, "twin", "S2");
  s.joinRoom(r, "other");
  s.postMessage(r, "other", "ping @twin", "text", ["twin"], null); // seq 1
  s.catchUp(r, "twin", 50, undefined, undefined, "S2"); // S2 reads; identity marker -> 1
  const idLevel = s.myMentions("twin", 50);
  const s1View = s.myMentions("twin", 50, undefined, undefined, "S1");
  const s2View = s.myMentions("twin", 50, undefined, undefined, "S2");
  check("identity-level inbox is empty after the twin read", idLevel.messages.length === 0, idLevel.messages);
  check(
    "lagging private session still sees the mention its own catch_up would deliver",
    s1View.messages.length === 1 && s1View.messages[0].seq === 1,
    s1View.messages.map((m) => m.seq),
  );
  check("the session that read it sees nothing", s2View.messages.length === 0, s2View.messages);
  s.close();
}

// --- after_id paging ----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("hero", null, null, null);
  s.upsertAgent("spammer", null, null, null);
  s.joinRoom(r, "hero");
  s.joinRoom(r, "spammer");
  for (let i = 1; i <= 8; i++) s.postMessage(r, "spammer", "m" + i, "text", ["hero"], null);
  const seen = [];
  let afterId = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = s.myMentions("hero", 3, undefined, undefined, null, afterId);
    if (page.messages.length === 0) break;
    for (const m of page.messages) seen.push(m.seq);
    afterId = page.next_after_id;
  }
  check(
    "after_id pages the full backlog exactly once (no repeats, no loss)",
    seen.join(",") === "1,2,3,4,5,6,7,8",
    seen,
  );
  s.close();
}

// --- by_room bounded by max_bytes ----------------------------------------------
{
  const s = new ChatStore(":memory:");
  s.upsertAgent("hero", null, null, null);
  s.upsertAgent("noise", null, null, null);
  for (let i = 1; i <= 30; i++) {
    const id = s.createRoom("room-" + String(i).padStart(2, "0") + "-" + "x".repeat(80), null, null).id;
    s.joinRoom(id, "hero");
    s.joinRoom(id, "noise");
    // DIRECTED, one per room: an earlier version posted only broadcasts, so
    // the "pre-truncation" assertion below was === 0 and could not tell a
    // pre-truncation count from a post-truncation one (mutation-proven).
    s.postMessage(id, "noise", "ping @hero", "text", ["hero"], null);
  }
  const inbox = s.myMentions("hero", 50, undefined, 2000);
  const size = JSON.stringify(inbox).length;
  check(`whole inbox response respects max_bytes (${size} <= 2000)`, size <= 2000, size);
  check("by_room truncation is flagged", inbox.by_room_truncated === true, inbox);
  check(
    "total_directed counts every room PRE-truncation",
    inbox.total_directed === 30,
    inbox.total_directed,
  );
  check(
    "truncated by_room keeps fewer rooms than total_directed spans",
    inbox.by_room.length < 30 && inbox.by_room.length > 0,
    inbox.by_room.length,
  );
  s.close();
}

// --- cursor mode switch: shared rejoin clears the stale private baseline ----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("twin", null, null, null);
  s.upsertAgent("other", null, null, null);
  s.joinRoom(r, "twin", "SX"); // private cursor for session SX
  s.joinRoom(r, "other");
  s.postMessage(r, "other", "ping @twin", "text", ["twin"], null); // seq 1
  s.catchUp(r, "twin", 50); // identity marker -> 1 (read via shared cursor)
  const before = s.myMentions("twin", 50, undefined, undefined, "SX");
  check(
    "private row feeds the inbox while the session is private",
    before.messages.length === 1,
    before.messages,
  );
  s.joinRoom(r, "twin"); // rejoin SHARED
  s.clearSessionCursor(r, "twin", "SX"); // what the MCP layer now does on shared joins
  const after = s.myMentions("twin", 50, undefined, undefined, "SX");
  check(
    "shared rejoin clears the stale private baseline from the inbox",
    after.messages.length === 0,
    after.messages,
  );
  s.close();
}

// --- small max_bytes stays a real bound (floor cannot exceed the budget) ----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("busy", null, null).id;
  s.upsertAgent("hero", null, null, null);
  s.upsertAgent("n", null, null, null);
  s.joinRoom(r, "hero");
  s.joinRoom(r, "n");
  for (let i = 0; i < 10; i++)
    s.postMessage(r, "n", "hello @hero " + "x".repeat(300), "text", ["hero"], null);
  const inbox = s.myMentions("hero", 50, undefined, 1000);
  const size = JSON.stringify(inbox).length;
  check(`max_bytes=1000 is a hard bound (${size} <= 1000)`, size <= 1000, size);
  check("byte_limited flagged when trimmed", inbox.byte_limited === true, inbox.byte_limited);
  s.close();
}

// --- envelope-dominated messages: HARD byte bound on the whole response -----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  // 100 valid mention ids INCLUDING the reader (an earlier version of this
  // test generated ids that never mentioned the reader, making the inbox
  // half vacuous).
  const ids = ["a", ...Array.from({ length: 99 }, (_, i) => "m" + i + "x".repeat(190))];
  s.postMessage(r, "b", "short body", "text", ids, null);
  const page = s.catchUp(r, "a", 50, undefined, 1000);
  const size = JSON.stringify(page).length;
  check(`catch_up WHOLE response hard-bounded (${size} <= 1000)`, size <= 1000, size);
  check(
    "mentions cut is flagged with the original count",
    page.messages[0].to_truncated === true && page.messages[0].to_total === 100,
    page.messages[0].to_total,
  );
  s.markRead(r, "a", 0); // rewind to test the inbox path on the same message
  const inbox = s.myMentions("a", 50, undefined, 1000);
  const isize = JSON.stringify(inbox).length;
  check(`my_mentions WHOLE response hard-bounded (${isize} <= 1000)`, isize <= 1000, isize);
  check("inbox is non-vacuous (the reader IS mentioned)", inbox.messages.length === 1, inbox.messages.length);
  s.close();
}

// --- reviewer repro pack: hard bound under hostile-but-legal metadata -------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room-" + "x".repeat(195), null, null).id; // legal long name
  const bigSender = "sender-" + "s".repeat(170); // legal long id
  s.upsertAgent("a", null, null, null);
  s.upsertAgent(bigSender, "t".repeat(100), "r".repeat(200), null); // long metadata
  s.joinRoom(r, "a");
  s.joinRoom(r, bigSender);
  s.postMessage(
    r,
    bigSender,
    "nine printable ids",
    "text",
    ["a", ...Array.from({ length: 8 }, (_, i) => "n" + i + "y".repeat(190))],
    null,
  );
  s.postMessage(r, bigSender, String.fromCharCode(1).repeat(400), "text", ["a"], null);
  s.postMessage(r, bigSender, "plain body from a long-metadata sender", "text", null, null);

  let pages = 0;
  const delivered = [];
  for (;;) {
    const p = s.catchUp(r, "a", 50, undefined, 1000);
    const sz = JSON.stringify(p).length;
    check(`repro catch_up page ${++pages} hard-bounded (${sz} <= 1000)`, sz <= 1000, sz);
    for (const m of p.messages) delivered.push(m.seq);
    if (p.remaining === 0) {
      check("repro final catch_up page not byte_limited", p.byte_limited === undefined, p);
      break;
    }
    if (pages > 10) {
      check("catch_up paging terminates", false, pages);
      break;
    }
  }
  // DELIVERY, not just page size: a bound that drops rows to stay small
  // passed the size checks above while silently losing messages
  // (mutation-proven by the test audit).
  check(
    "repro catch_up delivered every message exactly once",
    delivered.join(",") === "1,2,3",
    delivered,
  );
  s.markRead(r, "a", 0);
  let afterId = 0;
  let ipages = 0;
  const inboxSeqs = [];
  for (;;) {
    const p = s.myMentions("a", 50, undefined, 1000, null, afterId);
    const sz = JSON.stringify(p).length;
    check(`repro inbox page ${++ipages} hard-bounded (${sz} <= 1000)`, sz <= 1000, sz);
    for (const m of p.messages) inboxSeqs.push(m.seq);
    if (p.messages.length === 0) break;
    afterId = p.next_after_id;
    if (ipages > 10) {
      check("inbox paging terminates", false, ipages);
      break;
    }
  }
  check(
    "repro inbox delivered both directed messages exactly once",
    inboxSeqs.join(",") === "1,2",
    inboxSeqs,
  );
  s.close();
}

// --- AGENT_CHAT_DB=:memory: stays the SQLite sentinel ------------------------
{
  const saved = process.env.AGENT_CHAT_DB;
  process.env.AGENT_CHAT_DB = ":memory:";
  const s = new ChatStore();
  check("':memory:' env override is not path-resolved", s.path === ":memory:", s.path);
  s.close();
  if (saved === undefined) delete process.env.AGENT_CHAT_DB;
  else process.env.AGENT_CHAT_DB = saved;
}

// --- touch refreshes ALL of a session's cursors against the 7-day GC ---------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-gc-"));
  const dbPath = join(dir, "t.db");
  const s = new ChatStore(dbPath);
  const ra = s.createRoom("a", null, null).id;
  const rb = s.createRoom("b", null, null).id;
  s.upsertAgent("twin", null, null, null);
  s.upsertAgent("other", null, null, null);
  s.joinRoom(ra, "twin", "S1");
  s.joinRoom(rb, "twin", "S1"); // private cursors in BOTH rooms
  s.joinRoom(rb, "other");
  const raw = new Database(dbPath);
  raw
    .prepare("UPDATE session_markers SET updated_at = datetime('now', '-8 days') WHERE session_id = 'S1'")
    .run();
  raw.close();
  // The session is active in room A only; the touch must shield room B too.
  s.touch(ra, "twin", "S1");
  s.joinRoom(rb, "other", "SZ"); // triggers the GC pass in room B
  const rawB = new Database(dbPath);
  const survived = rawB
    .prepare("SELECT COUNT(*) AS c FROM session_markers WHERE room_id = ? AND session_id = 'S1'")
    .get(rb).c;
  rawB.close();
  check("inactive-room private cursor survives GC while its session is alive", survived === 1, survived);
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
