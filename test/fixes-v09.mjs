// Regression tests for the NINTH-round fixes, each reproducing an issue an
// external reviewer confirmed against v0.7.2:
//   1  bulk reads silently omitted rows when preview_chars / a compact JSON
//      reparse shrank them below their raw size: get_thread and search now flag
//      byte_limited / next_offset via fetchBounded's `exhausted` signal.
//   3  the NUL heal is cursored one row at a time (not .all()); many NUL rows
//      all heal.
//   8b wait_for_messages allows a SCOPED watch on a soft-left room (the poller
//      supports it), while still refusing a never-joined room.
//   11 structured JSON rejects lone surrogates in nested strings and keys
//      before JSON.stringify can hide them as ASCII escapes.
//   13 resolveRoom skips the id lookup for a numeric ref past 2^53 (would round
//      to a neighbour) and falls through to the exact-name lookup.
//   14 the poller accepts a heavily zero-padded small value ("00000000001").
//   15 a whitespace-only agent_id is rejected, not silently treated as omitted.
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
const NUL = String.fromCharCode(0);

// --- 1: get_thread + search flag omission after a shrink ----------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v09-omit-"));
  const s = new ChatStore(join(dir, "t.db"));
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null); s.joinRoom(r, "a");
  // 10 large replies; preview_chars shrinks them so boundByBytes would fit all
  // it fetched -- but fetchBounded stopped on the raw budget with rows behind.
  const root = s.postMessage(r, "a", "root", "text", null, null).seq;
  for (let i = 0; i < 10; i++) s.postMessage(r, "a", "R" + i + ".".repeat(50000), "text", null, root);
  const th = s.getThread(r, root, 3, 10);
  check(
    "get_thread flags byte_limited when a preview cut hides replies",
    th.replies.length < 10 && th.byte_limited === true,
    { replies: th.replies.length, byte_limited: th.byte_limited },
  );
  // 10 whitespace-heavy JSON matches: reparse compacts them below raw size.
  const gap = " ".repeat(60000);
  for (let i = 0; i < 10; i++) {
    s.postMessage(r, "a", '["needle",' + gap + '"v' + i + '"]', "json", null, null);
  }
  const sr = s.searchMessages(r, "needle", 20, 0);
  check(
    "search emits next_offset when a JSON reparse hides matches",
    sr.matches.length < 10 && typeof sr.next_offset === "number",
    { matches: sr.matches.length, next_offset: sr.next_offset },
  );
  // Paging with the emitted next_offset actually reaches the rest (no loss).
  const seen = new Set();
  let off = 0, guard = 0;
  for (;;) {
    if (++guard > 100) break;
    const p = s.searchMessages(r, "needle", 20, off);
    for (const m of p.matches) seen.add(m.seq);
    if (p.next_offset === undefined) break;
    off = p.next_offset;
  }
  check("paging by next_offset delivers all 10 JSON matches", seen.size === 10, seen.size);
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 3: many NUL rows all heal (cursored, not .all()) -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v09-heal-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("r", null, null); s.upsertAgent("a", null, null, null); s.joinRoom(1, "a"); s.close(); }
  {
    const raw = new Database(DB);
    raw.pragma("foreign_keys = ON");
    raw.exec("DROP TRIGGER IF EXISTS messages_reject_nul");
    const ins = raw.prepare("INSERT INTO messages (room_id,seq,agent_id,format,body) VALUES (1,?,'a','text',?)");
    for (let i = 1; i <= 25; i++) ins.run(i, "a" + i + NUL + "b" + i);
    // A build old enough to write NULs predates the migration marker, so clear
    // user_version: the body NUL scan is now gated on it and must re-run here.
    raw.pragma("user_version = 0");
    raw.close();
  }
  const s = new ChatStore(DB); // migrate heal runs
  let allHealed = true;
  for (let i = 1; i <= 25; i++) {
    const gm = s.getMessage(1, i, 0, 1000);
    if (gm.content !== "a" + i + "�" + "b" + i) allHealed = false;
  }
  const leftover = new Database(DB).prepare("SELECT COUNT(*) c FROM messages WHERE instr(body, char(0)) > 0").get().c;
  check("all 25 NUL rows healed (cursored heal, no .all())", allHealed && leftover === 0, { allHealed, leftover });
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 13: resolveRoom skips an unsafe-integer id ref ---------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("real-room", null, null);
  check("resolveRoom finds a normal id", s.resolveRoom(String(r.id))?.id === r.id, null);
  // 2^53+1 rounds to 2^53 in JS; must NOT resolve to any room by rounding.
  check(
    "resolveRoom rejects an id past 2^53 (no rounded neighbour)",
    s.resolveRoom("9007199254740993") === undefined,
    null,
  );
  s.close();
}

