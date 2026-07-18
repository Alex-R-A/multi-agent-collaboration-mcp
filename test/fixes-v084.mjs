// Regression tests for the v0.8.4 review fixes:
//  #1 the all-rooms poller probe with --session baselines off the session's
//     OWN private cursor, so a private session lagging its twin is woken
//     (the identity marker is the MAX across sessions and hid its unread)
//  #2 tools/list advertises post_message `content` WITHOUT excluding objects
//     (the z.custom union arm was dropped from the generated JSON Schema, so
//     schema-validating clients rejected every object body client-side)
//  #3 store-level metadata length caps: a direct caller cannot create a claim
//     key (etc.) that busts the listing byte budgets, which assume the MCP
//     schema caps
//  #4 a live session's leave tombstone is refreshed by its touches, so
//     my_mentions muting no longer silently expires at the 7-day GC age
//     while the session is still polling
//  #5 touch() runs the presence GC, so a crashed twin in a stable-but-active
//     room is reconciled without waiting for a join/leave/prune
//  (web gating and the web search probe are covered in web-participate.mjs.)
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
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

// --- #1: --session baselines the all-rooms probe off the session cursor ------
{
  const dir = mkdtempSync(join(tmpdir(), "v084-poll-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a", "A", "A"); // private session A
  s.joinRoom(r, "a", "B", "B"); // private twin B
  s.joinRoom(r, "b", null, "BOB");
  for (let i = 0; i < 3; i++) s.postMessage(r, "b", "m" + i, "text", null, null);
  // Twin B reads everything, advancing the identity marker past A's cursor.
  s.catchUp(r, "a", 50, undefined, undefined, "B");
  s.close();
  const CHECK = join(ROOT, "dist", "check.js");
  const env = { ...process.env, AGENT_CHAT_DB: DB };
  const idp = spawnSync("node", [CHECK, "--agent", "a"], { env, encoding: "utf8" });
  const sess = spawnSync("node", [CHECK, "--agent", "a", "--session", "A"], {
    env,
    encoding: "utf8",
  });
  check(
    "#1 identity-level probe sees nothing (twin advanced the marker)",
    idp.status === 1,
    { status: idp.status, err: idp.stderr },
  );
  check(
    "#1 --session probe wakes the lagging private session (exit 0)",
    sess.status === 0,
    { status: sess.status, out: sess.stdout, err: sess.stderr },
  );
  const parsed = sess.status === 0 ? JSON.parse(sess.stdout) : null;
  check(
    "#1 --session probe reports the session's own unread count",
    !!parsed && parsed.unread === 3,
    parsed,
  );
  rmSync(dir, { recursive: true, force: true });
}

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
  await call("create_room", { name: "schema-room" });
  await call("join_room", { room: "schema-room", agent_id: "u" });
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
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
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
    /exceeds 200/.test(threw(() => s.createRoom("n".repeat(201), null, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char agent id",
    /exceeds 200/.test(threw(() => s.upsertAgent("i".repeat(201), null, null, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char mention id",
    /exceeds 200/.test(
      threw(() => s.postMessage(r, "a", "x", "text", ["m".repeat(201)], null)),
    ),
    null,
  );
  // At-cap values still pass (the MCP schema allows exactly these lengths).
  const ok = s.claimResource(r, "k".repeat(500), "a", 900, null);
  check("#3 at-cap 500-char key is still granted", ok.granted === true, ok);
  s.close();
}

// --- #4: a live session's mute survives past the GC age -----------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v084-tomb-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("room", null, null).id;
  for (const id of ["a", "b", "c"]) s.upsertAgent(id, null, null, null);
  s.joinRoom(r, "a", "A", "A");
  s.joinRoom(r, "a", "B", "B"); // twin keeps the identity present
  s.joinRoom(r, "b", null, "BOB");
  s.postMessage(r, "b", "hi @a", "text", ["a"], null);
  s.leaveRoom(r, "a", "A"); // session A mutes the room
  // Simulate the tombstone approaching the GC age while session A stays
  // alive and polling: its next touch must refresh the LEFT row too.
  const raw = new Database(DB);
  raw
    .prepare(
      "UPDATE session_presence SET updated_at = datetime('now','-8 days') WHERE session_id = 'A'",
    )
    .run();
  raw.close();
  s.touchSessionAlive("A", "a"); // as session A's next tool call would
  s.joinRoom(r, "c", null, "C"); // runs the GC
  const inbox = s.myMentions("a", 50, undefined, 100000, "A", 0);
  check(
    "#4 live session's mute survives past the GC age",
    inbox.messages.length === 0,
    inbox.messages.length,
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- #5: an ordinary touch reconciles a crashed twin in the active room -------
{
  const dir = mkdtempSync(join(tmpdir(), "v084-gc-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("live", null, null, null);
  s.upsertAgent("dead", null, null, null);
  s.joinRoom(r, "live", null, "L");
  s.joinRoom(r, "dead", null, "D"); // this session then crashes
  const raw = new Database(DB);
  raw
    .prepare(
      "UPDATE session_presence SET updated_at = datetime('now','-8 days') WHERE session_id = 'D'",
    )
    .run();
  raw.close();
  s.touch(r, "live", "L"); // an ordinary tool-call touch
  check(
    "#5 touch reaps a crashed twin's stale presence",
    s.getMembership(r, "dead").left_at !== null,
    s.getMembership(r, "dead"),
  );
  check(
    "#5 the live toucher stays present",
    s.getMembership(r, "live").left_at === null,
    s.getMembership(r, "live"),
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
