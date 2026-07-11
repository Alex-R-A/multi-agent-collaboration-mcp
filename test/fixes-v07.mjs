// Regression tests for the sixth-round fixes (v0.7.0):
// - strict tool schemas: unknown argument keys are rejected, never stripped
// - sticky session identity: omitted agent_id reuses the session's identity
// - private cursor mode keyed by (room, identity), not room alone
// - reply_to_agent insert trigger: old-build writers can no longer strand
//   replies undirected when the parent is pruned before a new-build restart
// - body_len column: exact lengths for capped fetches; JS backfill for
//   pre-column rows measures UTF-16 exactly (astral-safe)
// - get_message: serialized-size cap, low-surrogate start backoff
// - prune reaps expired private session cursors instead of being blocked
// - deleted-room races fail cleanly (no raw FK errors, no false successes)
// - bounded listings (list_rooms/list_agents/list_claims) with previews
// - search_messages offset paging
// - owner-only database file permissions
// - viewer: aggregate page budget (trimmed), reply_to_agent in payloads,
//   frame headers, exact-origin writes, schema preflight, :memory: refusal
// - poller: base-10 --interval, sleep child dies with the script
// - check: unsafe-integer --since rejected
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal MCP stdio client (line-delimited JSON-RPC against dist/index.js).
function mcpClient(env) {
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) replies.set(m.id, m);
      } catch {}
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitFor = (id) =>
    new Promise((res, rej) => {
      const dead = setTimeout(() => rej(new Error("MCP reply timeout id " + id)), 15_000);
      const t = setInterval(() => {
        if (replies.has(id)) {
          clearTimeout(dead);
          clearInterval(t);
          res(replies.get(id));
        }
      }, 20);
    });
  let nextId = 100;
  // Raw reply: callers inspect the rejection (the SDK surfaces its own
  // InvalidParams as an isError tool result, not a JSON-RPC error).
  const raw = async (name, args) => {
    const id = ++nextId;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return waitFor(id);
  };
  // True iff the call was rejected for an unrecognized argument key.
  const rejectedKeys = (r, key) => {
    const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
    return (
      !!(r.error || (r.result && r.result.isError)) &&
      new RegExp(`Unrecognized key.*${key}|${key}.*Unrecognized key`, "s").test(
        (r.error && r.error.message) || text || "",
      )
    );
  };
  const call = async (name, args) => {
    const r = await raw(name, args);
    if (r.error) throw new Error("unexpected protocol error: " + r.error.message);
    return JSON.parse(r.result.content[0].text);
  };
  let initResult = null;
  const init = async () => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    initResult = (await waitFor(1)).result;
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  const listTools = async () => {
    const id = ++nextId;
    send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
    return (await waitFor(id)).result.tools;
  };
  return { child, raw, call, rejectedKeys, listTools, instructions: () => initResult && initResult.instructions, init };
}

