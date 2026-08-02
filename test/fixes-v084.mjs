// Regression tests for the v0.8.4 review fixes:
//  #2 tools/list advertises post_message `content` WITHOUT excluding objects
//     (the z.custom union arm was dropped from the generated JSON Schema, so
//     schema-validating clients rejected every object body client-side)
//  #3 store-level metadata length caps: a direct caller cannot create a claim
//     key (etc.) that busts the listing byte budgets, which assume the MCP
//     schema caps
//  - thread focal/parent/replies share one deferred snapshot
//  - successful CAS posts reuse their zero-crossing proof
//  - my_mentions entry/count scans use the directed-candidate partial index
//  - room activity follows the highest message seq, not timestamp ordering
//  - catch_up computes its advisory cross-room summary outside IMMEDIATE
//  - thread preorder remains numeric across the 10-to-11-digit seq boundary
//  (#1, #4, and #5 all rested on SESSIONS: a private session cursor lagging
//   its twin, a live session's leave tombstone, and reconciling a crashed twin.
//   A persona has exactly one runtime, so there is no twin to lag, no second
//   cursor to baseline against, and nothing to reconcile; those tests were
//   deleted with the model they tested.)
//  (web gating and the web search probe are covered in web-participate.mjs.)
import { ChatStore } from "../dist/db.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("fixes-v084.mjs", async () => {
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- #2: advertised content schema admits objects; runtime still validates ---
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v084-schema-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const wait = (id) => new Promise((res, rej) => {
    const t = setInterval(() => {
      if (!R.has(id)) return;
      clearInterval(t);
      clearTimeout(dead);
      res(R.get(id));
    }, 15);
    const dead = setTimeout(() => {
      clearInterval(t);
      child.kill("SIGKILL");
      rej(new Error(`MCP reply timeout id ${id}`));
    }, 15_000);
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await wait(2);
  // Inspect the ACTUAL advertised schema, not just runtime acceptance: the
  // bug lived in the generated JSON Schema (object arm dropped from anyOf).
  const tool = list.result.tools.find((t) => t.name === "post_message");
  const content = tool.inputSchema.properties.content;
  const excludesObjects =
    (Array.isArray(content.anyOf) &&
      !content.anyOf.some((a) => !a.type || a.type === "object")) ||
    (typeof content.type === "string" && content.type !== "object") ||
    (Array.isArray(content.type) && !content.type.includes("object"));
  check("#2 advertised content schema does not exclude objects", !excludesObjects, content);
  let id = 2;
  const call = async (name, args) => {
    const i = ++id;
    send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    return wait(i);
  };
  // Identify first because room administration requires a live persona.
  await call("identify_persona", {
    brand: "testbrand",
    model: "testmodel",
    version: "1.0",
  });
  await call("create_room", { name: "schema-room" });
  await call("join_room", { room: "schema-room" });
  const obj = await call("post_message", { content: { plan: "x", steps: [1, 2] } });
  const str = await call("post_message", { content: "plain" });
  const num = await call("post_message", { content: 42 });
  check("#2 runtime accepts an object body", obj.result && !obj.result.isError, obj.result);
  check("#2 runtime accepts a string body", str.result && !str.result.isError, str.result);
  check(
    "#2 runtime still rejects a number body",
    num.result && num.result.isError === true,
    num.result,
  );
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

// --- #3: store-level metadata caps match the MCP schema caps ------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  const threw = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  check(
    "#3 store rejects a 120k-char claim key",
    /exceeds 500/.test(threw(() => s.claimResource(r, "k".repeat(120_000), "a", 900, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char room name",
    /exceeds 200/.test(threw(() => mkRoom(s, "n".repeat(201), null, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char agent id",
    /exceeds 200/.test(threw(() => mkAgent(s, "i".repeat(201)))),
    null,
  );
  check(
    "#3 store rejects a 201-char mention id",
    /exceeds 200/.test(
      threw(() => s.postMessage(r, "a", "x", "text", ["m".repeat(201)], null, null)),
    ),
    null,
  );
  // Exact room identifiers reject edge whitespace instead of normalizing it.
  const countRooms = () =>
    s.db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
  const roomsBefore = countRooms();
  const badNames = ["", " ", "\t", " leading", "trailing\n"];
  const rejections = badNames.map((n) => threw(() => mkRoom(s, n, null, null)));
  check(
    "#3 store rejects empty, blank, and edge-whitespace room names",
    rejections.every((m) => /non-empty.*leading or trailing/.test(m)) &&
      countRooms() === roomsBefore,
    { rejections, roomsBefore, roomsAfter: countRooms() },
  );
  // Prove only the edges are illegal.
  const spaced = mkRoom(s, "inner spaces kept", null, null);
  check(
    "#3 internal spaces remain legal and are stored byte-exact",
    spaced.name === "inner spaces kept" &&
      s.db
        .prepare("SELECT COUNT(*) AS c FROM rooms WHERE name = ?")
        .get("inner spaces kept").c === 1 &&
      countRooms() === roomsBefore + 1,
    spaced,
  );
  // At-cap values still pass (the MCP schema allows exactly these lengths).
  const ok = s.claimResource(r, "k".repeat(500), "a", 900, null);
  check("#3 at-cap 500-char key is still granted", ok.granted === true, ok);
  s.close();
}

// --- DB review: get_thread reads one deferred snapshot ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v084-thread-snapshot-"));
  const DB = join(dir, "t.db");
  const reader = new ChatStore(DB);
  const room = mkRoom(reader, "thread-snapshot", null, null).id;
  for (const id of ["a", "b"]) {
    mkAgent(reader, id);
    reader.joinRoom(room, id, {});
  }
  const parent = reader.postMessage(
    room,
    "a",
    "parent",
    "text",
    null,
    null,
    null,
  );
  const focal = reader.postMessage(
    room,
    "b",
    "focal",
    "text",
    null,
    parent.seq,
    null,
  );
  const existing = reader.postMessage(
    room,
    "a",
    "existing reply",
    "text",
    null,
    focal.seq,
    null,
  );
  const writer = new ChatStore(DB);
  const getRawMessage = reader.getRawMessage.bind(reader);
  let injected = false;
  let pruned;
  let late;
  reader.getRawMessage = (...args) => {
    const row = getRawMessage(...args);
    if (!injected) {
      injected = true;
      pruned = writer.pruneMessages(room, "a", 2, true);
      late = writer.postMessage(
        room,
        "a",
        "late reply",
        "text",
        null,
        focal.seq,
        null,
      );
    }
    return row;
  };
  const thread = reader.getThread(room, focal.seq);
  const live = writer.getThread(room, focal.seq);
  check(
    "get_thread holds one deferred snapshot while a writer commits",
    injected &&
      pruned?.deleted === 1 &&
      late?.posted === true &&
      thread?.parent?.seq === parent.seq &&
      thread.replies.map((r) => r.seq).join(",") === String(existing.seq) &&
      live?.parent === null &&
      live.replies.map((r) => r.seq).join(",") ===
        `${existing.seq},${late.seq}`,
    { injected, pruned, late, thread, live },
  );
  reader.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- DB review: accepted CAS reuses the zero-crossing proof -------------------
{
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, "cas-query-count", null, null).id;
  mkAgent(s, "me");
  s.joinRoom(room, "me", {});
  const prepare = s.db.prepare;
  let crossingAggregates = 0;
  s.db.prepare = function (sql) {
    const normalized = String(sql).replace(/\s+/g, " ");
    if (
      normalized.includes(
        "SELECT COUNT(*) AS c, MIN(seq) AS mn, MAX(seq) AS mx,",
      ) &&
      normalized.includes(
        "FROM messages WHERE room_id = ? AND seq > ? AND agent_id != ?",
      )
    ) {
      crossingAggregates++;
    }
    return prepare.call(this, sql);
  };
  let posted;
  try {
    posted = s.postMessage(
      room,
      "me",
      "accepted CAS",
      "text",
      null,
      null,
      null,
      { ifLastReadSeq: 0 },
    );
  } finally {
    s.db.prepare = prepare;
  }
  check(
    "accepted CAS runs only its stale-check aggregate",
    posted?.posted === true &&
      posted.crossed === 0 &&
      posted.crossed_directed === 0 &&
      posted.crossed_range === null &&
      crossingAggregates === 1,
    { posted, crossingAggregates },
  );
  s.close();
}

// --- DB review: my_mentions uses its directed-candidate partial index ----------
{
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, "mentions-index", null, null).id;
  for (const id of ["me", "peer"]) {
    mkAgent(s, id);
    s.joinRoom(room, id, {});
  }
  const root = s.postMessage(room, "me", "root", "text", null, null, null);
  s.postMessage(room, "peer", "broadcast", "text", null, null, null);
  const mention = s.postMessage(
    room,
    "peer",
    "mention",
    "text",
    ["me"],
    null,
    null,
  );
  const reply = s.postMessage(
    room,
    "peer",
    "reply",
    "text",
    null,
    root.seq,
    null,
  );
  const prepare = s.db.prepare;
  let entrySql = "";
  let countSql = "";
  s.db.prepare = function (sql) {
    const text = String(sql);
    if (text.includes("g.id AS gid") && text.includes("JOIN memberships mb")) {
      entrySql = text;
    } else if (
      text.includes("SELECT COUNT(*) AS td") &&
      text.includes("JOIN memberships mb")
    ) {
      countSql = text;
    }
    return prepare.call(this, sql);
  };
  let inbox;
  try {
    inbox = s.myMentions("me", 50, undefined, 100_000, 0);
  } finally {
    s.db.prepare = prepare;
  }
  const entryPlan = entrySql
    ? prepare
        .call(s.db, `EXPLAIN QUERY PLAN ${entrySql}`)
        .all("me", 0, "me", "me", "me", 51)
    : [];
  const countPlan = countSql
    ? prepare
        .call(s.db, `EXPLAIN QUERY PLAN ${countSql}`)
        .all("me", "me", "me", "me")
    : [];
  const usesCandidateIndex = (plan) =>
    plan.some((row) =>
      String(row.detail).includes(
        "SEARCH g USING INDEX idx_messages_directed_candidates",
      ),
    );
  check(
    "my_mentions entry and count queries use the directed-candidate index",
    inbox.messages.map((m) => m.seq).join(",") ===
      `${mention.seq},${reply.seq}` &&
      inbox.total_directed === 2 &&
      usesCandidateIndex(entryPlan) &&
      usesCandidateIndex(countPlan),
    { inbox, entryPlan, countPlan },
  );
  s.close();
}

// --- DB review: room activity follows message sequence ------------------------
{
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, "activity-seq", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(room, "a", {});
  const first = s.postMessage(room, "a", "first", "text", null, null, null);
  const second = s.postMessage(room, "a", "second", "text", null, null, null);
  const stamp = s.db.prepare(
    "UPDATE messages SET created_at = ? WHERE room_id = ? AND seq = ?",
  );
  stamp.run("2099-01-01 00:00:00", room, first.seq);
  stamp.run("2000-01-01 00:00:00", room, second.seq);
  const listed = s.listRooms().rooms.find((r) => r.id === room);
  check(
    "list_rooms takes last_activity from the highest message seq",
    listed?.last_activity === "2000-01-01 00:00:00",
    listed,
  );
  s.close();
}

// --- DB review: empty catch_up releases IMMEDIATE before room aggregation -----
{
  const s = new ChatStore(":memory:");
  const current = mkRoom(s, "summary-current", null, null).id;
  const other = mkRoom(s, "summary-other", null, null).id;
  for (const id of ["me", "peer"]) mkAgent(s, id);
  s.joinRoom(current, "me", {});
  s.joinRoom(other, "me", {});
  s.joinRoom(other, "peer", {});
  s.postMessage(other, "peer", "waiting elsewhere", "text", null, null, null);

  const unreadByRoom = s.unreadByRoom.bind(s);
  let summaryInTransaction = null;
  s.unreadByRoom = (...args) => {
    summaryInTransaction = s.db.inTransaction;
    return unreadByRoom(...args);
  };
  const caught = s.catchUp(
    current,
    "me",
    50,
    undefined,
    100_000,
    {},
  );
  check(
    "empty catch_up computes its cross-room summary after IMMEDIATE commits",
    summaryInTransaction === false &&
      caught.messages.length === 0 &&
      caught.rooms_with_unread?.length === 1 &&
      caught.rooms_with_unread[0].room_id === other &&
      caught.rooms_with_unread[0].unread === 1,
    { summaryInTransaction, caught },
  );

  s.unreadByRoom = unreadByRoom;
  s.joinRoom(current, "peer", {});
  const skipped = s.postMessage(
    current,
    "peer",
    "low priority",
    "text",
    null,
    null,
    null,
  );
  let summaryCalls = 0;
  s.unreadByRoom = () => {
    summaryCalls++;
    throw new Error("summary failed after commit");
  };
  let degraded;
  let thrown;
  try {
    degraded = s.catchUp(
      current,
      "me",
      50,
      undefined,
      100_000,
      { priorityOnly: true },
    );
  } catch (error) {
    thrown = error;
  }
  check(
    "a post-commit summary failure still returns the committed catch_up result",
    summaryCalls === 1 &&
      thrown === undefined &&
      degraded?.messages.length === 0 &&
      degraded?.advanced === true &&
      degraded?.new_last_read_seq === skipped.seq &&
      degraded?.skipped_count === 1 &&
      !("rooms_with_unread" in degraded),
    { summaryCalls, thrown: thrown?.message, degraded },
  );
  s.close();
}

// --- DB review: thread paths cover every safe-integer writer seq --------------
{
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, "thread-safe-integer-order", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(room, "a", {});
  const root = s.postMessage(room, "a", "root", "text", null, null, null);
  const insert = s.db.prepare(
    `INSERT INTO messages
       (room_id, seq, agent_id, format, body, body_len, reply_to_seq, reply_to_agent)
     VALUES (?, ?, 'a', 'text', ?, ?, ?, 'a')`,
  );
  const first = 9_999_999_999;
  const second = 10_000_000_000;
  const grandchild = 10_000_000_001;
  insert.run(room, first, "first child", 11, root.seq);
  insert.run(room, second, "second child", 12, root.seq);
  insert.run(room, grandchild, "grandchild", 10, first);

  const thread = s.getThread(room, root.seq, 3);
  check(
    "get_thread keeps numeric preorder across 10- and 11-digit seqs",
    thread?.replies.map((r) => r.seq).join(",") ===
      `${first},${grandchild},${second}`,
    thread?.replies,
  );
  s.close();
}

// --- DB review: recursive cap preserves preorder before fat joins -------------
{
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, "thread-priority-cap", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(room, "a", {});
  const root = s.postMessage(room, "a", "root", "text", null, null, null);
  const insert = s.db.prepare(
    `INSERT INTO messages
       (room_id, seq, agent_id, format, body, body_len, reply_to_seq, reply_to_agent)
     VALUES (?, ?, 'a', 'text', 'x', 1, ?, 'a')`,
  );
  s.db.transaction(() => {
    insert.run(room, 2, root.seq);
    for (let seq = 3; seq <= 502; seq++) insert.run(room, seq, 2);
    insert.run(room, 503, root.seq);
  })();

  const prepare = s.db.prepare;
  let recursiveSql = "";
  s.db.prepare = function (sql) {
    if (String(sql).includes("WITH RECURSIVE descendants")) {
      recursiveSql = String(sql);
    }
    return prepare.call(this, sql);
  };
  const thread = s.getThread(room, root.seq, 3, 1);
  s.db.prepare = prepare;
  const recursivePlan = s.db
    .prepare(`EXPLAIN QUERY PLAN ${recursiveSql}`)
    .all({ room, root: root.seq, maxDepth: 3, lim: 501 })
    .map((row) => String(row.detail));
  check(
    "get_thread caps preorder and expands descendants through the reply index",
    /AS path[\s\S]*ORDER BY path\s+LIMIT @lim\s*\)\s*SELECT/.test(
      recursiveSql,
    ) &&
      recursivePlan.some(
        (detail) =>
          detail.includes("SEARCH c USING INDEX idx_messages_reply") &&
          detail.includes("reply_to_seq=?"),
      ) &&
      recursivePlan.some(
        (detail) =>
          detail.includes("SEARCH s USING INDEX idx_messages_supersedes") &&
          detail.includes("supersedes_seq=?"),
      ) &&
      recursivePlan.some(
        (detail) =>
          detail.includes("SEARCH g USING") &&
          detail.includes("room_id=? AND seq=?"),
      ) &&
      thread?.replies.length === 500 &&
      thread.replies[0].seq === 2 &&
      thread.replies.at(-1).seq === 501 &&
      thread.replies_capped === true,
    {
      sqlCaptured: recursiveSql.length > 0,
      recursivePlan,
      replies: thread?.replies.length,
      first: thread?.replies[0]?.seq,
      last: thread?.replies.at(-1)?.seq,
      capped: thread?.replies_capped,
    },
  );
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);

expect(failures).toBe(0);
});
