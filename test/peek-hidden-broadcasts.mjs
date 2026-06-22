// Regression for the cold-start failure: catch_up({mentions_me}) is a filtered
// peek that hides broadcasts. Before the fix its result ({messages, remaining})
// let an agent mistake "no directed unread" for "no room unread" and report
// "no reply" while a broadcast brief sat unread. The peek now reports
// marker-relative unread_total and hidden_by_filter so an empty/exhausted peek
// cannot be mistaken for a quiet room.
//
// Run: node test/peek-hidden-broadcasts.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../dist/db.js";

const dir = mkdtempSync(join(tmpdir(), "aichat-peek-"));
const DB = join(dir, "peek.db");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

{
  const s = new ChatStore(DB);
  s.createRoom("r", null, null);
  s.upsertAgent("A", "claude", null, null); s.joinRoom(1, "A"); // reader
  s.upsertAgent("B", "claude", null, null); s.joinRoom(1, "B"); // poster
  // seq1 mention->A, seq2 broadcast, seq3 broadcast, seq4 mention->A
  s.postMessage(1, "B", "hi A (1)", "text", ["A"], null);
  s.postMessage(1, "B", "broadcast (2)", "text", null, null);
  s.postMessage(1, "B", "broadcast (3)", "text", null, null);
  s.postMessage(1, "B", "hi A (4)", "text", ["A"], null);

  const peek = s.catchUp(1, "A", 50, "A");
  check("peek returns only directed messages (seq 1,4)", peek.messages.map((m) => m.seq).join(",") === "1,4", peek.messages.map((m) => m.seq));
  check("peek unread_total = 4 (all from others)", peek.unread_total === 4, peek.unread_total);
  check("peek hidden_by_filter = 2 (the broadcasts)", peek.hidden_by_filter === 2, peek.hidden_by_filter);
  check("peek hint names the hidden count", typeof peek.hint === "string" && peek.hint.includes("2"), peek.hint);
  check("peek did NOT advance the marker", peek.advanced === false && s.getMembership(1, "A").last_read_seq === 0, s.getMembership(1, "A"));

  const sync = s.catchUp(1, "A", 50);
  check("plain catch_up returns all 4 and advances", sync.messages.length === 4 && sync.advanced && sync.new_last_read_seq === 4, { n: sync.messages.length, adv: sync.advanced });

  const peek2 = s.catchUp(1, "A", 50, "A");
  check("caught-up peek: unread_total 0, hidden 0, no hint", peek2.unread_total === 0 && peek2.hidden_by_filter === 0 && peek2.hint === undefined, peek2);
  s.close();
}

{
  const DB2 = join(dir, "peek2.db");
  const s = new ChatStore(DB2);
  s.createRoom("r", null, null);
  s.upsertAgent("A", null, null, null); s.joinRoom(1, "A");
  s.upsertAgent("B", null, null, null); s.joinRoom(1, "B");
  s.postMessage(1, "B", "m1", "text", ["A"], null);
  s.postMessage(1, "B", "m2", "text", ["A"], null);
  const peek = s.catchUp(1, "A", 50, "A");
  check("all-directed: unread_total 2, hidden_by_filter 0, no hint", peek.unread_total === 2 && peek.hidden_by_filter === 0 && peek.hint === undefined, peek);
  s.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
