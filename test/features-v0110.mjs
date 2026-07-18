// Phase 3 tests (v0.11.0): conditional post (CAS), crossed_directed,
// opt-in crossed previews, explicit room / expected_room on post_message.
//  S1 crossed_directed counts mention- and reply-directed crossings
//  S2 CAS reject is token-relative, stores nothing, returns bounded previews
//     with per-row directed; accept path unchanged when the token is current
//  S3 crossed_remaining when the row cap cuts the reject preview list
//  S4 crossed_preview_chars on an accepted post; absent without the opt-in
//  S5 adversarial bodies in crossed previews: astral codepoint cuts, huge
//     bodies bounded, control-char escaping bounded, json partials
//  S6 a reject consumes nothing: catch_up still delivers the crossed rows
//  S7 client_message_id deduplicates exact lost-response retries, rejects reuse
//  P1 MCP: room targets a joined room without switching active
//  P2 MCP: expected_room asserts the active room; mutual exclusion with room
//  P3 MCP: CAS reject shape + idempotent retry succeeds
//  P4 MCP: back-compat accept shape (posted:true rides along)
//  P5 MCP: client_message_id returns original seq on exact retry
import { ChatStore } from "../dist/db.js";
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

// --- S1: crossed_directed --------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("cross-room", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  const mine = s.postMessage(r, "me", "root", "text", null, null);
  check("S1 clean post: crossed 0, crossed_directed 0",
    mine.posted === true && mine.crossed === 0 && mine.crossed_directed === 0, mine);
  s.postMessage(r, "peer", "broadcast", "text", null, null);
  s.postMessage(r, "peer", "mention", "text", ["me"], null);
  s.postMessage(r, "peer", "reply", "text", null, mine.seq);
  const next = s.postMessage(r, "me", "over the top", "text", null, null);
  check(
    "S1 crossed 3 with 2 directed (mention + reply)",
    next.crossed === 3 && next.crossed_directed === 2 &&
      next.crossed_range.from_seq === mine.seq + 1,
    next,
  );
  s.close();
}

// --- S2/S3/S6: CAS reject --------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("cas-future-token", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  s.postMessage(r, "peer", "unread context", "text", null, null); // cursor=0, seq=1
  let aheadError = "";
  try {
    s.postMessage(r, "me", "must not post", "text", null, null, null, null, {
      ifLastReadSeq: 1,
    });
  } catch (e) {
    aheadError = String(e?.message ?? e);
  }
  check(
    "S2 CAS rejects a token ahead of the effective read cursor",
    /ahead of.*read (marker|cursor)/i.test(aheadError) &&
      !s.readHistory(r, 10).messages.some((m) => m.content === "must not post"),
    { aheadError, history: s.readHistory(r, 10).messages },
  );
  s.close();
}