// --- 5 + 8b + 11 + 15: MCP client integration -------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v09-mcp-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("watch-me", null, null); s.close(); }
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

  // #15: whitespace-only agent_id is rejected (not silently treated as omitted).
  const ws = await call("join_room", { room: "watch-me", agent_id: "   " });
  check("whitespace-only agent_id is rejected", ws.isErr && /whitespace|empty/.test(JSON.stringify(ws.data)), ws);

  // Join normally, then SOFT-LEAVE, then a scoped wait_for_messages must succeed.
  await call("join_room", { room: "watch-me", agent_id: "u" });
  await call("leave_room", {});
  const softLeft = await call("wait_for_messages", { room: "watch-me" });
  check(
    "wait_for_messages allows a scoped watch on a soft-left room",
    !softLeft.isErr && typeof softLeft.data.command === "string",
    softLeft,
  );
  // But a never-joined room is still refused.
  const never = await call("wait_for_messages", { room: "nope-never" });
  check("wait_for_messages still refuses a never-existent room", never.isErr, never);

  // #5: a scoped watch on a PRIVATE-cursor room emits --since (this session's
  // own position) so the poller does not fall back to the identity marker a
  // twin may have advanced; a shared-cursor room omits it.
  await call("join_room", { room: "watch-me", agent_id: "p", cursor: "private" });
  const priv = await call("wait_for_messages", { room: "watch-me" });
  check("private scoped watch emits --since", !priv.isErr && /--since /.test(priv.data.command || ""), priv.data.command);
  await call("join_room", { room: "watch-me", agent_id: "p", cursor: "shared" });
  const shared = await call("wait_for_messages", { room: "watch-me" });
  check("shared scoped watch omits --since", !shared.isErr && !/--since /.test(shared.data.command || ""), shared.data.command);

  // #11: JSON.stringify normally turns a semantic lone surrogate into the
  // ASCII escape "\\ud800", so the storage-level string guard cannot see it.
  // Reject malformed strings and object keys before encoding instead.
  const malformedJson = [
    ["a nested high surrogate", { outer: { inner: ["ok", "x\ud800y"] } }],
    ["a nested low surrogate", [{ outer: ["ok", { inner: "x\udc00y" }] }]],
    ["a lone surrogate in an object key", { ["key\ud800"]: "value" }],
    ["surrogate halves split across values", ["\ud83d", "\ude00"]],
  ];
  for (const [name, content] of malformedJson) {
    const bad = await call("post_message", { content });
    check(
      `structured JSON rejects ${name}`,
      bad.isErr && /lone surrogate|malformed UTF-16/.test(JSON.stringify(bad.data)),
      bad,
    );
  }
  const badText = await call("post_message", { content: "x\ud800y" });
  check("text and structured JSON share the lone-surrogate policy", badText.isErr, badText);
  const empty = await call("read_history", { limit: 10 });
  check("rejected malformed content inserted no messages", empty.data.messages.length === 0, empty.data);

  // A real surrogate pair is valid, while the six literal characters
  // backslash-u-d-8-0-0 are ordinary ASCII. Nested NUL is valid Unicode and is
  // safely escaped in the serialized database body, so it remains supported.
  const goodKeys = ["pair-\ud83d\ude00", "literal-\\ud800", "nul-\u0000"];
  const goodContent = {
    nested: [{ emoji: "\ud83d\ude00" }],
    literal: "\\ud800",
    nul: "a\u0000b",
    keys: Object.fromEntries(goodKeys.map((key, i) => [key, i])),
  };
  const good = await call("post_message", { content: goodContent });
  const badTextNul = await call("post_message", { content: "a\u0000b" });
  check(
    "plain-text NUL is rejected while a nested JSON NUL remains supported",
    badTextNul.isErr && /NUL/.test(JSON.stringify(badTextNul.data)),
    badTextNul,
  );
  const goodTextContent = "pair-\ud83d\ude00 literal-\\ud800";
  const goodText = await call("post_message", { content: goodTextContent });
  const goodHistory = await call("read_history", { limit: 10 });
  const jsonMessage = goodHistory.data.messages.find((m) => m.seq === 1);
  const textMessage = goodHistory.data.messages.find((m) => m.seq === 2);
  check(
    "valid pairs, literal backslash-u, nested NUL, and valid keys round-trip",
    !good.isErr &&
      good.data.seq === 1 &&
      jsonMessage?.format === "json" &&
      jsonMessage.content?.nested?.[0]?.emoji === "\ud83d\ude00" &&
      jsonMessage.content?.literal === "\\ud800" &&
      jsonMessage.content?.nul === "a\u0000b" &&
      Object.keys(jsonMessage.content?.keys ?? {}).join("|") === goodKeys.join("|"),
    { good, history: goodHistory.data },
  );
  check(
    "valid-pair and literal-backslash text still round-trip",
    !goodText.isErr &&
      goodText.data.seq === 2 &&
      textMessage?.format === "text" &&
      textMessage.content === goodTextContent,
    { goodText, textMessage },
  );
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

