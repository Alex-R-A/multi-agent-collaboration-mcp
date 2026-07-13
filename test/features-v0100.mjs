// Phase 2 blocking-wait tests (v0.10.0): catch_up({wait_seconds}) with the
// capture/probe/abort core plus the in_turn_wait presence lease.
//  S1 unreadProbe uses catchUp's exact predicate (own posts excluded,
//     session cursor honored, non-member throws)
//  S2 wait leases: watching in recipientStatus/list_agents, expiry, reaping
//  S3 deleteRoom clears leases
//  M1 immediate backlog return (no sleep when messages already wait)
//  M2 one-call handoff: wait -> peer posts -> pending call returns it;
//     watching:true while open, false after
//  M3 timeout carries timed_out/call_again/waited_ms/rooms_with_unread
//  M4 wait_seconds omitted keeps the exact v0.9 response shape
//  M5 active-room change mid-wait: captured room governs
//  M6 cursor-mode flip mid-wait: session_changed, nothing advanced
//  M7 shared twin consumes mid-wait: no stale refire, later message delivered
//  M8 client cancellation: response suppressed, marker NOT advanced, lease
//     dropped, backlog recoverable
//  M9 room deleted mid-wait: clean error, not a raw constraint failure
//  M10 wait_seconds above the 25s cap is rejected
//  M11 two waiters (separate server processes) both receive one post
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- S1: probe predicate parity -------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("probe-room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a", "S", "S"); // private session S
  s.joinRoom(r, "b");
  s.postMessage(r, "a", "own post", "text", null, null);
  check("S1 own post does not count as unread", s.unreadProbe(r, "a", null) === 0, null);
  s.postMessage(r, "b", "peer post", "text", null, null);
  check("S1 peer post counts", s.unreadProbe(r, "a", null) === 1, null);
  // Twin advances the identity marker; session S's private cursor still sees it.
  s.catchUp(r, "a", 50);
  check("S1 identity probe drained", s.unreadProbe(r, "a", null) === 0, null);
  // Session S's cursor is still 0: one unread (the peer post; own posts never count).
  check("S1 private-session probe still sees it", s.unreadProbe(r, "a", "S") === 1, null);
  let threw = "";
  try {
    s.unreadProbe(r, "never-joined", null);
  } catch (e) {
    threw = e.message;
  }
  check("S1 non-member probe throws", /not a member/.test(threw), threw);
  s.close();
}

