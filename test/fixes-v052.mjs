// Regression tests for the v0.5.2 review fixes:
// - leave/rejoin must not discard a lagging private session cursor
// - reply_to_seq validated inside the insert transaction
// - get_thread charges SERIALIZED size (escaping/envelope), not raw chars
// - redundant idx_messages_room_seq dropped from legacy database files
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ChatStore, DEFAULT_MAX_BYTES } from "../dist/db.js";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- leave/rejoin preserves a lagging private session cursor ---------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("twin", null, null, null);
  s.upsertAgent("other", null, null, null);
  s.joinRoom(r, "twin", "S1");
  s.joinRoom(r, "twin", "S2");
  s.joinRoom(r, "other");
  for (let i = 1; i <= 10; i++) s.postMessage(r, "other", `m${i}`, "text", null, null);
  s.markRead(r, "twin", 3, "S1"); // S1 lags at 3
  s.catchUp(r, "twin", 500, undefined, undefined, undefined, undefined, "S2"); // identity marker -> 10
  s.leaveRoom(r, "twin"); // soft leave must NOT drop session cursors
  s.joinRoom(r, "twin", "S1"); // rejoin the lagging session
  check(
    "rejoin resumes the lagging session at ITS position, not the identity MAX",
    s.getCursor(r, "twin", "S1").last_read_seq === 3,
    s.getCursor(r, "twin", "S1"),
  );
  const resumed = s.catchUp(r, "twin", 500, undefined, undefined, undefined, undefined, "S1");
  check(
    "no messages lost across leave/rejoin (7 undelivered arrive)",
    resumed.messages.length === 7 && resumed.messages[0].seq === 4,
    { n: resumed.messages.length },
  );
  s.close();
}

// --- reply_to_seq validated in-transaction ----------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
  let rejected = false;
  try {
    s.postMessage(r, "a", "dangling", "text", null, 999);
  } catch (e) {
    rejected = /reply_to_seq 999 does not exist/.test(e.message);
  }
  check("reply to a nonexistent seq is rejected by postMessage itself", rejected);
  s.postMessage(r, "a", "root", "text", null, null); // seq 1
  const ok = s.postMessage(r, "a", "reply", "text", null, 1); // seq 2
  check("valid reply still accepted", ok.seq === 2, ok);
  s.close();
}

// --- get_thread: serialized budget honored for escape-heavy bodies ----------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
  // \u0001 serializes 6x ("\u0001" per char): 60k raw chars ~= 360k serialized.
  s.postMessage(r, "a", "\u0001".repeat(60_000), "text", null, null); // seq 1
  s.postMessage(r, "a", "focal reply", "text", null, 1); // seq 2
  const CAP = DEFAULT_MAX_BYTES + 10_000; // budget plus corrective-pass slack
  const viaParent = s.getThread(r, 2, 3);
  const parentTotal = JSON.stringify(viaParent).length;
  check(
    `escape-heavy PARENT charged at serialized size (${parentTotal} <= ${CAP})`,
    parentTotal <= CAP,
    parentTotal,
  );
  check(
    "parent arrives truncated with markers",
    viaParent.parent.truncated === true && viaParent.parent.length === 60_000,
    viaParent.parent,
  );
  const viaFocal = s.getThread(r, 1, 3);
  const focalTotal = JSON.stringify(viaFocal).length;
  check(
    `escape-heavy FOCAL message charged at serialized size (${focalTotal} <= ${CAP})`,
    focalTotal <= CAP,
    focalTotal,
  );
  check(
    "focal arrives truncated, replies still delivered",
    viaFocal.message.truncated === true && viaFocal.replies.length === 1,
    { truncated: viaFocal.message.truncated, replies: viaFocal.replies.length },
  );
  s.close();
}

// --- redundant (room_id, seq) index dropped from legacy files ---------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-idx-"));
  const dbPath = join(dir, "t.db");
  new ChatStore(dbPath).close();
  const raw = new Database(dbPath);
  raw.exec("CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq)"); // simulate legacy build
  raw.close();
  new ChatStore(dbPath).close(); // migrate() must drop it
  const probe = new Database(dbPath);
  probe.pragma("query_only = ON");
  const idx = probe
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_room_seq'")
    .get();
  check("legacy idx_messages_room_seq is dropped by migration", idx === undefined, idx);
  const plan = probe
    .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages WHERE room_id=1 AND seq>5")
    .all();
  check(
    "queries still use the UNIQUE(room_id, seq) auto-index",
    plan.some((p) => /sqlite_autoindex_messages/.test(p.detail)),
    plan.map((p) => p.detail),
  );
  probe.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
