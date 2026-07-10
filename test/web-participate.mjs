// Regression tests for the web viewer's participation endpoints:
// join/post/read/leave, mention parsing, reply validation, join gating,
// and interop (an agent's catch_up sees a web-posted message as directed).
import { spawn } from "node:child_process";
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
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
