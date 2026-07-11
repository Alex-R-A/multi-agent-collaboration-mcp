// Feature tests for v0.5.0: byte-bounded reads (marker only advances over
// delivered rows), sliceable get_message, post-time crossing report,
// supersede annotation, advisory claims, and private session cursors.
// Plus v0.5.1 regression tests for the Fable/Opus review findings.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";

let failures = 0;
function check(cond, label) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    failures++;
    console.log(`FAIL  ${label}`);
  }
}

const s = new ChatStore(":memory:");
const room = s.createRoom("r", null, null).id;
s.upsertAgent("alice", "claude", "reviewer", null);
s.upsertAgent("bob", "codex", "planner", null);
s.joinRoom(room, "alice");
s.joinRoom(room, "bob");

// --- byte-bounded catch_up: marker advances only over delivered rows -------
const BODY = "x".repeat(2000);
for (let i = 0; i < 5; i++) s.postMessage(room, "bob", BODY, "text", null, null);

// Budget fits ~2 messages; drain in a loop and prove no loss and no overlap.
const seen = [];
let byteLimitedPages = 0;
for (let guard = 0; guard < 10; guard++) {
  const r = s.catchUp(room, "alice", 50, undefined, 5000);
  if (r.byte_limited) byteLimitedPages++;
  for (const m of r.messages) seen.push(m.seq);
  check(r.messages.length > 0, `page ${guard}: non-empty while remaining`, r);
  check(
    r.messages.length > 0 && r.new_last_read_seq === r.messages.at(-1).seq,
    `page ${guard}: marker == last delivered seq`,
  );
  if (r.remaining === 0) {
    check(r.byte_limited === undefined, "final page reports byte_limited falsy", r);
    break;
  }
}
check(byteLimitedPages >= 1, "byte budget forced multiple pages");
check(seen.join(",") === "1,2,3,4,5", "drained 5 msgs in order, no loss, no overlap", seen);

// --- head message alone exceeds the budget: truncated, never an empty page -
s.postMessage(room, "bob", "y".repeat(20_000), "text", null, null); // seq 6
const big = s.catchUp(room, "alice", 50, undefined, 5000);
check(big.messages.length === 1 && big.messages[0].seq === 6, "oversized head still delivered");
check(big.messages[0].truncated === true && big.messages[0].length === 20_000, "oversized head truncated with full length");
check(
  big.new_last_read_seq === 6 && big.remaining === 0 && big.byte_limited === undefined,
  "marker advanced past oversized head; byte_limited truthfully absent (nothing left to page)",
  big,
);

// --- sliceable get_message --------------------------------------------------
const g1 = s.getMessage(room, 6, 0, 8000);
const g2 = s.getMessage(room, 6, 8000, 8000);
const g3 = s.getMessage(room, 6, 16_000, 8000);
check(g1.truncated === true && g1.length === 20_000 && g1.offset === 0, "slice 1 carries truncated/length/offset");
check(g1.content.length === 8000 && g2.content.length === 8000 && g3.content.length === 4000, "slices partition the body");
check(g1.content + g2.content + g3.content === "y".repeat(20_000), "slices reconstruct the body exactly");
const gFull = s.getMessage(room, 1);
check(gFull.truncated === undefined && gFull.content === BODY, "small message returned whole by default");

// --- post-time crossing report ----------------------------------------------
// alice is caught up through 6; bob posts 2 more; alice posts blind.
s.postMessage(room, "bob", "crossing-1", "text", null, null); // seq 7
s.postMessage(room, "bob", "crossing-2", "text", null, null); // seq 8
const posted = s.postMessage(room, "alice", "my blind post", "text", null, null); // seq 9
check(posted.crossed === 2, "crossed counts unread from others at post time");
check(
  posted.crossed_range?.from_seq === 7 && posted.crossed_range?.to_seq === 8,
  "crossed_range brackets the unseen messages",
);
const caughtUp = s.catchUp(room, "alice", 50);
check(caughtUp.messages.length === 2, "crossed messages still arrive via catch_up (not marked read)");
const cleanPost = s.postMessage(room, "alice", "informed post", "text", null, null); // seq 10
check(cleanPost.crossed === 0 && cleanPost.crossed_range === null, "no crossing when caught up");

