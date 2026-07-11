// Regression tests for the self-review round (v0.6.4):
// - sticky private cursors: an omitted `cursor` on rejoin must not destroy a
//   session's private read position (driven over real MCP stdio JSON-RPC)
// - FTS index self-heal: a crash between CREATE and rebuild left search
//   permanently and silently broken for pre-FTS messages
// - surrogate-safe truncation: previews and offset paging never emit a lone
//   surrogate; offset walks still reassemble bodies exactly
// - truthful byte_limited on a lone oversized head row
// - prune: keepLast clamp, blocking-marker min_read_seq, soft-left refusal
// - LIKE wildcard escaping in the agent filter
// - crossing reports honor private session cursors
// - supersede chains: latest-wins, and pruning old links never breaks reads
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

// --- sticky private cursor over real MCP stdio -------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-sticky-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = s.createRoom("sticky", null, null).id;
    s.upsertAgent("other", null, null, null);
    s.joinRoom(r, "other");
    for (let i = 1; i <= 10; i++) s.postMessage(r, "other", "m" + i, "text", null, null);
    s.close();
  }
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
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
  const call = async (id, name, args) => {
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const r = await waitFor(id);
    return JSON.parse(r.result.content[0].text);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await waitFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  await call(2, "join_room", { room: "sticky", agent_id: "twin", cursor: "private" });
  const first = await call(3, "catch_up", { limit: 3 });
  check(
    "private session reads its first page",
    first.messages.length === 3 && first.new_last_read_seq === 3,
    first,
  );
  // A shared twin (another process) reads everything: identity marker -> 10.
  {
    const s = new ChatStore(DB);
    s.markRead(1, "twin", 10);
    s.close();
  }
  // Rejoin WITHOUT repeating cursor:'private' (a role refresh, a reconnect).
  const rejoin = await call(4, "join_room", { room: "sticky", agent_id: "twin", role: "refreshed" });
  check("rejoin keeps the private mode", rejoin.cursor === "private", rejoin);
  check("rejoin keeps the private position", rejoin.last_read_seq === 3, rejoin);
  const after = await call(5, "catch_up", { limit: 50 });
  check(
    "no message loss: the session still gets seqs 4-10 after an omitted-cursor rejoin",
    after.messages.length === 7 && after.messages[0].seq === 4,
    { count: after.messages.length, first: after.messages[0] && after.messages[0].seq },
  );
  // An EXPLICIT shared downgrade is still honored.
  const shared = await call(6, "join_room", { room: "sticky", agent_id: "twin", cursor: "shared" });
  check("explicit shared downgrade works", shared.cursor === "shared", shared);
  child.kill();
  rmSync(dir, { recursive: true, force: true });
}

// --- FTS self-heal after the historical crash window --------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-ftsheal-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = s.createRoom("r", null, null).id;
    s.upsertAgent("b", null, null, null);
    s.joinRoom(r, "b");
    s.postMessage(r, "b", "needle in a haystack", "text", null, null);
    s.close();
  }
  // Damage: index emptied while the table exists (what a crash between
  // CREATE VIRTUAL TABLE and the rebuild left behind).
  {
    const raw = new Database(DB);
    raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all')");
    raw.close();
  }
  const s = new ChatStore(DB); // migrate() must detect and rebuild
  check(
    "search self-heals on reopen after index damage",
    s.searchMessages(1, "needle", 10).matches.length === 1,
    s.searchMessages(1, "needle", 10),
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- surrogate-safe cuts -------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("emoji", null, null).id;
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "b");
  const body = "\u{1F600}".repeat(100); // 200 UTF-16 units
  s.postMessage(r, "b", body, "text", null, null); // seq 1
  s.postMessage(r, "b", "reply target", "text", null, 1); // seq 2, preview of 1

  const loneHigh = (str) => {
    const c = str.charCodeAt(str.length - 1);
    return c >= 0xd800 && c <= 0xdbff;
  };

  // Preview cut lands mid-pair without the backoff (5 units).
  const prev = s.readHistory(r, 1, 2, 5).messages[0];
  check("preview never ends in a lone surrogate", !loneHigh(String(prev.content)), prev.content);
  check("preview still flagged truncated with full length", prev.truncated === true && prev.length === 200, prev);

  // Offset walk with an odd page size: every page well-formed, reassembly exact.
  let walked = "";
  let off = 0;
  let pages = 0;
  let malformed = 0;
  for (;;) {
    const page = s.getMessage(r, 1, off, 7);
    const c = String(page.content);
    if (c.length > 1 && loneHigh(c)) malformed++;
    walked += c;
    off = page.next_offset; // get_message offsets count codepoints; advance by it
    pages++;
    if (!page.truncated) break;
    if (pages > 60) {
      check("offset walk terminates", false, pages);
      break;
    }
  }
  check(`every offset page well-formed (${pages} pages)`, malformed === 0, malformed);
  check("offset walk reassembles the emoji body exactly", walked === body, { walkedLen: walked.length });

  // Reply preview (makePreview) backs off too.
  const reply = s.readHistory(r, 1).messages[0];
  check(
    "reply preview is well-formed unicode",
    reply.reply_to && !/[\ud800-\udbff]$/.test(reply.reply_to.preview.replace(/\.\.\.$/, "")),
    reply.reply_to,
  );
  s.close();
}

