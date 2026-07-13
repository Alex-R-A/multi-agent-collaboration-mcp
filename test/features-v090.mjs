// Phase 1 receive-path tests (v0.9.0):
//  A1 catch_up({room}) reads a named joined room WITHOUT switching the active
//     room, honoring that room's own private session cursor
//  A2 rooms_with_unread on an empty catch_up: session-aware, own-posts
//     excluded, excludes the room just read, directed-first ordering,
//     truncation flag, [] when nowhere has traffic
//  A3 recipientStatus marker_behind (0 when caught up, null for unknown)
//  A4 pendingDirected: rows per (agent, room), cleared by reading, left
//     members excluded, truncation
//  B1 MCP: identity fields on every catch_up response; named-room read keeps
//     the active room; never-joined room fails with the join remedy
//  B2 MCP: delivery_warnings for unknown/left/stale-idle recipients, absent
//     for active ones; recipients carry marker_behind
//  B3 MCP: pending_work tool; server_info limits + manual; wait_for_messages
//     threads timeout/interval into the command
//  C1 check.js: rooms_with_updates on exit 0 (all-rooms), absent on quiet
//     exit 1; --help exits 0 (script and probe)
//  D1 adversarial: quote/astral room names round-trip through
//     rooms_with_unread; reply-directedness counts in `directed`
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

// --- A1/A2: store-level cross-room summary and private-cursor awareness ------
{
  const s = new ChatStore(":memory:");
  const r1 = s.createRoom("alpha", null, null).id;
  const r2 = s.createRoom("beta", null, null).id;
  const r3 = s.createRoom("gamma", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r1, "a");
  s.joinRoom(r2, "a", "S", "S"); // private session S in beta
  s.joinRoom(r3, "a");
  s.joinRoom(r1, "b");
  s.joinRoom(r2, "b");
  s.joinRoom(r3, "b");
  s.postMessage(r2, "b", "beta broadcast", "text", null, null);
  s.postMessage(r2, "b", "beta directed", "text", ["a"], null);
  s.postMessage(r3, "b", "gamma broadcast", "text", null, null);

  // Empty read of alpha with a summary: beta (1 directed) sorts before gamma.
  const empty = s.catchUp(r1, "a", 50, undefined, undefined, null, {
    sessionId: "S",
  });
  check("A2 empty read carries rooms_with_unread", Array.isArray(empty.rooms_with_unread), empty);
  check(
    "A2 summary lists beta first (directed DESC), then gamma",
    empty.rooms_with_unread?.length === 2 &&
      empty.rooms_with_unread[0].room_id === r2 &&
      empty.rooms_with_unread[0].unread === 2 &&
      empty.rooms_with_unread[0].directed === 1 &&
      empty.rooms_with_unread[1].room_id === r3 &&
      empty.rooms_with_unread[1].directed === 0,
    empty.rooms_with_unread,
  );
  check(
    "A2 read room itself is excluded from the summary",
    !empty.rooms_with_unread.some((r) => r.room_id === r1),
    empty.rooms_with_unread,
  );

  // A twin (shared cursor) drains beta at the identity level; session S's
  // private cursor is still behind, so a session-aware summary keeps beta.
  s.catchUp(r2, "a", 50);
  const twinView = s.catchUp(r1, "a", 50, undefined, undefined, null, {
    sessionId: "S",
  });
  check(
    "A2 session-aware summary still shows beta for the lagging private session",
    twinView.rooms_with_unread.some((r) => r.room_id === r2 && r.unread === 2),
    twinView.rooms_with_unread,
  );
  const idView = s.catchUp(r1, "a", 50, undefined, undefined, null, {
    sessionId: null,
  });
  check(
    "A2 identity-level summary shows beta drained (only gamma left)",
    idView.rooms_with_unread.length === 1 && idView.rooms_with_unread[0].room_id === r3,
    idView.rooms_with_unread,
  );

  // A1: the named-room read honors the private selector.
  const priv = s.catchUp(r2, "a", 50, undefined, undefined, "S");
  check(
    "A1 private-cursor read of beta still returns both messages",
    priv.messages.length === 2 && priv.advanced === true,
    priv,
  );

  // Non-empty read: no summary field at all.
  s.postMessage(r1, "b", "alpha msg", "text", null, null);
  const nonEmpty = s.catchUp(r1, "a", 50, undefined, undefined, null, {
    sessionId: null,
  });
  check(
    "A2 non-empty read omits rooms_with_unread",
    nonEmpty.messages.length === 1 && nonEmpty.rooms_with_unread === undefined,
    nonEmpty,
  );

  // Nowhere has traffic: an explicit empty array, not an omission.
  s.catchUp(r3, "a", 50);
  const quiet = s.catchUp(r1, "a", 50, undefined, undefined, null, {
    sessionId: null,
  });
  check(
    "A2 quiet-everywhere empty read reports rooms_with_unread: []",
    Array.isArray(quiet.rooms_with_unread) && quiet.rooms_with_unread.length === 0,
    quiet,
  );

  // No summary requested (legacy shape): field absent even on an empty read.
  const legacy = s.catchUp(r1, "a", 50);
  check(
    "A2 summary is opt-in (absent without unreadSummary)",
    legacy.rooms_with_unread === undefined,
    legacy,
  );
  s.close();
}