// --- 14: poller accepts an 11-digit zero-padded value -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v09-poll-"));
  const DB = join(dir, "t.db");
  { const s = new ChatStore(DB); s.createRoom("r", null, null); s.upsertAgent("w", null, null, null); s.joinRoom(1, "w"); s.close(); }
  const POLLER = join(ROOT, "scripts", "wait-for-updates.sh");
  const run = (a) => spawnSync("bash", [POLLER, ...a], { env: { ...process.env, AGENT_CHAT_DB: DB }, encoding: "utf8", timeout: 20000 });
  const padded = run(["--agent", "w", "--interval", "00000000001", "--timeout", "1"]);
  check("poller accepts an 11-digit zero-padded value (times out cleanly)", padded.status === 124, { status: padded.status, stderr: padded.stderr });
  const huge = run(["--agent", "w", "--interval", "99999999999", "--timeout", "1"]);
  check("poller still rejects a genuinely huge value", huge.status === 2 && /too large/.test(huge.stderr), { status: huge.status });
  rmSync(dir, { recursive: true, force: true });
}

// --- 7: claim listing keyset-pages; a claim expiring mid-page skips nothing ---
{
  const dir = mkdtempSync(join(tmpdir(), "v09-claims-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("claims", null, null).id;
  s.upsertAgent("a", null, null, null); s.joinRoom(r, "a");
  for (const k of ["k-a", "k-b", "k-c", "k-d"]) s.claimResource(r, k, "a", 900, null);
  const p1 = s.listClaims(r, 2, "");
  check(
    "claims page 1: first two by key, next_key set",
    p1.claims.map((c) => c.key).join(",") === "k-a,k-b" && p1.next_key === "k-b",
    { keys: p1.claims.map((c) => c.key), next_key: p1.next_key },
  );
  // Expire the FIRST claim between pages. Under the old DELETE-then-OFFSET, page
  // 2 at offset 2 would shift over the now-3-row set and skip the live k-c.
  {
    const raw = new Database(DB);
    raw.prepare("UPDATE claims SET expires_at = datetime('now','-10 seconds') WHERE key = 'k-a'").run();
    raw.close();
  }
  const p2 = s.listClaims(r, 2, p1.next_key);
  check(
    "claims page 2 (keyset) returns k-c,k-d after k-a expired -- live claim not skipped",
    p2.claims.map((c) => c.key).join(",") === "k-c,k-d",
    p2.claims.map((c) => c.key),
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 9: preview_chars cuts in CODEPOINTS (parity with get_message) -----------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null); s.joinRoom(r, "a");
  s.postMessage(r, "a", "\u{1F600}".repeat(75), "text", null, null); // 75 emoji = 75 cp, 150 UTF-16
  const p50 = s.readHistory(r, 10, undefined, 50).messages[0];
  check(
    "preview_chars:50 keeps 50 codepoints (emoji), not 25 UTF-16 halves",
    [...p50.content].length === 50 && p50.truncated === true && p50.length === 75,
    { cp: [...p50.content].length, truncated: p50.truncated, length: p50.length },
  );
  const p100 = s.readHistory(r, 10, undefined, 100).messages[0];
  check(
    "preview_chars:100 returns all 75 emoji, not truncated",
    [...p100.content].length === 75 && !p100.truncated,
    { cp: [...p100.content].length, truncated: p100.truncated },
  );
  s.close();
}

// --- 10: legacy metadata NULs are healed (not just message bodies) -----------
{
  const dir = mkdtempSync(join(tmpdir(), "v09-meta-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    s.createRoom("r", "desc", null);
    s.upsertAgent("a", null, null, "adesc");
    s.joinRoom(1, "a");
    s.claimResource(1, "k", "a", 900, "cnote");
    s.close();
  }
  {
    const raw = new Database(DB);
    raw.prepare("UPDATE rooms SET description = 'x'||char(0)||'y' WHERE id=1").run();
    raw.prepare("UPDATE agents SET description = 'a'||char(0)||'b' WHERE id='a'").run();
    raw.prepare("UPDATE claims SET note = 'n'||char(0)||'m' WHERE room_id=1 AND key='k'").run();
    raw.close();
  }
  const s = new ChatStore(DB); // migrate heals metadata columns
  const room = s.listRooms(10, 0).rooms[0];
  const agent = s.listAgents(1, 5).agents.find((a) => a.id === "a");
  const claim = s.listClaims(1).claims[0];
  check("room description NUL healed (listing substr reads it whole)", room.description === "x�y", room.description);
  check("agent description NUL healed", agent && agent.description === "a�b", agent && agent.description);
  check("claim note NUL healed", claim && claim.note === "n�m", claim && claim.note);
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- 6: session-aware presence -- one twin leaving does not evict a live twin -
// The 4th joinRoom arg is the PRESENCE nonce (every session registers one now);
// the 3rd is the cursor nonce. Here both twins are private (cursor + presence).
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("x", null, null, null);
  s.joinRoom(r, "x", "sessA", "sessA"); // session A (cursor + presence)
  s.joinRoom(r, "x", "sessB", "sessB"); // session B
  const leftA = s.leaveRoom(r, "x", "sessA");
  const afterA = s.getMembership(r, "x");
  check("session A leave returns true (it left)", leftA === true, leftA);
  check(
    "identity STAYS present after one twin leaves (live twin B remains)",
    afterA.left_at === null && s.presentRoomCount("x") === 1,
    { left_at: afterA.left_at, present: s.presentRoomCount("x") },
  );
  const leftB = s.leaveRoom(r, "x", "sessB");
  const afterB = s.getMembership(r, "x");
  check(
    "identity leaves once the LAST twin leaves",
    leftB === true && afterB.left_at !== null && s.presentRoomCount("x") === 0,
    { left_at: afterB.left_at, present: s.presentRoomCount("x") },
  );
  s.joinRoom(r, "x", "sessA", "sessA"); // rejoin clears this session's left flag
  check(
    "rejoin restores identity presence",
    s.getMembership(r, "x").left_at === null && s.presentRoomCount("x") === 1,
    s.presentRoomCount("x"),
  );
  s.close();
}

// --- 6b: shared (no session) leave stays identity-level ----------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("y", null, null, null);
  s.joinRoom(r, "y"); // shared, no sessionId
  const left = s.leaveRoom(r, "y");
  check(
    "shared leave marks identity left (no session rows to keep it present)",
    left === true && s.getMembership(r, "y").left_at !== null,
    s.getMembership(r, "y").left_at,
  );
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