{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("cas-room", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  s.postMessage(r, "peer", "first", "text", ["me"], null);
  const read = s.catchUp(r, "me", 50);
  const token = read.new_last_read_seq;
  // Current token: accepted.
  const okPost = s.postMessage(r, "me", "verdict v1", "text", null, null, null, null, {
    ifLastReadSeq: token,
  });
  check("S2 CAS accepts on a current token", okPost.posted === true, okPost);
  // Peer lands one; the same token now rejects.
  const sneak = s.postMessage(r, "peer", "changes everything", "text", ["me"], null);
  const before = s.unreadCount(r, 0, "peer");
  const rej = s.postMessage(r, "me", "verdict v2", "text", null, null, null, null, {
    ifLastReadSeq: token,
  });
  check(
    "S2 CAS rejects token-relative with per-row directed previews",
    rej.posted === false && rej.crossed === 1 && rej.crossed_directed === 1 &&
      rej.crossed_range.from_seq === sneak.seq &&
      rej.crossed_messages.length === 1 &&
      rej.crossed_messages[0].content === "changes everything" &&
      rej.crossed_messages[0].directed === true,
    rej,
  );
  check(
    "S2 a rejected post stores NOTHING",
    s.unreadCount(r, 0, "peer") === before,
    { before, after: s.unreadCount(r, 0, "peer") },
  );
  // S6: the reject consumed nothing; catch_up still delivers the crossing row.
  const after = s.catchUp(r, "me", 50);
  check(
    "S6 reject consumes nothing; catch_up still delivers the crossed message",
    after.messages.some((m) => m.content === "changes everything"),
    after.messages,
  );
  // Retry with the fresh token succeeds.
  const retry = s.postMessage(r, "me", "verdict v2", "text", null, null, null, null, {
    ifLastReadSeq: after.new_last_read_seq,
  });
  check("S2 idempotent retry with the fresh token is accepted", retry.posted === true, retry);

  // S3: 25 crossings, row cap 20 -> crossed_remaining 5.
  const r2 = s.createRoom("cas-flood", null, null).id;
  s.joinRoom(r2, "me");
  s.joinRoom(r2, "peer");
  for (let i = 0; i < 25; i++) s.postMessage(r2, "peer", "n" + i, "text", null, null);
  const flood = s.postMessage(r2, "me", "verdict", "text", null, null, null, null, {
    ifLastReadSeq: 0,
  });
  check(
    "S3 reject previews cap at 20 rows with crossed_remaining 5",
    flood.posted === false && flood.crossed === 25 &&
      flood.crossed_messages.length === 20 && flood.crossed_remaining === 5,
    { n: flood.crossed_messages?.length, rem: flood.crossed_remaining },
  );
  s.close();
}

// --- S4: opt-in previews on accept ------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("prev-room", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  s.postMessage(r, "peer", "context that crossed", "text", ["me"], null);
  s.postMessage(r, "peer", "broadcast context", "text", null, null);
  const plain = s.postMessage(r, "me", "no opt-in", "text", null, null);
  check(
    "S4 without the opt-in: counts only, no crossed_messages",
    plain.crossed === 2 && plain.crossed_messages === undefined,
    plain,
  );
  const withPrev = s.postMessage(r, "me", "with opt-in", "text", null, null, null, null, {
    crossedPreviewChars: 7,
  });
  check(
    "S4 opt-in returns truncated previews with directed flags",
    withPrev.posted === true && withPrev.crossed_messages.length === 2 &&
      withPrev.crossed_messages[0].content === "context" &&
      withPrev.crossed_messages[0].truncated === true &&
      withPrev.crossed_messages[0].directed === true &&
      withPrev.crossed_messages[1].directed === false,
    withPrev.crossed_messages,
  );
  s.close();
}

// --- S5: adversarial bodies in crossed previews ------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("adv-room", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  s.postMessage(r, "peer", "\u{1F989}".repeat(400), "text", null, null); // astral, 400 cp
  s.postMessage(r, "peer", "x".repeat(100_000), "text", null, null); // huge
  s.postMessage(r, "peer", "".repeat(2000), "text", null, null); // control-heavy
  s.postMessage(r, "peer", JSON.stringify({ deep: { nested: "value" } }), "json", null, null);
  const res = s.postMessage(r, "me", "over it", "text", null, null, null, null, {
    ifLastReadSeq: 0,
  });
  check("S5 adversarial reject returns all four rows",
    res.posted === false && res.crossed_messages.length === 4, res.crossed_messages?.length);
  const [astral, huge, ctrl, jsonRow] = res.crossed_messages;
  check(
    "S5 astral preview cuts in codepoints (no split surrogates)",
    astral.truncated === true && [...astral.content].length === 300 &&
      astral.length === 400,
    { cp: [...astral.content].length, len: astral.length, trunc: astral.truncated },
  );
  check(
    "S5 huge body arrives truncated with its full length reported",
    huge.truncated === true && huge.length === 100_000 && huge.content.length === 300,
    { len: huge.length, got: huge.content?.length },
  );
  check(
    "S5 control-heavy preview stays bounded",
    ctrl.truncated === true && ctrl.content.length <= 300,
    { got: ctrl.content?.length },
  );
  check(
    "S5 short json crossing arrives parsed",
    jsonRow.format === "json" && typeof jsonRow.content === "object" &&
      jsonRow.content.deep.nested === "value",
    jsonRow,
  );
  const serialized = JSON.stringify(res.crossed_messages);
  check("S5 whole preview list stays under its byte bound", serialized.length < 25_000, serialized.length);
  s.close();
}

