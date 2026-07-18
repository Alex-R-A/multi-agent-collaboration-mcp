// Regression tests for the v0.7.10 general-bug fixes (from a fresh external
// review; each reproduced before fixing):
//  #1  the message-body NUL scan is gated behind PRAGMA user_version (no
//      per-startup full-body scan once a file is marked migrated)
//  #6  a top-level "__proto__" JSON key is preserved, not silently dropped
//  #10 fetchBounded no longer emits a false byte_limited when its sentinel was
//      the last row
//  #11 the store rejects a pre-serialized json body hiding a nested lone
//      surrogate (defense in depth for direct callers)
// (#8 list_rooms atomic snapshot and #9 list_agents keyset are exercised by
//  fixes-v071; #8's race is timing-dependent and left to inspection.)
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
const NUL = String.fromCharCode(0);

// --- #1: user_version gates the body NUL scan --------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v0710-uv-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("r", null, null); s.upsertAgent("b", null, null, null); s.joinRoom(1, "b"); s.close(); }
  const uv = new Database(DB).pragma("user_version", { simple: true });
  check("#1 user_version marked after first migrate", uv === 2, uv);

  // A NUL inserted while the marker stands (trigger dropped only to simulate an
  // old writer) is NOT re-healed -- the scan is gated -- proving it is skipped.
  { const raw = new Database(DB); raw.exec("DROP TRIGGER IF EXISTS messages_reject_nul");
    raw.prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,1,'b','text',?)").run("a" + NUL + "z");
    raw.close(); }
  { const s = new ChatStore(DB); const gm = s.getMessage(1, 1, 0, 100);
    check("#1 gated: NUL row on an already-migrated file is NOT re-scanned", gm.content === "a", gm.content); s.close(); }

  // A genuinely legacy file (no marker) still heals on open.
  { const raw = new Database(DB); raw.pragma("user_version = 0"); raw.close(); }
  { const s = new ChatStore(DB); const gm = s.getMessage(1, 1, 0, 100);
    check("#1 legacy file (user_version 0) still heals the NUL", gm.content === "a�z", gm.content); s.close(); }
  rmSync(dir, { recursive: true, force: true });
}

// --- #10: no false byte_limited when the sentinel was the last row -----------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("w", null, null, null); s.upsertAgent("p", null, null, null);
  s.joinRoom(r, "w"); s.joinRoom(r, "p");
  s.postMessage(r, "p", "x".repeat(150000), "text", null, null); // alone fills the raw budget
  s.postMessage(r, "p", "y".repeat(150000), "text", null, null); // becomes the sentinel; also the last row
  const page = s.catchUp(r, "w", 500, 20, 100000);               // preview 20 shrinks both to fit
  check(
    "#10 catch_up: nothing left => byte_limited is absent, not a false positive",
    page.messages.length === 2 && page.remaining === 0 && page.byte_limited === undefined,
    { msgs: page.messages.length, remaining: page.remaining, byte_limited: page.byte_limited },
  );
  s.close();
}

// --- #11: store rejects a nested lone surrogate; nested NUL still allowed -----
{
  const s = new ChatStore(":memory:");
  s.createRoom("room", null, null); s.upsertAgent("p", null, null, null); s.joinRoom(1, "p");
  let rejected = false;
  try { s.postMessage(1, "p", '{"x":"\\ud800"}', "json", null, null); }
  catch (e) { rejected = /lone surrogate/.test(e.message); }
  check("#11 store rejects json body with a nested lone surrogate", rejected, null);
  let okNul = true;
  try { s.postMessage(1, "p", '{"x":"a\\u0000b"}', "json", null, null); } catch { okNul = false; }
  check("#11 nested NUL (valid Unicode, escaped) still stored", okNul, null);
  s.close();
}

// --- #6: a top-level __proto__ key survives a real MCP post ------------------
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v0710-proto-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], { env: { ...process.env, AGENT_CHAT_DB: DB }, stdio: ["pipe", "pipe", "ignore"] });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
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
  // Send a RAW JSON-RPC line so "__proto__" is a real JSON key (a JS object
  // literal { "__proto__": ... } would set the prototype, not an own key).
  const sendRaw = (s) => child.stdin.write(s + "\n");
  sendRaw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }));
  await w(1);
  sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const call = async (id, name, argsJson) => {
    sendRaw(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${name}","arguments":${argsJson}}}`);
    const r = await w(id);
    try { return JSON.parse(r.result.content[0].text); } catch { return { raw: r.result.content[0].text }; }
  };
  await call(2, "create_room", '{"name":"proto-room"}');
  await call(3, "join_room", '{"room":"proto-room","agent_id":"poster"}');
  const posted = await call(4, "post_message", '{"content":{"__proto__":{"kept":true},"normal":1}}');
  const got = await call(5, "get_message", `{"seq":${posted.seq}}`);
  const keys = got && got.content && typeof got.content === "object" ? Object.keys(got.content) : [];
  check(
    "#6 top-level __proto__ key preserved end-to-end (not dropped by z.record)",
    keys.includes("__proto__") && keys.includes("normal"),
    { keys, content: got.content },
  );
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
