// Regression tests for the EIGHTH-round fixes (v0.7.2), each reproducing an
// issue a reviewer confirmed against v0.7.1:
//  1  existing/old-writer NUL rows: migration heals them (NUL -> U+FFFD, read
//     whole) and a BEFORE INSERT trigger rejects an old build's NUL insert
//  2  `length` is CODEPOINTS everywhere (get_message and the bulk reads agreed
//     to disagree by the astral factor)
//  5  fetchBounded charges mentions too (empty-body/huge-mention rows no longer
//     materialize ~10 MB), fitRows reserves the response envelope
//  6  wait_for_messages refuses a doomed watch (room never joined / no rooms)
//  10 poller accepts zero-padded values, rejects genuinely huge ones
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
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
const NUL = String.fromCharCode(0);
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e.message));
  }
};

// --- 1: existing/old-writer NUL rows healed + rejected ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v072-nul-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); const r = s.createRoom("r", null, null).id; s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null); s.joinRoom(r, "a"); s.joinRoom(r, "b"); s.close(); }
  // An OLD build (no reject trigger) inserts a NUL body directly.
  {
    const raw = new Database(DB);
    raw.exec("DROP TRIGGER IF EXISTS messages_reject_nul");
    raw.prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,1,'b','text',?)").run("abc" + NUL + "def");
    raw.close();
  }
  // Reopen with the current build: the migration heals the existing NUL row.
  {
    const s = new ChatStore(DB);
    const gm = s.getMessage(1, 1, 0, 1000);
    check(
      "existing NUL row is healed (full text readable, NUL shown as U+FFFD)",
      gm.content === "abc�def",
      gm.content,
    );
    // An old build trying to insert ANOTHER NUL row is now rejected by the trigger.
    const raw = new Database(DB);
    let rejected = false;
    try { raw.prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,2,'b','text',?)").run("x" + NUL + "y"); }
    catch (e) { rejected = /NUL/.test(e.message); }
    raw.close();
    check("old-build NUL insert is rejected by the DB trigger", rejected, null);
    check("new-build NUL write is rejected in JS", throws(() => s.postMessage(1, "b", "p" + NUL + "q", "text", null, null), /NUL/), null);
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- 2: `length` is codepoints everywhere -------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null); s.joinRoom(r, "a"); s.joinRoom(r, "b");
  s.postMessage(r, "b", "\u{1F600}".repeat(200), "text", null, null); // 200 emoji = 200 codepoints, 400 UTF-16
  const hist = s.readHistory(r, 1, undefined, 100).messages[0]; // preview cut
  const gm = s.getMessage(r, 1, 0, 100);
  check(
    "history and get_message report the SAME length, in codepoints (200, not 400)",
    hist.length === 200 && gm.length === 200,
    { hist: hist.length, gm: gm.length },
  );
  s.close();
}

// --- 5: fetchBounded charges mentions; empty-body/huge-mention rows bounded ----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null); s.upsertAgent("b", null, null, null); s.joinRoom(r, "a"); s.joinRoom(r, "b");
  // 300 rows: empty body, but a big mentions list each (~2000 chars serialized).
  const bigMentions = Array.from({ length: 100 }, (_, i) => "agent-" + String(i).padStart(4, "0"));
  for (let i = 0; i < 300; i++) s.postMessage(r, "b", "", "text", bigMentions, null);
  const heapBefore = process.memoryUsage().heapUsed;
  const page = s.catchUp(r, "a", 500, undefined, 100_000);
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  check("catch_up over huge-mention rows fits max_bytes", size(page) <= 100_000, size(page));
  check("catch_up delivers at least one and flags more remain", page.messages.length >= 1 && page.byte_limited === true, page.messages.length);
  check(
    "catch_up did not materialize all 300 mention-heavy rows (~<4 MB)",
    heapGrowth < 4_000_000,
    { heapGrowth },
  );
  s.close();
}

// --- 5b: list response (array + envelope) stays under the budget --------------
{
  const s = new ChatStore(":memory:");
  const heavy = "d".repeat(3000);
  for (let i = 0; i < 80; i++) s.createRoom("room-" + i, heavy, null);
  const { rooms } = s.listRooms(200, 0);
  // The store returns just the array; the whole MCP result adds total/flags.
  const wholeResponse = { rooms, total: 80, truncated: true };
  check("whole list response (array + envelope) stays under the budget", size(wholeResponse) <= 100_000, size(wholeResponse));
  s.close();
}

// --- 6 + 10: wait_for_messages membership guard, poller numeric edges ----------
{
  const dir = mkdtempSync(join(tmpdir(), "v072-mcp-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    s.createRoom("joined-room", null, null);
    s.createRoom("other-room", null, null);
    s.close();
  }
  // MCP client.
  const child = spawn("node", [join(ROOT, "dist", "index.js")], { env: { ...process.env, AGENT_CHAT_DB: DB }, stdio: ["pipe", "pipe", "ignore"] });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const s = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const w = (id) => new Promise((res) => { const t = setInterval(() => { if (R.has(id)) { clearInterval(t); res(R.get(id)); } }, 15); });
  let id = 1;
  const call = async (name, args) => {
    const i = ++id;
    s({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    const r = await w(i);
    const isErr = r.result && r.result.isError;
    return { isErr, data: (() => { try { return JSON.parse(r.result.content[0].text); } catch { return { error: r.result.content[0].text }; } })() };
  };
  s({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await w(1);
  s({ jsonrpc: "2.0", method: "notifications/initialized" });

  await call("join_room", { room: "joined-room", agent_id: "u" });
  // Scoping to a room the identity never joined -> refuse.
  const notJoined = await call("wait_for_messages", { room: "other-room" });
  check("wait_for_messages refuses a room you never joined", notJoined.isErr && /never joined/.test(notJoined.data.error), notJoined);
  // The joined room works.
  const ok = await call("wait_for_messages", {});
  check("wait_for_messages returns a command for a joined identity", typeof ok.data.command === "string" && ok.data.command.includes("--agent 'u'"), ok.data);
  // Leave the only room, then unscoped watch -> refuse (would exit 2).
  await call("leave_room", {});
  const noRooms = await call("wait_for_messages", {});
  check("wait_for_messages refuses an all-rooms watch when in no room", noRooms.isErr && /not present in any room/.test(noRooms.data.error), noRooms);
  child.kill();

  // Poller: zero-padded value accepted, huge value rejected.
  {
    const setup = new ChatStore(DB);
    setup.upsertAgent("w", null, null, null);
    setup.joinRoom(1, "w");
    setup.close();
  }
  const POLLER = join(ROOT, "scripts", "wait-for-updates.sh");
  const padded = spawnSync("bash", [POLLER, "--agent", "w", "--interval", "0000000001", "--timeout", "1"], { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 20_000 });
  check("poller accepts a zero-padded --interval (times out cleanly)", padded.status === 124, { status: padded.status, stderr: padded.stderr });
  const huge = spawnSync("bash", [POLLER, "--agent", "w", "--interval", "99999999999", "--timeout", "1"], { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 20_000 });
  check("poller rejects a genuinely huge --interval", huge.status === 2 && /too large/.test(huge.stderr), { status: huge.status, stderr: huge.stderr });

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
