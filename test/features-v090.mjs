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
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    env: {
      ...process.env,
      AGENT_CHAT_DB: DB,
      AGENT_CHAT_MAX_WAIT_SECONDS: "25",
    },
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

  // Cross-room rows must remain expandable in their SOURCE room. Sequences
  // are per-room, so silently falling back to the active room can return a
  // real but unrelated message with the same seq.
  const pageA = s.createRoom("page-active", null, null).id;
  const pageB = s.createRoom("page-source", null, null).id;
  s.joinRoom(pageA, "peer");
  s.joinRoom(pageB, "peer");
  await call("join_room", { room: "page-source" });
  await call("join_room", { room: "page-active" });
  s.postMessage(pageA, "peer", "WRONG active-room body", "text", null, null);
  s.postMessage(pageB, "peer", "B".repeat(500), "text", null, null);
  const cut = await call("catch_up", { room: "page-source", preview_chars: 10 });
  check(
    "B1 cross-room catch_up returns a truncated source-room row",
    cut.data.room_id === pageB && cut.data.messages[0]?.truncated === true &&
      cut.data.messages[0]?.content === "B".repeat(10),
    cut.data,
  );
  const activeMsg = await call("get_message", { seq: 1 });
  const sourceMsg = await call("get_message", { room: "page-source", seq: 1 });
  check(
    "B1 get_message(room) expands the source row, not same-seq active content",
    activeMsg.data.content === "WRONG active-room body" &&
      sourceMsg.data.content === "B".repeat(500),
    { active: activeMsg.data.content, source: sourceMsg.data.content?.slice(0, 20) },
  );
  const sourceThread = await call("get_thread", { room: String(pageB), seq: 1 });
  check(
    "B1 get_thread(room) expands the source room without switching active",
    sourceThread.data.message?.content === "B".repeat(500) &&
      (await call("whoami", {})).data.room_id === pageA,
    sourceThread.data,
  );

  // The MCP handler's routing fields are part of max_bytes too. A dense row
  // that makes the store spend almost the full budget must be shrunk enough
  // that adding agent_id/room_id/room_name cannot push the wire result over.
  const budgetRoom = s.createRoom("budget-room", null, null).id;
  s.upsertAgent("noisy", "\u0001".repeat(100), "\u0002".repeat(200), null);
  s.joinRoom(budgetRoom, "noisy");
  await call("join_room", { room: "budget-room" });
  s.postMessage(budgetRoom, "noisy", "\u0003".repeat(5000), "text", null, null);
  const bounded = await call("catch_up", { max_bytes: 1000 });
  check(
    "B1 complete advancing catch_up response honors max_bytes",
    !bounded.isError && bounded.data.advanced === true &&
      bounded.data.messages.length === 1 && JSON.stringify(bounded.data).length <= 1000,
    { size: JSON.stringify(bounded.data).length, data: bounded.data },
  );

  // If the fixed routing metadata itself leaves less than one safe stub, the
  // handler must reject BEFORE entering the advancing store transaction.
  const denseRoomName = "meta-" + "\u0001".repeat(190);
  const denseRoom = s.createRoom(denseRoomName, null, null).id;
  s.joinRoom(denseRoom, "peer");
  await call("join_room", { room: denseRoomName });
  s.postMessage(denseRoom, "peer", "recoverable", "text", null, null);
  const tooSmall = await call("catch_up", { max_bytes: 1000 });
  check(
    "B1 an impossible metadata budget fails before marker advance",
    tooSmall.isError === true && /too small/.test(tooSmall.data.error) &&
      s.getMembership(denseRoom, "u").last_read_seq === 0,
    { result: tooSmall.data, membership: s.getMembership(denseRoom, "u") },
  );
  const retried = await call("catch_up", { max_bytes: 3000 });
  check(
    "B1 larger-budget retry recovers the unadvanced message",
    !retried.isError && retried.data.messages[0]?.content === "recoverable" &&
      JSON.stringify(retried.data).length <= 3000,
    { size: JSON.stringify(retried.data).length, data: retried.data },
  );

  // Restore the original active room for the delivery-status checks below.
  await call("join_room", { room: "active-room" });

  // B2: delivery warnings. ghost = never joined; leaver = joined then left;
  // stale = idle with older backlog; idle-caught-up = idle but current before
  // this send; peer = active. Only factual pre-existing lag warrants idle text.
  s.upsertAgent("leaver", null, null, null);
  s.joinRoom(rA, "leaver");
  // Model the leave/wait race: a lease may outlive membership presence. A
  // definitive left warning must win over stale watching:true state.
  s.beginWaitLease(rA, "leaver", "STALE-LEAVER-WAIT", 30);
  s.leaveRoom(rA, "leaver");
  s.upsertAgent("stale", null, null, null);
  s.joinRoom(rA, "stale");
  s.markRead(rA, "stale");
  s.upsertAgent("watcher", null, null, null);
  s.joinRoom(rA, "watcher");
  s.markRead(rA, "watcher");
  s.postMessage(rA, "peer", "older backlog", "text", null, null);
  s.upsertAgent("idle-caught-up", null, null, null);
  s.joinRoom(rA, "idle-caught-up");
  s.markRead(rA, "idle-caught-up");
  {
    const raw = new Database(DB);
    raw.prepare(
      "UPDATE memberships SET last_seen = datetime('now','-2 hours') WHERE agent_id IN ('stale','watcher','idle-caught-up')",
    ).run();
    raw.close();
  }
  s.beginWaitLease(rA, "watcher", "OPEN-WAIT", 30);
  s.touch(rA, "peer");
  const post = await call("post_message", {
    content: "fanout",
    to: ["ghost", "leaver", "stale", "idle-caught-up", "watcher", "peer"],
  });
  const w = post.data.delivery_warnings ?? [];
  check(
    "B2 warnings for ghost (unknown), leaver (left), stale (idle)",
    w.length === 3 &&
      w.some((x) => x.startsWith("ghost:") && /never joined/.test(x)) &&
      w.some((x) => x.startsWith("leaver:") && /left/.test(x)) &&
      w.some((x) =>
        x.startsWith("stale:") &&
        /no observed activity in this room for 2h/.test(x) &&
        /marker was 1 seq behind before this post/.test(x),
      ) &&
      !w.some((x) => /likely unreachable/.test(x)),
    w,
  );
  check(
    "B2 no warning for active or watching recipients",
      !w.some((x) => x.startsWith("peer:")) &&
      !w.some((x) => x.startsWith("watcher:")) &&
      !w.some((x) => x.startsWith("idle-caught-up:")),
    w,
  );
  check(
    "B2 post-transaction recipient rows include the new unread message",
    post.data.recipients.every((r) => "marker_behind" in r) &&
      post.data.recipients.find((r) => r.id === "ghost").marker_behind === null &&
      post.data.recipients.find((r) => r.id === "leaver").status === "left" &&
      post.data.recipients.find((r) => r.id === "leaver").watching === true &&
      post.data.recipients.find((r) => r.id === "stale").marker_behind === 2 &&
      post.data.recipients.find((r) => r.id === "idle-caught-up").marker_behind === 1 &&
      post.data.recipients.find((r) => r.id === "watcher").marker_behind === 2 &&
      post.data.recipients.find((r) => r.id === "watcher").watching === true &&
      post.data.recipients.find((r) => r.id === "watcher").status === "active",
    post.data.recipients,
  );
  s.endWaitLease(rA, "leaver", "STALE-LEAVER-WAIT");
  s.endWaitLease(rA, "watcher", "OPEN-WAIT");
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
      info.data.limits?.message_body_max_bytes === 10_000_000 &&
      info.data.limits?.bulk_read_default_budget_chars === 100_000 &&
      info.data.limits?.wait_seconds_max === 25 &&
      info.data.limits?.wait_seconds_default_max === 25 &&
      info.data.limits?.wait_seconds_configurable_hard_max === 120 &&
      info.data.limits?.crossed_preview_chars_max === 2000 &&
      info.data.limits?.client_message_id_max_chars === 200 &&
      info.data.limits?.metadata_caps_chars?.claim_key === 500 &&
      typeof info.data.manual === "string" &&
      info.data.manual.includes("OPERATING MANUAL") &&
      info.data.manual.includes("--session"),
    info.data.limits,
  );
  const wfm = await call("wait_for_messages", { timeout: 90, interval: 5 });
  check(
    "B3 wait_for_messages threads timeout/interval into the command",
    wfm.data.command.includes("--timeout '90'") &&
      wfm.data.command.includes("--interval '5'") &&
      wfm.data.command.includes("--ok-on-timeout"),
    wfm.data.command,
  );
  const wfmDefault = await call("wait_for_messages", {});
  check(
    "B3 omitted valued knobs keep defaults; generated timeout is benign",
    !/--timeout(?:=|\s)/.test(wfmDefault.data.command) &&
      !wfmDefault.data.command.includes("--interval") &&
      wfmDefault.data.command.includes("--ok-on-timeout") &&
      wfmDefault.data.command.includes("poller.js") &&
      wfmDefault.data.single_process === true,
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

  // --mentions-only must name only rooms that actually contributed a
  // directed wake, not every room with unrelated broadcast traffic.
  {
    const extra = new ChatStore(DB);
    const broadcast = extra.createRoom("broadcast-only", null, null).id;
    extra.upsertAgent("c", null, null, null);
    extra.joinRoom(broadcast, "a");
    extra.joinRoom(broadcast, "b");
    extra.joinRoom(broadcast, "c");
    extra.postMessage(broadcast, "b", "not directed", "text", null, null);
    extra.close();
  }
  const mentionHit = spawnSync(
    "node",
    [CHECK, "--agent", "a", "--mentions-only"],
    { env, encoding: "utf8" },
  );
  const mentionJson = mentionHit.status === 0 ? JSON.parse(mentionHit.stdout) : null;
  check(
    "C1 mentions-only summary omits broadcast-only rooms",
    mentionHit.status === 0 && mentionJson.rooms_with_updates?.length === 1 &&
      mentionJson.rooms_with_updates[0].room_id === r1 &&
      mentionJson.rooms_with_updates[0].directed === 1,
    { status: mentionHit.status, out: mentionHit.stdout, err: mentionHit.stderr },
  );

  const leanQuiet = spawnSync(
    "node",
    [CHECK, "--wake-only", "--agent", "c", "--mentions-only"],
    { env, encoding: "utf8" },
  );
  const leanJson = leanQuiet.status === 1 ? JSON.parse(leanQuiet.stdout) : null;
  check(
    "C1 poller quiet path skips repeated exact broadcast-backlog counts",
    leanQuiet.status === 1 && leanJson?.has_updates === false &&
      leanJson?.unread_count_skipped === true &&
      !("unread" in leanJson),
    { status: leanQuiet.status, out: leanQuiet.stdout, err: leanQuiet.stderr },
  );
  const scopedLean = spawnSync(
    "node",
    [
      CHECK,
      "--wake-only",
      "--room",
      "broadcast-only",
      "--agent",
      "c",
      "--mentions-only",
    ],
    { env, encoding: "utf8" },
  );
  const scopedLeanJson =
    scopedLean.status === 1 ? JSON.parse(scopedLean.stdout) : null;
  check(
    "C1 scoped mentions-only quiet path skips the broadcast count too",
    scopedLean.status === 1 && scopedLeanJson?.has_updates === false &&
      scopedLeanJson?.unread_count_skipped === true,
    { status: scopedLean.status, out: scopedLean.stdout, err: scopedLean.stderr },
  );

  // Count Node launches during a bounded quiet watch. The compatibility shell
  // must exec exactly one persistent watcher, not spawn one probe per tick.
  const countFile = join(dir, "probe-count");
  const nodeWrapper = join(dir, "counting-node.sh");
  writeFileSync(countFile, "");
  writeFileSync(
    nodeWrapper,
    '#!/bin/sh\nprintf "x\\n" >> "$COUNT_FILE"\nexec "$REAL_NODE" "$@"\n',
  );
  chmodSync(nodeWrapper, 0o700);
  const pollStarted = Date.now();
  const boundedPoll = spawnSync(
    "bash",
    [
      join(ROOT, "scripts", "wait-for-updates.sh"),
      "--node",
      nodeWrapper,
      "--agent",
      "c",
      "--mentions-only",
      "--interval",
      "5",
      "--timeout",
      "1",
      "--ok-on-timeout",
    ],
    {
      env: { ...env, COUNT_FILE: countFile, REAL_NODE: process.execPath },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const pollElapsed = Date.now() - pollStarted;
  const probeLog = readFileSync(countFile, "utf8").trim();
  const probeCount = probeLog === "" ? 0 : probeLog.split("\n").length;
  let boundedJson = null;
  try {
    boundedJson = JSON.parse(boundedPoll.stdout.trim());
  } catch {}
  check(
    "C1 benign quiet timeout uses one Node process and exits 0 with typed stdout",
    boundedPoll.status === 0 && probeCount === 1 &&
      boundedJson?.has_updates === false && boundedJson?.timed_out === true &&
      boundedPoll.stderr === "" &&
      pollElapsed >= 1000 && pollElapsed < 6000,
    {
      status: boundedPoll.status,
      probes: probeCount,
      elapsed: pollElapsed,
      out: boundedPoll.stdout,
      err: boundedPoll.stderr,
      parsed: boundedJson,
    },
  );

  // The room summary is capped for a small status line, but callers route
  // catch_up calls from it; disclose when additional firing rooms were cut.
  {
    const extra = new ChatStore(DB);
    for (let i = 0; i < 21; i++) {
      const room = extra.createRoom(`wake-${i}`, null, null).id;
      extra.joinRoom(room, "a");
      extra.joinRoom(room, "b");
      extra.postMessage(room, "b", "directed", "text", ["a"], null);
    }
    extra.close();
  }
  const manyHit = spawnSync("node", [CHECK, "--agent", "a"], {
    env,
    encoding: "utf8",
  });
  const manyJson = manyHit.status === 0 ? JSON.parse(manyHit.stdout) : null;
  check(
    "C1 >20 firing rooms set rooms_with_updates_truncated",
    manyHit.status === 0 && manyJson.rooms_with_updates?.length === 20 &&
      manyJson.rooms_with_updates_truncated === true,
    { status: manyHit.status, out: manyHit.stdout, err: manyHit.stderr },
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

  // The summary shares catch_up's hard response budget. Legal control-heavy
  // room names escape to ~6x their in-memory length; the v0.9 implementation
  // appended up to twenty of them after spending the entire message budget.
  for (let i = 0; i < 20; i++) {
    const name = `dense-${String(i).padStart(2, "0")}-` + "\u0001".repeat(190);
    const room = s.createRoom(name, null, null).id;
    s.joinRoom(room, "a");
    s.joinRoom(room, "b");
    s.postMessage(room, "b", "unread", "text", null, null);
  }
  const boundedSummary = s.catchUp(home, "a", 50, undefined, 1000, null, {
    sessionId: null,
  });
  check(
    "D1 rooms_with_unread shares the complete catch_up byte budget",
    JSON.stringify(boundedSummary).length <= 1000 &&
      boundedSummary.rooms_with_unread.length > 0 &&
      boundedSummary.rooms_with_unread_truncated === true,
    { size: JSON.stringify(boundedSummary).length, summary: boundedSummary },
  );
  s.close();
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall features-v090 checks passed");
