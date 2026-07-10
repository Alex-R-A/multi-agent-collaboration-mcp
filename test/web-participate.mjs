// Regression tests for the web viewer's participation endpoints:
// join/post/read/leave, mention parsing, reply validation, join gating,
// and interop (an agent's catch_up sees a web-posted message as directed).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
} finally {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
