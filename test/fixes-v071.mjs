// Regression tests for the SEVENTH-round fixes (v0.7.1), each reproducing a
// bug an adversarial reviewer confirmed against v0.7.0:
//  1  embedded NUL is rejected at write (SQLite substr/length truncate at it,
//     so a stored NUL silently drops the tail and advances the marker past it)
//  2  the body_len trigger no longer stamps a wrong (codepoint) astral length
//     that never self-repairs; fullLen()=max() never under-reports
//  3  get_message pages a huge body with BOUNDED memory (window, not prefix)
//  4  bulk reads bound memory by iterating and stopping at the budget
//  5  list tools bound the SERIALIZED response and page with offset
//  (6 covered a session that switched IDENTITY keeping its old identity's
//   private cursor alive. Private session cursors are gone -- one runtime holds
//   one persona -- so the case cannot arise and its test was deleted. The
//   surviving half, per-room read markers, is covered by fixes-v064.)
//  7  search: g.id tie-break + limit+1 probe (no false next_offset)
//  8  chmod tightens only directories WE create, never a pre-existing parent,
//     and one failed chmod does not skip later independent targets
//  12 delete_room on an already-deleted room fails cleanly
//  13 lone surrogates are rejected at write
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkAgent, mkRoom, rmRoom } from "./persona-helpers.mjs";

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
  const r = mkRoom(s, "n", null, null).id;
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  check(
    "post_message with an embedded NUL is rejected (was silent truncation)",
    throws(() => s.postMessage(r, "b", "abc" + NUL + "def", "text", null, null, null), /NUL/),
    null,
  );
  check(
    "post_message with a lone high surrogate is rejected",
    throws(() => s.postMessage(r, "b", "x\ud800y", "text", null, null, null), /surrogate/),
    null,
  );
  check(
    "create_room with a NUL pinned is rejected",
    throws(() => mkRoom(s, "bad", null, "pin" + NUL + "ned"), /NUL/),
    null,
  );
  check(
    "set_role with a NUL role is rejected",
    throws(() => s.setRole(r, "a", "re" + NUL + "viewer"), /NUL/),
    null,
  );
  check(
    "join_room with a NUL role is rejected",
    throws(() => s.joinRoom(r, "a", { role: "re" + NUL + "viewer" }), /NUL/),
    null,
  );
  check(
    "claim with a NUL note is rejected",
    throws(() => s.claimResource(r, "k", "a", 900, "no" + NUL + "te"), /NUL/),
    null,
  );
  // A legitimate control char that is NOT NUL still stores and round-trips.
  s.postMessage(r, "b", "ctl\u0001ok", "text", null, null, null);
  const back = s.getMessage(r, 1, 0, 1000);
  check("a non-NUL control char round-trips intact", back.content === "ctl\u0001ok", back.content);
  s.close();
}