// --- A2b: truncation flag on the summary --------------------------------------
{
  const s = new ChatStore(":memory:");
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  const home = s.createRoom("home", null, null).id;
  s.joinRoom(home, "a");
  // 21 other rooms with unread; the summary caps at 20.
  for (let i = 0; i < 21; i++) {
    const r = s.createRoom(`spill-${i}`, null, null).id;
    s.joinRoom(r, "a");
    s.joinRoom(r, "b");
    s.postMessage(r, "b", "x", "text", null, null);
  }
  const res = s.catchUp(home, "a", 50, undefined, undefined, null, {
    sessionId: null,
  });
  check(
    "A2b summary truncates at 20 rooms with the flag set",
    res.rooms_with_unread.length === 20 && res.rooms_with_unread_truncated === true,
    { n: res.rooms_with_unread.length, flag: res.rooms_with_unread_truncated },
  );
  s.close();
}

// --- A3: marker_behind ---------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r = s.createRoom("room", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r, "a");
  s.joinRoom(r, "b");
  for (let i = 0; i < 3; i++) s.postMessage(r, "a", "m" + i, "text", null, null);
  let st = s.recipientStatus(r, ["b", "ghost"], 5);
  check(
    "A3 marker_behind counts unswept messages; null for unknown",
    st[0].marker_behind === 3 && st[1].marker_behind === null,
    st,
  );
  s.catchUp(r, "b", 50);
  st = s.recipientStatus(r, ["b"], 5);
  check("A3 marker_behind is 0 once caught up", st[0].marker_behind === 0, st);
  s.close();
}

// --- A4: pendingDirected --------------------------------------------------------
{
  const s = new ChatStore(":memory:");
  const r1 = s.createRoom("lane-one", null, null).id;
  const r2 = s.createRoom("lane-two", null, null).id;
  s.upsertAgent("boss", null, null, null);
  s.upsertAgent("w1", null, null, null);
  s.upsertAgent("w2", null, null, null);
  s.joinRoom(r1, "boss");
  s.joinRoom(r1, "w1");
  s.joinRoom(r2, "boss");
  s.joinRoom(r2, "w2");
  const first = s.postMessage(r1, "boss", "task for w1", "text", ["w1"], null);
  s.postMessage(r2, "boss", "task for w2", "text", ["w2"], null);
  // A reply to w1's message is directed at w1 without a mention.
  s.postMessage(r1, "w1", "w1 speaks", "text", null, null);
  const w1msg = s.catchUp(r1, "boss", 50); // boss reads so boss has no pending
  // catch_up excludes boss's own post, so w1's message is the only row.
  s.postMessage(r1, "boss", "re: w1", "text", null, w1msg.messages[0].seq);

  let view = s.pendingDirected(50);
  check(
    "A4 one row per (agent, room); replies count as directed",
    view.pending.length === 2 &&
      view.pending.some(
        (p) => p.agent_id === "w1" && p.room_id === r1 && p.directed_unread === 2,
      ) &&
      view.pending.some(
        (p) => p.agent_id === "w2" && p.room_id === r2 && p.directed_unread === 1,
      ),
    view.pending,
  );
  const w1row = view.pending.find((p) => p.agent_id === "w1");
  check(
    "A4 oldest_seq points at the earliest pending directed message",
    w1row.oldest_seq === first.seq,
    w1row,
  );
  check("A4 truncation flag with limit 1", s.pendingDirected(1).truncated === true, null);

  s.catchUp(r1, "w1", 50);
  view = s.pendingDirected(50);
  check(
    "A4 reading clears the row",
    view.pending.length === 1 && view.pending[0].agent_id === "w2",
    view.pending,
  );
  s.leaveRoom(r2, "w2");
  view = s.pendingDirected(50);
  check("A4 left members are excluded", view.pending.length === 0, view.pending);
  s.close();
}