// --- S2/S3: wait leases ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v0100-lease-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("lease-room", null, null).id;
  s.upsertAgent("w", null, null, null);
  s.joinRoom(r, "w");
  s.beginWaitLease(r, "w", "NONCE", 30);
  let st = s.recipientStatus(r, ["w"], 5);
  check("S2 open lease reads as watching in recipientStatus", st[0].watching === true, st);
  const la = s.listAgents(r, 5).agents.find((a) => a.id === "w");
  check("S2 open lease reads as watching in list_agents", la.watching === true, la);
  s.endWaitLease(r, "w", "NONCE");
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 closed lease reads as not watching", st[0].watching === false, st);
  // An expired lease (crashed waiter) must read false and get reaped.
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO wait_leases (room_id, agent_id, session_id, expires_at)
       VALUES (?, 'w', 'DEAD', datetime('now', '-1 seconds'))`,
    ).run(r);
    raw.close();
  }
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 expired lease reads as not watching", st[0].watching === false, st);
  s.beginWaitLease(r, "w", "NONCE2", 30);
  {
    const raw = new Database(DB);
    const dead = raw
      .prepare("SELECT COUNT(*) AS c FROM wait_leases WHERE session_id = 'DEAD'")
      .get();
    raw.close();
    check("S2 beginWaitLease reaps expired rows", dead.c === 0, dead);
  }
  s.deleteRoom(r);
  {
    const raw = new Database(DB);
    const left = raw.prepare("SELECT COUNT(*) AS c FROM wait_leases").get();
    raw.close();
    check("S3 deleteRoom clears wait leases", left.c === 0, left);
  }
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- MCP harness -----------------------------------------------------------------
function startServer(DB) {
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  let id = 100;
  const sendCall = (name, args) => {
    const i = ++id;
    send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    return i;
  };
  const waitFor = (i, timeoutMs = 30_000) =>
    new Promise((res) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        if (R.has(i)) { clearInterval(t); res(R.get(i)); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(t); res(null); }
      }, 15);
    });
  const parse = (m) => {
    if (!m) return { timedOutWaiting: true };
    if (m.error) return { rpcError: m.error };
    const body = m.result?.content?.[0]?.text;
    let data = null;
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        data = { raw: body }; // e.g. the SDK's own validation error text
      }
    }
    return { isError: m.result?.isError === true, data };
  };
  const call = async (name, args) => parse(await waitFor(sendCall(name, args)));
  const init = async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  const cancel = (i) =>
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: i, reason: "test" } });
  return { child, call, sendCall, waitFor, parse, cancel, init };
}

await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v0100-mcp-"));
  const DB = join(dir, "t.db");
  const srv = startServer(DB);
  await srv.init();
  const s = new ChatStore(DB);
  const rA = s.createRoom("wait-a", null, null).id;
  const rB = s.createRoom("wait-b", null, null).id;
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(rA, "peer");
  s.joinRoom(rB, "peer");
  await srv.call("join_room", { room: "wait-b", agent_id: "u" });
  await srv.call("join_room", { room: "wait-a", agent_id: "u" }); // active = A

  // M1: backlog present -> no sleep.
  s.postMessage(rA, "peer", "already here", "text", null, null);
  const t1 = Date.now();
  const m1 = await srv.call("catch_up", { wait_seconds: 10 });
  check(
    "M1 immediate backlog returns without sleeping",
    m1.data.messages.length === 1 && Date.now() - t1 < 2000 && m1.data.waited_ms < 2000,
    { waited_ms: m1.data.waited_ms },
  );

  // M2: the one-call handoff, with the lease visible while open.
  const id2 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(700);
  const during = s.recipientStatus(rA, ["u"], 5)[0];
  s.postMessage(rA, "peer", "handoff", "text", ["u"], null);
  const m2 = srv.parse(await srv.waitFor(id2));
  check(
    "M2 pending call returns the posted message and advances",
    m2.data.messages.length === 1 && m2.data.messages[0].content === "handoff" &&
      m2.data.advanced === true && m2.data.waited_ms >= 500 && m2.data.timed_out === undefined,
    { n: m2.data.messages?.length, waited: m2.data.waited_ms },
  );
  check("M2 watching:true while the wait is open", during.watching === true, during);
  const after = s.recipientStatus(rA, ["u"], 5)[0];
  check("M2 watching:false once the call returned", after.watching === false, after);

  // M3: timeout metadata.
  const t3 = Date.now();
  const m3 = await srv.call("catch_up", { wait_seconds: 1 });
  check(
    "M3 timeout carries timed_out/call_again/waited_ms/rooms_with_unread",
    m3.data.timed_out === true && m3.data.call_again === true &&
      m3.data.waited_ms >= 1000 && Date.now() - t3 >= 1000 &&
      Array.isArray(m3.data.rooms_with_unread),
    m3.data,
  );

  // M4: omitted wait keeps the v0.9 shape (no waited_ms/timed_out).
  const m4 = await srv.call("catch_up", {});
  check(
    "M4 omitted wait_seconds adds no wait fields",
    m4.data.waited_ms === undefined && m4.data.timed_out === undefined,
    m4.data,
  );

  // M5: active-room change mid-wait; the captured room governs.
  const id5 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-b" }); // active moves to B mid-wait
  s.postMessage(rA, "peer", "for the captured room", "text", null, null);
  const m5 = srv.parse(await srv.waitFor(id5));
  const who5 = await srv.call("whoami", {});
  check(
    "M5 wait returns the CAPTURED room's message after an active-room switch",
    m5.data.room_id === rA && m5.data.room_name === "wait-a" &&
      m5.data.messages.length === 1 &&
      m5.data.messages[0].content === "for the captured room",
    m5.data,
  );
  check("M5 the concurrent join still moved the active room", who5.data.room_id === rB, who5.data);
  await srv.call("join_room", { room: "wait-a" }); // back to A, shared

  // M6: cursor-mode flip mid-wait -> session_changed, nothing advanced.
  const before6 = s.getMembership(rA, "u").last_read_seq;
  const id6 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-a", cursor: "private" }); // flip shared->private
  s.postMessage(rA, "peer", "post-flip message", "text", null, null);
  const m6 = srv.parse(await srv.waitFor(id6));
  check(
    "M6 flip mid-wait returns session_changed without reading",
    m6.data.session_changed === true && m6.data.call_again === true &&
      m6.data.messages.length === 0,
    m6.data,
  );
  check(
    "M6 no marker advanced past the pre-flip position",
    s.getMembership(rA, "u").last_read_seq === before6,
    { before: before6, now: s.getMembership(rA, "u").last_read_seq },
  );
  const recover6 = await srv.call("catch_up", {});
  check(
    "M6 the message is recoverable by the next call",
    recover6.data.messages.some((m) => m.content === "post-flip message"),
    recover6.data.messages,
  );
  await srv.call("join_room", { room: "wait-a", cursor: "shared" }); // back to shared

  // M7: shared twin consumes mid-wait (atomically, so the outcome is
  // deterministic): the waiter must NOT refire on the consumed message and
  // must deliver only the later one.
  const id7 = srv.sendCall("catch_up", { wait_seconds: 12 });
  await sleep(600);
  {
    const raw = new Database(DB);
    raw
      .transaction(() => {
        raw
          .prepare(
            `INSERT INTO messages (room_id, seq, agent_id, format, body, body_len)
             VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE room_id = ?), 'peer', 'text', 'ghosted', 7)`,
          )
          .run(rA, rA);
        raw
          .prepare(
            `UPDATE memberships SET last_read_seq =
               (SELECT MAX(seq) FROM messages WHERE room_id = ?)
             WHERE room_id = ? AND agent_id = 'u'`,
          )
          .run(rA, rA);
      })
      .immediate();
    raw.close();
  }
  await sleep(1200); // several probe ticks over the already-consumed message
  s.postMessage(rA, "peer", "the real one", "text", null, null);
  const m7 = srv.parse(await srv.waitFor(id7));
  check(
    "M7 twin-consumed message never refires; the later message is delivered",
    m7.data.messages.length === 1 && m7.data.messages[0].content === "the real one" &&
      !m7.data.messages.some((m) => m.content === "ghosted"),
    m7.data.messages,
  );

  // M8: client cancellation. Response is suppressed, marker must not advance,
  // the lease drops, and the message is recoverable afterward.
  const id8 = srv.sendCall("catch_up", { wait_seconds: 8 });
  await sleep(700);
  srv.cancel(id8);
  await sleep(200);
  const before8 = s.getMembership(rA, "u").last_read_seq;
  const seq8 = s.postMessage(rA, "peer", "posted after cancel", "text", null, null).seq;
  const m8 = await srv.waitFor(id8, 2500);
  check("M8 cancelled call's response is suppressed", m8 === null, m8);
  check(
    "M8 no marker advance after the observed abort",
    s.getMembership(rA, "u").last_read_seq === before8 && before8 < seq8,
    { before: before8, seq: seq8, now: s.getMembership(rA, "u").last_read_seq },
  );
  const lease8 = s.recipientStatus(rA, ["u"], 5)[0];
  check("M8 lease dropped on cancellation", lease8.watching === false, lease8);
  const recover8 = await srv.call("catch_up", {});
  check(
    "M8 the message is recoverable by the next call",
    recover8.data.messages.some((m) => m.content === "posted after cancel"),
    recover8.data.messages,
  );

  // M9: room deleted mid-wait -> clean error naming the deletion.
  const rD = s.createRoom("doomed", null, null).id;
  s.joinRoom(rD, "peer");
  await srv.call("join_room", { room: "doomed" });
  const id9 = srv.sendCall("catch_up", { wait_seconds: 8 });
  await sleep(700);
  s.deleteRoom(rD);
  const m9 = srv.parse(await srv.waitFor(id9));
  check(
    "M9 deletion mid-wait yields a clean error",
    m9.isError === true && /deleted while waiting/.test(m9.data.error),
    m9,
  );
  await srv.call("join_room", { room: "wait-a" });

  // M10: the cap is enforced at the schema.
  const m10 = await srv.call("catch_up", { wait_seconds: 26 });
  check(
    "M10 wait_seconds above the 25s cap is rejected",
    (m10.rpcError !== undefined || m10.isError === true) &&
      /25/.test(JSON.stringify(m10)),
    m10,
  );

  // M12: identity mutation mid-wait -- a concurrent join under a NEW
  // agent_id switches the session identity, but the captured identity
  // governs: the wait returns and advances for the ORIGINAL agent.
  const before12 = s.getMembership(rA, "u").last_read_seq;
  const id12 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-b", agent_id: "v" }); // identity -> v
  const seq12 = s.postMessage(rA, "peer", "for the old identity", "text", null, null).seq;
  const m12 = srv.parse(await srv.waitFor(id12));
  const who12 = await srv.call("whoami", {});
  check(
    "M12 identity change mid-wait: captured identity still receives and advances",
    m12.data.agent_id === "u" && m12.data.messages.length === 1 &&
      m12.data.messages[0].content === "for the old identity" &&
      s.getMembership(rA, "u").last_read_seq === seq12 && before12 < seq12,
    { data: m12.data, marker: s.getMembership(rA, "u").last_read_seq },
  );
  check(
    "M12 the session itself now runs as the new identity",
    who12.data.agent_id === "v",
    who12.data,
  );

  s.close();
  srv.child.kill();

  // M11: two waiters in separate server processes, one post wakes both.
  const srv1 = startServer(DB);
  const srv2 = startServer(DB);
  await srv1.init();
  await srv2.init();
  await srv1.call("join_room", { room: "wait-a", agent_id: "w1" });
  await srv2.call("join_room", { room: "wait-a", agent_id: "w2" });
  await srv1.call("catch_up", {}); // drain backlogs so both waits block
  await srv2.call("catch_up", {});
  const w1 = srv1.sendCall("catch_up", { wait_seconds: 10 });
  const w2 = srv2.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(700);
  const s2 = new ChatStore(DB);
  s2.postMessage(rA, "peer", "broadcast to waiters", "text", null, null);
  const r1 = srv1.parse(await srv1.waitFor(w1));
  const r2 = srv2.parse(await srv2.waitFor(w2));
  check(
    "M11 both concurrent waiters receive the one post",
    r1.data.messages.some((m) => m.content === "broadcast to waiters") &&
      r2.data.messages.some((m) => m.content === "broadcast to waiters"),
    { r1: r1.data.messages?.length, r2: r2.data.messages?.length },
  );
  s2.close();
  srv1.child.kill();
  srv2.child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall features-v0100 checks passed");
