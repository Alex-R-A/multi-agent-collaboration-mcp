// Phase 2 blocking-wait tests (v0.10.0): catch_up({wait_seconds}) with the
// capture/probe/abort core plus the in_turn_wait presence lease.
//  S1 unreadProbe uses catchUp's exact predicate (own posts excluded,
//     live-identity fenced, non-member throws)
//  S2 wait leases: watching in recipientStatus/list_agents, expiry, reaping
//  S3 deleteRoom clears leases
//  M1 immediate backlog return (no sleep when messages already wait)
//  M2 one-call handoff: wait -> peer posts -> pending call returns it;
//     watching:true while open, false after
//  M3 timeout carries timed_out/call_again/waited_ms/rooms_with_unread
//  M4 wait_seconds omitted adds no wait-only response fields
//  M4b concurrent waits in one process keep independent leases
//  M4c named-room waits heartbeat the captured room, not the active room
//  M7 a concurrent read consumes mid-wait: no stale refire, later message delivered
//  M8 client cancellation: response suppressed, marker NOT advanced, lease
//     dropped, backlog recoverable
//  M9 room deleted mid-wait: clean error, not a raw constraint failure
//  M10 120s server cap returns immediate backlog; 121 is rejected
//  M11 two waiters (separate server processes) both receive one post
//  M12 active-room change mid-wait: captured room and identity govern
//  M13 concurrent leave ends a quiet wait and drops its lease
//  M14 one liveness write per operation: the active-room touch and the resolved
//      target share a single (room, identity) throttle, and a different-room
//      operation still refreshes both rooms
import { ChatStore, PersonaLostError } from "../dist/db.js";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkAgent, mkRoom, rmRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("features-v0100.mjs", async () => {
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
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  s.postMessage(r, "a", "own post", "text", null, null, null);
  check("S1 own post does not count as unread", s.unreadProbe(r, "a") === 0, null);
  s.postMessage(r, "b", "peer post", "text", null, null, null);
  check("S1 peer post counts", s.unreadProbe(r, "a") === 1, null);
  // The advancing read drains the ONE cursor this persona has.
  s.catchUp(r, "a", 50, undefined, 100000);
  check("S1 probe drained after the advancing read", s.unreadProbe(r, "a") === 0, null);
  // Parity is the point of this section: the probe and catch_up must agree, so
  // a probe that fires must be followed by a read that returns something.
  s.postMessage(r, "b", "another peer post", "text", null, null, null);
  check("S1 probe fires again on new peer traffic", s.unreadProbe(r, "a") === 1, null);
  check(
    "S1 the advancing read agrees with the probe (no spin)",
    s.catchUp(r, "a", 50, undefined, 100000).messages.length === 1,
    null,
  );
  // A live persona that never joined is a non-membership; a missing persona is
  // a terminal identity loss. The probe must not collapse those conditions.
  mkAgent(s, "never-joined");
  let threw = "";
  try {
    s.unreadProbe(r, "never-joined");
  } catch (e) {
    threw = e.message;
  }
  check("S1 non-member probe throws", /not a member/.test(threw), threw);
  let vanished = null;
  try {
    s.unreadProbe(r, "no-such-persona");
  } catch (e) {
    vanished = e;
  }
  check(
    "S1 a probe for a persona that does not exist reports loss, not non-membership",
    vanished instanceof PersonaLostError && vanished.missing === true,
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
  s.joinRoom(r, "w", {});
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
  s.touch(r, "w");
  check(
    "S2 captured-room touch refreshes a live membership",
    lastSeen() !== staleSeen && s.recipientStatus(r, ["w"], 5)[0].status === "active",
    { before: staleSeen, after: lastSeen(), status: s.recipientStatus(r, ["w"], 5)[0] },
  );
  s.leaveRoom(r, "w");
  // Backdate after leave so any forbidden touch write is observable.
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'w'",
    ).run(r);
    raw.close();
  }
  const leftSeen = lastSeen();
  s.touch(r, "w");
  check(
    "S2 captured-room touch cannot resurrect a LEFT room",
    lastSeen() === leftSeen && s.getMembership(r, "w").left_at !== null,
    { before: leftSeen, after: lastSeen(), membership: s.getMembership(r, "w") },
  );
  s.joinRoom(r, "w", {});
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = 'w'",
    ).run(r);
    raw.close();
  }
  s.beginWaitLease(r, "w", 30);
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
  s.endWaitLease(r, "w");
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 closed lease reads as not watching", st[0].watching === false, st);
  // An expired lease from a crashed waiter must read false and get reaped.
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO wait_leases (room_id, agent_id, expires_at)
       VALUES (?, 'w', datetime('now', '-1 seconds'))`,
    ).run(r);
    raw.close();
  }
  st = s.recipientStatus(r, ["w"], 5);
  check("S2 expired lease reads as not watching", st[0].watching === false, st);
  s.beginWaitLease(r, "w", 30);
  {
    const raw = new Database(DB);
    const dead = raw
      .prepare(
        "SELECT COUNT(*) AS c FROM wait_leases WHERE expires_at <= datetime('now')",
      )
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
  s.joinRoom(rA, "peer", {});
  s.joinRoom(rB, "peer", {});
  const identified = await srv.call("identify_persona", {
    brand: "wait",
    model: "blocking-client",
    version: "1.0",
  });
  const mcpAgentId = identified.data.agent_id;
  // Join wait-b from THIS process, not through the server: touchSession() now
  // shares the per-(room, identity) throttle, so a server-side join that made
  // wait-b the active room would leave a throttle entry that suppresses the
  // captured-room heartbeat M4c is written to observe.
  s.joinRoom(rB, mcpAgentId, {});
  await srv.call("join_room", { room: "wait-a" }); // active = A

  // M1: backlog present -> no sleep.
  s.postMessage(rA, "peer", "already here", "text", null, null, null);
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
  const during = s.recipientStatus(rA, [mcpAgentId], 5)[0];
  s.postMessage(rA, "peer", "handoff", "text", [mcpAgentId], null, null);
  const m2 = srv.parse(await srv.waitFor(id2));
  check(
    "M2 pending call returns the posted message and advances",
    m2.data.messages.length === 1 && m2.data.messages[0].content === "handoff" &&
      m2.data.advanced === true && m2.data.waited_ms >= 500 && m2.data.timed_out === undefined,
    { n: m2.data.messages?.length, waited: m2.data.waited_ms },
  );
  check("M2 watching:true while the wait is open", during.watching === true, during);
  const after = s.recipientStatus(rA, [mcpAgentId], 5)[0];
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

  // M4: omitted wait adds no wait-only metadata.
  const m4 = await srv.call("catch_up", {});
  check(
    "M4 omitted wait_seconds adds no wait fields",
    m4.data.waited_ms === undefined && m4.data.timed_out === undefined,
    m4.data,
  );

  // M4b: two concurrent calls from one runtime share one lease row per room
  // and persona. The short one finishing must not delete it while the long one
  // is still live. The runtime closes the lease only after the last wait ends.
  const leaseProbe = new Database(DB);
  const leaseStatement = leaseProbe.prepare(
    `SELECT started_at, expires_at
       FROM wait_leases
      WHERE room_id = ? AND agent_id = ?`,
  );
  const readLease = (roomId = rA) => leaseStatement.get(roomId, mcpAgentId);
  const waitForLease = async (roomId = rA) => {
    const deadline = Date.now() + 3_000;
    let row;
    do {
      row = readLease(roomId);
      if (row) return row;
      await sleep(20);
    } while (Date.now() < deadline);
    return row;
  };

  const short4b = srv.sendCall("catch_up", { wait_seconds: 2 });
  const initialShort4b = await waitForLease();
  // SQLite timestamps have one-second resolution. Two adjacent wait starts can
  // therefore look equal even if the conflict update wrongly resets
  // started_at. Force an older existing value so preservation is observable
  // without depending on scheduler timing.
  const forcedStart4b = "2000-01-01 00:00:00";
  leaseProbe
    .prepare(
      `UPDATE wait_leases SET started_at = ?
        WHERE room_id = ? AND agent_id = ?`,
    )
    .run(forcedStart4b, rA, mcpAgentId);
  const preservedShort4b = readLease();
  const long4b = srv.sendCall("catch_up", { wait_seconds: 10 });
  const shortResult4b = srv.parse(await srv.waitFor(short4b));
  const afterShort4b = readLease();
  const between4b = s.recipientStatus(rA, [mcpAgentId], 5)[0];
  check(
    "M4b long wait extends the shared lease without resetting its start",
    shortResult4b.data.timed_out === true &&
      initialShort4b &&
      preservedShort4b?.started_at === forcedStart4b &&
      afterShort4b &&
      afterShort4b.started_at === forcedStart4b &&
      afterShort4b.expires_at > initialShort4b.expires_at &&
      between4b.watching === true,
    {
      short: shortResult4b.data,
      initial: initialShort4b,
      preserved: preservedShort4b,
      after: afterShort4b,
      between: between4b,
    },
  );
  s.postMessage(rA, "peer", "for the surviving wait", "text", null, null, null);
  const longResult4b = srv.parse(await srv.waitFor(long4b));
  check(
    "M4b surviving wait receives the later post",
    longResult4b.data.messages.some((m) => m.content === "for the surviving wait") &&
      s.recipientStatus(rA, [mcpAgentId], 5)[0].watching === false,
    longResult4b.data,
  );

  // Reverse the arrival order. A last-writer-wins lease passes the case above
  // because the long wait opens last, but it shortens the lease here.
  const longFirst4b = srv.sendCall("catch_up", { wait_seconds: 10 });
  const initialLong4b = await waitForLease();
  const shortSecond4b = srv.sendCall("catch_up", { wait_seconds: 1 });
  const shortSecondResult4b = srv.parse(await srv.waitFor(shortSecond4b));
  const afterShortSecond4b = readLease();
  check(
    "M4b reverse-arrival short wait changes neither aggregate timestamp",
    shortSecondResult4b.data.timed_out === true &&
      initialLong4b &&
      afterShortSecond4b &&
      afterShortSecond4b.started_at === initialLong4b.started_at &&
      afterShortSecond4b.expires_at === initialLong4b.expires_at &&
      s.recipientStatus(rA, [mcpAgentId], 5)[0].watching === true,
    {
      short: shortSecondResult4b.data,
      initial: initialLong4b,
      after: afterShortSecond4b,
    },
  );
  s.postMessage(rA, "peer", "for the long-first wait", "text", null, null, null);
  const longFirstResult4b = srv.parse(await srv.waitFor(longFirst4b));
  check(
    "M4b reverse-arrival long wait receives the later post",
    longFirstResult4b.data.messages.some(
      (m) => m.content === "for the long-first wait",
    ) &&
      s.recipientStatus(rA, [mcpAgentId], 5)[0].watching === false,
    longFirstResult4b.data,
  );
  // M4c: explicit-room activity must refresh the room the wait captured,
  // while leaving the active-room selection alone.
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE room_id = ? AND agent_id = ?",
    ).run(rB, mcpAgentId);
    raw.close();
  }
  const cross4c = srv.sendCall("catch_up", {
    room: "wait-b",
    wait_seconds: 10,
  });
  await sleep(700);
  const during4c = s.recipientStatus(rB, [mcpAgentId], 5)[0];
  check(
    "M4c named-room wait heartbeats its captured room",
    during4c.status === "active" && during4c.watching === true &&
      (during4c.idle_seconds ?? Infinity) < 60,
    during4c,
  );
  s.postMessage(rB, "peer", "cross-room handoff", "text", null, null, null);
  const result4c = srv.parse(await srv.waitFor(cross4c));
  const who4c = await srv.call("whoami", {});
  check(
    "M4c named-room wait receives without switching active room",
    result4c.data.room_id === rB &&
      result4c.data.messages.some((m) => m.content === "cross-room handoff") &&
      who4c.data.room_id === rA,
    { result: result4c.data, who: who4c.data },
  );

  // M7: a concurrent read consumes mid-wait (atomically, so the outcome is
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
             WHERE room_id = ? AND agent_id = ?`,
          )
          .run(rA, rA, mcpAgentId);
      })
      .immediate();
    raw.close();
  }
  await sleep(1200); // several probe ticks over the already-consumed message
  s.postMessage(rA, "peer", "the real one", "text", null, null, null);
  const m7 = srv.parse(await srv.waitFor(id7));
  check(
    "M7 concurrently consumed message never refires; the later message is delivered",
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
  const before8 = s.getMembership(rA, mcpAgentId).last_read_seq;
  const seq8 = s.postMessage(rA, "peer", "posted after cancel", "text", null, null, null).seq;
  const m8 = await srv.waitFor(id8, 2500, true);
  check("M8 cancelled call's response is suppressed", m8 === null, m8);
  check(
    "M8 no marker advance after the observed abort",
    s.getMembership(rA, mcpAgentId).last_read_seq === before8 && before8 < seq8,
    {
      before: before8,
      seq: seq8,
      now: s.getMembership(rA, mcpAgentId).last_read_seq,
    },
  );
  const lease8 = s.recipientStatus(rA, [mcpAgentId], 5)[0];
  check("M8 lease dropped on cancellation", lease8.watching === false, lease8);
  const recover8 = await srv.call("catch_up", {});
  check(
    "M8 the message is recoverable by the next call",
    recover8.data.messages.some((m) => m.content === "posted after cancel"),
    recover8.data.messages,
  );

  // M9: room deleted mid-wait -> clean error naming the deletion.
  const rD = mkRoom(s, "doomed", null, null).id;
  s.joinRoom(rD, "peer", {});
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
  s.postMessage(rA, "peer", "upper-cap immediate backlog", "text", null, null, null);
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

  // M12: a concurrent room change mid-wait. The captured room must still
  // govern the wait: it returns and advances for the room it started on.
  const before12 = s.getMembership(rA, mcpAgentId).last_read_seq;
  const id12 = srv.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(600);
  await srv.call("join_room", { room: "wait-b" }); // active room moves mid-wait
  const seq12 = s.postMessage(rA, "peer", "for the captured room", "text", null, null, null).seq;
  const m12 = srv.parse(await srv.waitFor(id12));
  const who12 = await srv.call("whoami", {});
  check(
    "M12 room change mid-wait: the captured room still receives and advances",
    m12.data.agent_id === mcpAgentId && m12.data.room_id === rA &&
      m12.data.messages.length === 1 &&
      m12.data.messages[0].content === "for the captured room" &&
      s.getMembership(rA, mcpAgentId).last_read_seq === seq12 && before12 < seq12,
    { data: m12.data, marker: s.getMembership(rA, mcpAgentId).last_read_seq },
  );
  check(
    "M12 the runtime keeps its persona and moved only the active room",
    who12.data.agent_id === mcpAgentId && who12.data.room_id === rB,
    who12.data,
  );

  // M13: observe the lease before sending leave, so a delayed wait start cannot
  // turn this into a test of a call that began after the room was already left.
  const before13 = s.getMembership(rB, mcpAgentId).last_read_seq;
  const id13 = srv.sendCall("catch_up", { wait_seconds: 10 });
  const armed13 = await waitForLease(rB);
  const leave13 = await srv.call("leave_room", {});
  const m13 = srv.parse(await srv.waitFor(id13, 3_000));
  const after13 = s.getMembership(rB, mcpAgentId);
  check(
    "M13 concurrent leave ends the quiet wait without consuming or retaining a lease",
    !!armed13 &&
      leave13.data.left === true &&
      m13.isError === true &&
      /LEFT room/.test(m13.data.error) &&
      after13.left_at !== null &&
      after13.last_read_seq === before13 &&
      readLease(rB) === undefined,
    {
      armed: armed13,
      leave: leave13.data,
      wait: m13.data,
      before: before13,
      after: after13,
      lease: readLease(rB),
    },
  );
  leaseProbe.close();

  s.close();
  srv.child.kill();

  // M11: two waiters in separate server processes, one post wakes both. They
  // are two DISTINCT personas: two runtimes can no longer share one, and each
  // has its own read position, so the single post is unread for both.
  const srv1 = startServer(DB);
  const srv2 = startServer(DB);
  await srv1.init();
  await srv2.init();
  const sameTuple = {
    brand: "waiter",
    model: "same-model",
    version: "1.0",
  };
  const identified1 = await srv1.call("identify_persona", sameTuple);
  const identified2 = await srv2.call("identify_persona", sameTuple);
  const identityProbe = new Database(DB, { readonly: true });
  const connectionRows = identityProbe
    .prepare(
      `SELECT id, connection_id FROM agents
        WHERE id IN (?, ?) ORDER BY id`,
    )
    .all(identified1.data.agent_id, identified2.data.agent_id);
  identityProbe.close();
  check(
    "M11 same-tuple processes receive distinct ids and connection bindings",
    identified1.data.agent_id !== identified2.data.agent_id &&
      connectionRows.length === 2 &&
      connectionRows.every((row) => typeof row.connection_id === "string") &&
      new Set(connectionRows.map((row) => row.connection_id)).size === 2,
    {
      first: identified1.data.agent_id,
      second: identified2.data.agent_id,
      connectionRows,
    },
  );
  await srv1.call("join_room", { room: "wait-a" });
  await srv2.call("join_room", { room: "wait-a" });
  await srv1.call("catch_up", {}); // drain backlogs so both waits block
  await srv2.call("catch_up", {});
  const w1 = srv1.sendCall("catch_up", { wait_seconds: 10 });
  const w2 = srv2.sendCall("catch_up", { wait_seconds: 10 });
  await sleep(700);
  const s2 = new ChatStore(DB);
  s2.postMessage(rA, "peer", "broadcast to waiters", "text", null, null, null);
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

// --- M14: one liveness write per operation --------------------------------------
// touchSession() used to keep its own PROCESS-GLOBAL throttle while handlers also
// called touchCapturedRoom() for the resolved target. Whenever that target IS the
// active room -- the common case -- a single tool call issued two liveness write
// transactions against the same membership row. last_seen cannot witness this
// (both writes carry the same second), so count the UPDATEs directly with a
// trigger installed AFTER setup.
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v0100-touch-"));
  const DB = join(dir, "t.db");
  const srv = startServer(DB);
  await srv.init();
  const s = new ChatStore(DB);
  const rA = mkRoom(s, "touch-a", null, null).id;
  const rB = mkRoom(s, "touch-b", null, null).id;
  const rC = mkRoom(s, "touch-c", null, null).id;
  const identified = await srv.call("identify_persona", {
    brand: "touch",
    model: "throttle-client",
    version: "1.0",
  });
  const agentId = identified.data.agent_id;
  // The FIRST room this process binds: join_room's own touchSession() sees a
  // null active room and returns, so no throttle entry for rA exists yet. That
  // is exactly the state a freshly joined runtime is in.
  await srv.call("join_room", { room: "touch-a" });

  // A non-TEMP trigger is required: TEMP triggers are connection-local and would
  // never fire for the server process's writes.
  const probe = new Database(DB);
  probe.exec(
    `CREATE TABLE touch_probe (room_id INTEGER NOT NULL, agent_id TEXT NOT NULL);
     CREATE TRIGGER touch_probe_trg AFTER UPDATE ON memberships
     BEGIN
       INSERT INTO touch_probe (room_id, agent_id) VALUES (NEW.room_id, NEW.agent_id);
     END;`,
  );
  const touched = () =>
    probe
      .prepare(
        "SELECT room_id FROM touch_probe WHERE agent_id = ? ORDER BY room_id",
      )
      .all(agentId)
      .map((r) => r.room_id);
  const resetProbe = () => probe.prepare("DELETE FROM touch_probe").run();

  // list_claims is the smallest handler on the touchSession -> touchCapturedRoom
  // path that writes nothing else to memberships: no marker advance, no post.
  await srv.call("list_claims", {});
  const firstOp = touched();
  check(
    "M14 an active-room operation performs exactly one liveness write",
    firstOp.length === 1 && firstOp[0] === rA,
    { rooms: firstOp },
  );

  // The surviving throttle must still suppress the repeat inside the interval.
  resetProbe();
  await srv.call("list_claims", {});
  const repeatOp = touched();
  check(
    "M14 a repeat same-room operation inside the interval writes nothing",
    repeatOp.length === 0,
    { rooms: repeatOp },
  );

  // A different-room operation must still refresh BOTH the active room and the
  // explicit target. rC becomes active via join_room; rB is joined from THIS
  // process, so the server never touched it and its throttle entry stays cold.
  await srv.call("join_room", { room: "touch-c" });
  s.joinRoom(rB, agentId, {});
  resetProbe();
  const cross = await srv.call("list_claims", { room: "touch-b" });
  const crossOp = touched();
  check(
    "M14 an explicit different-room operation touches active and target once each",
    cross.isError !== true &&
      crossOp.length === 2 &&
      crossOp.includes(rB) &&
      crossOp.includes(rC),
    { rooms: crossOp, isError: cross.isError, data: cross.data },
  );

  probe.exec("DROP TRIGGER touch_probe_trg; DROP TABLE touch_probe;");
  probe.close();
  s.close();
  srv.child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

expect(failures).toBe(0);
});
