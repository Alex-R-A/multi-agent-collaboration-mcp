// Regression tests for the sixth-round fixes (v0.7.0):
// - strict tool schemas: unknown argument keys are rejected, never stripped
// - sticky persona binding: a runtime keeps the persona it bound
// - read markers keyed by (room, persona)
// - body_len: exact UTF-16 lengths for capped fetches (astral-safe)
// - get_message: serialized-size cap, low-surrogate start backoff
// - prune is not blocked by stale read positions
// - deleted-room races fail cleanly (no raw FK errors, no false successes)
// - bounded listings (list_rooms/list_agents/list_claims) with previews
// - search_messages offset paging
// - owner-only database file permissions
// - viewer: aggregate page budget (trimmed), reply_to_agent in payloads,
//   frame headers, exact-origin writes, :memory: refusal
// - poller: base-10 --interval, sleep child dies with the script
// - check: unsafe-integer --since rejected
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom, rmRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("fixes-v07.mjs", async () => {
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
      const t = setInterval(() => {
        if (replies.has(id)) {
          clearTimeout(dead);
          clearInterval(t);
          res(replies.get(id));
        }
      }, 20);
      const dead = setTimeout(() => {
        clearInterval(t);
        child.kill("SIGKILL");
        rej(new Error("MCP reply timeout id " + id));
      }, 15_000);
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
    const r = mkRoom(s, "strict", null, null).id;
    mkAgent(s, "other");
    s.joinRoom(r, "other", {});
    for (let i = 1; i <= 3; i++) {
      s.postMessage(r, "other", "m" + i, "text", null, null, null);
    }
    s.close();
  }
  const c = mcpClient({ AGENT_CHAT_DB: DB });
  await c.init();
  await c.call("identify_persona", {
    brand: "strict",
    model: "schema-client",
    version: "1.0",
  });
  await c.call("join_room", { room: "strict" });

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
  // `previous` must report the actual marker moved from.
  const rewound = await c.call("mark_read", { seq: 1 });
  check(
    "mark_read reports the marker it MOVED FROM, not a constant",
    legit.previous === 0 && legit.latest === 3 &&
      rewound.previous === 2 && rewound.new === 1,
    { first: legit, rewound },
  );

  // --- the runtime's persona binding is sticky across joins --------------------
  // The old failure this replaces was a silent identity FORK on a later join.
  // The binding now lives in process memory for the runtime's whole life, so the
  // second join must report the same persona -- and a room joined under it must
  // be reachable without rebinding.
  const c2 = mcpClient({ AGENT_CHAT_DB: DB });
  await c2.init();
  const created = await c2.call("identify_persona", {
    brand: "testbrand",
    model: "testmodel",
    version: "1",
  });
  const j1 = await c2.call("join_room", { room: "strict" });
  await c2.call("create_room", { name: "second-room" });
  const j2 = await c2.call("join_room", { room: "second-room" });
  check(
    "a later join keeps the runtime's persona (no silent fork)",
    typeof j1.agent_id === "string" &&
      j1.agent_id === created.agent_id &&
      j2.agent_id === j1.agent_id,
    { created: created.agent_id, first: j1.agent_id, second: j2.agent_id },
  );
  // Read position is per (room, persona), so switching the active room back
  // must not disturb the other room's cursor.
  const backToFirst = await c2.call("join_room", { room: "strict" });
  check(
    "rejoining the first room resumes its own read position",
    backToFirst.agent_id === created.agent_id &&
      backToFirst.last_read_seq === j1.last_read_seq &&
      backToFirst.new_membership === false,
    backToFirst,
  );
  c2.child.kill();

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
  // Before binding a persona: no identity to watch for.
  const preJoin = await cp.raw("wait_for_messages", {});
  check(
    "wait_for_messages before binding asks you to identify a persona",
    !!(preJoin.result && preJoin.result.isError) &&
      /identify_persona/.test(preJoin.result.content[0].text),
    preJoin,
  );
  const pollerPersona = await cp.call("identify_persona", {
    brand: "poller",
    model: "runtime",
    version: "1.0",
  });
  await cp.call("join_room", { room: "strict" });
  const w = await cp.call("wait_for_messages", {});
  check(
    "wait_for_messages returns a runnable command for THIS identity",
    typeof w.command === "string" &&
      w.command.includes("poller.js") &&
      w.command.includes(`--agent '${pollerPersona.agent_id}'`) &&
      w.command.includes("--owner-pid") &&
      w.command.includes("--ok-on-timeout") &&
      !w.command.includes("--since") &&
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
  // Run the WHOLE returned command through `bash -c`, appending a short
  // timeout/interval.
  const runnable = spawnSync(
    "bash",
    ["-c", `${w.command} --timeout 3 --interval 5`],
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

// --- capped fetches keep length fields exact; giant-body stub + reassembly ----
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "big", null, null).id;
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  const body = "x".repeat(300_000);
  s.postMessage(r, "b", body, "text", null, null, null);
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
    off = m.next_offset;
    if (!m.truncated) break;
  }
  check("offset walk reassembles the capped-fetch body exactly", out === body, out.length);
  s.close();
}

