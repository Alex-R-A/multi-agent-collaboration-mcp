// Regression tests for the v0.8.3 review fixes:
//  #1 touchSessionAlive refreshes presence for the CURRENT identity only, so
//     an identity a session switched away from ages out via the 7-day GC and
//     reads as left, instead of showing `present` for the life of the process.
//     (Cursor rows stay nonce-wide: switching back must resume the private
//     read position, so the marker row must survive the identity switch.)
//  (#2 web presence rows and the web search more-probe are covered in
//   test/web-participate.mjs, which boots the viewer server.)
import { ChatStore } from "../dist/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- #1: abandoned identity's presence ages out; current identity survives ---
{
  const dir = mkdtempSync(join(tmpdir(), "v083-touch-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r = s.createRoom("room", null, null).id;
  for (const id of ["x", "y", "z"]) s.upsertAgent(id, null, null, null);
  // One process (nonce N) joins as x, then switches identity to y.
  s.joinRoom(r, "x", null, "N");
  s.joinRoom(r, "y", null, "N");
  // Backdate both presence rows past the GC window, as if the process had
  // been idle for 8 days; then the live session touches under its CURRENT
  // identity (y), as every tool call does.
  const raw = new Database(DB);
  raw
    .prepare(
      "UPDATE session_presence SET updated_at = datetime('now','-8 days') WHERE session_id = 'N'",
    )
    .run();
  raw.close();
  s.touchSessionAlive("N", "y");
  s.joinRoom(r, "z", null, "Z"); // runs the presence GC + recompute
  const mx = s.getMembership(r, "x");
  const my = s.getMembership(r, "y");
  check(
    "#1 switched-away identity is marked left by the GC",
    mx !== undefined && mx.left_at !== null,
    mx,
  );
  check(
    "#1 current identity's presence survives the touch + GC",
    my !== undefined && my.left_at === null,
    my,
  );
  // The abandoned identity's read position is intact for a later rejoin.
  check(
    "#1 abandoned identity keeps its read marker for resume",
    s.getMembership(r, "x").last_read_seq === 0,
    s.getMembership(r, "x"),
  );
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
