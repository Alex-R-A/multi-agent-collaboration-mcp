// Focused MCP lifecycle/order regressions. One server process only; every wait
// and child has a hard deadline, and the suite runner owns the process group.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
}

function startMcp(dbPath) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: dbPath },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        replies.set(message.id, message);
      }
    }
  });
  const waitFor = (id, timeoutMs = 5_000) => {
    if (replies.has(id)) {
      const reply = replies.get(id);
      replies.delete(id);
      return Promise.resolve(reply);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`MCP reply ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.set(id, { resolve, timer });
    });
  };
  const sendBatch = (messages) => {
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  };
  const tool = (id, name, args) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const data = (reply) => {
    const text = reply.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  };
  const waitForExit = (timeoutMs = 3_000) =>
    new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`MCP child did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  return { child, data, sendBatch, tool, waitFor, waitForExit };
}

const dir = mkdtempSync(join(tmpdir(), "aichat-mcp-life-"));
const DB = join(dir, "chat.db");
let store;
let client;
try {
  store = new ChatStore(DB);
  const roomA = mkRoom(store, "order-a", null, null).id;
  const roomB = mkRoom(store, "order-b", null, null).id;
  mkAgent(store, "peer");
  store.joinRoom(roomA, "peer", {});
  store.joinRoom(roomB, "peer", {});

  client = startMcp(DB);
  client.sendBatch([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "1" },
      },
    },
  ]);
  await client.waitFor(1);
  client.sendBatch([{ jsonrpc: "2.0", method: "notifications/initialized" }]);

  // Bind the persona before the pipelining cases: join_room requires one, and
  // this file is about REQUEST ORDER, not identity, so identification is setup.
  client.sendBatch([
    client.tool(9, "identify_persona", {
      brand: "lifecycle",
      model: "ordered-client",
      version: "1.0",
    }),
  ]);
  const orderedId = client.data(await client.waitFor(9)).agent_id;

  // One write is important: both requests reach the SDK in one input chunk.
  client.sendBatch([
    client.tool(10, "join_room", { room: "order-a" }),
    client.tool(11, "whoami", {}),
  ]);
  const [joinedReply, whoReply] = await Promise.all([
    client.waitFor(10),
    client.waitFor(11),
  ]);
  const joined = client.data(joinedReply);
  const who = client.data(whoReply);
  check(
    "pipelined whoami observes the earlier join",
    joined?.room_id === roomA && who?.joined === true &&
      who?.agent_id === orderedId && who?.room_id === roomA,
    { joined, who },
  );

  // A validation failure must release its FIFO ticket.
  client.sendBatch([
    client.tool(12, "whoami", { unknown_key: true }),
    client.tool(13, "whoami", {}),
  ]);
  const [invalid, afterInvalid] = await Promise.all([
    client.waitFor(12),
    client.waitFor(13),
  ]);
  check(
    "invalid pipelined request cannot deadlock the next request",
    invalid.result?.isError === true && client.data(afterInvalid)?.room_id === roomA,
    { invalid: invalid.result, after: client.data(afterInvalid) },
  );

  // FIFO covers only the synchronous state-capture prefix: a long wait must
  // not serialize the later join, and it must remain bound to room A.
  const joinStarted = Date.now();
  client.sendBatch([
    client.tool(20, "catch_up", { wait_seconds: 3 }),
    client.tool(21, "join_room", { room: "order-b" }),
  ]);
  const moved = client.data(await client.waitFor(21, 1_500));
  const joinElapsed = Date.now() - joinStarted;
  store.postMessage(roomA, "peer", "wake-a", "text", null, null, null);
  const waited = client.data(await client.waitFor(20, 3_500));
  check(
    "state FIFO does not serialize a blocking wait",
    joinElapsed < 1_500 && moved?.room_id === roomB,
    { joinElapsed, moved },
  );
  check(
    "blocking wait stays captured on its pre-join room",
    waited?.room_id === roomA && waited?.messages?.[0]?.content === "wake-a",
    waited,
  );

  // Start another empty wait, prove its lease exists, then close stdin. EOF
  // must abort/drain the request and remove its lease. Post only after the
  // observed exit: stdin.end() alone has no cross-process happens-before edge,
  // so an immediate post would make scheduler timing masquerade as a bug.
  client.sendBatch([client.tool(30, "catch_up", { wait_seconds: 5 })]);
  let leases = 0;
  const leaseDeadline = Date.now() + 2_000;
  while (Date.now() < leaseDeadline) {
    const raw = new Database(DB, { readonly: true });
    leases = raw.prepare("SELECT COUNT(*) AS c FROM wait_leases").get().c;
    raw.close();
    if (leases > 0) break;
    await sleep(20);
  }
  const markerBefore = store.getMembership(roomB, orderedId).last_read_seq;
  client.child.stdin.end();
  const exitCode = await client.waitForExit(5_000);
  const raw = new Database(DB, { readonly: true });
  const leasesAfter = raw.prepare("SELECT COUNT(*) AS c FROM wait_leases").get().c;
  raw.close();
  const markerAfter = store.getMembership(roomB, orderedId).last_read_seq;
  const peerPost = store.postMessage(
    roomB,
    "peer",
    "after-eof",
    "text",
    null,
    null,
    null,
  );
  check("EOF test established an active wait lease", leases > 0, leases);
  check(
    "EOF aborts waits, removes leases, and preserves the unread peer post",
    exitCode === 0 && leasesAfter === 0 && markerAfter === markerBefore &&
      markerAfter < peerPost.seq,
    { exitCode, leasesAfter, markerBefore, markerAfter, peerSeq: peerPost.seq },
  );
} catch (error) {
  check("MCP lifecycle harness completed", false, String(error));
} finally {
  if (client?.child.exitCode === null) client.child.kill("SIGKILL");
  try {
    store?.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
