// Regression tests for the web viewer's participation endpoints:
// join/post/read/leave, mention parsing, reply validation, join gating,
// and interop (an agent's catch_up sees a web-posted message as directed).
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

const dir = mkdtempSync(join(tmpdir(), "aichat-web-"));
const DB = join(dir, "web.db");

// Seed: one room, one agent with two messages so seq starts at 3 for the web user.
{
  const s = new ChatStore(DB);
  s.createRoom("r", null, null);
  s.upsertAgent("bot", "claude", null, null);
  s.joinRoom(1, "bot");
  s.postMessage(1, "bot", "first", "text", null, null);
  s.postMessage(1, "bot", "second", "text", null, null);
  s.close();
}

const child = spawn("node", [join(ROOT, "web", "server.mjs")], {
  env: { ...process.env, AGENT_CHAT_DB: DB, AGENT_CHAT_VIEWER_PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});

const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server did not start")), 10_000);
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) {
      clearTimeout(t);
      resolve(Number(m[1]));
    }
  });
});
const base = `http://127.0.0.1:${port}`;
check(
  "PORT=0 bound a real ephemeral port (printed URL is usable, not :0)",
  Number.isInteger(port) && port > 0,
  port,
);

async function post(path, payload) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: r.status, data: await r.json() };
}

