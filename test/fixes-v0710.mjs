// Regression tests for the v0.7.10 general-bug fixes (from a fresh external
// review; each reproduced before fixing):
//  #6  a top-level "__proto__" JSON key is preserved, not silently dropped
//  #10 fetchBounded no longer emits a false byte_limited when its sentinel was
//      the last row
//  #11 the store rejects a pre-serialized json body hiding a nested lone
//      surrogate (defense in depth for direct callers)
// (#8 list_rooms atomic snapshot and #9 list_agents keyset are exercised by
//  fixes-v071; #8's race is timing-dependent and left to inspection.)
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

// --- #10: no false byte_limited when the sentinel was the last row -----------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  mkAgent(s, "w"); mkAgent(s, "p");
  s.joinRoom(r, "w", EPOCH1, {}); s.joinRoom(r, "p", EPOCH1, {});
  s.postMessage(r, "p", "x".repeat(150000), "text", null, null, null, EPOCH1); // alone fills the raw budget
  s.postMessage(r, "p", "y".repeat(150000), "text", null, null, null, EPOCH1); // becomes the sentinel; also the last row
  const page = s.catchUp(r, "w", 500, 20, 100000, EPOCH1);               // preview 20 shrinks both to fit
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
  mkRoom(s, "room", null, null); mkAgent(s, "p"); s.joinRoom(1, "p", EPOCH1, {});
  let rejected = false;
  try { s.postMessage(1, "p", '{"x":"\\ud800"}', "json", null, null, null, EPOCH1); }
  catch (e) { rejected = /lone surrogate/.test(e.message); }
  check("#11 store rejects json body with a nested lone surrogate", rejected, null);
  let okNul = true;
  try { s.postMessage(1, "p", '{"x":"a\\u0000b"}', "json", null, null, null, EPOCH1); } catch { okNul = false; }
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
  // Bind FIRST: room administration is epoch-fenced, so create_room needs a
  // live persona. Rooms must precede JOINS, not bindings.
  await call(
    21,
    "create_persona",
    '{"brand":"testbrand","model":"testmodel","version":"1"}',
  );
  await call(2, "create_room", '{"name":"proto-room"}');
  await call(3, "join_room", '{"room":"proto-room"}');
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