// --- B: MCP-level (one server, temp DB, direct store handle alongside) ---------
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v090-mcp-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const wait = (id) => new Promise((res) => { const t = setInterval(() => { if (R.has(id)) { clearInterval(t); res(R.get(id)); } }, 15); });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  const call = async (name, args) => {
    const i = ++id;
    send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    const m = await wait(i);
    const body = m.result?.content?.[0]?.text;
    return { isError: m.result?.isError === true, data: body ? JSON.parse(body) : null };
  };

  // Rooms and a second agent driven through a DIRECT store handle on the
  // same file (cross-process WAL is the deployment reality).
  const s = new ChatStore(DB);
  const rA = s.createRoom("active-room", null, null).id;
  const rB = s.createRoom("other-room", null, null).id;
  s.upsertAgent("peer", null, null, null);
  s.joinRoom(rA, "peer");
  s.joinRoom(rB, "peer");

  await call("join_room", { room: "other-room", agent_id: "u" });
  await call("join_room", { room: "active-room", agent_id: "u" }); // active = A
  s.postMessage(rB, "peer", "hello in B", "text", ["u"], null);

  // B1: empty active-room read names itself and discloses room B.
  const empty = await call("catch_up", {});
  check(
    "B1 catch_up carries agent_id/room_id/room_name",
    empty.data.agent_id === "u" && empty.data.room_id === rA && empty.data.room_name === "active-room",
    empty.data,
  );
  check(
    "B1 empty active read discloses other-room's unread",
    empty.data.rooms_with_unread?.length === 1 &&
      empty.data.rooms_with_unread[0].room_id === rB &&
      empty.data.rooms_with_unread[0].directed === 1,
    empty.data,
  );

  // B1: named-room read returns B's message and does NOT switch the active room.
  const cross = await call("catch_up", { room: "other-room" });
  check(
    "B1 catch_up({room}) reads the named room",
    !cross.isError && cross.data.room_id === rB && cross.data.messages.length === 1 &&
      cross.data.messages[0].content === "hello in B",
    cross.data,
  );
  const who = await call("whoami", {});
  check(
    "B1 active room is unchanged after the named-room read",
    who.data.room_id === rA && who.data.room_name === "active-room",
    who.data,
  );
  const never = await call("catch_up", { room: "does-not-exist" });
  check("B1 unknown room fails cleanly", never.isError === true, never.data);
  s.upsertAgent("u", null, null, null); // ensure exists for the next check
  const unjoined = s.createRoom("unjoined-room", null, null).id;
  const nomember = await call("catch_up", { room: "unjoined-room" });
  check(
    "B1 never-joined room fails with the join remedy",
    nomember.isError === true && /join_room/.test(nomember.data.error),
    nomember.data,
  );
  void unjoined;

  // B2: delivery warnings. ghost = never joined; leaver = joined then left;
  // stale = present but idle 2h; peer = active.
  s.upsertAgent("leaver", null, null, null);
  s.joinRoom(rA, "leaver");
  s.leaveRoom(rA, "leaver");
  s.upsertAgent("stale", null, null, null);
  s.joinRoom(rA, "stale");
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE agent_id = 'stale'",
    ).run();
    raw.close();
  }
  s.touch(rA, "peer");
  const post = await call("post_message", {
    content: "fanout",
    to: ["ghost", "leaver", "stale", "peer"],
  });
  const w = post.data.delivery_warnings ?? [];
  check(
    "B2 warnings for ghost (unknown), leaver (left), stale (idle)",
    w.length === 3 &&
      w.some((x) => x.startsWith("ghost:") && /never joined/.test(x)) &&
      w.some((x) => x.startsWith("leaver:") && /left/.test(x)) &&
      w.some((x) => x.startsWith("stale:") && /idle 2h/.test(x) && /marker \d+ behind/.test(x)),
    w,
  );
  check(
    "B2 no warning for the active recipient",
    !w.some((x) => x.startsWith("peer:")),
    w,
  );
  check(
    "B2 recipients rows carry marker_behind",
    post.data.recipients.every((r) => "marker_behind" in r) &&
      post.data.recipients.find((r) => r.id === "ghost").marker_behind === null,
    post.data.recipients,
  );
  const clean = await call("post_message", { content: "to peer", to: ["peer"] });
  check(
    "B2 all-active post omits delivery_warnings",
    clean.data.delivery_warnings === undefined,
    clean.data,
  );

  // B3: pending_work tool, server_info limits/manual, poller knob threading.
  const pending = await call("pending_work", {});
  check(
    "B3 pending_work lists directed unread per agent+room",
    !pending.isError && Array.isArray(pending.data.pending) &&
      pending.data.pending.some((p) => p.agent_id === "ghost") === false &&
      pending.data.pending.some((p) => p.agent_id === "stale" && p.room_id === rA),
    pending.data,
  );
  const info = await call("server_info", {});
  check(
    "B3 server_info publishes limits and the manual",
    info.data.limits?.message_body_max_bytes === 1_000_000_000 &&
      info.data.limits?.bulk_read_default_budget_chars === 100_000 &&
      info.data.limits?.metadata_caps_chars?.claim_key === 500 &&
      typeof info.data.manual === "string" &&
      info.data.manual.includes("OPERATING MANUAL") &&
      info.data.manual.includes("--session"),
    info.data.limits,
  );
  const wfm = await call("wait_for_messages", { timeout: 90, interval: 2 });
  check(
    "B3 wait_for_messages threads timeout/interval into the command",
    wfm.data.command.includes("--timeout '90'") && wfm.data.command.includes("--interval '2'"),
    wfm.data.command,
  );
  const wfmDefault = await call("wait_for_messages", {});
  check(
    "B3 omitted knobs emit no flags (script defaults govern)",
    !wfmDefault.data.command.includes("--timeout") && !wfmDefault.data.command.includes("--interval"),
    wfmDefault.data.command,
  );

  s.close();
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

