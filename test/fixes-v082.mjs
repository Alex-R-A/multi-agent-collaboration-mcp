// Regression tests for the v0.8.2 fixes (a third external review of the
// presence work); each reproduced before fixing:
//  #1 the GC keeps left-but-fresh presence rows, so my_mentions muting is not
//     undone by an unrelated agent's join
//  #3 list_agents keyset is on the monotonic membership rowid, so a same-second
//     join whose id sorts BELOW the cursor is not skipped
//  #4 an all-rooms poller with --session excludes rooms the session soft-left
//  #6 metadata list responses reserve budget for the paging cursor (stay <=100k)
//  #8 request strings (room refs, FTS queries, filters) are length-capped
import { ChatStore } from "../dist/db.js";
import { spawnSync, spawn } from "node:child_process";
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
const size = (o) => JSON.stringify(o).length;

// --- #1: my_mentions muting survives an unrelated join (GC keeps left rows) ---
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a", "A", "A"); s.joinRoom(r, "a", "B", "B"); s.joinRoom(r, "b", null, "BOB");
  s.postMessage(r, "b", "hi @a", "text", ["a"], null);
  s.leaveRoom(r, "a", "A");
  const before = s.myMentions("a", 50, undefined, 100000, "A", 0).messages.length;
  s.upsertAgent("c", null, null, null); s.joinRoom(r, "c", null, "C"); // runs the GC
  const after = s.myMentions("a", 50, undefined, 100000, "A", 0).messages.length;
  check("#1 left session stays muted after an unrelated join", before === 0 && after === 0, { before, after });
  s.close();
}

// --- #3: list_agents rowid keyset does not skip a lower-id same-second join ---
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  for (const id of ["m","n","o","p"]) { s.upsertAgent(id, null, null, null); s.joinRoom(r, id); }
  const seen = new Set();
  let after;
  for (let i = 0; i < 10; i++) {
    const pg = s.listAgents(r, 5, undefined, 2, after);
    for (const a of pg.agents) seen.add(a.id);
    if (i === 0) { s.upsertAgent("a", null, null, null); s.joinRoom(r, "a"); } // id below the cursor
    if (pg.next_after === undefined) break;
    after = pg.next_after;
  }
  check("#3 lower-id same-second join is not skipped by keyset", ["m","n","o","p"].every((id) => seen.has(id)) && seen.has("a"),
    { seen: [...seen] });
  check("#3 next_after is a rowid number", typeof s.listAgents(r, 5, undefined, 2).next_after === "number", null);
  s.close();
}

// --- #4: --session makes the all-rooms poller exclude soft-left rooms ---------
{
  const dir = mkdtempSync(join(tmpdir(), "v082-sess-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a", "A", "A"); s.joinRoom(r, "a", "B", "B"); s.joinRoom(r, "b", null, "BOB");
  s.postMessage(r, "b", "hi", "text", null, null);
  s.leaveRoom(r, "a", "A"); // session A leaves; twin B keeps identity present
  s.close();
  const CHECK = join(ROOT, "dist", "check.js");
  const env = { ...process.env, AGENT_CHAT_DB: DB };
  const idp = spawnSync("node", [CHECK, "--agent", "a"], { env, encoding: "utf8" });
  const sess = spawnSync("node", [CHECK, "--agent", "a", "--session", "A"], { env, encoding: "utf8" });
  check("#4 identity-level probe sees the unread (exit 0)", idp.status === 0, { status: idp.status, err: idp.stderr });
  check("#4 --session probe for the LEFT session sees nothing (exit 1, not error)", sess.status === 1, { status: sess.status, err: sess.stderr });
  rmSync(dir, { recursive: true, force: true });
}

// --- #6: list_claims with long keys stays under the 100k response bound -------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null); s.joinRoom(r, "a");
  const K = 500; // max claim key length
  for (let i = 0; i < 400; i++) s.claimResource(r, "k" + String(i).padStart(3, "0") + "x".repeat(K - 4), "a", 900, null);
  const page = s.listClaims(r, 1000, "");
  const whole = { claims: page.claims, total: page.total, ...(page.next_key !== undefined ? { next_key: page.next_key, truncated: true } : {}) };
  check("#6 list_claims whole response (rows + next_key cursor) stays <= 100000", size(whole) <= 100_000, size(whole));
  check("#6 list_claims still emits a next_key (it was trimmed, so more remain)", page.next_key !== undefined, page.next_key);
  s.close();
}

// --- #8: over-long request strings are rejected (MCP schema caps) -------------
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v082-cap-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], { env: { ...process.env, AGENT_CHAT_DB: DB }, stdio: ["pipe", "pipe", "ignore"] });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const s = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const w = (id) => new Promise((res, rej) => {
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
  let id = 1;
  const call = async (name, args) => { const i = ++id; s({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } }); return w(i); };
  s({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await w(1);
  s({ jsonrpc: "2.0", method: "notifications/initialized" });
  const big = "x".repeat(250000);
  const r = await call("join_room", { room: big, agent_id: "u" });
  const resp = JSON.stringify(r);
  check("#8 a 250k-char room ref is rejected (no 250k error response)", r.result && r.result.isError && resp.length < 5000,
    { isError: r.result && r.result.isError, respLen: resp.length });
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