// --- supersede: author-only, annotated on reads -----------------------------
const sup = s.postMessage(room, "bob", "corrected proposal", "text", null, null, 7); // seq 11 supersedes 7
check(sup.seq === 11, "supersede post accepted for own message");
let rejected = false;
try {
  s.postMessage(room, "alice", "hijack", "text", null, null, 8); // 8 is bob's
} catch (e) {
  rejected = /only supersede your own/.test(e.message);
}
check(rejected, "superseding someone else's message is rejected");
const old = s.getMessage(room, 7);
check(old.superseded_by === 11, "old message annotated with superseded_by");
const neu = s.getMessage(room, 11);
check(neu.supersedes === 7, "new message carries supersedes");
const hist = s.readHistory(room, 50);
const h7 = hist.messages.find((m) => m.seq === 7);
check(h7.superseded_by === 11, "read_history carries the annotation too");

// --- advisory claims ---------------------------------------------------------
const c1 = s.claimResource(room, "file:src/db.ts", "alice", 900, "editing");
check(c1.granted === true && c1.renewed === false, "first claim granted");
const c2 = s.claimResource(room, "file:src/db.ts", "bob", 900, null);
check(c2.granted === false && c2.holder === "alice", "second claimant denied with holder info");
const c3 = s.claimResource(room, "file:src/db.ts", "alice", 900, "still editing");
check(c3.granted === true && c3.renewed === true, "same holder renews");
const rel1 = s.releaseClaim(room, "file:src/db.ts", "bob");
check(rel1.released === false, "non-holder cannot release an active claim");
const rel2 = s.releaseClaim(room, "file:src/db.ts", "alice");
check(rel2.released === true, "holder releases");
const c4 = s.claimResource(room, "file:src/db.ts", "bob", 900, null);
check(c4.granted === true, "released key claimable by another agent");
const { claims: list } = s.listClaims(room);
check(list.length === 1 && list[0].holder === "bob" && list[0].expires_in_seconds > 0, "list_claims shows active holder");

// expiry: a 1-second claim frees itself
const exp = s.claimResource(room, "task:short", "alice", 1, null);
check(exp.granted === true, "short-TTL claim granted");
await new Promise((r) => setTimeout(r, 1600));
const c5 = s.claimResource(room, "task:short", "bob", 900, null);
check(c5.granted === true, "expired claim claimable by another agent");

// --- private session cursors -------------------------------------------------
// Twin sessions under ONE agent_id: with private cursors BOTH see the full
// stream (no mutual backlog theft); the identity marker becomes the MAX.
s.upsertAgent("twin", null, null, null);
s.joinRoom(room, "twin", "S1");
s.joinRoom(room, "twin", "S2");
const base = s.getMembership(room, "twin").last_read_seq; // 0: sees whole room
const t1 = s.catchUp(room, "twin", 500, undefined, undefined, "S1");
const t2 = s.catchUp(room, "twin", 500, undefined, undefined, "S2");
check(base === 0 && t1.messages.length === 11 && t2.messages.length === 11, "both private sessions receive the full stream");
check(s.getMembership(room, "twin").last_read_seq === 11, "identity marker advanced to MAX across sessions");
// New message: both sessions get it once each; shared-mode splitting is
// covered by test/concurrent-catchup.mjs and must stay intact.
s.postMessage(room, "bob", "for the twins", "text", null, null); // seq 12
const t1b = s.catchUp(room, "twin", 500, undefined, undefined, "S1");
const t2b = s.catchUp(room, "twin", 500, undefined, undefined, "S2");
check(t1b.messages.length === 1 && t2b.messages.length === 1, "each private session sees the new message exactly once");
// mark_read on one session does not move the other.
s.markRead(room, "twin", 5, "S1");
const s1Cur = s.getCursor(room, "twin", "S1").last_read_seq;
const s2Cur = s.getCursor(room, "twin", "S2").last_read_seq;
check(s1Cur === 5 && s2Cur === 12, "mark_read rewinds only its own session cursor");
check(s.getMembership(room, "twin").last_read_seq === 12, "identity marker stays monotonic on session rewind");

s.close();

// ===========================================================================
// v0.5.1 regressions (Fable/Opus review findings)
// ===========================================================================

