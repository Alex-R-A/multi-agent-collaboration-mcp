// Regression tests for the v0.7.8 fixes (two findings from a three-way review,
// each reproduced against the built store before the fix):
//  #2  my_mentions now signals "more remain" (byte_limited) when the ROW limit
//      cuts a page, not only when the byte budget does -- an agent paging on the
//      documented byte_limited signal used to under-read its inbox silently.
//  #4  list_rooms is KEYSET-paged (after_id/next_id), so a room deleted between
//      pages can no longer shift OFFSET and skip a still-live room.
import { ChatStore } from "../dist/db.js";
import { EPOCH1, mkAgent, mkRoom, rmRoom } from "./persona-helpers.mjs";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- #2: my_mentions flags a ROW-limit cut, and after_id delivers the rest ----
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  mkAgent(s, "w");
  mkAgent(s, "p");
  s.joinRoom(r, "w", EPOCH1, {});
  s.joinRoom(r, "p", EPOCH1, {});
  const N = 60; // > default limit 50, but all fit well inside 100k bytes
  for (let i = 0; i < N; i++) s.postMessage(r, "p", "hi " + i, "text", ["w"], null, null, EPOCH1);

  const page = s.myMentions("w", 50, undefined, 100000, 0);
  check(
    "my_mentions returns exactly `limit` on an over-limit inbox",
    page.messages.length === 50,
    page.messages.length,
  );
  check(
    "my_mentions flags byte_limited when the ROW limit (not bytes) cut the page",
    page.byte_limited === true,
    { byte_limited: page.byte_limited, size: JSON.stringify(page).length },
  );

  // Paging by byte_limited + after_id (the documented protocol) delivers ALL.
  const seen = new Set();
  let after = 0;
  let guard = 0;
  for (;;) {
    const p = s.myMentions("w", 50, undefined, 100000, after);
    for (const m of p.messages) seen.add(m.seq);
    if (!p.byte_limited) break; // stop exactly on the documented signal
    after = p.next_after_id;
    if (++guard > 20) {
      check("my_mentions byte_limited paging terminates", false, guard);
      break;
    }
  }
  check(
    "paging on byte_limited alone now delivers every directed message",
    seen.size === N,
    seen.size,
  );

  // Boundary: exactly `limit` directed messages must NOT emit a false signal.
  const s2 = new ChatStore(":memory:");
  const r2 = mkRoom(s2, "room", null, null).id;
  mkAgent(s2, "w");
  mkAgent(s2, "p");
  s2.joinRoom(r2, "w", EPOCH1, {});
  s2.joinRoom(r2, "p", EPOCH1, {});
  for (let i = 0; i < 50; i++) s2.postMessage(r2, "p", "hi " + i, "text", ["w"], null, null, EPOCH1);
  const exact = s2.myMentions("w", 50, undefined, 100000, 0);
  check(
    "exactly `limit` directed messages emits NO false byte_limited",
    exact.messages.length === 50 && exact.byte_limited === undefined,
    { len: exact.messages.length, byte_limited: exact.byte_limited },
  );
  s2.close();
  s.close();
}

// --- #4: list_rooms keyset paging survives a concurrent delete_room -----------
{
  const s = new ChatStore(":memory:");
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(mkRoom(s, "room-" + i, null, null).id);

  const p1 = s.listRooms(3, 0);
  const seen = new Set(p1.rooms.map((r) => r.id));
  check("list_rooms first keyset page returns 3 with a next_id", p1.rooms.length === 3 && typeof p1.next_id === "number", p1.next_id);

  // A concurrent delete removes a room whose id is INSIDE page 1's range.
  rmRoom(s, ids[1]);

  // Page 2 continues from the keyset cursor, not a shifted offset.
  const p2 = s.listRooms(3, p1.next_id);
  for (const r of p2.rooms) seen.add(r.id);

  const live = ids.filter((_, i) => i !== 1); // id[1] legitimately deleted
  const missing = live.filter((id) => !seen.has(id));
  check(
    "keyset paging skips NO live room when one is deleted between pages",
    missing.length === 0,
    { missing, seen: [...seen] },
  );

  // next_id must terminate: a full walk of an undisturbed listing ends cleanly.
  const s2 = new ChatStore(":memory:");
  for (let i = 0; i < 5; i++) mkRoom(s2, "r-" + i, null, null);
  const walked = new Set();
  let after = 0;
  let guard = 0;
  for (;;) {
    const pg = s2.listRooms(2, after);
    for (const r of pg.rooms) walked.add(r.id);
    if (pg.next_id === undefined) break;
    after = pg.next_id;
    if (++guard > 20) {
      check("list_rooms keyset walk terminates", false, guard);
      break;
    }
  }
  check("list_rooms keyset walk covers all rooms and stops", walked.size === 5, walked.size);
  s2.close();
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