// --- truthful byte_limited on a lone oversized row -----------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  s.postMessage(r, "b", "z".repeat(5000), "text", null, null);
  const page = s.catchUp(r, "a", 50, undefined, 1000);
  check(
    "lone oversized head: delivered shrunk, byte_limited truthfully absent",
    page.messages.length === 1 && page.remaining === 0 && page.byte_limited === undefined,
    page,
  );
  s.close();
}

// --- prune: keepLast clamp + soft-left refusal + blocking min ------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("author", null, null, null);
  s.upsertAgent("away", null, null, null);
  s.joinRoom(r, "author");
  s.joinRoom(r, "away");
  for (let i = 1; i <= 10; i++) s.postMessage(r, "author", "m" + i, "text", null, null);
  s.markRead(r, "away", 3);
  s.leaveRoom(r, "away"); // soft leave preserves the read position
  const refused = s.pruneMessages(r, 5, false);
  check(
    "prune refuses for a SOFT-LEFT member's unread (documented, previously untested)",
    refused.refused === true && refused.would_delete_unread === 2,
    refused,
  );
  check(
    "refusal min_read_seq names the blocking marker, not the author's 0",
    refused.min_read_seq === 3,
    refused,
  );
  const clamped = s.pruneMessages(r, 0, true);
  check(
    "keepLast=0 clamps to keeping the newest message (seq monotonicity)",
    clamped.kept === 1 && clamped.deleted === 9,
    clamped,
  );
  s.close();
}

// --- LIKE wildcard escaping in the agent filter --------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("pct", null, "rate x50%y", null);
  s.upsertAgent("plain", null, "rate x50zy", null);
  s.joinRoom(r, "pct");
  s.joinRoom(r, "plain");
  const { agents: hits } = s.listAgents(r, 5, "50%");
  check(
    "agent filter treats % as a literal, not a wildcard",
    hits.length === 1 && hits[0].id === "pct",
    hits.map((a) => a.id),
  );
  s.close();
}

// --- crossing report honors private session cursors ----------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("twin", null, null, null);
  s.upsertAgent("other", null, null, null);
  s.joinRoom(r, "twin", "S1");
  s.joinRoom(r, "other");
  for (let i = 1; i <= 10; i++) s.postMessage(r, "other", "m" + i, "text", null, null);
  s.markRead(r, "twin", 3, "S1"); // S1 at 3; identity marker rises to 3
  s.markRead(r, "twin", 10); // shared/identity marker at 10, S1 still 3
  const bySession = s.postMessage(r, "twin", "posting blind", "text", null, null, null, "S1");
  check(
    "crossed is cursor-relative for a private session (7 unseen, seqs 4-10)",
    bySession.crossed === 7 &&
      bySession.crossed_range.from_seq === 4 &&
      bySession.crossed_range.to_seq === 10,
    bySession,
  );
  const byIdentity = s.postMessage(r, "twin", "posting synced", "text", null, null, null, null);
  check(
    "crossed is zero for the fully-read identity marker",
    byIdentity.crossed === 0,
    byIdentity,
  );
  s.close();
}

// --- supersede chains ----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("r", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.joinRoom(r, "a");
  s.postMessage(r, "a", "v1", "text", null, null); // seq 1
  s.postMessage(r, "a", "v2", "text", null, null, 1); // seq 2 supersedes 1
  s.postMessage(r, "a", "v3", "text", null, null, 2); // seq 3 supersedes 2
  s.postMessage(r, "a", "v2b late correction", "text", null, null, 1); // seq 4 ALSO supersedes 1
  check("chain hop 1 resolves to the LATEST superseder", s.getMessage(r, 1).superseded_by === 4, s.getMessage(r, 1));
  check("chain hop 2 intact", s.getMessage(r, 2).superseded_by === 3, s.getMessage(r, 2));
  check("chain tip is unsuperseded", s.getMessage(r, 3).superseded_by === undefined, s.getMessage(r, 3));
  // Prune the chain's base; readers of survivors must not break.
  for (let i = 0; i < 6; i++) s.postMessage(r, "a", "filler", "text", null, null); // seqs 5-10
  const pr = s.pruneMessages(r, 7, true); // cutoff removes seqs 1-3
  check("prune removed the chain base", pr.deleted === 3, pr);
  const survivor = s.getMessage(r, 4);
  check(
    "survivor still reports its (now-pruned) supersede target without error",
    survivor.supersedes === 1 && survivor.superseded_by === undefined,
    survivor,
  );
  const hist = s.readHistory(r, 50);
  check("history over a pruned chain reads cleanly", hist.messages.length === 7, hist.messages.length);
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
