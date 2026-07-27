// Phase 2 blocking-wait tests (v0.10.0): catch_up({wait_seconds}) with the
// capture/probe/abort core plus the in_turn_wait presence lease.
//  S1 unreadProbe uses catchUp's exact predicate (own posts excluded,
//     epoch fenced, non-member throws)
//  S2 wait leases: watching in recipientStatus/list_agents, expiry, reaping
//  S3 deleteRoom clears leases
//  M1 immediate backlog return (no sleep when messages already wait)
//  M2 one-call handoff: wait -> peer posts -> pending call returns it;
//     watching:true while open, false after
//  M3 timeout carries timed_out/call_again/waited_ms/rooms_with_unread
//  M4 wait_seconds omitted keeps the exact v0.9 response shape
//  M4b concurrent waits in one process keep independent leases
//  M4c named-room waits heartbeat the captured room, not the active room
//  M5 active-room change mid-wait: captured room governs
//  M6 takeover mid-wait: the wait does not advance under a lost authority
//  M7 a concurrent read consumes mid-wait: no stale refire, later message delivered
//  M8 client cancellation: response suppressed, marker NOT advanced, lease
//     dropped, backlog recoverable
//  M9 room deleted mid-wait: clean error, not a raw constraint failure
//  M10 120s server cap returns immediate backlog; 121 is rejected
//  M11 two waiters (separate server processes) both receive one post
import { ChatStore, PersonaLostError } from "../dist/db.js";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EPOCH1, mkAgent, bindArgs, mkRoom, rmRoom } from "./persona-helpers.mjs";

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
  const r = mkRoom(s, "probe-room", null, null).id;
  mkAgent(s, "u");
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", EPOCH1, {});
  s.joinRoom(r, "b", EPOCH1, {});
  s.postMessage(r, "a", "own post", "text", null, null, null, EPOCH1);
  check("S1 own post does not count as unread", s.unreadProbe(r, "a", EPOCH1) === 0, null);
  s.postMessage(r, "b", "peer post", "text", null, null, null, EPOCH1);
  check("S1 peer post counts", s.unreadProbe(r, "a", EPOCH1) === 1, null);
  // The advancing read drains the ONE cursor this persona has.
  s.catchUp(r, "a", 50, undefined, 100000, EPOCH1);
  check("S1 probe drained after the advancing read", s.unreadProbe(r, "a", EPOCH1) === 0, null);
  // Parity is the point of this section: the probe and catch_up must agree, so
  // a probe that fires must be followed by a read that returns something.
  s.postMessage(r, "b", "another peer post", "text", null, null, null, EPOCH1);
  check("S1 probe fires again on new peer traffic", s.unreadProbe(r, "a", EPOCH1) === 1, null);
  check(
    "S1 the advancing read agrees with the probe (no spin)",
    s.catchUp(r, "a", 50, undefined, 100000, EPOCH1).messages.length === 1,
    null,
  );
  // The probe reports THREE distinct conditions and must not confuse them. A
  // live persona that never joined is a non-membership; a persona at a stale
  // epoch, or one whose row is gone, is a lost persona. Collapsing the second
  // pair into "not a member" would tell a taken-over runtime to rejoin a room
  // it is already in.
  mkAgent(s, "never-joined");
  let threw = "";
  try {
    s.unreadProbe(r, "never-joined", EPOCH1);
  } catch (e) {
    threw = e.message;
  }
  check("S1 non-member probe throws", /not a member/.test(threw), threw);
  let stale = null;
  try {
    s.unreadProbe(r, "a", EPOCH1 + 1);
  } catch (e) {
    stale = e;
  }
  check(
    "S1 a stale epoch probe throws persona_lost, NOT a membership error",
    stale instanceof PersonaLostError && !/not a member/.test(stale.message),
    stale && stale.message,
  );
  let vanished = null;
  try {
    s.unreadProbe(r, "no-such-persona", EPOCH1);
  } catch (e) {
    vanished = e;
  }
  check(
    "S1 a probe for a persona that does not exist reports loss, not non-membership",
    vanished instanceof PersonaLostError && vanished.currentEpoch === null,
    vanished && vanished.message,
  );
  s.close();
}

