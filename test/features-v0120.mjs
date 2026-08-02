// Priority backlog triage tests (v0.12.0).
// Ordinary catch_up remains lossless. priority_only:true deliberately returns
// priority posts plus every directed post, reports what it skipped, and drains
// trailing low-priority chatter only after every qualifying row was delivered.
import { ChatStore } from "../dist/db.js";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("features-v0120.mjs", async () => {
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, condition, detail) => {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
};

function setup(name = "priority-room") {
  const s = new ChatStore(":memory:");
  const room = mkRoom(s, name, null, null).id;
  mkAgent(s, "me");
  for (const id of ["me", "peer"]) {
    mkAgent(s, id);
    s.joinRoom(room, id, {});
  }
  return { s, room };
}

// E1: cursor normalization makes own-only suffixes finite work for the poller.
// It may cross own rows (which catch_up never returns), but never the next peer.
{
  const { s, room } = setup("cursor-normalization");
  const own1 = s.postMessage(room, "me", "own-1", "text", null, null, null);
  check(
    "E1 an own-only post becomes the durable shared baseline",
    own1.seq === 1 && s.getMembership(room, "me").last_read_seq === 1 &&
      s.unreadProbe(room, "me") === 0,
    s.getMembership(room, "me"),
  );
  s.markRead(room, "me", 0);
  const repaired = s.catchUp(room, "me", 50, undefined, 100000);
  check(
    "E1 an empty historical own tail is repaired once",
    repaired.messages.length === 0 && repaired.advanced === true &&
      repaired.new_last_read_seq === 1 &&
      s.getMembership(room, "me").last_read_seq === 1,
    repaired,
  );

  s.postMessage(room, "peer", "peer-1", "text", null, null, null); // seq 2
  const blind = s.postMessage(room, "me", "own-2", "text", null, null, null); // seq 3
  check(
    "E1 posting never normalizes across an unseen peer",
    blind.crossed === 1 && s.getMembership(room, "me").last_read_seq === 1,
    { blind, marker: s.getMembership(room, "me") },
  );
  const caught = s.catchUp(room, "me", 50, undefined, 100000);
  check(
    "E1 catch_up delivers the peer then absorbs its trailing own suffix",
    caught.messages.map((m) => m.seq).join(",") === "2" &&
      caught.new_last_read_seq === 3 && caught.remaining === 0,
    caught,
  );

  s.postMessage(room, "peer", "peer-2", "text", null, null, null); // seq 4
  s.postMessage(room, "me", "own-3", "text", null, null, null); // seq 5
  s.postMessage(room, "peer", "peer-3", "text", null, null, null); // seq 6
  const one = s.catchUp(room, "me", 1, undefined, 100000);
  check(
    "E1 a limited page crosses own rows but stops before the next peer",
    one.messages[0]?.seq === 4 && one.new_last_read_seq === 5 &&
      one.remaining === 1 && s.getMembership(room, "me").last_read_seq === 5,
    one,
  );
  const rest = s.catchUp(room, "me", 50, undefined, 100000);
  check(
    "E1 the peer beyond the own suffix remains deliverable",
    rest.messages.map((m) => m.seq).join(",") === "6" && rest.remaining === 0,
    rest,
  );
  s.close();
}

// S1/S2: qualifying rules, disclosed loss, trailing drain, and row paging.
{
  const { s, room } = setup();
  const root = s.postMessage(room, "me", "my root", "text", null, null, null);
  s.postMessage(room, "peer", "low-1", "text", null, null, null);
  s.postMessage(room, "peer", "checkpoint", "text", null, null, null, {
    priority: true,
  });
  s.postMessage(room, "peer", "low-2", "text", null, null, null);
  s.postMessage(room, "peer", "mention", "text", ["me"], null, null);
  s.postMessage(room, "peer", "reply", "text", null, root.seq, null);
  s.postMessage(room, "peer", "low-3", "text", null, null, null);

  const page = s.catchUp(room, "me", 50, undefined, 100_000, {
    priorityOnly: true,
  });
  check(
    "S1 priority-only returns checkpoints plus mention/reply directed rows",
    page.messages.map((m) => m.content).join(",") ===
      "checkpoint,mention,reply" &&
      page.messages[0].priority === true &&
      page.messages[1].priority === undefined,
    page,
  );
  check(
    "S1 complete qualifying page drains trailing chatter with a loud cutoff",
    page.lossy === true && page.priority_only === true &&
      page.skipped_count === 3 && page.qualifying_remaining === 0 &&
      page.cutoff_seq === 7 && page.new_last_read_seq === 7 &&
      page.remaining === 0,
    page,
  );
  check(
    "S1 ordinary catch_up has no discarded backlog left",
    s.catchUp(room, "me", 50, undefined, 100000).messages.length === 0,
    null,
  );

  s.markRead(room, "me", 0);
  const first = s.catchUp(room, "me", 1, undefined, 100_000, {
    priorityOnly: true,
  });
  check(
    "S2 row limit stops at the delivered qualifier and preserves later ones",
    first.messages.length === 1 && first.messages[0].content === "checkpoint" &&
      first.cutoff_seq === 3 && first.qualifying_remaining === 2 &&
      first.remaining === 4 && first.skipped_count === 1,
    first,
  );
  const second = s.catchUp(room, "me", 2, undefined, 100_000, {
    priorityOnly: true,
  });
  check(
    "S2 final qualifying page consumes all remaining low-priority rows",
    second.messages.map((m) => m.content).join(",") === "mention,reply" &&
      second.cutoff_seq === 7 && second.qualifying_remaining === 0 &&
      second.skipped_count === 2 && second.remaining === 0,
    second,
  );
  s.close();
}

// S3: a backlog with no qualifiers is skipped in one explicit call.
{
  const { s, room } = setup("all-low");
  for (let i = 0; i < 25; i++) {
    s.postMessage(room, "peer", `noise-${i}`, "text", null, null, null);
  }
  const page = s.catchUp(room, "me", 5, undefined, 100_000, {
    priorityOnly: true,
  });
  check(
    "S3 no-qualifier backlog advances to the snapshot cutoff",
    page.messages.length === 0 && page.skipped_count === 25 &&
      page.cutoff_seq === 25 && page.remaining === 0 && page.advanced === true,
    page,
  );
  s.close();
}

// S4: a byte cut cannot advance past an unseen priority row.
{
  const { s, room } = setup("priority-byte-cut");
  for (let i = 0; i < 2; i++) {
    s.postMessage(room, "peer", String.fromCharCode(3).repeat(5000), "text", null, null, null, { priority: true });
  }
  const page = s.catchUp(room, "me", 50, undefined, 1000, {
    priorityOnly: true,
  });
  check(
    "S4 byte-bounded priority page never skips the next qualifier",
    JSON.stringify(page).length <= 1000 && page.messages.length === 1 &&
      page.qualifying_remaining === 1 && page.cutoff_seq === page.messages[0].seq &&
      page.remaining === 1,
    { size: JSON.stringify(page).length, page },
  );
  const rest = s.catchUp(room, "me", 50, 20, 100_000, {
    priorityOnly: true,
  });
  check(
    "S4 retry delivers the preserved priority row",
    rest.messages.length === 1 && rest.messages[0].seq !== page.messages[0].seq &&
      rest.qualifying_remaining === 0 && rest.remaining === 0,
    rest,
  );
  s.close();
}

// D1: direct ChatStore callers get the same bounded/progress-safe behavior as
// MCP-validated callers. These guards prevent a script from turning a lossy
// limit edge into silent advancement or an offset walk into an infinite loop.
// They are the ONLY coverage of these limits at the store boundary -- the MCP
// schemas reject the same values earlier, so removing this block leaves every
// direct-caller guard untested.
{
  const { s, room } = setup("direct-boundaries");
  s.postMessage(room, "peer", "important", "text", null, null, null, {
    priority: true,
  });
  const zeroLimit = s.catchUp(room, "me", 0, undefined, 100_000, {
    priorityOnly: true,
  });
  check(
    "D1 priority catch_up clamps a direct zero limit before advancing",
    zeroLimit.messages.length === 1 &&
      zeroLimit.messages[0].content === "important" &&
      zeroLimit.new_last_read_seq === 1,
    zeroLimit,
  );

  const emoji = s.postMessage(room, "peer", "\u{1f600}z", "text", null, null, null);
  const tinyPage = s.getMessage(room, emoji.seq, 0, 1);
  check(
    "D1 tiny get_message pages always advance across an astral codepoint",
    tinyPage?.content === "\u{1f600}" && tinyPage.next_offset === 1,
    tinyPage,
  );
  const ascii = s.postMessage(room, "peer", "ab", "text", null, null, null);
  const tinyAscii = s.getMessage(room, ascii.seq, 0, 1);
  check(
    "D1 tiny get_message still honors a one-codepoint ASCII window",
    tinyAscii?.content === "a" && tinyAscii.next_offset === 1,
    tinyAscii,
  );
  let nonfiniteReadError = "";
  try {
    s.getMessage(room, ascii.seq, 0, Number.POSITIVE_INFINITY);
  } catch (error) {
    nonfiniteReadError = String(error?.message ?? error);
  }
  check(
    "D1 direct get_message rejects a non-finite allocation bound",
    /max_chars must be finite/.test(nonfiniteReadError),
    nonfiniteReadError,
  );

  let oversizedCatchUpError = "";
  try {
    s.catchUp(room, "me", 50, undefined, 400_001);
  } catch (error) {
    oversizedCatchUpError = String(error?.message ?? error);
  }
  check(
    "D1 direct catch_up cannot exceed the MCP allocation budget",
    /to 400000/.test(oversizedCatchUpError),
    oversizedCatchUpError,
  );

  let nanCasError = "";
  try {
    s.postMessage(room, "me", "unsafe NaN decision", "text", null, null, null, {
      ifLastReadSeq: Number.NaN,
    });
  } catch (error) {
    nanCasError = String(error?.message ?? error);
  }
  check(
    "D1 a direct NaN CAS token is rejected instead of disabling the guard",
    /non-negative safe integer/.test(nanCasError) &&
      !s.readHistory(room, 50).messages.some(
        (message) => message.content === "unsafe NaN decision",
      ),
    nanCasError,
  );

  s.markRead(room, "me");
  s.postMessage(room, "peer", "x".repeat(5000), "text", null, null, null);
  const boundedCrossing = s.postMessage(
    room,
    "me",
    "response",
    "text",
    null,
    null,
    null,
    { crossedPreviewChars: 1_000_000 },
  );
  check(
    "D1 direct crossed previews respect the public cap",
    boundedCrossing.posted === true &&
      boundedCrossing.crossed_messages?.[0]?.content.length === 2000 &&
      boundedCrossing.crossed_messages[0].truncated === true,
    boundedCrossing,
  );

  const invalidClaimTtls = [-1, 0, 1.5, Number.NaN, 86_401].map((ttl) => {
    try {
      return { ttl, result: s.claimResource(room, `ttl-${ttl}`, "me", ttl, null) };
    } catch (error) {
      return { ttl, error: String(error?.message ?? error) };
    }
  });
  const minimumClaim = s.claimResource(room, "ttl-minimum", "me", 1, null);
  const maximumClaim = s.claimResource(room, "ttl-maximum", "me", 86_400, null);
  check(
    "D1 direct claim TTLs enforce the MCP integer range",
    invalidClaimTtls.every(
      ({ error }) =>
        typeof error === "string" && /integer from 1 to 86400/.test(error),
    ) &&
      minimumClaim.granted === true &&
      maximumClaim.granted === true,
    { invalidClaimTtls, minimumClaim, maximumClaim },
  );

  s.catchUp(room, "me", 50, undefined, 100_000);
  const numericBody = "9".repeat(5000);
  s.postMessage(room, "peer", numericBody, "json", null, null, null);
  const cappedJson = s.catchUp(room, "me", 50, undefined, 1000);
  const cappedNumeric = cappedJson.messages[0];
  check(
    "D1 a fetch-capped JSON body stays raw and discloses truncation",
    typeof cappedNumeric?.content === "string" &&
      cappedNumeric.content.length > 0 &&
      numericBody.startsWith(cappedNumeric.content) &&
      cappedNumeric.truncated === true &&
      cappedNumeric.length === numericBody.length &&
      JSON.stringify(cappedJson).length <= 1000,
    { cappedNumeric, size: JSON.stringify(cappedJson).length },
  );

  const capture = (call) => {
    try {
      return { value: call() };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const markerBeforeInvalid = s.getMembership(room, "me").last_read_seq;
  const invalidMarkers = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map(
    (seq) => ({
      seq,
      result: capture(() => s.markRead(room, "me", seq)),
      marker: s.getMembership(room, "me").last_read_seq,
    }),
  );
  check(
    "D1 invalid mark_read targets fail before changing the cursor",
    invalidMarkers.every(
      ({ result, marker }) =>
        /mark_read seq must be an integer/.test(result.error ?? "") &&
        marker === markerBeforeInvalid,
    ),
    { markerBeforeInvalid, invalidMarkers },
  );

  const invalidCursors = [
    capture(() => s.listRooms(10, Number.NaN)),
    capture(() => s.listRooms(10, Number.POSITIVE_INFINITY)),
    capture(() => s.listRooms(10, 0.5)),
    capture(() => s.listAgents(room, 5, undefined, 10, Number.NaN)),
    capture(() =>
      s.listAgents(room, 5, undefined, 10, Number.POSITIVE_INFINITY),
    ),
    capture(() => s.listAgents(room, 5, undefined, 10, 0.5)),
  ];
  check(
    "D1 invalid listing cursors are rejected instead of restarting paging",
    invalidCursors.every(
      ({ error }) =>
        /list_(rooms after_id|agents after) must be an integer/.test(error ?? "") &&
        !/sqlite/i.test(error ?? ""),
    ),
    invalidCursors,
  );

  const invalidBulkReads = [
    capture(() => s.readHistory(room, Number.NaN)),
    capture(() => s.readHistory(room, 501)),
    capture(() => s.readHistory(room, 50, Number.NaN)),
    capture(() => s.readHistory(room, 50, undefined, undefined, 400_001)),
    capture(() => s.myMentions("me", Number.NaN)),
    capture(() => s.myMentions("me", 501)),
    capture(() => s.myMentions("me", 50, undefined, 400_001)),
    capture(() => s.myMentions("me", 50, undefined, 100_000, Number.NaN)),
    capture(() => s.getThread(room, 1, 3, undefined, Number.POSITIVE_INFINITY)),
    capture(() => s.searchMessages(room, "important", 20, 0, 100_001)),
  ];
  const legalHistory = capture(() =>
    s.readHistory(room, 500, undefined, undefined, 400_000),
  );
  const legalMentions = capture(() =>
    s.myMentions("me", 500, undefined, 400_000, 0),
  );
  check(
    "D1 direct bulk reads enforce their public row and response budgets",
    invalidBulkReads.every(
      ({ error }) =>
        /must be an integer from/.test(error ?? "") &&
        !/sqlite/i.test(error ?? ""),
    ) &&
      legalHistory.error === undefined &&
      legalMentions.error === undefined &&
      JSON.stringify(legalHistory.value).length <= 400_000 &&
      JSON.stringify(legalMentions.value).length <= 400_000,
    { invalidBulkReads, legalHistory, legalMentions },
  );

  const hundredIds = Array.from({ length: 100 }, (_, i) => `unknown-${i}`);
  const tooManyIds = [...hundredIds, "unknown-100"];
  const legalStatuses = capture(() => s.recipientStatus(room, hundredIds, 5));
  const legalRetired = capture(() => s.retiredIds(hundredIds));
  const excessiveStatuses = capture(() =>
    s.recipientStatus(room, tooManyIds, 5),
  );
  const excessiveRetired = capture(() => s.retiredIds(tooManyIds));
  check(
    "D1 recipient lookups reject oversized arrays before SQLite preparation",
    legalStatuses.value?.length === 100 &&
      legalRetired.value instanceof Set &&
      /at most 100 ids/.test(excessiveStatuses.error ?? "") &&
      /at most 100 ids/.test(excessiveRetired.error ?? "") &&
      !/sqlite/i.test(excessiveStatuses.error ?? "") &&
      !/sqlite/i.test(excessiveRetired.error ?? ""),
    { legalStatuses, legalRetired, excessiveStatuses, excessiveRetired },
  );
  s.close();
}

// S6: pending_work is byte-bounded and keyset-pageable, including ties where
// one agent has pending rows in several rooms in the same second.
{
  const s = new ChatStore(":memory:");
  mkAgent(s, "boss");
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, "0");
    const room = mkRoom(s, `${n}-${String.fromCharCode(1).repeat(190)}`, null, null).id;
    const worker = `worker-${n}-${"\\".repeat(180)}`;
    mkAgent(s, worker);
    s.joinRoom(room, "boss", {});
    s.joinRoom(room, worker, {});
    s.postMessage(room, "boss", "work", "text", [worker], null, null);
  }
  const keys = [];
  let after;
  let sawSizeCut = false;
  let terminated = false;
  let largest = 0;
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const page = s.pendingDirected(500, after);
    largest = Math.max(largest, JSON.stringify(page).length);
    sawSizeCut ||= page.size_trimmed;
    keys.push(...page.pending.map((p) => `${p.agent_id}\0${p.room_id}`));
    if (!page.truncated) {
      terminated = true;
      break;
    }
    if (!page.next_after) break;
    after = page.next_after;
  }
  check(
    "S6 pending-work pages stay bounded and traverse every row once",
    terminated && sawSizeCut && largest <= 100_000 && keys.length === 60 &&
      new Set(keys).size === 60,
    { terminated, sawSizeCut, largest, rows: keys.length, unique: new Set(keys).size },
  );
  s.close();
}