try {
  // join
  const j = await post("/api/join", { room: 1, name: "alex" });
  check("join succeeds", j.status === 200 && j.data.joined === true && j.data.agent_id === "alex", j);

  // post before join is rejected for another name
  const ghost = await post("/api/post", { room: 1, name: "ghost", body: "hi" });
  check("posting without joining is rejected", ghost.status === 400 && /join the room first/.test(ghost.data.error), ghost);

  // invalid name rejected
  const bad = await post("/api/join", { room: 1, name: "bad name!" });
  check("invalid name rejected", bad.status === 400, bad);

  // post with reply + mention
  const p = await post("/api/post", { room: 1, name: "alex", body: "hello @bot from the web", reply_to_seq: 1 });
  check("post succeeds with seq 3", p.status === 200 && p.data.seq === 3, p);

  // reply to a nonexistent message rejected
  const dangling = await post("/api/post", { room: 1, name: "alex", body: "x", reply_to_seq: 999 });
  check("dangling reply rejected", dangling.status === 400 && /does not exist/.test(dangling.data.error), dangling);

  // A body with an embedded NUL or a lone surrogate is rejected: the web writes
  // SQL directly, so it must enforce the same round-trip safety the store does
  // (SQLite substr/length truncate at a NUL, silently dropping the tail).
  const nulPost = await post("/api/post", { room: 1, name: "alex", body: "abc" + String.fromCharCode(0) + "def" });
  check("web rejects a NUL body (was silent truncation)", nulPost.status === 400 && /NUL/.test(nulPost.data.error), nulPost);
  const lonePost = await post("/api/post", { room: 1, name: "alex", body: "x\ud800y" });
  check("web rejects a lone-surrogate body", lonePost.status === 400 && /surrogate/.test(lonePost.data.error), lonePost);

  // the message reads back with human type, parsed mentions, reply ref
  const list = await (await fetch(`${base}/api/messages?room=1`)).json();
  const msg = list.messages.find((m) => m.seq === 3);
  check(
    "message readable with type/mentions/reply",
    msg && msg.from === "alex" && msg.type === "human" &&
      Array.isArray(msg.mentions) && msg.mentions[0] === "bot" && msg.reply_to_seq === 1,
    msg,
  );

  // read marker: monotonic
  const r1 = await post("/api/read", { room: 1, name: "alex", seq: 3 });
  const r2 = await post("/api/read", { room: 1, name: "alex", seq: 1 });
  check("read marker advances and is monotonic", r1.data.last_read_seq === 3 && r2.data.last_read_seq === 3, { r1: r1.data, r2: r2.data });

  // interop: the agent's catch_up sees the web post as a directed message
  {
    const s = new ChatStore(DB);
    const got = s.catchUp(1, "bot", 50);
    const m = got.messages.find((x) => x.seq === 3);
    check(
      "agent catch_up receives the web post with its mention",
      !!m && m.from === "alex" && Array.isArray(m.to) && m.to.includes("bot"),
      got.messages.map((x) => x.seq),
    );
    check("web read marker visible to store layer", s.getMembership(1, "alex").last_read_seq === 3, s.getMembership(1, "alex"));
    s.close();
  }

  // leave: gated posting again
  const l = await post("/api/leave", { room: 1, name: "alex" });
  const afterLeave = await post("/api/post", { room: 1, name: "alex", body: "still here?" });
  check("leave then post is rejected", l.data.left === true && afterLeave.status === 400, { l: l.data, afterLeave });

  // rejoin resumes (idempotent join, membership revived)
  const rejoin = await post("/api/join", { room: 1, name: "alex" });
  const again = await post("/api/post", { room: 1, name: "alex", body: "back" });
  check("rejoin revives posting", rejoin.status === 200 && again.status === 200 && again.data.seq === 4, { rejoin: rejoin.data, again: again.data });

  // mention parsing strips trailing punctuation ("@bot." tags bot)
  const punct = await post("/api/post", { room: 1, name: "alex", body: "thanks @bot." }); // seq 5
  const tail = await (await fetch(`${base}/api/messages?room=1&after=4`)).json();
  check(
    "trailing punctuation stripped from mentions",
    Array.isArray(tail.messages[0].mentions) && tail.messages[0].mentions[0] === "bot",
    tail.messages[0],
  );

  // a JSON `null` body is a 400 validation error, not a 500
  const nul = await fetch(base + "/api/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  check("null JSON payload is a 400", nul.status === 400, nul.status);

  // the read marker clamps to the room's latest seq (monotonic max would
  // otherwise make an oversized value permanent)
  const big = await post("/api/read", { room: 1, name: "alex", seq: 9_999_999 });
  check("read marker clamped to latest", big.data.last_read_seq === punct.data.seq, big.data);

  // full-text search: finds the web post, surfaces FTS syntax errors as 400
  const s1 = await (await fetch(`${base}/api/search?room=1&q=${encodeURIComponent("hello web")}`)).json();
  check("search finds the web post", Array.isArray(s1.matches) && s1.matches.some((m) => m.seq === 3), s1);
  const s2 = await fetch(`${base}/api/search?room=1&q=${encodeURIComponent('"unbalanced (')}`);
  check("fts syntax error is a 400", s2.status === 400, s2.status);

  // browser drive-by protection: foreign origins rejected, local allowed,
  // no Origin header (curl/scripts) allowed
  const evil = await fetch(base + "/api/post", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ room: 1, name: "alex", body: "csrf attempt" }),
  });
  check("foreign-origin write rejected", evil.status === 403, evil.status);
  const localOk = await fetch(base + "/api/post", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ room: 1, name: "alex", body: "local origin ok" }),
  });
  check("local-origin write allowed", localOk.status === 200, localOk.status);

  // /api/me reports membership + marker (gap-aware read marking baseline)
  const me = await (await fetch(`${base}/api/me?room=1&name=alex`)).json();
  check("/api/me reports joined with a marker", me.joined === true && me.last_read_seq >= 3, me);
  const me2 = await (await fetch(`${base}/api/me?room=1&name=stranger`)).json();
  check("/api/me for a non-member reports not joined", me2.joined === false, me2);

  // supersession annotations surface in the viewer API
  {
    const s = new ChatStore(DB);
    const wrong = s.postMessage(1, "bot", "wrong figure", "text", null, null).seq;
    s.postMessage(1, "bot", "corrected figure", "text", null, null, wrong);
    s.close();
    const list = await (await fetch(`${base}/api/messages?room=1`)).json();
    const old = list.messages.find((m) => m.seq === wrong);
    const neu = list.messages.find((m) => m.seq === wrong + 1);
    check(
      "viewer API carries superseded_by / supersedes_seq",
      old.superseded_by === wrong + 1 && neu.supersedes_seq === wrong,
      { old: old.superseded_by, neu: neu.supersedes_seq },
    );
    const sres = await (
      await fetch(`${base}/api/search?room=1&q=${encodeURIComponent('"wrong figure"')}`)
    ).json();
    const sm = (sres.matches || []).find((m) => m.seq === wrong);
    check(
      "search results carry supersession fields too",
      !!sm && sm.superseded_by === wrong + 1,
      sm,
    );
  }

  // web replies stamp the denormalized reply author (prune-safe direction)
  {
    const rep = await post("/api/post", { room: 1, name: "alex", body: "web reply", reply_to_seq: 1 });
    const raw = new Database(DB);
    const row = raw
      .prepare("SELECT reply_to_agent FROM messages WHERE room_id = 1 AND seq = ?")
      .get(rep.data.seq);
    raw.close();
    check("web reply stamps reply_to_agent", row.reply_to_agent === "bot", row);
  }

  // full room deletion cascades to every related table
  {
    const s = new ChatStore(DB);
    const rid = s.createRoom("doomed", null, null).id;
    s.upsertAgent("ghost", null, null, null);
    s.joinRoom(rid, "ghost", "SX"); // membership + session marker
    s.postMessage(rid, "ghost", "to be erased", "text", null, null);
    s.claimResource(rid, "file:x", "ghost", 900, null);
    s.close();

    const noConfirm = await post("/api/delete-room", { room: rid, confirm: false });
    check("delete without confirm:true is rejected", noConfirm.status === 400, noConfirm);
    const del = await post("/api/delete-room", { room: rid, confirm: true });
    check(
      "delete-room succeeds with counts",
      del.status === 200 && del.data.messages === 1 && del.data.members === 1 && del.data.name === "doomed",
      del,
    );
    const raw = new Database(DB);
    const remains = {
      room: raw.prepare("SELECT COUNT(*) AS c FROM rooms WHERE id = ?").get(rid).c,
      msgs: raw.prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?").get(rid).c,
      members: raw.prepare("SELECT COUNT(*) AS c FROM memberships WHERE room_id = ?").get(rid).c,
      markers: raw.prepare("SELECT COUNT(*) AS c FROM session_markers WHERE room_id = ?").get(rid).c,
      claims: raw.prepare("SELECT COUNT(*) AS c FROM claims WHERE room_id = ?").get(rid).c,
    };
    raw.close();
    check("messages/memberships/markers/claims/room all cascaded", Object.values(remains).every((v) => v === 0), remains);
    const missing = await post("/api/delete-room", { room: rid, confirm: true });
    check("deleting a missing room is a 400", missing.status === 400, missing);
  }

  // input validation hardening (self-review round)
  {
    const floaty = await fetch(base + "/api/messages?room=1&limit=1.5");
    check("float limit is handled, not a 500", floaty.status === 200, floaty.status);
    const coerced = await post("/api/join", { room: true, name: "coerce" });
    check("room:true is rejected (no Number() coercion)", coerced.status === 400, coerced);
    const nullSeq = await post("/api/read", { room: 1, name: "alex", seq: null });
    check("seq:null is rejected", nullSeq.status === 400, nullSeq);
    const big = await fetch(base + "/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: 1, name: "alex", body: "a".repeat(800_000) }),
    });
    const bigBody = await big.json().catch(() => null);
    check(
      "oversized body gets a READABLE 413, not a connection reset",
      big.status === 413 && bigBody && /too large/.test(bigBody.error),
      { status: big.status, body: bigBody },
    );
    const alive = await fetch(base + "/api/rooms");
    check("server alive after the 413", alive.status === 200, alive.status);
    // Host allowlist (DNS-rebinding hygiene) via a raw request: fetch()
    // refuses to override the Host header.
    const evilHost = await new Promise((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/api/rooms", headers: { Host: "evil.example.com" } },
        (r) => resolve(r.statusCode),
      );
      req.on("error", () => resolve(-1));
      req.end();
    });
    check("foreign Host header is rejected on reads", evilHost === 403, evilHost);
    // Body cap: a >100k body arrives cut with an honest flag.
    {
      const s = new ChatStore(DB);
      s.postMessage(1, "bot", "capped " + "y".repeat(150_000), "text", null, null);
      s.close();
      const r = await fetch(base + "/api/messages?room=1");
      const data = await r.json();
      const m = data.messages.find((x) => x.body.startsWith("capped"));
      check(
        "big bodies are capped per page with truncation metadata",
        m && m.body.length === 100_000 && m.body_truncated === true && m.body_length === 150_007,
        m && { len: m.body.length, flag: m.body_truncated, total: m.body_length },
      );
      const small = data.messages.find((x) => x.seq === 1);
      check("small bodies carry no cap bookkeeping", small && small.body_length === undefined && small.body_truncated === undefined, small);
    }
    // 201-char mention runs are skipped, not mistagged as their 200-prefix.
    {
      const long = "b".repeat(201);
      await post("/api/post", { room: 1, name: "alex", body: `hi @${long} and @carol.` });
      const r = await fetch(base + "/api/messages?room=1");
      const data = await r.json();
      const m = data.messages[data.messages.length - 1];
      check(
        "201-char mention skipped; trailing-dot mention still tags",
        JSON.stringify(m.mentions) === '["carol"]',
        m.mentions,
      );
    }
  }

  // web joins register a presence row, so a web participant sharing a name
  // with MCP sessions is never evicted by the presence recompute (v0.8.3)
  {
    const s = new ChatStore(DB);
    const rid = s.createRoom("shared-name", null, null).id;
    s.close();
    const wj = await post("/api/join", { room: rid, name: "pat" });
    // An MCP session joins and leaves under the SAME name; the recompute must
    // see the web participant's live presence row and keep the membership.
    const s2 = new ChatStore(DB);
    s2.joinRoom(rid, "pat", null, "MCPNONCE");
    s2.leaveRoom(rid, "pat", "MCPNONCE");
    const m = s2.getMembership(rid, "pat");
    s2.close();
    check(
      "MCP twin leave does not evict the web participant",
      wj.status === 200 && m.left_at === null,
      m,
    );
    const still = await post("/api/post", { room: rid, name: "pat", body: "still here" });
    check("web participant can still post after the twin left", still.status === 200, still);
    // The inverse: a web leave with a live MCP twin must not evict the twin.
    const s3 = new ChatStore(DB);
    s3.joinRoom(rid, "pat", null, "MCPNONCE2");
    s3.close();
    const wl = await post("/api/leave", { room: rid, name: "pat" });
    const s4 = new ChatStore(DB);
    const m2 = s4.getMembership(rid, "pat");
    s4.close();
    check(
      "web leave with a live MCP twin keeps the identity present",
      wl.status === 200 && wl.data.left === true && m2.left_at === null,
      { wl: wl.data, m2 },
    );
    // With no live sessions anywhere, a web leave marks the membership left.
    const s5 = new ChatStore(DB);
    s5.leaveRoom(rid, "pat", "MCPNONCE2");
    s5.close();
    const rejoinW = await post("/api/join", { room: rid, name: "pat" });
    const wl2 = await post("/api/leave", { room: rid, name: "pat" });
    const s6 = new ChatStore(DB);
    const m3 = s6.getMembership(rid, "pat");
    s6.close();
    check(
      "web leave with no live twins marks the membership left",
      rejoinW.status === 200 && wl2.data.left === true && m3.left_at !== null,
      { wl2: wl2.data, m3 },
    );
  }

  // search: a page of exactly `limit` matches signals more exist (v0.8.3)
  {
    for (let i = 0; i < 4; i++) {
      await post("/api/post", { room: 1, name: "alex", body: "needleword " + i });
    }
    const cut = await (await fetch(`${base}/api/search?room=1&q=needleword&limit=3`)).json();
    check(
      "search limit cut carries the trimmed flag",
      cut.matches.length === 3 && cut.trimmed === true,
      { n: cut.matches.length, trimmed: cut.trimmed },
    );
    const all = await (await fetch(`${base}/api/search?room=1&q=needleword&limit=50`)).json();
    check(
      "a complete search page carries no trimmed flag",
      all.matches.length === 4 && all.trimmed === undefined,
      { n: all.matches.length, trimmed: all.trimmed },
    );
  }

  // web gating requires a LIVE web presence row (v0.8.4): an MCP-only
  // identity cannot act through the web API without a web join, and a left
  // web session cannot post or advance the durable read marker even while an
  // MCP twin keeps the membership present.
  {
    const s = new ChatStore(DB);
    const rid = s.createRoom("gating", null, null).id;
    s.joinRoom(rid, "bot"); // MCP-style membership, no web presence row
    s.close();
    const meBot = await (await fetch(`${base}/api/me?room=${rid}&name=bot`)).json();
    const postBot = await post("/api/post", { room: rid, name: "bot", body: "via web" });
    const readBot = await post("/api/read", { room: rid, name: "bot", seq: 1 });
    check("MCP-only identity is not web-joined", meBot.joined === false, meBot);
    check("MCP-only identity cannot post via the web API", postBot.status === 400, postBot);
    check("MCP-only identity cannot mark read via the web API", readBot.status === 400, readBot);

    await post("/api/join", { room: rid, name: "meg" });
    const s2 = new ChatStore(DB);
    s2.joinRoom(rid, "meg", null, "TWIN"); // live MCP twin, same name
    s2.postMessage(rid, "bot", "unseen", "text", null, null);
    s2.close();
    await post("/api/leave", { room: rid, name: "meg" });
    const meMeg = await (await fetch(`${base}/api/me?room=${rid}&name=meg`)).json();
    const postMeg = await post("/api/post", { room: rid, name: "meg", body: "after leave" });
    const readMeg = await post("/api/read", { room: rid, name: "meg", seq: 99 });
    const s3 = new ChatStore(DB);
    const megRow = s3.getMembership(rid, "meg");
    s3.close();
    check(
      "left web session reports not joined despite a live MCP twin",
      meMeg.joined === false,
      meMeg,
    );
    check(
      "left web session cannot post (no presence resurrection)",
      postMeg.status === 400,
      postMeg,
    );
    check(
      "left web session cannot advance the durable marker",
      readMeg.status === 400 && megRow.last_read_seq === 0,
      { status: readMeg.status, marker: megRow.last_read_seq },
    );
    check("the MCP twin is still present after the web leave", megRow.left_at === null, megRow);
  }
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