// --- S2/S3: wait leases ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v0100-lease-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = mkRoom(s, "lease-room", null, null).id;
  mkAgent(s, "w");
  s.joinRoom(r, "w", EPOCH1, {});
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'w'",
    ).run(r);
    raw.close();
  }
  // touch() is void, so assert its persisted liveness effect.
  const lastSeen = () => {
    const raw = new Database(DB);
    const row = raw
      .prepare(
        "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = 'w'",
      )
      .get(r);
    raw.close();
    return row.last_seen;
  };
  const staleSeen = lastSeen();
  s.touch(r, "w", EPOCH1);
  check(
    "S2 captured-room touch refreshes a live membership",
    lastSeen() !== staleSeen && s.recipientStatus(r, ["w"], 5)[0].status === "active",
    { before: staleSeen, after: lastSeen(), status: s.recipientStatus(r, ["w"], 5)[0] },
  );
  s.leaveRoom(r, "w", EPOCH1);
  // Backdate after leave so any forbidden touch write is observable.
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'w'",
    ).run(r);
    raw.close();
  }
  const leftSeen = lastSeen();
  s.touch(r, "w", EPOCH1);
  check(
    "S2 captured-room touch cannot resurrect a LEFT room",
    lastSeen() === leftSeen && s.getMembership(r, "w").left_at !== null,
    { before: leftSeen, after: lastSeen(), membership: s.getMembership(r, "w") },
  );
  s.joinRoom(r, "w", EPOCH1, {});
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'w'",
    ).run(r);
    raw.close();
  }
  s.beginWaitLease(r, "w", EPOCH1, 30);
  let st = s.recipientStatus(r, ["w"], 5);
  check(
    "S2 open lease is watching+active despite an old heartbeat",
    st[0].watching === true && st[0].status === "active",
    st,
  );
  const la = s.listAgents(r, 5).agents.find((a) => a.id === "w");
  check(
    "S2 open lease is watching+active in list_agents",
    la.watching === true && la.active === true,
    la,
  );
  s.endWaitLease(r, "w", EPOCH1);
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 closed lease reads as not watching", st[0].watching === false, st);
  // An expired lease (crashed waiter) must read false and get reaped. The row is
  // written under a DEAD epoch, which is what a hard-killed earlier tenure
  // leaves behind.
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO wait_leases (room_id, agent_id, epoch, expires_at)
       VALUES (?, 'w', 99, datetime('now', '-1 seconds'))`,
    ).run(r);
    raw.close();
  }
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 expired lease reads as not watching", st[0].watching === false, st);
  s.beginWaitLease(r, "w", EPOCH1, 30);
  {
    const raw = new Database(DB);
    const dead = raw
      .prepare("SELECT COUNT(*) AS c FROM wait_leases WHERE epoch = 99")
      .get();
    raw.close();
    check("S2 beginWaitLease reaps expired rows", dead.c === 0, dead);
  }
  rmRoom(s, r);
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
    env: {
      ...process.env,
      AGENT_CHAT_DB: DB,
      AGENT_CHAT_MAX_WAIT_SECONDS: "120",
    },
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
  const waitFor = (i, timeoutMs = 15_000, allowNoResponse = false) =>
    new Promise((res, rej) => {
      const t = setInterval(() => {
        if (R.has(i)) { clearInterval(t); res(R.get(i)); }
        else if (Date.now() >= deadline) {
          clearInterval(t);
          if (allowNoResponse) res(null);
          else {
            child.kill("SIGKILL");
            rej(new Error(`MCP reply timeout id ${i}`));
          }
        }
      }, 15);
      const deadline = Date.now() + timeoutMs;
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
  const rA = mkRoom(s, "wait-a", null, null).id;
  const rB = mkRoom(s, "wait-b", null, null).id;
  mkAgent(s, "peer");
  s.joinRoom(rA, "peer", EPOCH1, {});
  s.joinRoom(rB, "peer", EPOCH1, {});
  mkAgent(s, "u");
  await srv.call("resume_persona", bindArgs("u"));
  await srv.call("join_room", { room: "wait-b" });
  await srv.call("join_room", { room: "wait-a" }); // active = A

  // M1: backlog present -> no sleep.
  s.postMessage(rA, "peer", "already here", "text", null, null, null, EPOCH1);
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
  s.postMessage(rA, "peer", "handoff", "text", ["u"], null, null, EPOCH1);
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

  // M4b: two concurrent calls from ONE runtime. The lease row is per (room,
  // persona) so a takeover replaces it rather than sitting beside it, which
  // means both waits share ONE row -- and the short one finishing must NOT
  // delete it while the long one is still live. The runtime refcounts its own
  // open waits and only the last one out closes the lease.
  const short4b = srv.sendCall("catch_up", { wait_seconds: 1 });
  const long4b = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(700);
  {
    const raw = new Database(DB);
    const leases = raw
      .prepare(
        "SELECT COUNT(*) AS c FROM wait_leases WHERE room_id = ? AND agent_id = 'u'",
      )
      .get(rA);
    raw.close();
    check("M4b one persona holds exactly one lease row per room", leases.c === 1, leases);
  }
  const shortResult4b = srv.parse(await srv.waitFor(short4b));
  const between4b = s.recipientStatus(rA, ["u"], 5)[0];
  check(
    "M4b first timeout leaves the second wait watching",
    shortResult4b.data.timed_out === true && between4b.watching === true,
    { short: shortResult4b.data, between: between4b },
  );
  s.postMessage(rA, "peer", "for the surviving wait", "text", null, null, null, EPOCH1);
  const longResult4b = srv.parse(await srv.waitFor(long4b));
  check(
    "M4b surviving wait receives the later post",
    longResult4b.data.messages.some((m) => m.content === "for the surviving wait") &&
      s.recipientStatus(rA, ["u"], 5)[0].watching === false,
    longResult4b.data,
  );

  // M4c: explicit-room activity must refresh the room the wait captured,
  // while leaving the active-room selection alone.
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'u'",
    ).run(rB);
    raw.close();
  }
  const cross4c = srv.sendCall("catch_up", {
    room: "wait-b",
    wait_seconds: 10,
  });
  await sleep(700);
  const during4c = s.recipientStatus(rB, ["u"], 5)[0];
  check(
    "M4c named-room wait heartbeats its captured room",
    during4c.status === "active" && during4c.watching === true &&
      (during4c.idle_seconds ?? Infinity) < 60,
    during4c,
  );
  s.postMessage(rB, "peer", "cross-room handoff", "text", null, null, null, EPOCH1);
  const result4c = srv.parse(await srv.waitFor(cross4c));
  const who4c = await srv.call("whoami", {});
  check(
    "M4c named-room wait receives without switching active room",
    result4c.data.room_id === rB &&
      result4c.data.messages.some((m) => m.content === "cross-room handoff") &&
      who4c.data.room_id === rA,
    { result: result4c.data, who: who4c.data },
  );

  // M5: active-room change mid-wait; the captured room governs.
  const id5 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-b" }); // active moves to B mid-wait
  s.postMessage(rA, "peer", "for the captured room", "text", null, null, null, EPOCH1);
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
  await srv.call("join_room", { room: "wait-a" }); // back to A

  // M6: a TAKEOVER mid-wait. The authority under an open wait can change, and
  // the wait must not consume the message under an authority it no longer
  // holds.
  const before6 = s.getMembership(rA, "u").last_read_seq;
  const id6 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  s.attachPersona({
    id: "u",
    resumeWord: "test-resume-word",
    brand: "testbrand",
    model: "testmodel",
    version: "1",
  });
  s.postMessage(rA, "peer", "post-takeover message", "text", null, null, null, EPOCH1);
  const m6 = srv.parse(await srv.waitFor(id6));
  check(
    // isError, not just the payload. A fenced wait that returned this body in a
    // SUCCESS envelope would read as an ordinary result to any client that
    // checks the protocol flag before the body, which is the normal order.
    "M6 takeover mid-wait fails the wait with terminal persona_lost",
    m6.isError === true &&
      m6.data.code === "persona_lost" &&
      m6.data.terminal === true,
    { isError: m6.isError, data: m6.data },
  );
  check(
    "M6 the fenced wait advanced no marker",
    s.getMembership(rA, "u").last_read_seq === before6,
    { before: before6, now: s.getMembership(rA, "u").last_read_seq },
  );
  // The message is not lost: it is still unread for whoever holds the persona.
  check(
    "M6 the message survives for the current holder",
    s.catchUp(rA, "u", 50, undefined, 100000, s.currentEpoch("u")).messages.some(
      (m) => m.content === "post-takeover message",
    ),
    null,
  );
  // Re-bind this runtime so the remaining M7+ cases run under a live persona.
  await srv.call("resume_persona", bindArgs("u"));
  await srv.call("join_room", { room: "wait-a" });

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
  s.postMessage(rA, "peer", "the real one", "text", null, null, null, EPOCH1);
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
  const seq8 = s.postMessage(rA, "peer", "posted after cancel", "text", null, null, null, EPOCH1).seq;
  const m8 = await srv.waitFor(id8, 2500, true);
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
  const rD = mkRoom(s, "doomed", null, null).id;
  s.joinRoom(rD, "peer", EPOCH1, {});
  await srv.call("join_room", { room: "doomed" });
  const id9 = srv.sendCall("catch_up", { wait_seconds: 8 });
  await sleep(700);
  rmRoom(s, rD);
  const m9 = srv.parse(await srv.waitFor(id9));
  check(
    "M9 deletion mid-wait yields a clean error",
    m9.isError === true && /deleted while waiting/.test(m9.data.error),
    m9,
  );
  await srv.call("join_room", { room: "wait-a" });

  // M10: opt into the deployment ceiling and prove it without sleeping for it:
  // existing backlog returns immediately; one second above rejects in schema.
  s.postMessage(rA, "peer", "upper-cap immediate backlog", "text", null, null, null, EPOCH1);
  const m10edge = await srv.call("catch_up", { wait_seconds: 120 });
  check(
    "M10 configured wait_seconds=120 returns existing backlog immediately",
    m10edge.data.messages.some((m) => m.content === "upper-cap immediate backlog") &&
      m10edge.data.waited_ms < 2000,
    m10edge,
  );
  const m10 = await srv.call("catch_up", { wait_seconds: 121 });
  check(
    "M10 wait_seconds above the 120s cap is rejected",
    (m10.rpcError !== undefined || m10.isError === true) &&
      /120/.test(JSON.stringify(m10)),
    m10,
  );

  // M12: a concurrent ROOM change mid-wait. The identity cannot change any more
  // (one runtime holds one persona for its whole life, and a join takes no
  // agent_id), but the active ROOM still can, and the captured room must still
  // govern the wait: it returns and advances for the room it started on.
  const before12 = s.getMembership(rA, "u").last_read_seq;
  const id12 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-b" }); // active room moves mid-wait
  const seq12 = s.postMessage(rA, "peer", "for the captured room", "text", null, null, null, EPOCH1).seq;
  const m12 = srv.parse(await srv.waitFor(id12));
  const who12 = await srv.call("whoami", {});
  check(
    "M12 room change mid-wait: the captured room still receives and advances",
    m12.data.agent_id === "u" && m12.data.room_id === rA &&
      m12.data.messages.length === 1 &&
      m12.data.messages[0].content === "for the captured room" &&
      s.getMembership(rA, "u").last_read_seq === seq12 && before12 < seq12,
    { data: m12.data, marker: s.getMembership(rA, "u").last_read_seq },
  );
  check(
    "M12 the runtime keeps its persona and moved only the active room",
    who12.data.agent_id === "u" && who12.data.room_id === rB,
    who12.data,
  );

  s.close();
  srv.child.kill();

  // M11: two waiters in separate server processes, one post wakes both. They
  // are two DISTINCT personas: two runtimes can no longer share one, and each
  // has its own read position, so the single post is unread for both.
  {
    const seed = new ChatStore(DB);
    mkAgent(seed, "waiter-1");
    mkAgent(seed, "waiter-2");
    seed.close();
  }
  const srv1 = startServer(DB);
  const srv2 = startServer(DB);
  await srv1.init();
  await srv2.init();
  await srv1.call("resume_persona", bindArgs("waiter-1"));
  await srv2.call("resume_persona", bindArgs("waiter-2"));
  await srv1.call("join_room", { room: "wait-a" });
  await srv2.call("join_room", { room: "wait-a" });
  await srv1.call("catch_up", {}); // drain backlogs so both waits block
  await srv2.call("catch_up", {});
  const w1 = srv1.sendCall("catch_up", { wait_seconds: 10 });
  const w2 = srv2.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(700);
  const s2 = new ChatStore(DB);
  s2.postMessage(rA, "peer", "broadcast to waiters", "text", null, null, null, EPOCH1);
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