{
  const s = new ChatStore(":memory:");
  mkAgent(s, "boss");
  mkAgent(s, "same-target");
  for (let i = 0; i < 3; i++) {
    const room = mkRoom(s, `tie-${i}`, null, null).id;
    s.joinRoom(room, "boss", {});
    s.joinRoom(room, "same-target", {});
    s.postMessage(room, "boss", "work", "text", ["same-target"], null, null);
  }
  const rooms = [];
  let after;
  for (let pageNo = 0; pageNo < 4; pageNo++) {
    const page = s.pendingDirected(1, after);
    rooms.push(...page.pending.map((p) => p.room_id));
    if (!page.truncated) break;
    after = page.next_after;
  }
  check(
    "S6 pending-work cursor has a deterministic room-id tie-breaker",
    rooms.length === 3 && new Set(rooms).size === 3 &&
      rooms.join(",") === [...rooms].sort((a, b) => a - b).join(","),
    rooms,
  );
  s.close();
}

// P1/P2: MCP schema, post/read response, and incompatible live-wait guard.
const mcpFixture = {};
const mcpFixtureRun = (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v0120-mcp-"));
  mcpFixture.dir = dir;
  const DB = join(dir, "t.db");
  // P5 edits build-info to exercise stale-build detection. Stage the tiny
  // dist tree in an ignored project-local directory so a forced test kill can
  // never leave the real deployed artifact modified.
  const stageRoot = mkdtempSync(join(ROOT, ".aichat-v0120-"));
  mcpFixture.stageRoot = stageRoot;
  cpSync(join(ROOT, "dist"), join(stageRoot, "dist"), { recursive: true });
  const child = spawn("node", [join(stageRoot, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
    stdio: ["pipe", "pipe", "ignore"],
  });
  mcpFixture.child = child;
  const responses = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      } catch {}
    }
  });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const wait = (id) =>
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (!responses.has(id)) return;
        clearInterval(timer);
        clearTimeout(deadline);
        resolve(responses.get(id));
      }, 15);
      const deadline = setTimeout(() => {
        clearInterval(timer);
        child.kill("SIGKILL");
        reject(new Error(`MCP reply timeout id ${id}`));
      }, 15_000);
    });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  const call = async (name, args) => {
    const requestId = ++id;
    send({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const message = await wait(requestId);
    const text = message.result?.content?.[0]?.text;
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    return {
      isError: message.result?.isError === true,
      data,
    };
  };

  const store = new ChatStore(DB);
  mcpFixture.store = store;
  const room = mkRoom(store, "mcp-priority", null, null).id;
  mkAgent(store, "peer");
  store.joinRoom(room, "peer", {});
  const identified = await call("identify_persona", {
    brand: "priority",
    model: "triage-client",
    version: "1.0",
  });
  const mcpAgentId = identified.data.agent_id;
  await call("join_room", { room: "mcp-priority" });
  const posted = await call("post_message", {
    content: "my checkpoint",
    priority: true,
  });
  check(
    "P1 MCP post accepts and echoes priority:true",
    posted.data.posted === true && posted.data.priority === true &&
      store.readHistory(room, 10).messages[0].priority === true,
    posted.data,
  );
  store.postMessage(room, "peer", "low", "text", null, null, null);
  store.postMessage(room, "peer", "important", "text", null, null, null, {
    priority: true,
  });
  store.postMessage(room, "peer", "direct", "text", [mcpAgentId], null, null);
  store.postMessage(room, "peer", "tail noise", "text", null, null, null);
  const caught = await call("catch_up", { priority_only: true, max_bytes: 2000 });
  check(
    "P1 MCP priority catch-up is explicit, bounded, directed-safe, and draining",
    caught.data.lossy === true && caught.data.priority_only === true &&
      caught.data.messages.map((m) => m.content).join(",") === "important,direct" &&
      caught.data.skipped_count === 2 && caught.data.remaining === 0 &&
      JSON.stringify(caught.data).length <= 2000,
    caught.data,
  );

  store.postMessage(room, "peer", "must remain", "text", null, null, null);
  const markerBefore = store.getMembership(room, mcpAgentId).last_read_seq;
  const incompatible = await call("catch_up", {
    priority_only: true,
    wait_seconds: 1,
  });
  check(
    "P2 priority-only + wait rejects before advancing",
    incompatible.isError === true && /cannot be combined/.test(incompatible.data.error) &&
      store.getMembership(room, mcpAgentId).last_read_seq === markerBefore,
    incompatible.data,
  );
  const recovered = await call("catch_up", {});
  check(
    "P2 rejected combination leaves ordinary recovery intact",
    recovered.data.messages.some((m) => m.content === "must remain"),
    recovered.data,
  );

  const otherRoom = mkRoom(store, "claims-other", null, null).id;
  const unjoinedRoom = mkRoom(store, "claims-unjoined", null, null).id;
  await call("join_room", { room: "claims-other" });
  await call("join_room", { room: "mcp-priority" });
  const claimed = await call("claim", {
    room: "claims-other",
    key: "probe:cross-room",
    note: "explicit selector regression",
  });
  const listedOther = await call("list_claims", { room: String(otherRoom) });
  const listedActive = await call("list_claims", {});
  check(
    "P3 claim/list can target another joined room without changing active room",
    claimed.data.granted === true && claimed.data.room_id === otherRoom &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(claimed.data.expires_at) &&
      listedOther.data.room_id === otherRoom &&
      listedOther.data.claims.some((c) =>
        c.key === "probe:cross-room" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(c.expires_at),
      ) &&
      listedActive.data.room_name === "mcp-priority" &&
      !listedActive.data.claims.some((c) => c.key === "probe:cross-room"),
    { claimed: claimed.data, listedOther: listedOther.data, listedActive: listedActive.data },
  );
  const released = await call("release_claim", {
    room: "claims-other",
    key: "probe:cross-room",
  });
  const unjoined = await call("claim", {
    room: String(unjoinedRoom),
    key: "must-not-land",
  });
  check(
    "P3 targeted release works and an unjoined selector fails closed",
    released.data.released === true && released.data.room_id === otherRoom &&
      unjoined.isError === true && /never joined/.test(unjoined.data.error) &&
      store.listClaims(unjoinedRoom).claims.length === 0,
    { released: released.data, unjoined: unjoined.data },
  );

  // --- P3b: the LEFT boundary as an MCP caller sees it ---------------------
  const leftRoom = mkRoom(store, "left-behind", null, null).id;
  await call("join_room", { room: "left-behind" });
  const beforeLeaving = await call("post_message", { content: "before I go" });
  await call("claim", { key: "kept:across-leave", note: "still mine while away" });
  await call("leave_room", {});
  const leftPost = await call("post_message", {
    room: "left-behind",
    content: "from an empty seat",
  });
  check(
    "P3b an explicit-room LEFT refusal names the room and its id, not a bare id",
    leftPost.isError === true &&
      /LEFT/.test(leftPost.data.error) &&
      /join_room/.test(leftPost.data.error) &&
      leftPost.data.error.includes(`"left-behind" (${leftRoom})`) &&
      store.readHistory(leftRoom, 50).messages.every(
        (m) => m.content !== "from an empty seat",
      ),
    leftPost.data,
  );
  // These non-advancing reads and claim cleanup remain open while absent.
  const readWhileGone = await call("get_message", {
    room: "left-behind",
    seq: beforeLeaving.data.seq,
  });
  const threadWhileGone = await call("get_thread", {
    room: "left-behind",
    seq: beforeLeaving.data.seq,
  });
  const listWhileGone = await call("list_claims", { room: "left-behind" });
  const releaseWhileGone = await call("release_claim", {
    room: "left-behind",
    key: "kept:across-leave",
  });
  check(
    "P3b reading history and releasing a held claim stay open after leaving",
    readWhileGone.isError !== true &&
      readWhileGone.data.content === "before I go" &&
      threadWhileGone.isError !== true &&
      threadWhileGone.data.message.seq === beforeLeaving.data.seq &&
      listWhileGone.isError !== true &&
      listWhileGone.data.claims.some((c) => c.key === "kept:across-leave") &&
      releaseWhileGone.isError !== true &&
      releaseWhileGone.data.released === true,
    {
      read: readWhileGone.data,
      thread: threadWhileGone.data,
      list: listWhileGone.data,
      release: releaseWhileGone.data,
    },
  );
  // Soft-left access still requires an existing membership.
  const strangerRead = await call("get_message", {
    room: "claims-unjoined",
    seq: 1,
  });
  const strangerList = await call("list_claims", { room: "claims-unjoined" });
  check(
    "P3b left-safe reads are open to a LEFT member but not to a never-joined one",
    strangerRead.isError === true &&
      /never joined/.test(strangerRead.data.error) &&
      strangerList.isError === true &&
      /never joined/.test(strangerList.data.error),
    { read: strangerRead.data, list: strangerList.data },
  );

  const deletedActive = mkRoom(store, "deleted-active", null, null).id;
  await call("join_room", { room: "deleted-active" });
  store.deleteRoom(deletedActive, mcpAgentId);
  const identityAfterDelete = await call("whoami", {});
  check(
    "P3b whoami gives a possible recovery after the active room is deleted",
    identityAfterDelete.isError !== true &&
      identityAfterDelete.data.joined === false &&
      /list_rooms/.test(identityAfterDelete.data.note) &&
      /create_room/.test(identityAfterDelete.data.note) &&
      !/rejoin/.test(identityAfterDelete.data.note),
    identityAfterDelete.data,
  );
  await call("join_room", { room: "mcp-priority" });

  mkAgent(store, "todo-a");
  mkAgent(store, "todo-b");
  store.joinRoom(otherRoom, "peer", {});
  store.joinRoom(otherRoom, "todo-a", {});
  store.joinRoom(unjoinedRoom, "peer", {});
  store.joinRoom(unjoinedRoom, "todo-b", {});
  store.postMessage(otherRoom, "peer", "task a", "text", ["todo-a"], null, null);
  store.postMessage(unjoinedRoom, "peer", "task b", "text", ["todo-b"], null, null);
  const pendingFirst = await call("pending_work", { limit: 1 });
  const pendingSecond = await call("pending_work", {
    limit: 1,
    after: pendingFirst.data.next_after,
  });
  const pendingIds = [
    ...pendingFirst.data.pending,
    ...pendingSecond.data.pending,
  ].map((p) => p.agent_id);
  const badCursor = await call("pending_work", {
    after: { oldest_unix: 0, agent_id: "todo-a" },
  });
  check(
    "P4 pending_work keyset cursor traverses rows and is strict",
    pendingFirst.data.truncated === true && !!pendingFirst.data.next_after &&
      new Set(pendingIds).size === 2 && pendingIds.includes("todo-a") &&
      pendingIds.includes("todo-b") && badCursor.isError === true,
    {
      first: pendingFirst.data,
      second: pendingSecond.data,
      badCursor: badCursor.data,
    },
  );

  const buildInfoPath = join(stageRoot, "dist", "build-info.json");
  const originalBuildText = readFileSync(buildInfoPath, "utf8");
  const originalBuild = JSON.parse(originalBuildText);
  try {
    check(
      "P5 the current stamp carries an artifact hash (the stale contract needs it)",
      typeof originalBuild.artifact_hash === "string" &&
        originalBuild.artifact_hash.length === 64,
      originalBuild,
    );
    const baseTime = Date.parse(originalBuild.built_at) || Date.now();
    // Staleness is HASH-ONLY. A rebuild that produces identical output must not
    // be reported as a new deployment however much later it happened, so this
    // stamp moves built_at forward by a full hour and keeps the hash.
    writeFileSync(
      buildInfoPath,
      JSON.stringify({
        ...originalBuild,
        built_at: new Date(baseTime + 3_600_000).toISOString(),
      }) + "\n",
    );
    const sameArtifact = await call("server_info", {});
    // And the converse: a different hash IS a new deployment even if built_at
    // moves BACKWARD, which is what a timestamp comparison would have missed.
    writeFileSync(
      buildInfoPath,
      JSON.stringify({
        ...originalBuild,
        built_at: new Date(baseTime - 3_600_000).toISOString(),
        artifact_hash: "0".repeat(64),
      }) + "\n",
    );
    const changedArtifact = await call("server_info", {});
    check(
      "P5 identical rebuild is not stale even much later; a changed artifact is stale even if older",
      sameArtifact.data.stale === false && changedArtifact.data.stale === true &&
        sameArtifact.data.artifact_hash === originalBuild.artifact_hash,
      { same: sameArtifact.data, changed: changedArtifact.data },
    );
  } finally {
    writeFileSync(buildInfoPath, originalBuildText);
  }
})();
try {
  await mcpFixtureRun;
} finally {
  try {
    mcpFixture.store?.close();
  } finally {
    mcpFixture.child?.kill();
    if (mcpFixture.stageRoot) {
      rmSync(mcpFixture.stageRoot, { recursive: true, force: true });
    }
    if (mcpFixture.dir) rmSync(mcpFixture.dir, { recursive: true, force: true });
  }
}

