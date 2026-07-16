// Regression tests for the SEVENTH-round fixes (v0.7.1), each reproducing a
// bug an adversarial reviewer confirmed against v0.7.0:
//  1  embedded NUL is rejected at write (SQLite substr/length truncate at it,
//     so a stored NUL silently drops the tail and advances the marker past it)
//  2  the body_len trigger no longer stamps a wrong (codepoint) astral length
//     that never self-repairs; fullLen()=max() never under-reports
//  3  get_message pages a huge body with BOUNDED memory (window, not prefix)
//  4  bulk reads bound memory by iterating and stopping at the budget
//  5  list tools bound the SERIALIZED response and page with offset
//  6  a session that switches identity keeps its old identity's private cursor
//     alive (touch by session nonce), so switching back loses no messages
//  7  search: g.id tie-break + limit+1 probe (no false next_offset)
//  8  chmod tightens only directories WE create, never a pre-existing parent
//  12 delete_room on an already-deleted room fails cleanly
//  13 lone surrogates are rejected at write
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};
const size = (o) => JSON.stringify(o).length;
const NUL = String.fromCharCode(0);
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e.message));
  }
};

// --- 1 + 13: NUL and lone surrogates rejected at every write path -------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("n", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  check(
    "post_message with an embedded NUL is rejected (was silent truncation)",
    throws(() => s.postMessage(r, "b", "abc" + NUL + "def", "text", null, null), /NUL/),
    null,
  );
  check(
    "post_message with a lone high surrogate is rejected",
    throws(() => s.postMessage(r, "b", "x\ud800y", "text", null, null), /surrogate/),
    null,
  );
  check(
    "create_room with a NUL pinned is rejected",
    throws(() => s.createRoom("bad", null, "pin" + NUL + "ned"), /NUL/),
    null,
  );
  check(
    "upsertAgent with a NUL role is rejected",
    throws(() => s.upsertAgent("c", null, "ro" + NUL + "le", null), /NUL/),
    null,
  );
  check(
    "claim with a NUL note is rejected",
    throws(() => s.claimResource(r, "k", "a", 900, "no" + NUL + "te"), /NUL/),
    null,
  );
  // A legitimate control char that is NOT NUL still stores and round-trips.
  s.postMessage(r, "b", "ctl\u0001ok", "text", null, null);
  const back = s.getMessage(r, 1, 0, 1000);
  check("a non-NUL control char round-trips intact", back.content === "ctl\u0001ok", back.content);
  s.close();
}