// --- strict schemas: unknown keys are rejected, not silently stripped ---------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-strict-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = s.createRoom("strict", null, null).id;
    s.upsertAgent("other", null, null, null);
    s.joinRoom(r, "other");
    for (let i = 1; i <= 3; i++) s.postMessage(r, "other", "m" + i, "text", null, null);
    s.close();
  }
  const c = mcpClient({ AGENT_CHAT_DB: DB });
  await c.init();
  await c.call("join_room", { room: "strict", agent_id: "me" });

  const typo = await c.raw("mark_read", { sequence: 0 });
  check(
    "mark_read with a typo'd key is REJECTED (used to mark the whole backlog read)",
    c.rejectedKeys(typo, "sequence"),
    typo,
  );
  const me = await c.call("whoami", {});
  check("the typo'd mark_read moved nothing", me.last_read_seq === 0, me);

  const post = await c.raw("post_message", { content: "hi", too: ["other"] });
  check(
    "post_message with 'too' is REJECTED (used to post without recipients)",
    c.rejectedKeys(post, "too"),
    post,
  );
  const bogusEmpty = await c.raw("list_rooms", { room: 5 });
  check(
    "unknown keys on a parameterized no-such-key tool are rejected too",
    c.rejectedKeys(bogusEmpty, "room"),
    bogusEmpty,
  );
  const legit = await c.call("mark_read", { seq: 2 });
  check("valid mark_read still works under strict schemas", legit.new === 2, legit);

  // --- sticky session identity -------------------------------------------------
  const c2 = mcpClient({ AGENT_CHAT_DB: DB });
  await c2.init();
  const j1 = await c2.call("join_room", { room: "strict" });
  await c2.call("create_room", { name: "second-room" });
  const j2 = await c2.call("join_room", { room: "second-room" });
  check(
    "omitted agent_id on a later join keeps the session identity (no silent fork)",
    typeof j1.agent_id === "string" && j1.agent_id.length > 0 && j2.agent_id === j1.agent_id,
    { first: j1.agent_id, second: j2.agent_id },
  );
  c2.child.kill();

  // --- private cursor mode is keyed by (room, identity) ------------------------
  // Reviewer repro: A holds a private cursor at 3 (identity marker 10);
  // B joins the same room SHARED in the same session; A rejoins with cursor
  // omitted. A must still be private at 3 and receive 4..N.
  const c3 = mcpClient({ AGENT_CHAT_DB: DB });
  await c3.init();
  await c3.call("join_room", { room: "strict", agent_id: "A", cursor: "private" });
  const firstPage = await c3.call("catch_up", { limit: 2 });
  check("A's private cursor reads its first page", firstPage.new_last_read_seq === 2, firstPage);
  {
    const s = new ChatStore(DB);
    s.markRead(1, "A", 3); // A's shared twin read everything
    s.close();
  }
  await c3.call("join_room", { room: "strict", agent_id: "B", cursor: "shared" });
  const backToA = await c3.call("join_room", { room: "strict", agent_id: "A" });
  check(
    "B's shared join did not clear A's private mode",
    backToA.cursor === "private" && backToA.last_read_seq === 2,
    backToA,
  );
  const rest = await c3.call("catch_up", { limit: 50 });
  check(
    "A still receives the messages its private cursor had not read",
    rest.messages.length === 1 && rest.messages[0].seq === 3,
    rest.messages.map((m) => m.seq),
  );
  c3.child.kill();

  // --- wait_for_messages: the poller is discoverable as a TOOL ----------------
  // The recurring failure was an agent told "turn on a poller" grepping the
  // tool list, finding nothing, and stalling even though join_room already
  // returned the command. A named tool that returns the command fixes that.
  const cp = mcpClient({ AGENT_CHAT_DB: DB });
  await cp.init();
  const tools = await cp.listTools();
  const wfm = tools.find((t) => t.name === "wait_for_messages");
  check(
    "wait_for_messages appears in the tool list (mentions 'poller')",
    !!wfm && /poller/i.test(wfm.description || ""),
    wfm && wfm.name,
  );
  check(
    "server instructions point at the wait_for_messages tool",
    /wait_for_messages/.test(cp.instructions() || ""),
    (cp.instructions() || "").length,
  );
  // Before joining: needs an identity.
  const preJoin = await cp.raw("wait_for_messages", {});
  check(
    "wait_for_messages before join_room asks you to establish identity",
    !!(preJoin.result && preJoin.result.isError) &&
      /join a room first/.test(preJoin.result.content[0].text),
    preJoin,
  );
  await cp.call("join_room", { room: "strict", agent_id: "poller-user" });
  const w = await cp.call("wait_for_messages", {});
  check(
    "wait_for_messages returns a runnable command for THIS identity",
    typeof w.command === "string" &&
      w.command.includes("wait-for-updates.sh") &&
      w.command.includes("--agent 'poller-user'") &&
      !w.command.includes("--room") &&
      !w.command.includes("--mentions-only"),
    w.command,
  );
  const wScoped = await cp.call("wait_for_messages", { room: "strict", mentions_only: true });
  check(
    "wait_for_messages honors room + mentions_only (room resolved to its id)",
    wScoped.command.includes("--room '1'") && wScoped.command.includes("--mentions-only"),
    wScoped.command,
  );
  const wWasteful = await cp.raw("wait_for_messages", { rooms: "strict" });
  check(
    "wait_for_messages rejects unknown keys (strict) too",
    cp.rejectedKeys(wWasteful, "rooms"),
    wWasteful,
  );
  const wBadRoom = await cp.raw("wait_for_messages", { room: "no-such-room" });
  check(
    "wait_for_messages rejects a nonexistent room instead of emitting a broken command",
    !!(wBadRoom.result && wBadRoom.result.isError) &&
      /no room/.test(wBadRoom.result.content[0].text),
    wBadRoom,
  );
  // The returned command must actually RUN and produce a valid poller verdict,
  // not crash. poller-user joined a room with an unread backlog (seqs 1-3 from
  // "other"), so the deterministic result is exit 0 = "new messages".
  const parts = w.command.match(/^bash (.+) --agent '(.+)'$/);
  const runnable = spawnSync(
    "bash",
    [parts[1].replace(/^'|'$/g, ""), "--agent", parts[2], "--timeout", "3", "--interval", "1"],
    { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 15_000 },
  );
  check(
    "the command wait_for_messages returned actually runs (unread backlog -> exit 0)",
    runnable.status === 0 && /has_updates":true/.test(runnable.stdout),
    { status: runnable.status, stdout: runnable.stdout, stderr: runnable.stderr },
  );
  cp.child.kill();
  c.child.kill();
  rmSync(dir, { recursive: true, force: true });
}