// --- 2: body_len is exact for astral text, and NOT NULL ----------------------
//
// SQLite's length() counts codepoints, so a body of 200 emoji measures 200
// there and 400 in the UTF-16 unit the viewer reports. That is why the exact
// length is STAMPED at insert instead of computed at read time. The column is
// NOT NULL, so there is no fallback path and no reader has to guess which unit
// it is holding: a writer that omits it is rejected outright.
{
  const dir = mkdtempSync(join(tmpdir(), "v071-blen-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  mkRoom(s, "r", null, null);
  mkAgent(s, "a");
  s.joinRoom(1, "a", {});
  const astral = "\u{1F600}".repeat(200);
  s.postMessage(1, "a", astral, "text", null, null, null);
  const gm = s.getMessage(1, 1, 0, 100_000); // whole body fits
  check(
    "an astral body pages fully and reports its exact length",
    gm.truncated !== true && gm.content === astral,
    { truncated: gm.truncated, len: gm.content.length },
  );
  const raw = new Database(DB);
  const stamped = raw.prepare("SELECT body_len FROM messages WHERE seq = 1").get();
  check(
    "body_len is the UTF-16 length (400), not SQLite's codepoint count (200)",
    stamped.body_len === 400,
    stamped,
  );
  // The negative half. Without it the NOT NULL is unproven: every row this
  // suite writes goes through a store that stamps the column anyway.
  let omitted = "";
  try {
    raw
      .prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,2,'a','text',?)")
      .run("no length stamped");
  } catch (e) {
    omitted = String(e?.message ?? e);
  }
  check(
    "a direct writer that omits body_len is REJECTED, not stored with NULL",
    /NOT NULL constraint failed: messages\.body_len/.test(omitted),
    omitted || "NO ERROR RAISED",
  );
  raw.close();
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 3: get_message deep page is memory-bounded (window, not prefix) ----------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "big", null, null).id;
  mkAgent(s, "b");
  s.joinRoom(r, "b", {});
  // 5 MB body: a prefix fetch of a deep page would materialize megabytes; a
  // window fetch holds only ~maxChars. Assert the deep page returns the right
  // window and heap stays bounded.
  const body = "abcdefghij".repeat(500_000); // 5,000,000 chars
  s.postMessage(r, "b", body, "text", null, null, null);
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
  const r = mkRoom(s, "bulk", null, null).id;
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  // 20 legal 400k bodies. A fetch-all would still materialize ~8 MB to return
  // one, enough to violate the 5 MB assertion without making routine tests a
  // host stress workload.
  for (let i = 0; i < 20; i++) {
    s.postMessage(r, "b", "z".repeat(400_000), "text", null, null, null);
  }
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
  for (let i = 0; i < 60; i++) mkRoom(s, "room-" + i, null, heavy);
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

// --- 7: search tie-break + no false next_offset -------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "s", null, null).id;
  mkAgent(s, "b");
  s.joinRoom(r, "b", {});
  // Identical bodies -> identical rank; the g.id tie-break makes paging total.
  for (let i = 0; i < 4; i++) {
    s.postMessage(r, "b", "needle same", "text", null, null, null);
  }
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

  const faultDb = join(base, "fault.db");
  new Database(faultDb).close();
  const faultProbe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const dbPath = process.env.TEST_DB_PATH;
        const realChmod = fs.chmodSync;
        const realExists = fs.existsSync;
        const calls = [];
        let failedDb = false;
        fs.existsSync = (candidate) =>
          String(candidate).startsWith(dbPath) ? true : realExists(candidate);
        fs.chmodSync = (candidate, mode) => {
          const value = String(candidate);
          calls.push(value);
          if (value === dbPath && !failedDb) {
            failedDb = true;
            throw new Error("forced chmod failure");
          }
          if (value === dbPath + "-wal" || value === dbPath + "-shm") return;
          realChmod(candidate, mode);
        };
        syncBuiltinESMExports();
        const { ChatStore } = await import(process.env.TEST_DB_MODULE);
        const store = new ChatStore(dbPath);
        store.close();
        process.stdout.write(JSON.stringify(calls));
      `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_DB_PATH: faultDb,
        TEST_DB_MODULE: new URL("../dist/db.js", import.meta.url).href,
      },
    },
  );
  const chmodCalls = faultProbe.status === 0 ? JSON.parse(faultProbe.stdout) : [];
  check(
    "one chmod failure does not skip later database sidecars",
    chmodCalls.includes(faultDb + "-wal") && chmodCalls.includes(faultDb + "-shm"),
    { status: faultProbe.status, stderr: faultProbe.stderr, chmodCalls },
  );
  rmSync(base, { recursive: true, force: true });
}

// --- 12: delete_room on an already-deleted room fails cleanly -----------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "d", null, null).id;
  rmRoom(s, r);
  check(
    "second delete_room reports 'already deleted', not a false zero-count success",
    throws(() => rmRoom(s, r), /no longer exists/),
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
  const r = mkRoom(s, "many", null, null).id;
  const ids = Array.from({ length: 12 }, (_, i) => "agent-" + String(i).padStart(2, "0"));
  for (const id of ids) {
    mkAgent(s, id);
    s.joinRoom(r, id, {}); // all within the same wall-clock second
  }
  const seen = [];
  let after;
  for (let p = 0; p < 20; p++) {
    const { agents, next_after } = s.listAgents(r, 5, undefined, 3, after);
    for (const a of agents) seen.push(a.id);
    // A concurrent same-second join on page 2 would shift an OFFSET; keyset is
    // immune. Insert one mid-traversal to prove it.
    if (p === 1) {
      mkAgent(s, "agent-zz");
      s.joinRoom(r, "agent-zz", {});
    }
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
