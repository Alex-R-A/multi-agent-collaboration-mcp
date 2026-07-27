// Tests for the v0.6.0 cross-room mentions inbox (myMentions) and the
// all-rooms poller probe (check.js without --room). The inbox replaces the
// per-room mentions_me peek; it must preserve that feature's hard-learned
// lesson: a filtered view must never read as "all quiet" while broadcasts
// sit unread (by_room reports total unread per room).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";
import { EPOCH1, mkAgent, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "dist", "check.js");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "aichat-inbox-"));
const DB = join(dir, "inbox.db");
const s = new ChatStore(DB);

// Three rooms; hero is in all three, then leaves gamma.
const r1 = mkRoom(s, "alpha", null, null).id;
const r2 = mkRoom(s, "beta", null, null).id;
const r3 = mkRoom(s, "gamma", null, null).id;
mkAgent(s, "hero");
mkAgent(s, "ann");
mkAgent(s, "ben");
for (const r of [r1, r2, r3]) s.joinRoom(r, "hero", EPOCH1, {});
s.joinRoom(r1, "ann", EPOCH1, {});
s.joinRoom(r2, "ann", EPOCH1, {});
s.joinRoom(r3, "ben", EPOCH1, {});

s.postMessage(r1, "ann", "alpha broadcast", "text", null, null, null, EPOCH1); // a1
s.postMessage(r1, "ann", "alpha ping", "text", ["hero"], null, null, EPOCH1); // a2 directed
s.postMessage(r1, "hero", "hero speaks", "text", null, null, null, EPOCH1); // a3 (own)
s.postMessage(r1, "ann", "reply to hero", "text", null, 3, null, EPOCH1); // a4 directed (reply)
s.postMessage(r2, "ann", "beta broadcast one", "text", null, null, null, EPOCH1); // b1
s.postMessage(r2, "ann", "beta broadcast two", "text", null, null, null, EPOCH1); // b2
s.postMessage(r3, "ben", "gamma ping", "text", ["hero"], null, null, EPOCH1); // g1 directed
s.leaveRoom(r3, "hero", EPOCH1); // mutes gamma

// --- inbox contents, ordering, room tags -----------------------------------
{
  const inbox = s.myMentions("hero", 50);
  check(
    "inbox holds the two directed alpha messages, oldest first",
    inbox.messages.length === 2 &&
      inbox.messages[0].seq === 2 &&
      inbox.messages[1].seq === 4,
    inbox.messages.map((m) => [m.room_name, m.seq]),
  );
  check(
    "entries carry room_id and room_name",
    inbox.messages.every((m) => m.room_id === r1 && m.room_name === "alpha"),
    inbox.messages,
  );
  check("left room (gamma) is muted", !inbox.messages.some((m) => m.room_id === r3));
  check("total_directed counts present rooms only", inbox.total_directed === 2, inbox.total_directed);

  const alpha = inbox.by_room.find((r) => r.room_id === r1);
  const beta = inbox.by_room.find((r) => r.room_id === r2);
  const gamma = inbox.by_room.find((r) => r.room_id === r3);
  check(
    "by_room: alpha shows 3 unread (own post excluded) with 2 directed",
    alpha && alpha.unread === 3 && alpha.directed === 2,
    alpha,
  );
  check(
    "by_room: beta shows broadcasts as unread with 0 directed (anti-quiet signal)",
    beta && beta.unread === 2 && beta.directed === 0,
    beta,
  );
  check("by_room omits the left room", gamma === undefined, gamma);
  check(
    "inbox is a peek: no marker moved",
    s.getMembership(r1, "hero").last_read_seq === 0 &&
      s.getMembership(r2, "hero").last_read_seq === 0,
    [s.getMembership(r1, "hero"), s.getMembership(r2, "hero")],
  );
}

// --- entries clear by actually reading the room -----------------------------
{
  s.catchUp(r1, "hero", 50, undefined, 100000, EPOCH1); // read alpha
  const inbox = s.myMentions("hero", 50);
  check("reading a room clears its inbox entries", inbox.messages.length === 0, inbox.messages);
  check("total_directed drops to 0", inbox.total_directed === 0, inbox.total_directed);
  const beta = inbox.by_room.find((r) => r.room_id === r2);
  check("beta's unread broadcasts still visible in by_room", beta && beta.unread === 2, beta);
}

// --- rejoin unmutes ----------------------------------------------------------
{
  s.joinRoom(r3, "hero", EPOCH1, {});
  const inbox = s.myMentions("hero", 50);
  check(
    "rejoining gamma surfaces its pending mention",
    inbox.messages.length === 1 && inbox.messages[0].room_name === "gamma",
    inbox.messages,
  );
}

// --- byte bound ---------------------------------------------------------------
{
  s.postMessage(r2, "ann", "z".repeat(30_000), "text", ["hero"], null, null, EPOCH1);
  const inbox = s.myMentions("hero", 50, undefined, 5000);
  check(
    "byte budget trims the inbox and flags it",
    inbox.byte_limited === true && inbox.messages.length >= 1,
    { n: inbox.messages.length, limited: inbox.byte_limited },
  );
}
s.close();

// --- check.js all-rooms probe --------------------------------------------------
function probe(args) {
  const r = spawnSync("node", [CHECK, "--db", DB, ...args], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, err: r.stderr.trim() };
}

{
  const all = probe(["--agent", "hero"]);
  check(
    "all-rooms probe: exit 0 with per-identity totals",
    all.code === 0 && all.json && all.json.rooms === 3 && all.json.unread > 0,
    all,
  );
  const mentions = probe(["--agent", "hero", "--mentions-only"]);
  check(
    "all-rooms mentions-only probe fires on pending mentions",
    mentions.code === 0 && mentions.json.unread_mentions >= 2,
    mentions,
  );
  const ghost = probe(["--agent", "nobody"]);
  check("unknown agent is an error (exit 2), not a quiet room", ghost.code === 2, ghost);
  const sinceNoRoom = probe(["--agent", "hero", "--since", "3"]);
  check("--since without --room is rejected", sinceNoRoom.code === 2, sinceNoRoom);
  const scoped = probe(["--room", "beta", "--agent", "hero"]);
  check(
    "single-room mode still works with --room",
    scoped.code === 0 && scoped.json.room_id === 2,
    scoped,
  );

  // Drain everything; the all-rooms probe must then report quiet (exit 1).
  const s2 = new ChatStore(DB);
  for (const r of [1, 2, 3]) s2.catchUp(r, "hero", 500, undefined, 100000, EPOCH1);
  s2.close();
  const quiet = probe(["--agent", "hero"]);
  check(
    "all-rooms probe: exit 1 when fully caught up",
    quiet.code === 1 && quiet.json.unread === 0 && quiet.json.unread_mentions === 0,
    quiet,
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