// --- S7: sparse, opt-in post idempotency --------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("idempotent-post", null, null).id;
  s.upsertAgent("me", null, null, null);
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(r, "me");
  s.joinRoom(r, "peer");
  const opts = { clientMessageId: "verdict-req-1", ifLastReadSeq: 0 };
  const first = s.postMessage(r, "me", "verdict", "text", ["peer"], null, null, null, opts);
  s.postMessage(r, "peer", "later context", "text", null, null);
  const retry = s.postMessage(r, "me", "verdict", "text", ["peer"], null, null, null, opts);
  check(
    "S7 exact retry returns the original seq despite later CAS-stale traffic",
    first.posted === true && first.deduplicated === false &&
      retry.posted === true && retry.deduplicated === true &&
      retry.seq === first.seq &&
      s.readHistory(r, 20).messages.filter((m) => m.content === "verdict").length === 1,
    { first, retry, history: s.readHistory(r, 20).messages },
  );
  let collision = "";
  try {
    s.postMessage(
      r,
      "me",
      "different verdict",
      "text",
      ["peer"],
      null,
      null,
      null,
      { clientMessageId: "verdict-req-1" },
    );
  } catch (e) {
    collision = String(e?.message ?? e);
  }
  check(
    "S7 reusing a key for a different stored payload fails without another row",
    /already attached to a different stored payload/.test(collision) &&
      s.readHistory(r, 20).messages.filter((m) => /verdict/.test(String(m.content))).length === 1,
    { collision, history: s.readHistory(r, 20).messages },
  );
  s.close();
}

