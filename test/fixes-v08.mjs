// Regression tests for the v0.8.0 presence redesign: a session_presence table
// decoupled from cursors makes leave/presence correct for EVERY session mode.
// Findings closed (all reproduced before the redesign):
//  #4  pure-shared twins no longer evict each other on leave; a private leave
//      no longer evicts a live shared twin
//  #5  the presence GC recomputes memberships.left_at, so a crashed session no
//      longer lingers present forever
//  #2  my_mentions is session-aware: a session that left a room sees it muted
//      even while a twin keeps the identity present
//  #3  wait_for_messages flags baselined:true for a private-cursor --since watch
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- #4: two shared sessions -- one leaving keeps the live twin present -------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a", null, "P1"); // shared session 1 (presence only)
  s.joinRoom(r, "a", null, "P2"); // shared session 2
  s.leaveRoom(r, "a", "P1");
  check("#4 shared twin kept present after one leaves",
    s.getMembership(r, "a").left_at === null && s.presentRoomCount("a") === 1,
    { left_at: s.getMembership(r, "a").left_at, present: s.presentRoomCount("a") });
  s.leaveRoom(r, "a", "P2");
  check("#4 identity leaves once the LAST shared session leaves",
    s.getMembership(r, "a").left_at !== null && s.presentRoomCount("a") === 0, null);
  s.close();
}

// --- #4-mixed: a private session's leave does not evict a live shared twin ----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a", null, "SHARED");   // shared twin (presence SHARED)
  s.joinRoom(r, "a", "PRIV", "PRIV");   // private twin (cursor + presence PRIV)
  s.leaveRoom(r, "a", "PRIV");          // private leaves
  check("#4-mixed private leave keeps the live shared twin present",
    s.getMembership(r, "a").left_at === null && s.presentRoomCount("a") === 1, null);
  s.close();
}

// --- #5: presence GC recomputes memberships.left_at (no dead-present) ----------
{
  const dir = mkdtempSync(join(tmpdir(), "v08-gc-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("room", null, null); s.upsertAgent("ghost", null, null, null);
    s.joinRoom(1, "ghost", null, "G"); s.close(); } // present via G, never leaves (crash)
  { const raw = new Database(DB);
    raw.prepare("UPDATE session_presence SET updated_at = datetime('now','-8 days') WHERE session_id='G'").run();
    raw.close(); }
  { const s = new ChatStore(DB); s.upsertAgent("other", null, null, null); s.joinRoom(1, "other", null, "O"); // GC fires
    const rows = new Database(DB).prepare("SELECT COUNT(*) c FROM session_presence WHERE agent_id='ghost'").get().c;
    check("#5 crashed session GC'd AND identity marked left (not dead-present)",
      rows === 0 && s.getMembership(1, "ghost").left_at !== null,
      { rows, left_at: s.getMembership(1, "ghost").left_at });
    s.close(); }
  rmSync(dir, { recursive: true, force: true });
}

// --- #4-reaped: a leave AFTER this session's presence row was GC-reaped must
//     NOT evict a live twin (the no-row fallback reconciles, never blind-leaves)
{
  const dir = mkdtempSync(join(tmpdir(), "v08-reap-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("room", null, null); s.upsertAgent("a", null, null, null);
    s.joinRoom(1, "a", "A", "A"); s.joinRoom(1, "a", "B", "B"); s.close(); }
  { const raw = new Database(DB);
    raw.prepare("UPDATE session_presence SET updated_at=datetime('now','-8 days') WHERE session_id='A'").run();
    raw.close(); }
  { const s = new ChatStore(DB); s.upsertAgent("z", null, null, null); s.joinRoom(1, "z", null, "Z"); // GC reaps A's aged row
    s.leaveRoom(1, "a", "A"); // A leaves, but its presence row is gone
    check("#4-reaped: leave after GC-reap does NOT evict the live twin B",
      s.getMembership(1, "a").left_at === null && s.presentRoomCount("a") === 1,
      { left_at: s.getMembership(1, "a").left_at, present: s.presentRoomCount("a") });
    s.close(); }
  rmSync(dir, { recursive: true, force: true });
}

// --- #2: my_mentions is session-aware -- a left session mutes its room --------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a", "A", "A"); s.joinRoom(r, "a", "B", "B"); s.joinRoom(r, "b", null, "BOB");
  s.postMessage(r, "b", "hi @a", "text", ["a"], null);
  s.leaveRoom(r, "a", "A"); // session A leaves; twin B keeps identity present
  const inboxA = s.myMentions("a", 50, undefined, 100000, "A", 0);
  const inboxB = s.myMentions("a", 50, undefined, 100000, "B", 0);
  check("#2 left session A: room muted (no messages, no directed, no by_room)",
    inboxA.messages.length === 0 && inboxA.total_directed === 0 && inboxA.by_room.length === 0, inboxA);
  check("#2 live twin B: still sees the mention", inboxB.messages.length === 1 && inboxB.total_directed === 1, inboxB);
  s.close();
}

// --- #3: wait_for_messages flags baselined for a private scoped watch ---------
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v08-since-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], { env: { ...process.env, AGENT_CHAT_DB: DB }, stdio: ["pipe", "pipe", "ignore"] });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const s = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const w = (id) => new Promise((res) => { const t = setInterval(() => { if (R.has(id)) { clearInterval(t); res(R.get(id)); } }, 15); });
  let id = 1;
  const call = async (name, args) => { const i = ++id; s({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } }); const r = await w(i); return JSON.parse(r.result.content[0].text); };
  s({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await w(1);
  s({ jsonrpc: "2.0", method: "notifications/initialized" });
  await call("create_room", { name: "watch-room" });
  await call("join_room", { room: "watch-room", agent_id: "watcher", cursor: "private" });
  const wf = await call("wait_for_messages", { room: "watch-room" });
  check("#3 private scoped watch flags baselined:true and emits --since",
    wf.baselined === true && /--since /.test(wf.command), { baselined: wf.baselined, cmd: wf.command });
  // A shared (default) watch is not baselined.
  await call("join_room", { room: "watch-room", agent_id: "watcher", cursor: "shared" });
  const wf2 = await call("wait_for_messages", { room: "watch-room" });
  check("#3 shared scoped watch is NOT baselined", wf2.baselined === false && !/--since /.test(wf2.command), { baselined: wf2.baselined, cmd: wf2.command });
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