// --- boundByBytes: preview_chars > max_bytes must still respect the budget --
{
  const v = new ChatStore(":memory:");
  const r = v.createRoom("r", null, null).id;
  v.upsertAgent("a", null, null, null);
  v.upsertAgent("b", null, null, null);
  v.joinRoom(r, "a");
  v.joinRoom(r, "b");
  v.postMessage(r, "b", "z".repeat(300_000), "text", null, null);
  const page = v.catchUp(r, "a", 50, 150_000, 100_000);
  const size = JSON.stringify(page.messages).length;
  check(size <= 100_000, `preview_chars > max_bytes stays within budget (${size})`);
  check(
    page.messages[0].truncated === true && page.new_last_read_seq === 1,
    "oversized head still delivered truncated, marker advanced",
  );
  // Adversarial escaping: control chars serialize 6x, the estimate must
  // self-correct via the re-measure.
  v.postMessage(r, "b", "\u0001".repeat(30_000), "text", null, null);
  const esc = v.catchUp(r, "a", 50, undefined, 50_000);
  const escSize = JSON.stringify(esc.messages).length;
  check(escSize <= 50_000, `heavy-escaping body stays within budget (${escSize})`);
  v.close();
}

// --- joinRoom GC must not reap the session being resumed --------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-test-"));
  const dbPath = join(dir, "t.db");
  const v = new ChatStore(dbPath);
  const r = v.createRoom("r", null, null).id;
  v.upsertAgent("twin", null, null, null);
  v.upsertAgent("other", null, null, null);
  v.joinRoom(r, "twin", "S1");
  v.joinRoom(r, "twin", "S2");
  v.joinRoom(r, "other");
  for (let i = 0; i < 10; i++) v.postMessage(r, "other", `m${i}`, "text", null, null);
  v.markRead(r, "twin", 3, "S1"); // S1 lags at 3
  v.catchUp(r, "twin", 500, undefined, undefined, "S2"); // identity MAX -> 10
  const raw = new Database(dbPath);
  raw
    .prepare(
      "UPDATE session_markers SET updated_at = datetime('now', '-8 days') WHERE session_id = 'S1'",
    )
    .run();
  raw.close();
  v.joinRoom(r, "twin", "S1"); // resume after GC-eligible dormancy
  check(
    v.getCursor(r, "twin", "S1").last_read_seq === 3,
    "resume join preserves a dormant session cursor",
  );
  const resumed = v.catchUp(r, "twin", 500, undefined, undefined, "S1");
  check(resumed.messages.length === 7, "dormant session resumes with its full backlog");

  // --- prune refusal must see lagging private session cursors ---------------
  v.markRead(r, "twin", 3, "S1"); // re-lag S1 (catchUp above advanced it)
  const pr = v.pruneMessages(r, 5, false);
  check(pr.refused === true, "prune refuses while a private session lags");
  check(
    pr.min_read_seq === 3,
    "min_read_seq names the BLOCKING session cursor exactly (author-only lag exempt)",
    pr,
  );
  const forced = v.pruneMessages(r, 5, true);
  check(forced.deleted > 0, "force still prunes");
  v.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- get_thread: one budget across focal + parent + replies -----------------
{
  const v = new ChatStore(":memory:");
  const r = v.createRoom("r", null, null).id;
  v.upsertAgent("a", null, null, null);
  v.joinRoom(r, "a");
  v.postMessage(r, "a", "R".repeat(150_000), "text", null, null); // seq 1: root
  v.postMessage(r, "a", "P".repeat(150_000), "text", null, 1); // seq 2: focal, replies to 1
  v.postMessage(r, "a", "small reply", "text", null, 2); // seq 3
  const t = v.getThread(r, 2, 3);
  const total = JSON.stringify(t).length;
  // v0.5.2: the focal message is charged at SERIALIZED size (fitMessage), so
  // the whole response now genuinely fits the 100k budget, and the parent
  // receives the real remainder (~10k) instead of the 2k starvation floor.
  check(total <= 100_000, `thread shares one budget (${total} <= 100000)`);
  check(t.message.truncated === true, "focal message truncated under the budget");
  check(t.parent.truncated === true && t.parent.content.length <= 12_000, "parent charged against remainder, not a fresh cap");
  check(t.replies.length === 1 && t.replies[0].content === "small reply", "replies still delivered");
  v.close();
}

// --- get_message: final page reports truncated:false ------------------------
{
  const v = new ChatStore(":memory:");
  const r = v.createRoom("r", null, null).id;
  v.upsertAgent("a", null, null, null);
  v.joinRoom(r, "a");
  v.postMessage(r, "a", "abcdef", "text", null, null);
  const mid = v.getMessage(r, 1, 0, 3);
  const fin = v.getMessage(r, 1, 3, 3);
  const past = v.getMessage(r, 1, 6, 3);
  check(mid.truncated === true && mid.content === "abc", "mid page: truncated true");
  check(fin.truncated === false && fin.content === "def", "final page: truncated false");
  check(past.truncated === false && past.content === "", "past-end page: truncated false, empty");
  v.close();
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL PASS");