// --- reply_to_agent insert trigger (mixed-version writers) --------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-trigger-"));
  const DB = join(dir, "t.db");
  let roomId;
  {
    const s = new ChatStore(DB);
    roomId = s.createRoom("r", null, null).id;
    s.upsertAgent("author", null, null, null);
    s.upsertAgent("old-build", null, null, null);
    s.joinRoom(roomId, "author");
    s.joinRoom(roomId, "old-build");
    s.postMessage(roomId, "author", "parent", "text", null, null); // seq 1
    s.postMessage(roomId, "author", "filler", "text", null, null); // seq 2
    s.close();
  }
  // Simulate an OLD build inserting a reply: no reply_to_agent, no body_len.
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO messages (room_id, seq, agent_id, format, body, mentions, reply_to_seq)
       VALUES (?, 3, 'old-build', 'text', 'old reply', NULL, 1)`,
    ).run(roomId);
    const row = raw
      .prepare("SELECT reply_to_agent, body_len FROM messages WHERE room_id = ? AND seq = 3")
      .get(roomId);
    check(
      "insert trigger stamps reply_to_agent for old-build writers",
      row.reply_to_agent === "author",
      row,
    );
    check("insert trigger stamps body_len for old-build writers", row.body_len === 9, row);
    raw.close();
  }
  // Prune the parent, restart: the reply must STILL be directed at the
  // parent's author (before the trigger, this was permanently lost).
  {
    const s = new ChatStore(DB);
    s.pruneMessages(roomId, 2, true); // drops seq 1
    s.close();
  }
  {
    const s = new ChatStore(DB);
    const inbox = s.myMentions("author", 50);
    check(
      "reply stays directed after parent prune + restart",
      inbox.messages.length === 1 && inbox.messages[0].seq === 3,
      inbox.messages.map((m) => m.seq),
    );
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- body_len backfill measures UTF-16 exactly for pre-column rows ------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-backfill-"));
  const DB = join(dir, "t.db");
  // A pre-body_len database: minimal old schema, one astral-heavy row.
  {
    const raw = new Database(DB);
    raw.exec(`
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE agents (id TEXT PRIMARY KEY, type TEXT, role TEXT, description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE memberships (room_id INTEGER NOT NULL, agent_id TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, agent_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
        seq INTEGER NOT NULL, agent_id TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (room_id, seq));
      INSERT INTO rooms (name) VALUES ('r');
      INSERT INTO agents (id) VALUES ('a');
      INSERT INTO memberships (room_id, agent_id) VALUES (1, 'a');
    `);
    const astral = "\u{1F600}".repeat(50) + "tail"; // 50 pairs + 4 = 104 UTF-16 units
    raw.prepare("INSERT INTO messages (room_id, seq, agent_id, body) VALUES (1, 1, 'a', ?)").run(astral);
    raw.close();
  }
  {
    const s = new ChatStore(DB); // migrate + JS backfill
    s.close();
    const raw = new Database(DB);
    const { body_len } = raw.prepare("SELECT body_len FROM messages WHERE seq = 1").get();
    raw.close();
    check("JS backfill stores the exact UTF-16 length for astral rows", body_len === 104, body_len);
  }
  rmSync(dir, { recursive: true, force: true });
}

// --- capped fetches keep length fields exact; giant-body stub + reassembly ----
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("big", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  const body = "x".repeat(300_000);
  s.postMessage(r, "b", body, "text", null, null);
  const page = s.catchUp(r, "a", 50, undefined, 1000);
  check("giant body arrives as a stub within max_bytes", JSON.stringify(page).length <= 1000, JSON.stringify(page).length);
  check(
    "stub length is the EXACT full length despite the capped fetch",
    page.messages.length === 1 && page.messages[0].length === 300_000,
    page.messages[0] && page.messages[0].length,
  );
  // Offset walk reassembles the whole body exactly.
  let out = "";
  let off = 0;
  for (let i = 0; i < 10; i++) {
    const m = s.getMessage(r, 1, off, 100_000);
    out += m.content;
    off = m.offset + m.content.length;
    if (!m.truncated) break;
  }
  check("offset walk reassembles the capped-fetch body exactly", out === body, out.length);
  s.close();
}

// --- get_message: serialized cap and low-surrogate start backoff --------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("esc", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  const nuls = "\u0001".repeat(5000);
  s.postMessage(r, "b", nuls, "text", null, null); // seq 1
  const first = s.getMessage(r, 1, 0, 1000);
  check(
    "escape-heavy slice honors max_chars SERIALIZED (was 6x over)",
    JSON.stringify(first.content).length - 2 <= 1000,
    JSON.stringify(first.content).length,
  );
  let out = "";
  let off = 0;
  for (let i = 0; i < 100; i++) {
    const m = s.getMessage(r, 1, off, 1000);
    out += m.content;
    off = m.offset + m.content.length;
    if (!m.truncated) break;
  }
  check("escape-heavy offset walk still reassembles exactly", out === nuls, out.length);

  s.postMessage(r, "b", "ab\u{1F600}cd", "text", null, null); // seq 2: pair at units 2-3
  const mid = s.getMessage(r, 2, 3, 10);
  check(
    "offset landing on a low surrogate backs up to include the pair",
    mid.offset === 2 && mid.content.charCodeAt(0) >= 0xd800 && mid.content.charCodeAt(0) <= 0xdbff,
    mid,
  );
  s.close();
}

// --- prune: expired private cursors no longer block; fresh ones still do ------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-prune-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("p", null, null).id;
  s.upsertAgent("w", null, null, null);
  s.upsertAgent("r2", null, null, null);
  s.joinRoom(r, "w");
  s.joinRoom(r, "r2");
  for (let i = 1; i <= 6; i++) s.postMessage(r, "w", "m" + i, "text", null, null);
  s.markRead(r, "r2", 6);
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO session_markers (room_id, agent_id, session_id, last_read_seq, updated_at)
       VALUES (?, 'r2', 'dead-session', 0, datetime('now', '-8 days'))`,
    ).run(r);
    raw.close();
  }
  const pruned = s.pruneMessages(r, 2, false);
  check(
    "an 8-day-dead private cursor no longer blocks pruning",
    pruned.refused === undefined && pruned.deleted === 4,
    pruned,
  );
  {
    const raw = new Database(DB);
    raw.prepare(
      `INSERT INTO session_markers (room_id, agent_id, session_id, last_read_seq)
       VALUES (?, 'r2', 'live-session', 0)`,
    ).run(r);
    raw.close();
  }
  const refused = s.pruneMessages(r, 1, false);
  check("a LIVE lagging private cursor still refuses", refused.refused === true, refused);
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- deleted-room races fail cleanly ------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("doomed", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
  s.deleteRoom(r);
  const expectClean = (name, fn) => {
    try {
      fn();
      check(`${name} on a deleted room fails (not a silent success)`, false, "no throw");
    } catch (e) {
      check(
        `${name} on a deleted room fails cleanly`,
        /no longer exists/.test(String(e.message)),
        e.message,
      );
    }
  };
  expectClean("postMessage", () => s.postMessage(r, "a", "x", "text", null, null));
  expectClean("joinRoom", () => s.joinRoom(r, "a"));
  expectClean("claimResource", () => s.claimResource(r, "k", "a", 900, null));
  expectClean("setPinned", () => s.setPinned(r, "pin"));
  expectClean("pruneMessages", () => s.pruneMessages(r, 1, true));
  s.close();
}