// --- get_message: serialized cap and low-surrogate start backoff --------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "esc", null, null).id;
  mkAgent(s, "b");
  s.joinRoom(r, "b", {});
  const nuls = "\u0001".repeat(5000);
  s.postMessage(r, "b", nuls, "text", null, null, null); // seq 1
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
    off = m.next_offset;
    if (!m.truncated) break;
  }
  check("escape-heavy offset walk still reassembles exactly", out === nuls, out.length);

  // get_message offsets count CODEPOINTS, so a slice boundary never falls
  // between a surrogate pair: "ab<emoji>cd" is codepoints a,b,emoji,c,d.
  // Fetching from codepoint 2 returns the WHOLE emoji first (its high
  // surrogate), never a lone low surrogate.
  s.postMessage(r, "b", "ab\u{1F600}cd", "text", null, null, null); // seq 2
  const mid = s.getMessage(r, 2, 2, 10);
  check(
    "codepoint offset never splits a surrogate pair",
    mid.content.charCodeAt(0) >= 0xd800 &&
      mid.content.charCodeAt(0) <= 0xdbff &&
      mid.content === "\u{1F600}cd" &&
      mid.length === 5,
    mid,
  );
  s.close();
}


// --- deleted-room races fail cleanly ------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "doomed", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  rmRoom(s, r);
  const expectClean = (name, fn) => {
    try {
      fn();
      check(`${name} on a deleted room fails (not a silent success)`, false, "no throw");
    } catch (e) {
      const m = String(e.message);
      check(
        `${name} on a deleted room fails cleanly`,
        // Deleted-room errors must offer a possible remedy.
        /no longer exists/.test(m) &&
          /list_rooms/.test(m) &&
          /create_room/.test(m) &&
          !/never joined/.test(m) &&
          !/have LEFT/.test(m),
        e.message,
      );
    }
  };
  expectClean("postMessage", () => s.postMessage(r, "a", "x", "text", null, null, null));
  expectClean("catchUp", () => s.catchUp(r, "a", 50, undefined, 100000));
  expectClean("joinRoom", () => s.joinRoom(r, "a", {}));
  expectClean("claimResource", () => s.claimResource(r, "k", "a", 900, null));
  expectClean("releaseClaim", () => s.releaseClaim(r, "k", "a"));
  expectClean("listClaims", () => s.listClaims(r));
  expectClean("setPinned", () => s.setPinned(r, "a", "pin"));
  expectClean("pruneMessages", () => s.pruneMessages(r, "a", 1, true));
  expectClean("setRole", () => s.setRole(r, "a", "x"));
  expectClean("markRead", () => s.markRead(r, "a"));
  expectClean("beginWaitLease", () => s.beginWaitLease(r, "a", 30));
  s.close();
}

// --- bounded listings -----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const big = "P".repeat(10_000);
  mkRoom(s, "one", "d".repeat(2000), big);
  mkRoom(s, "two", null, null);
  mkRoom(s, "three", null, null);
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
  mkAgent(s, "longdesc", { description: "D".repeat(2000) });
  mkAgent(s, "plain");
  s.joinRoom(r1, "longdesc", {});
  s.joinRoom(r1, "plain", {});
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

  mkAgent(s, "gone");
  s.joinRoom(r1, "gone", {});
  s.leaveRoom(r1, "gone");
  check("presentCount counts only present members", s.presentCount(r1) === 2, s.presentCount(r1));
  s.close();
}