// P6: build stamping proves both HEAD and complete working-tree cleanliness.
{
  const dir = mkdtempSync(join(tmpdir(), "v0120-stamp-"));
  try {
    const bin = join(dir, "bin");
    const scripts = join(dir, "scripts");
    const dist = join(dir, "dist");
    mkdirSync(bin);
    mkdirSync(scripts);
    mkdirSync(dist);
    cpSync(join(ROOT, "scripts", "stamp-build.mjs"), join(scripts, "stamp-build.mjs"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.0.0-test", dependencies: {} }),
    );
    writeFileSync(join(dist, "index.js"), "export const stamped = true;\n");
    const fakeGitPath = join(bin, "git");
    writeFileSync(
      fakeGitPath,
      `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  [ "$FAKE_GIT_FAILURE" = "rev-parse" ] && exit 31
  printf 'abc123\n'
  exit 0
fi
if [ "$1" = "status" ]; then
  [ "$FAKE_GIT_FAILURE" = "status" ] && exit 32
  for arg in "$@"; do
    [ "$arg" = "--untracked-files=all" ] && { printf '?? src/new.ts\n'; exit 0; }
  done
  exit 0
fi
exit 33
`,
    );
    chmodSync(fakeGitPath, 0o700);
    const runStamp = (failure = "") => {
      const result = spawnSync(process.execPath, [join(scripts, "stamp-build.mjs")], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_GIT_FAILURE: failure,
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      let info = null;
      try {
        info = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));
      } catch {}
      return { result, info };
    };

    const dirty = runStamp();
    check(
      "P6 stamp forces complete untracked-file enumeration",
      dirty.result.status === 0 && dirty.info?.commit === "abc123-dirty",
      { status: dirty.result.status, info: dirty.info, stderr: dirty.result.stderr },
    );
    const failedStatus = runStamp("status");
    const failedHead = runStamp("rev-parse");
    check(
      "P6 stamp reports unknown when either Git identity check fails",
      failedStatus.result.status === 0 && failedStatus.info?.commit === "unknown" &&
        failedHead.result.status === 0 && failedHead.info?.commit === "unknown",
      { status: failedStatus, head: failedHead },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// R1: refresh is safe in a published package and preserves registrations and
// Antigravity-specific fields during an in-place build refresh.
{
  const dir = mkdtempSync(join(tmpdir(), "v0120-refresh-"));
  const bin = join(dir, "bin");
  const configPath = join(dir, "agy.json");
  const logPath = join(dir, "calls.log");
  mkdirSync(bin);
  const fakeClient =
    '#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$FAKE_LOG"\n' +
    'if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then if [ "${0##*/}" = "claude" ]; then printf "Command: %s\\nArgs: %s\\n" "$FAKE_NODE_BIN" "$FAKE_SERVER_PATH"; else printf "command: %s\\nargs: %s\\n" "$FAKE_NODE_BIN" "$FAKE_SERVER_PATH"; fi; exit 0; fi\nexit 97\n';
  for (const name of ["codex", "claude"]) {
    const path = join(bin, name);
    writeFileSync(path, fakeClient);
    chmodSync(path, 0o700);
  }
  const agy = join(bin, "agy");
  writeFileSync(agy, "#!/bin/sh\nexit 0\n");
  chmodSync(agy, 0o700);
  writeFileSync(logPath, "");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        "agent-chat": {
          command: "old-node",
          args: ["old-server"],
          env: { KEEP_ME: "yes" },
          timeout: 17,
        },
      },
    }),
  );
  const refreshed = spawnSync(
    "bash",
    [join(ROOT, "scripts", "refresh-mcp.sh")],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AGENT_CHAT_AGY_CONFIG: configPath,
        AGENT_CHAT_NODE_BIN: process.execPath,
        FAKE_LOG: logPath,
        FAKE_NODE_BIN: process.execPath,
        FAKE_SERVER_PATH: join(ROOT, "dist", "index.js"),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const calls = readFileSync(logPath, "utf8");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const entry = config.mcpServers["agent-chat"];
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check(
    "R1 refresh preserves live registrations and custom target fields",
    refreshed.status === 0 && /codex mcp get agent-chat/.test(calls) &&
      /claude mcp get agent-chat/.test(calls) && !/mcp remove|mcp add/.test(calls) &&
      entry.env.KEEP_ME === "yes" && entry.timeout === 17 &&
      entry.command === process.execPath &&
      entry.args[0] === join(ROOT, "dist", "index.js"),
    { status: refreshed.status, calls, entry, err: refreshed.stderr },
  );
  check(
    "R1 packaged refresh uses build-if-source prepare instead of unconditional tsc",
    /node scripts\/prepare\.mjs/.test(pkg.scripts["mcp:refresh"]) &&
      !/npm run build/.test(pkg.scripts["mcp:refresh"]),
    pkg.scripts["mcp:refresh"],
  );
  writeFileSync(logPath, "");
  const mismatched = spawnSync(
    "bash",
    [join(ROOT, "scripts", "refresh-mcp.sh")],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AGENT_CHAT_AGY_CONFIG: configPath,
        AGENT_CHAT_NODE_BIN: process.execPath,
        FAKE_LOG: logPath,
        FAKE_NODE_BIN: process.execPath,
        FAKE_SERVER_PATH: join(ROOT, "dist", "index.js") + ".old",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const mismatchCalls = readFileSync(logPath, "utf8");
  check(
    "R1 refresh rejects an exact-path near miss instead of claiming success",
    mismatched.status === 1 &&
      /AGENT_CHAT_FORCE_REREGISTER=1/.test(mismatched.stderr) &&
      !/mcp remove|mcp add/.test(mismatchCalls),
    {
      status: mismatched.status,
      calls: mismatchCalls,
      out: mismatched.stdout,
      err: mismatched.stderr,
    },
  );
  rmSync(dir, { recursive: true, force: true });
}
console.log("\nall features-v0120 checks passed");

expect(failures).toBe(0);
});