// --- bounded listings -----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const big = "P".repeat(10_000);
  s.createRoom("one", "d".repeat(2000), big);
  s.createRoom("two", null, null);
  s.createRoom("three", null, null);
  const all = s.listRooms();
  const one = all.rooms.find((r) => r.name === "one");
  check(
    "list_rooms previews a 10k pinned to 300 chars with a flag",
    one.pinned.length === 300 && one.pinned_truncated === true && one.description_truncated === true,
    { len: one.pinned && one.pinned.length, flag: one.pinned_truncated },
  );
  check("list_rooms reports the true total", all.total === 3 && all.rooms.length === 3, all.total);
  const cut = s.listRooms(2);
  check("list_rooms honors limit with total intact", cut.rooms.length === 2 && cut.total === 3, cut);

  const r1 = s.getRoomByName("one").id;
  s.upsertAgent("longdesc", null, null, "D".repeat(2000));
  s.upsertAgent("plain", null, null, null);
  s.joinRoom(r1, "longdesc");
  s.joinRoom(r1, "plain");
  const ag = s.listAgents(r1, 5);
  const ld = ag.agents.find((a) => a.id === "longdesc");
  check(
    "list_agents previews long descriptions with a flag",
    ld.description.length === 300 && ld.description_truncated === true,
    ld.description && ld.description.length,
  );
  const agCut = s.listAgents(r1, 5, undefined, 1);
  check("list_agents honors limit with total", agCut.agents.length === 1 && agCut.total === 2, agCut);

  s.claimResource(r1, "k1", "plain", 900, "N".repeat(2000));
  const cl = s.listClaims(r1);
  check(
    "list_claims previews long notes with a flag and total",
    cl.total === 1 && cl.claims[0].note.length === 300 && cl.claims[0].note_truncated === true,
    cl.claims[0] && cl.claims[0].note.length,
  );

  s.upsertAgent("gone", null, null, null);
  s.joinRoom(r1, "gone");
  s.leaveRoom(r1, "gone");
  check("presentCount counts only present members", s.presentCount(r1) === 2, s.presentCount(r1));
  s.close();
}