// --- C1: probe summary + --help -----------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "v090-check-"));
  const DB = join(dir, "t.db");
  const s = new ChatStore(DB);
  const r1 = s.createRoom("noisy", null, null).id;
  const r2 = s.createRoom("quiet", null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(r1, "a");
  s.joinRoom(r2, "a");
  s.joinRoom(r1, "b");
  s.postMessage(r1, "b", "wake up", "text", ["a"], null);
  s.close();
  const CHECK = join(ROOT, "dist", "check.js");
  const env = { ...process.env, AGENT_CHAT_DB: DB };
  const hit = spawnSync("node", [CHECK, "--agent", "a"], { env, encoding: "utf8" });
  const hitJson = hit.status === 0 ? JSON.parse(hit.stdout) : null;
  check(
    "C1 exit-0 all-rooms probe names the firing room",
    hit.status === 0 &&
      hitJson.rooms_with_updates?.length === 1 &&
      hitJson.rooms_with_updates[0].room_id === r1 &&
      hitJson.rooms_with_updates[0].name === "noisy" &&
      hitJson.rooms_with_updates[0].unread === 1 &&
      hitJson.rooms_with_updates[0].directed === 1,
    { status: hit.status, out: hit.stdout, err: hit.stderr },
  );
  const quiet = spawnSync("node", [CHECK, "--agent", "b"], { env, encoding: "utf8" });
  const quietJson = quiet.status === 1 ? JSON.parse(quiet.stdout) : null;
  check(
    "C1 quiet probe (exit 1) omits rooms_with_updates",
    quiet.status === 1 && quietJson && !("rooms_with_updates" in quietJson),
    { status: quiet.status, out: quiet.stdout },
  );
  const help = spawnSync("node", [CHECK, "--help"], { env, encoding: "utf8" });
  check(
    "C1 check.js --help exits 0 with usage",
    help.status === 0 && /Usage:/.test(help.stdout),
    { status: help.status, out: help.stdout.slice(0, 120) },
  );
  const shHelp = spawnSync("bash", [join(ROOT, "scripts", "wait-for-updates.sh"), "--help"], {
    env,
    encoding: "utf8",
  });
  check(
    "C1 wait-for-updates.sh --help exits 0 with usage",
    shHelp.status === 0 && /Usage:/.test(shHelp.stdout),
    { status: shHelp.status, out: shHelp.stdout.slice(0, 120), err: shHelp.stderr },
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- D1: adversarial names and directedness ------------------------------------
{
  const s = new ChatStore(":memory:");
  const weird = "r\u{1F989}oom-'quote\"-é"; // astral + quotes + accent
  const home = s.createRoom("plain-home", null, null).id;
  const w = s.createRoom(weird, null, null).id;
  s.upsertAgent("a", null, null, null);
  s.upsertAgent("b", null, null, null);
  s.joinRoom(home, "a");
  s.joinRoom(w, "a");
  s.joinRoom(w, "b");
  // Directed via a reply chain, no mention: a posts, b replies to it.
  const mine = s.postMessage(w, "a", "root", "text", null, null);
  s.postMessage(w, "b", "reply", "text", null, mine.seq);
  const res = s.catchUp(home, "a", 50, undefined, undefined, null, {
    sessionId: null,
  });
  const entry = res.rooms_with_unread.find((r) => r.room_id === w);
  check(
    "D1 adversarial room name round-trips exactly; reply counts as directed",
    entry !== undefined && entry.name === weird && entry.unread === 1 && entry.directed === 1,
    res.rooms_with_unread,
  );
  const json = JSON.stringify(res);
  check("D1 summary serializes to valid JSON", JSON.parse(json) !== null, null);
  s.close();
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall features-v090 checks passed");
