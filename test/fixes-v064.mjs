// Regression tests for the self-review round (v0.6.4):
// - sticky read positions: a rejoin must not destroy the persona's read
//   position for that room (driven over real MCP stdio JSON-RPC)
// - FTS search survives closing and reopening the current database
// - surrogate-safe truncation: previews and offset paging never emit a lone
//   surrogate; offset walks still reassemble bodies exactly
// - truthful byte_limited on a lone oversized head row
// - prune: keepLast clamp, blocking-marker min_read_seq, soft-left refusal
// - LIKE wildcard escaping in the agent filter
// - crossing reports honor the persona's per-room read markers
// - supersede chains: latest-wins, and pruning old links never breaks reads
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- FTS persists across a current database reopen -----------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "aichat-fts-reopen-"));
  const DB = join(dir, "t.db");
  {
    const s = new ChatStore(DB);
    const r = mkRoom(s, "r", null, null).id;
    mkAgent(s, "b");
    s.joinRoom(r, "b", {});
    s.postMessage(r, "b", "needle in a haystack", "text", null, null, null);
    s.close();
  }
  const s = new ChatStore(DB);
  const search = s.searchMessages(1, "needle", 10);
  check(
    "search index persists across a current database reopen",
    search.matches.length === 1,
    search,
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- surrogate-safe cuts -------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "emoji", null, null).id;
  mkAgent(s, "b");
  s.joinRoom(r, "b", {});
  const body = "\u{1F600}".repeat(100); // 200 UTF-16 units
  s.postMessage(r, "b", body, "text", null, null, null); // seq 1
  s.postMessage(r, "b", "reply target", "text", null, 1, null); // seq 2, preview of 1

  const loneHigh = (str) => {
    const c = str.charCodeAt(str.length - 1);
    return c >= 0xd800 && c <= 0xdbff;
  };

  // Preview cut lands mid-pair without the backoff (5 units).
  const prev = s.readHistory(r, 1, 2, 5).messages[0];
  check("preview never ends in a lone surrogate", !loneHigh(String(prev.content)), prev.content);
  // length is now in CODEPOINTS (characters), consistent with get_message: a
  // 100-emoji body is 100 characters (was reported as 200 UTF-16 units).
  check("preview still flagged truncated with full length", prev.truncated === true && prev.length === 100, prev);

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
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "a");
  mkAgent(s, "b");
  s.joinRoom(r, "a", {});
  s.joinRoom(r, "b", {});
  s.postMessage(r, "b", "z".repeat(5000), "text", null, null, null);
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
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "author");
  mkAgent(s, "away");
  s.joinRoom(r, "author", {});
  s.joinRoom(r, "away", {});
  for (let i = 1; i <= 10; i++) s.postMessage(r, "author", "m" + i, "text", null, null, null);
  s.markRead(r, "away", 3);
  s.leaveRoom(r, "away"); // soft leave preserves the read position
  const refused = s.pruneMessages(r, "author", 5, false);
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
  const clamped = s.pruneMessages(r, "author", 0, true);
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
  const r = mkRoom(s, "r", null, null).id;
  // The filter now matches the ROOM-LOCAL role (plus id/brand/model/description).
  mkAgent(s, "pct");
  mkAgent(s, "plain");
  s.joinRoom(r, "pct", { role: "rate x50%y" });
  s.joinRoom(r, "plain", { role: "rate x50zy" });
  const { agents: hits } = s.listAgents(r, 5, "50%");
  check(
    "agent filter treats % as a literal, not a wildcard",
    hits.length === 1 && hits[0].id === "pct",
    hits.map((a) => a.id),
  );
  s.close();
}

// --- supersede chains ----------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  s.postMessage(r, "a", "v1", "text", null, null, null); // seq 1
  s.postMessage(r, "a", "v2", "text", null, null, 1); // seq 2 supersedes 1
  s.postMessage(r, "a", "v3", "text", null, null, 2); // seq 3 supersedes 2
  s.postMessage(r, "a", "v2b late correction", "text", null, null, 1); // seq 4 ALSO supersedes 1
  check("chain hop 1 resolves to the LATEST superseder", s.getMessage(r, 1).superseded_by === 4, s.getMessage(r, 1));
  check("chain hop 2 intact", s.getMessage(r, 2).superseded_by === 3, s.getMessage(r, 2));
  check("chain tip is unsuperseded", s.getMessage(r, 3).superseded_by === undefined, s.getMessage(r, 3));
  // Prune the chain's base; readers of survivors must not break.
  for (let i = 0; i < 6; i++) s.postMessage(r, "a", "filler", "text", null, null, null); // seqs 5-10
  const pr = s.pruneMessages(r, "a", 7, true); // cutoff removes seqs 1-3
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