// --- search_messages offset paging ----------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "s", null, null).id;
  mkAgent(s, "b");
  s.joinRoom(r, "b", {});
  for (let i = 1; i <= 5; i++) {
    s.postMessage(r, "b", "needle " + i, "text", null, null, null);
  }
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
  const r = mkRoom(s, "p", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  s.postMessage(r, "a", "x", "text", null, null, null); // force WAL sidecars into being
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
    roomId = mkRoom(s, "w", null, null).id;
    mkAgent(s, "author");
    mkAgent(s, "replier");
    s.joinRoom(roomId, "author", {});
    s.joinRoom(roomId, "replier", {});
    s.postMessage(roomId, "author", "the parent", "text", null, null, null); // seq 1
    s.postMessage(roomId, "replier", "the reply", "text", null, 1, null); // seq 2
    // 30 legal 99k bodies: a 400-row page used to serialize all of them.
    for (let i = 0; i < 30; i++) {
      s.postMessage(roomId, "author", "B".repeat(99_000), "text", null, null, null);
    }
    s.close();
  }
  const web = spawn("node", [join(ROOT, "web", "server.mjs")], {
    env: { ...process.env, AGENT_CHAT_DB: DB, AGENT_CHAT_VIEWER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
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

    // The same-origin probe below must reach the marker write to get a 200, so a
    // participant has to be allocated through the web API first. Canonical
    // rejoin rejects the LLM author because only human identities may use it.
    const llmCollision = await fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: roomId, agent_id: "author" }),
    });
    check(
      "a human web join cannot take an LLM persona's id",
      llmCollision.status === 400,
      llmCollision.status,
    );
    const wjoin = await fetch(`${base}/api/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        room: roomId,
        base_name: "reader",
        operation_id: randomUUID(),
      }),
    });
    const webIdentity = await wjoin.json();
    check(
      "web join for the origin probes succeeds",
      wjoin.status === 200 && webIdentity.agent_id === "human-reader-1",
      { status: wjoin.status, body: webIdentity },
    );
    const foreign = await fetch(`${base}/api/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" },
      body: JSON.stringify({
        room: roomId,
        agent_id: webIdentity.agent_id,
        seq: 1,
      }),
    });
    check("a DIFFERENT localhost port's Origin is rejected", foreign.status === 403, foreign.status);
    const same = await fetch(`${base}/api/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        room: roomId,
        agent_id: webIdentity.agent_id,
        seq: 1,
      }),
    });
    check("the viewer's own exact origin is accepted", same.status === 200, same.status);
  } finally {
    if (web.exitCode === null && web.signalCode === null) {
      const closed = new Promise((resolve) => web.once("close", resolve));
      web.kill("SIGKILL");
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- viewer: :memory: refusal ----------------------------------------------------
//
// There is deliberately NO old-schema coverage here. The viewer reads exactly
// one schema and does not detect, explain, or upgrade an older file; replacing
// the database is a deployment step. A pre-persona file fails raw, which is the
// accepted contract, not a behavior worth pinning with a test.
{
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
}

// --- poller: base-10 interval, childless lifecycle; check: unsafe --since ---------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-poll7-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = mkRoom(s, "q", null, null).id;
    mkAgent(s, "watcher");
    s.joinRoom(r, "watcher", {});
    s.close();
  }
  const POLLER = join(ROOT, "dist", "poller.js");
  const octal = spawnSync(
    "node",
    [POLLER, "--agent", "watcher", "--interval", "08", "--timeout", "1"],
    { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 30_000 },
  );
  check(
    "--interval 08 is base-10, not an octal arithmetic crash (quiet room times out)",
    octal.status === 124,
    { status: octal.status, stderr: octal.stderr },
  );

  if (process.platform !== "win32") {
    const poller = spawn(process.execPath, [POLLER, "--agent", "watcher", "--interval", "30", "--timeout", "300"], {
      env: { ...process.env, AGENT_CHAT_DB: DB },
      stdio: "ignore",
    });
    await sleep(300);
    const children = spawnSync("pgrep", ["-P", String(poller.pid)], {
      encoding: "utf8",
    });
    check(
      "watcher holds no polling child processes",
      (children.stdout || "").trim() === "",
      children.stdout,
    );
    poller.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        poller.kill("SIGKILL");
        resolve();
      }, 2_000);
      poller.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
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

expect(failures).toBe(0);
});