// --- 2: body_len never wrong; fullLen()=max() never under-reports -------------
{
  const dir = mkdtempSync(join(tmpdir(), "v071-blen-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("r", null, null); s.upsertAgent("a", null, null, null); s.joinRoom(1, "a"); s.close(); }
  // Old build inserts a 200-emoji (400 UTF-16) reply with no body_len.
  const raw = new Database(DB);
  raw.prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,1,'a','text',?)").run("\u{1F600}".repeat(200));
  raw.close();
  const s = new ChatStore(DB); // migrate + backfill
  const gm = s.getMessage(1, 1, 0, 100_000); // whole body fits
  check(
    "astral old-build row reports the exact length and pages fully (no truncation)",
    gm.truncated !== true && gm.content === "\u{1F600}".repeat(200),
    { truncated: gm.truncated, len: gm.content.length },
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 3: get_message deep page is memory-bounded (window, not prefix) ----------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("big", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  // 5 MB body: a prefix fetch of a deep page would materialize megabytes; a
  // window fetch holds only ~maxChars. Assert the deep page returns the right
  // window and heap stays bounded.
  const body = "abcdefghij".repeat(500_000); // 5,000,000 chars
  s.postMessage(r, "b", body, "text", null, null);
  const deep = s.getMessage(r, 1, 4_000_000, 1000);
  check(
    "deep get_message page returns exactly its window",
    deep.content === body.slice(4_000_000, 4_001_000) && deep.offset === 4_000_000,
    { len: deep.content.length, off: deep.offset },
  );
  check("deep page reports more remains", deep.truncated === true && deep.next_offset === 4_001_000, deep.next_offset);
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5; i++) s.getMessage(r, 1, 4_000_000, 1000);
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  check(
    "repeated deep pages do not accumulate the whole prefix in the JS heap",
    heapGrowth < 2_000_000,
    { heapGrowth },
  );
  s.close();
}

// --- 4: bulk read bounds memory by iterating and stopping ---------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("bulk", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  // 20 legal 400k bodies. A fetch-all would still materialize ~8 MB to return
  // one, enough to violate the 5 MB assertion without making routine tests a
  // host stress workload.
  for (let i = 0; i < 20; i++) s.postMessage(r, "b", "z".repeat(400_000), "text", null, null);
  const heapBefore = process.memoryUsage().heapUsed;
  const page = s.catchUp(r, "a", 500, undefined, 100_000);
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  check("catch_up over huge bodies still fits max_bytes", size(page) <= 100_000, size(page));
  check("catch_up delivers the head and flags byte_limited", page.messages.length >= 1 && page.byte_limited === true, page.messages.length);
  check(
    "catch_up did not materialize all 20 bodies at once (~<5 MB, not ~8 MB)",
    heapGrowth < 5_000_000,
    { heapGrowth },
  );
  s.close();
}

// --- 5: list tools bound the serialized response and page with offset ---------
{
  const s = new ChatStore(":memory:");
  // 60 rooms, each with a control-heavy 300-char pinned that serializes ~6x.
  const heavy = "\u0001".repeat(300);
  for (let i = 0; i < 60; i++) s.createRoom("room-" + i, null, heavy);
  const first = s.listRooms(200, 0);
  check("list_rooms response is serialized-bounded", size(first.rooms) <= 100_000, size(first.rooms));
  check("list_rooms reports the true total", first.total === 60, first.total);
  // Keyset paging (after_id = next_id) reaches rooms past the first
  // size-trimmed page.
  const seen = new Set();
  let afterId = 0;
  for (let i = 0; i < 20; i++) {
    const pg = s.listRooms(200, afterId);
    for (const rm of pg.rooms) seen.add(rm.id);
    if (pg.next_id === undefined || pg.rooms.length === 0) break;
    afterId = pg.next_id;
  }
  check("list_rooms keyset paging reaches every room", seen.size === 60, seen.size);
  s.close();
}

// --- 6: identity switch keeps the old identity's private cursor alive ---------
// touchSessionMarkers keys on the session nonce, not (agent, nonce), so a
// session that renames still refreshes its earlier identity's cursor.
{
  const dir = mkdtempSync(join(tmpdir(), "v071-switch-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("sw", null, null).id;
  s.upsertAgent("A", null, null, null);
  s.upsertAgent("poster", null, null, null);
  s.joinRoom(r, "poster");
  for (let i = 1; i <= 10; i++) s.postMessage(r, "poster", "m" + i, "text", null, null);
  const NONCE = "sess-nonce-1";
  s.joinRoom(r, "A", NONCE); // A's private cursor at 0
  s.markRead(r, "A", 3, NONCE); // A read to 3 privately
  s.markRead(r, "A", 10); // identity marker (shared twin) to 10
  // Age A's cursor to 8 days old (as if the process was busy under identity B).
  {
    const raw = new Database(DB);
    raw.prepare("UPDATE session_markers SET updated_at = datetime('now','-8 days') WHERE session_id = ?").run(NONCE);
    raw.close();
  }
  // The process is now acting as identity B but SAME session nonce; a touch
  // must refresh A's cursor too (keyed by nonce), sparing it the GC.
  s.upsertAgent("B", null, null, null);
  s.touchSessionMarkers("B", NONCE);
  // A prune (which reaps expired cursors) must NOT drop A's now-fresh cursor.
  s.pruneMessages(r, 1, true);
  const cur = s.getCursor(r, "A", NONCE);
  check(
    "the renamed session's old-identity private cursor survived the GC",
    cur && cur.last_read_seq === 3,
    cur,
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 7: search tie-break + no false next_offset -------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("s", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  // Identical bodies -> identical rank; the g.id tie-break makes paging total.
  for (let i = 0; i < 4; i++) s.postMessage(r, "b", "needle same", "text", null, null);
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < 6; i++) {
    const res = s.searchMessages(r, "needle", 2, offset);
    for (const m of res.matches) seen.add(m.seq);
    if (res.next_offset === undefined) break;
    offset = res.next_offset;
  }
  check("equal-rank search pages cover every match exactly once", seen.size === 4, [...seen]);
  // Exactly `limit` matches must NOT emit a next_offset that returns nothing.
  const exact = s.searchMessages(r, "needle", 4, 0);
  check(
    "a page of exactly `limit` matches emits no false next_offset",
    exact.matches.length === 4 && exact.next_offset === undefined,
    exact.next_offset,
  );
  s.close();
}

// --- 8: chmod tightens only directories WE create -----------------------------
if (process.platform !== "win32") {
  const base = mkdtempSync(join(tmpdir(), "v071-perm-"));
  const shared = join(base, "shared-project");
  mkdirSync(shared, { mode: 0o755 });
  const before = statSync(shared).mode & 0o777;
  // DB directly inside the PRE-EXISTING shared dir: we did not create it, so we
  // must not chmod it.
  const s = new ChatStore(join(shared, "chat.db"));
  s.close();
  const after = statSync(shared).mode & 0o777;
  check("a pre-existing parent dir is left untouched", before === after && after === 0o755, after.toString(8));
  check("the db file itself is still owner-only", (statSync(join(shared, "chat.db")).mode & 0o777) === 0o600, null);
  // A dir we DO create is tightened.
  const madeDb = join(base, "made", "chat.db");
  const s2 = new ChatStore(madeDb);
  s2.close();
  check("a directory we created is 0700", (statSync(join(base, "made")).mode & 0o777) === 0o700, null);
  rmSync(base, { recursive: true, force: true });
}

// --- 12: delete_room on an already-deleted room fails cleanly -----------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("d", null, null).id;
  s.deleteRoom(r);
  check(
    "second delete_room reports 'already deleted', not a false zero-count success",
    throws(() => s.deleteRoom(r), /no longer exists/),
    null,
  );
  s.close();
}

// --- 4b: list_agents pagination is stable under same-second joins -------------
// joined_at is second-resolution; the composite (joined_at, a.id) keyset gives
// a total order so paging never skips or duplicates same-second joiners, even
// with a concurrent join between pages.
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("many", null, null).id;
  const ids = Array.from({ length: 12 }, (_, i) => "agent-" + String(i).padStart(2, "0"));
  for (const id of ids) {
    s.upsertAgent(id, null, null, null);
    s.joinRoom(r, id); // all within the same wall-clock second
  }
  const seen = [];
  let after;
  for (let p = 0; p < 20; p++) {
    const { agents, next_after } = s.listAgents(r, 5, undefined, 3, after);
    for (const a of agents) seen.push(a.id);
    // A concurrent same-second join on page 2 would shift an OFFSET; keyset is
    // immune. Insert one mid-traversal to prove it.
    if (p === 1) { s.upsertAgent("agent-zz", null, null, null); s.joinRoom(r, "agent-zz"); }
    if (next_after === undefined || agents.length === 0) break;
    after = next_after;
  }
  const uniq = new Set(seen);
  check(
    "list_agents keyset paging covers every same-second joiner exactly once",
    seen.length === uniq.size && uniq.size >= 12 && ids.every((id) => uniq.has(id)),
    { count: seen.length, unique: uniq.size },
  );
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