// --- P: MCP surface -----------------------------------------------------------------
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v0110-mcp-"));
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
    const deadline = setTimeout(() => {
      clearInterval(poll);
      child.kill("SIGKILL");
      rej(new Error(`MCP reply timeout id ${id}`));
    }, 15_000);
    const poll = setInterval(() => {
      if (R.has(id)) {
        clearInterval(poll);
        clearTimeout(deadline);
        res(R.get(id));
      }
    }, 15);
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  const call = async (name, args) => {
    const i = ++id;
    send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    const m = await wait(i);
    const body = m.result?.content?.[0]?.text;
    let data = null;
    if (body) { try { data = JSON.parse(body); } catch { data = { raw: body }; } }
    return { isError: m.result?.isError === true, data };
  };

  const s = new ChatStore(DB);
  const rA = s.createRoom("post-a", null, null).id;
  const rB = s.createRoom("post-b", null, null).id;
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(rA, "peer");
  s.joinRoom(rB, "peer");
  await call("join_room", { room: "post-b", agent_id: "u" });
  await call("join_room", { room: "post-a", agent_id: "u" }); // active = A

  // P1: explicit room target.
  const p1 = await call("post_message", { content: "into B", room: "post-b" });
  const who = await call("whoami", {});
  check(
    "P1 room: posts to the named room, active room unchanged",
    p1.data.posted === true && p1.data.room_id === rB && p1.data.room_name === "post-b" &&
      who.data.room_id === rA,
    { p1: p1.data, who: who.data.room_id },
  );
  const landed = s.readHistory(rB, 10).messages.some((m) => m.content === "into B");
  check("P1 the message landed in the target room", landed, null);
  const p1e = await call("post_message", { content: "x", room: "never-joined-room" });
  check("P1 unknown/never-joined room fails", p1e.isError === true, p1e.data);

  // P2: expected_room.
  const p2ok = await call("post_message", { content: "guarded", expected_room: "post-a" });
  check("P2 matching expected_room posts", p2ok.data.posted === true, p2ok.data);
  const p2bad = await call("post_message", { content: "misrouted", expected_room: "post-b" });
  check(
    "P2 mismatched expected_room rejects with nothing posted",
    p2bad.isError === true && /does not match the active room/.test(p2bad.data.error),
    p2bad.data,
  );
  const p2both = await call("post_message", {
    content: "x",
    room: "post-a",
    expected_room: "post-a",
  });
  check("P2 room + expected_room together are rejected", p2both.isError === true, p2both.data);

  // P3: CAS over MCP.
  const drain = await call("catch_up", {});
  const token = drain.data.new_last_read_seq;
  s.postMessage(rA, "peer", "landed during composition", "text", ["u"], null);
  const p3rej = await call("post_message", {
    content: "verdict",
    if_last_read_seq: token,
  });
  check(
    "P3 stale CAS returns posted:false with previews and retry guidance",
    p3rej.isError !== true && p3rej.data.posted === false &&
      p3rej.data.rejected === "stale_read" &&
      p3rej.data.crossed_messages.length === 1 &&
      p3rej.data.crossed_messages[0].directed === true &&
      /call catch_up/.test(p3rej.data.retry) &&
      /re-send the SAME content/.test(p3rej.data.retry),
    p3rej.data,
  );
  const reread = await call("catch_up", {});
  const p3ok = await call("post_message", {
    content: "verdict",
    if_last_read_seq: reread.data.new_last_read_seq,
  });
  check("P3 retry with the fresh token posts", p3ok.data.posted === true, p3ok.data);

  const beforeAhead = s.readHistory(rA, 100).messages.length;
  const p3ahead = await call("post_message", {
    content: "must not bypass with a future token",
    if_last_read_seq: reread.data.new_last_read_seq + 1000,
  });
  check(
    "P3 future CAS token fails without storing a post",
    p3ahead.isError === true && /ahead of.*read (marker|cursor)/i.test(p3ahead.data.error) &&
      s.readHistory(rA, 100).messages.length === beforeAhead,
    { result: p3ahead.data, beforeAhead, after: s.readHistory(rA, 100).messages.length },
  );

  // P4: back-compat accept shape.
  const p4 = await call("post_message", { content: "plain", to: ["peer"] });
  check(
    "P4 accept shape keeps seq/crossed/recipients and adds posted/crossed_directed",
    typeof p4.data.seq === "number" && p4.data.posted === true &&
      typeof p4.data.crossed === "number" && typeof p4.data.crossed_directed === "number" &&
      Array.isArray(p4.data.recipients),
    p4.data,
  );

  // P5: a lost response can be retried without duplicating the post.
  const p5first = await call("post_message", {
    content: "large dispositive result",
    client_message_id: "mcp-request-1",
  });
  s.postMessage(rA, "peer", "later traffic", "text", null, null);
  const p5retry = await call("post_message", {
    content: "large dispositive result",
    client_message_id: "mcp-request-1",
  });
  check(
    "P5 exact idempotent retry returns the original seq and inserts no duplicate",
    p5first.data.posted === true && p5first.data.deduplicated === undefined &&
      p5retry.data.posted === true && p5retry.data.deduplicated === true &&
      p5retry.data.seq === p5first.data.seq &&
      s.readHistory(rA, 100).messages.filter((m) => m.content === "large dispositive result").length === 1,
    { first: p5first.data, retry: p5retry.data },
  );
  const p5collision = await call("post_message", {
    content: "different result",
    client_message_id: "mcp-request-1",
  });
  check(
    "P5 key reuse with a different stored payload fails",
    p5collision.isError === true && /different stored payload/.test(p5collision.data.error),
    p5collision.data,
  );

  // P6: pruning must not erase the evidence behind a dispositive CAS token.
  const pruneRoom = s.createRoom("cas-prune", null, null).id;
  s.joinRoom(pruneRoom, "peer");
  await call("join_room", { room: "cas-prune" });
  const oldToken = (await call("catch_up", {})).data.new_last_read_seq;
  s.postMessage(pruneRoom, "peer", "contradiction", "text", null, null); // seq 1
  await call("catch_up", {}); // user has read it, but oldToken remains 0
  await call("post_message", { content: "own suffix" }); // seq 2
  s.markRead(pruneRoom, "peer");
  const pruned = s.pruneMessages(pruneRoom, 1, false);
  const evidenceGone = await call("post_message", {
    content: "must not land",
    if_last_read_seq: oldToken,
  });
  check(
    "P6 CAS rejects when pruning removed evidence after the token",
    pruned.deleted === 1 && evidenceGone.isError !== true &&
      evidenceGone.data.posted === false &&
      evidenceGone.data.rejected === "evidence_pruned" &&
      evidenceGone.data.pruned_through_seq === 1 &&
      /cannot prove/.test(evidenceGone.data.retry) &&
      !s.readHistory(pruneRoom, 20).messages.some((m) => m.content === "must not land"),
    { pruned, result: evidenceGone.data },
  );
  const freshToken = (await call("catch_up", {})).data.new_last_read_seq;
  const afterPrune = await call("post_message", {
    content: "fresh decision",
    if_last_read_seq: freshToken,
  });
  check(
    "P6 catch_up supplies a fresh token that can post",
    freshToken === 2 && afterPrune.data.posted === true,
    { freshToken, result: afterPrune.data },
  );

  s.close();
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall features-v0110 checks passed");
