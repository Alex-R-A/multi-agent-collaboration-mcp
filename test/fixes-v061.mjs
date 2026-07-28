// Regression tests for the v0.6.1 external-review fixes:
// - reply directedness survives pruning of the parent (denormalized author)
// - my_mentions honors the persona's per-room read markers
// - my_mentions pages with after_id (no repeating first page)
// - my_mentions bounds by_room within max_bytes
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- reply directedness survives pruning the parent --------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "alice");
  mkAgent(s, "bob");
  s.joinRoom(r, "alice", {});
  s.joinRoom(r, "bob", {});
  s.postMessage(r, "alice", "parent that will be pruned", "text", null, null, null); // seq 1
  for (let i = 0; i < 7; i++) s.postMessage(r, "bob", "filler " + i, "text", null, null, null); // 2..8
  s.postMessage(r, "bob", "late reply to alice", "text", null, 1, null); // seq 9, directed at alice
  const pruned = s.pruneMessages(r, "alice", 5, true); // deletes seq < 5, incl. the parent
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

// --- after_id paging ----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "hero");
  mkAgent(s, "spammer");
  s.joinRoom(r, "hero", {});
  s.joinRoom(r, "spammer", {});
  for (let i = 1; i <= 8; i++) s.postMessage(r, "spammer", "m" + i, "text", ["hero"], null, null);
  const seen = [];
  let afterId = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = s.myMentions("hero", 3, undefined, undefined, afterId);
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
  mkAgent(s, "hero");
  mkAgent(s, "noise");
  for (let i = 1; i <= 30; i++) {
    const id = mkRoom(s, "room-" + String(i).padStart(2, "0") + "-" + "x".repeat(80), null, null).id;
    s.joinRoom(id, "hero", {});
    s.joinRoom(id, "noise", {});
    // DIRECTED, one per room: an earlier version posted only broadcasts, so
    // the "pre-truncation" assertion below was === 0 and could not tell a
    // pre-truncation count from a post-truncation one (mutation-proven).
    s.postMessage(id, "noise", "ping @hero", "text", ["hero"], null, null);
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

// --- small max_bytes stays a real bound (floor cannot exceed the budget) ----
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "busy", null, null).id;
  mkAgent(s, "hero");
  mkAgent(s, "n");
  s.joinRoom(r, "hero", {});
  s.joinRoom(r, "n", {});
  for (let i = 0; i < 10; i++)
    s.postMessage(r, "n", "hello @hero " + "x".repeat(300), "text", ["hero"], null, null);
  const inbox = s.myMentions("hero", 50, undefined, 1000);
  const size = JSON.stringify(inbox).length;
  check(`max_bytes=1000 is a hard bound (${size} <= 1000)`, size <= 1000, size);
  check("byte_limited flagged when trimmed", inbox.byte_limited === true, inbox.byte_limited);
  s.close();
}

// --- envelope-dominated messages: HARD byte bound on the whole response -----
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  // 100 valid mention ids INCLUDING the reader (an earlier version of this
  // test generated ids that never mentioned the reader, making the inbox
  // half vacuous).
  const ids = ["a", ...Array.from({ length: 99 }, (_, i) => "m" + i + "x".repeat(190))];
  s.postMessage(r, "b", "short body", "text", ids, null, null);
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
  const r = mkRoom(s, "room-" + "x".repeat(195), null, null).id; // legal long name
  const bigSender = "sender-" + "s".repeat(170); // legal long id
  mkAgent(s, "a");
  mkAgent(s, bigSender); // long metadata
  s.joinRoom(r, "a", {});
  s.joinRoom(r, bigSender, {});
  s.postMessage(r, bigSender, "nine printable ids", "text", ["a", ...Array.from({ length: 8 }, (_, i) => "n" + i + "y".repeat(190))], null, null);
  s.postMessage(r, bigSender, String.fromCharCode(1).repeat(400), "text", ["a"], null, null);
  s.postMessage(r, bigSender, "plain body from a long-metadata sender", "text", null, null, null);

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
    const p = s.myMentions("a", 50, undefined, 1000, afterId);
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

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