// --- search_messages offset paging ----------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("s", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  for (let i = 1; i <= 5; i++) s.postMessage(r, "b", "needle " + i, "text", null, null);
  const seen = new Set();
  let offset = 0;
  let pages = 0;
  for (;;) {
    const res = s.searchMessages(r, "needle", 2, offset);
    for (const m of res.matches) seen.add(m.seq);
    pages++;
    if (res.next_offset === undefined || pages > 5) break;
    offset = res.next_offset;
  }
  check("offset paging reaches every match behind the limit", seen.size === 5, [...seen]);
  const last = s.searchMessages(r, "needle", 2, 4);
  check(
    "final search page omits next_offset",
    last.matches.length === 1 && last.next_offset === undefined,
    last,
  );
  s.close();
}

// --- database file permissions ---------------------------------------------------
if (process.platform !== "win32") {
  const dir = mkdtempSync(join(tmpdir(), "aichat-perms-"));
  const DB = join(dir, "sub", "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("p", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
  s.postMessage(r, "a", "x", "text", null, null); // force WAL sidecars into being
  const mode = (p) => statSync(p).mode & 0o777;
  check("database file is owner-only (0600)", mode(DB) === 0o600, mode(DB).toString(8));
  check("database directory is owner-only (0700)", mode(join(dir, "sub")) === 0o700, mode(join(dir, "sub")).toString(8));
  if (existsSync(DB + "-wal")) {
    check("WAL sidecar inherits owner-only mode", mode(DB + "-wal") === 0o600, mode(DB + "-wal").toString(8));
  }
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- viewer: budget, reply_to_agent, headers, origin, preflight ------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-web7-"));
  const DB = join(dir, "t.db");
  let roomId;
  {
    const s = new ChatStore(DB);
    roomId = s.createRoom("w", null, null).id;
    s.upsertAgent("author", null, null, null);
    s.upsertAgent("replier", null, null, null);
    s.joinRoom(roomId, "author");
    s.joinRoom(roomId, "replier");
    s.postMessage(roomId, "author", "the parent", "text", null, null); // seq 1
    s.postMessage(roomId, "replier", "the reply", "text", null, 1); // seq 2
    // 30 legal 99k bodies: a 400-row page used to serialize all of them.
    for (let i = 0; i < 30; i++) {
      s.postMessage(roomId, "author", "B".repeat(99_000), "text", null, null);
    }
    s.close();
  }
  const web = spawn("node", [join(ROOT, "web", "server.mjs")], {
    env: { ...process.env, AGENT_CHAT_DB: DB, AGENT_CHAT_VIEWER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((res, rej) => {
    let out = "";
    const dead = setTimeout(() => rej(new Error("viewer boot timeout: " + out)), 10_000);
    web.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(dead);
        res(Number(m[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;

  const page = await (await fetch(`${base}/api/messages?room=${roomId}&limit=400`)).json();
  const bodyTotal = page.messages.reduce((a, m) => a + m.body.length, 0);
  check(
    "viewer page honors the aggregate body budget",
    page.trimmed === true && bodyTotal <= 2_000_000 && page.messages.length > 0,
    { rows: page.messages.length, bodyTotal, trimmed: page.trimmed },
  );

  const head = await (await fetch(`${base}/api/messages?room=${roomId}&limit=2`)).json();
  const reply = head.messages.find((m) => m.seq === 2) ||
    (await (await fetch(`${base}/api/messages?room=${roomId}&after=1&limit=1`)).json()).messages[0];
  check(
    "viewer payload carries reply_to_agent",
    reply && reply.reply_to_agent === "author",
    reply,
  );

  const html = await fetch(`${base}/`);
  check(
    "HTML refuses framing (clickjacking)",
    html.headers.get("x-frame-options") === "DENY" &&
      /frame-ancestors 'none'/.test(html.headers.get("content-security-policy") || ""),
    Object.fromEntries(html.headers),
  );

  const foreign = await fetch(`${base}/api/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" },
    body: JSON.stringify({ room: roomId, name: "author", seq: 1 }),
  });
  check("a DIFFERENT localhost port's Origin is rejected", foreign.status === 403, foreign.status);
  const самe = await fetch(`${base}/api/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ room: roomId, name: "author", seq: 1 }),
  });
  check("the viewer's own exact origin is accepted", самe.status === 200, самe.status);

  web.kill();
  rmSync(dir, { recursive: true, force: true });
}

// --- viewer: schema preflight and :memory: refusal --------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-web7pre-"));
  const DB = join(dir, "old.db");
  {
    // Faithful v1 shape (the columns migrate() does NOT add must exist).
    const raw = new Database(DB);
    raw.exec(`
      CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE agents (id TEXT PRIMARY KEY, type TEXT, role TEXT, description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE memberships (room_id INTEGER NOT NULL, agent_id TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (datetime('now')), last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, agent_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL,
        seq INTEGER NOT NULL, agent_id TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (room_id, seq));
      INSERT INTO rooms (name) VALUES ('legacy');
    `);
    raw.close();
  }
  const web = spawn("node", [join(ROOT, "web", "server.mjs")], {
    env: { ...process.env, AGENT_CHAT_DB: DB, AGENT_CHAT_VIEWER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((res, rej) => {
    let out = "";
    const dead = setTimeout(() => rej(new Error("viewer boot timeout")), 10_000);
    web.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(dead);
        res(Number(m[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const stale = await (await fetch(`${base}/api/rooms`)).json();
  check(
    "old-schema database yields one clear remedy, not mixed 400/500s",
    typeof stale.error === "string" && /predates|migrate/.test(stale.error),
    stale,
  );
  {
    const s = new ChatStore(DB); // migrate in place
    s.close();
  }
  const fresh = await (await fetch(`${base}/api/rooms`)).json();
  check(
    "viewer recovers WITHOUT restart once the MCP migrates the file",
    !fresh.error && Array.isArray(fresh.rooms) && fresh.rooms.length === 1,
    fresh,
  );
  web.kill();

  const mem = spawnSync("node", [join(ROOT, "web", "server.mjs")], {
    env: { ...process.env, AGENT_CHAT_DB: ":memory:" },
    encoding: "utf8",
    timeout: 10_000,
  });
  check(
    ":memory: viewer refuses with a diagnosis instead of showing an empty db",
    mem.status === 1 && /:memory:/.test(mem.stderr),
    { status: mem.status, stderr: mem.stderr },
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- poller: base-10 interval, sleep-child cleanup; check: unsafe --since ---------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-poll7-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = s.createRoom("q", null, null).id;
    s.upsertAgent("watcher", null, null, null);
    s.joinRoom(r, "watcher");
    s.close();
  }
  const POLLER = join(ROOT, "scripts", "wait-for-updates.sh");
  const octal = spawnSync(
    "bash",
    [POLLER, "--agent", "watcher", "--interval", "08", "--timeout", "1"],
    { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 30_000 },
  );
  check(
    "--interval 08 is base-10, not an octal arithmetic crash (quiet room times out)",
    octal.status === 124,
    { status: octal.status, stderr: octal.stderr },
  );

  if (process.platform !== "win32") {
    const poller = spawn("bash", [POLLER, "--agent", "watcher", "--interval", "30", "--timeout", "300"], {
      env: { ...process.env, AGENT_CHAT_DB: DB },
      stdio: "ignore",
    });
    // Wait for the nap's sleep child to appear.
    let sleepPid = null;
    for (let i = 0; i < 50 && sleepPid === null; i++) {
      await sleep(200);
      const ps = spawnSync("pgrep", ["-P", String(poller.pid), "sleep"], { encoding: "utf8" });
      const pid = Number((ps.stdout || "").trim().split("\n")[0]);
      if (Number.isInteger(pid) && pid > 0) sleepPid = pid;
    }
    check("poller spawned its interruptible sleep child", sleepPid !== null, sleepPid);
    if (sleepPid !== null) {
      poller.kill("SIGTERM");
      await sleep(600);
      let alive = true;
      try {
        process.kill(sleepPid, 0);
      } catch {
        alive = false;
      }
      check("SIGTERM kills the sleep child too (no orphan naps)", alive === false, { sleepPid, alive });
    } else {
      poller.kill("SIGKILL");
    }
  }

  const huge = spawnSync(
    "node",
    [join(ROOT, "dist", "check.js"), "--room", "q", "--since", "99999999999999999999"],
    { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 20_000 },
  );
  check(
    "check rejects an unsafe-integer --since instead of rounding it",
    huge.status === 2 && /too large/.test(huge.stderr),
    { status: huge.status, stderr: huge.stderr },
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
