// Regression tests for the v0.8.2 fixes (a third external review of the
// presence work); each reproduced before fixing:
//  #3 list_agents keyset is on the monotonic membership rowid, so a same-second
//     join whose id sorts BELOW the cursor is not skipped
//  #6 metadata list responses reserve budget for the paging cursor (stay <=100k)
//  #8 request strings (room refs, FTS queries, filters) are length-capped
//  (#1 and #4 were about PRIVATE SESSION CURSORS -- a left session staying
//   muted across an unrelated join, and --session excluding soft-left rooms
//   from an all-rooms poll. Sessions are gone: one runtime holds one persona.
//   Left-room muting for my_mentions is covered in my-mentions.mjs, and the
//   poller's left-room exclusion in features-persona.mjs.)
import { ChatStore } from "../dist/db.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EPOCH1, mkAgent, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};
const size = (o) => JSON.stringify(o).length;

// --- #3: list_agents rowid keyset does not skip a lower-id same-second join ---
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  for (const id of ["m","n","o","p"]) { mkAgent(s, id); s.joinRoom(r, id, EPOCH1, {}); }
  const seen = new Set();
  let after;
  for (let i = 0; i < 10; i++) {
    const pg = s.listAgents(r, 5, undefined, 2, after);
    for (const a of pg.agents) seen.add(a.id);
    if (i === 0) { mkAgent(s, "a"); s.joinRoom(r, "a", EPOCH1, {}); } // id below the cursor
    if (pg.next_after === undefined) break;
    after = pg.next_after;
  }
  check("#3 lower-id same-second join is not skipped by keyset", ["m","n","o","p"].every((id) => seen.has(id)) && seen.has("a"),
    { seen: [...seen] });
  check("#3 next_after is a rowid number", typeof s.listAgents(r, 5, undefined, 2).next_after === "number", null);
  s.close();
}

// --- #6: list_claims with long keys stays under the 100k response bound -------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", EPOCH1, {});
  const K = 500; // max claim key length
  for (let i = 0; i < 400; i++) {
    s.claimResource(r, "k" + String(i).padStart(3, "0") + "x".repeat(K - 4), "a", EPOCH1, 900, null);
  }
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
  // BIND A PERSONA FIRST. Without it join_room fails at requirePersona and the
  // call never reaches the room-reference length cap, so this check passed
  // whether or not the cap existed. The point is the SCHEMA rejection: an
  // oversized reference must not be echoed back inside a 250k error response.
  const persona = await call("create_persona", {
    brand: "testbrand",
    model: "testmodel",
    version: "1",
  });
  check(
    "#8 the cap test actually has a bound persona (else it never reaches the cap)",
    persona.result && persona.result.isError !== true,
    persona.result,
  );
  const big = "x".repeat(250000);
  const r = await call("join_room", { room: big });
  const resp = JSON.stringify(r);
  const text = (r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || "";
  check("#8 a 250k-char room ref is rejected (no 250k error response)", r.result && r.result.isError && resp.length < 5000,
    { isError: r.result && r.result.isError, respLen: resp.length });
  check(
    "#8 the rejection is the schema length cap, not a missing-persona error",
    /too_big|at most 500|Too big|String must contain at most/i.test(text) &&
      !/no persona bound/.test(text),
    text.slice(0, 300),
  );
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
