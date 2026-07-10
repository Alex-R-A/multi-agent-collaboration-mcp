// Regression tests for the fifth-round external-review fixes: max_bytes is a
// hard bound on the WHOLE serialized response for every bulk read, measured
// exactly (array commas/brackets and worst-case envelopes included), for any
// legal input including control-heavy metadata; get_thread shares the same
// guarantee. The serialized store result IS the wire payload (ok() is a bare
// JSON.stringify), so JSON.stringify(result).length is the exact assertion.
import { ChatStore } from "../dist/db.js";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};
const size = (o) => JSON.stringify(o).length;

// --- boundary-packed pages stay within max_bytes -----------------------------
// Bodies are sized so the per-row serialized sizes sum to EXACTLY the old
// (element-sum) budget: the uncounted commas, brackets, and envelope slack
// then pushed the response past max_bytes by a two-digit sliver.
{
  const s = new ChatStore(":memory:");
  const probe = s.createRoom("probe", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(probe, "b");
  s.postMessage(probe, "b", "x".repeat(100), "text", null, null);
  const rowEnv = size(s.readHistory(probe, 1).messages[0]) - 100;

  const MAX = 100_000;
  const r = s.createRoom("dense", null, null).id;
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  const perRow = 1998; // 50 rows x 1998 = 99900 = the old element-sum budget
  for (let i = 0; i < 55; i++) {
    s.postMessage(r, "b", "x".repeat(perRow - rowEnv), "text", null, null);
  }

  const seen = new Set();
  let pages = 0;
  let firstPageCount = 0;
  let dups = 0;
  for (;;) {
    const page = s.catchUp(r, "a", 500, undefined, MAX);
    check(`catch_up dense page ${++pages} <= max_bytes`, size(page) <= MAX, size(page));
    if (pages === 1) firstPageCount = page.messages.length;
    for (const m of page.messages) {
      if (seen.has(m.seq)) dups++;
      seen.add(m.seq);
    }
    if (!page.byte_limited) break;
    if (pages > 10) break;
  }
  check("catch_up paging repeats no seq", dups === 0, dups);
  check("catch_up paging delivered all 55 packed messages", seen.size === 55, seen.size);
  check("catch_up page is not over-trimmed (>= 45 of 50 boundary rows)", firstPageCount >= 45, firstPageCount);

  const h = s.readHistory(r, 60, undefined, undefined, MAX);
  check("read_history dense response <= max_bytes", size(h) <= MAX, size(h));
  check("read_history flags the cut", h.byte_limited === true, h);
  s.close();
}

// --- my_mentions dense inbox at max_bytes=400000 ------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("inbox", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  for (let i = 0; i < 110; i++) {
    s.postMessage(r, "b", "y".repeat(3900), "text", ["a"], null);
  }
  const MAX = 400_000;
  const seen = new Set();
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = s.myMentions("a", 500, undefined, MAX, null, after);
    check(`my_mentions dense page ${++pages} <= max_bytes`, size(page) <= MAX, size(page));
    for (const m of page.messages) seen.add(m.seq);
    if (page.next_after_id === after) break;
    after = page.next_after_id;
    if (pages > 10) break;
  }
  check("my_mentions paging delivered all 110 entries", seen.size === 110, seen.size);
  s.close();
}

// --- search_messages dense matches stay within the default budget -------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("searchable", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  for (let i = 0; i < 60; i++) {
    s.postMessage(r, "b", "needle " + "z".repeat(1990), "text", null, null);
  }
  const res = s.searchMessages(r, "needle", 60);
  check("search_messages dense response <= 100000", size(res) <= 100_000, size(res));
  check("search_messages flags the cut", res.byte_limited === true, res);
  s.close();
}

// --- control-heavy metadata: the stub itself is measured, not sliced ----------
// A control char serializes as 6 chars (\u0001); fixed code-unit cuts of the
// room name / sender type / role let stubs escape a 1000-char budget.
{
  const s = new ChatStore(":memory:");
  const ctl = "\u0001".repeat(200);
  const room = s.createRoom(ctl, null, null).id;
  const sender = "s".repeat(200);
  s.upsertAgent("a", null, null, null);
  s.upsertAgent(sender, "\u0001".repeat(100), ctl, null);
  s.joinRoom(room, "a");
  s.joinRoom(room, sender);
  s.postMessage(room, sender, "\u0001".repeat(400), "text", ["a"], null);

  const MAX = 1000;
  let after = 0;
  for (let i = 0; i < 5; i++) {
    const page = s.myMentions("a", 50, undefined, MAX, null, after);
    check(`ctl-heavy my_mentions page ${i + 1} <= 1000`, size(page) <= MAX, size(page));
    if (page.next_after_id === after) break;
    after = page.next_after_id;
  }
  for (let i = 0; i < 5; i++) {
    const page = s.catchUp(room, "a", 50, undefined, MAX);
    check(`ctl-heavy catch_up page ${i + 1} <= 1000`, size(page) <= MAX, size(page));
    if (!page.byte_limited) break;
  }
  const h = s.readHistory(room, 50, undefined, undefined, MAX);
  check("ctl-heavy read_history <= 1000", size(h) <= MAX, size(h));
  s.close();
}

// --- get_thread shares the hard bound ------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("threads", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");

  // Reviewer repro 1: plain 99,700-char focal message whose parent adds
  // 1,800 more; the old per-part floors stacked past the budget.
  s.postMessage(r, "a", "p".repeat(1800), "text", null, null); // seq 1
  s.postMessage(r, "b", "f".repeat(99_700), "text", null, 1); // seq 2
  const t1 = s.getThread(r, 2);
  check("thread: big focal + parent <= 100000", size(t1) <= 100_000, size(t1));
  check("thread: focal keeps most of its body", String(t1.message.content).length > 50_000, String(t1.message.content).length);
  check("thread: parent still present", t1.parent !== null && t1.parent.seq === 1, t1.parent);

  // Reviewer repro 2: 200k control-char body plus 100 printable mentions.
  const mentions = Array.from({ length: 100 }, (_, i) => "agent-" + i);
  s.postMessage(r, "b", "\u0001".repeat(200_000), "text", mentions, null); // seq 3
  const t2 = s.getThread(r, 3);
  check("thread: 200k ctl body + 100 mentions <= 100000", size(t2) <= 100_000, size(t2));

  // Replies packed near the boundary.
  s.postMessage(r, "a", "root", "text", null, null); // seq 4
  for (let i = 0; i < 60; i++) {
    s.postMessage(r, "b", "w".repeat(1990), "text", null, 4);
  }
  const t3 = s.getThread(r, 4);
  check("thread: dense replies <= 100000", size(t3) <= 100_000, size(t3));
  check("thread: dense replies flag byte_limited", t3.byte_limited === true, t3);
  check("thread: dense replies still carry a useful page", t3.replies.length >= 40, t3.replies.length);
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
