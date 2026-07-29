// HTTP classification for web database failures. The lock is held by this
// process while the viewer child opens its own SQLite connection, so the busy
// result crosses both a connection and process boundary.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "aichat-web-errors-"));
const DB = join(dir, "chat.db");
let failures = 0;
let child;
let locker;

function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
}

async function startViewer() {
  child = spawn(process.execPath, [join(ROOT, "web", "server.mjs")], {
    env: { ...process.env, AGENT_CHAT_DB: DB, AGENT_CHAT_VIEWER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`viewer start timed out: ${stdout}${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${Number(match[1])}`);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `viewer exited before listening (${code ?? signal}): ${stdout}${stderr}`,
        ),
      );
    });
  });
}

async function post(base, path, payload) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  return { status: response.status, data: await response.json() };
}

async function stopViewer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGKILL");
  await closed;
}

try {
  const store = new ChatStore(DB);
  store.close();
  const seed = new Database(DB);
  const roomId = Number(
    seed.prepare("INSERT INTO rooms (name) VALUES (?)").run("error-status")
      .lastInsertRowid,
  );
  seed.close();

  const base = await startViewer();
  const badInput = await post(base, "/api/join", {
    room: roomId,
    base_name: "bad name",
    operation_id: randomUUID(),
  });
  check(
    "invalid client input remains HTTP 400",
    badInput.status === 400 && /base_name/.test(badInput.data.error),
    badInput,
  );

  const missingRoom = await post(base, "/api/join", {
    room: roomId + 1000,
    base_name: "missing",
    operation_id: randomUUID(),
  });
  check(
    "an expected transaction-domain failure remains HTTP 400",
    missingRoom.status === 400 && /no room/.test(missingRoom.data.error),
    missingRoom,
  );

  const busyOperation = randomUUID();
  locker = new Database(DB);
  locker.exec("BEGIN IMMEDIATE");
  check(
    "the independent fixture connection holds the write lock",
    locker.inTransaction,
    { inTransaction: locker.inTransaction },
  );
  const busy = await post(base, "/api/join", {
    room: roomId,
    base_name: "contended",
    operation_id: busyOperation,
  });
  const busyRows = locker
    .prepare(
      "SELECT COUNT(*) AS c FROM human_allocations WHERE operation_id = ?",
    )
    .get(busyOperation).c;
  check(
    "SQLite write contention returns HTTP 503 without allocating",
    busy.status === 503 &&
      /locked|busy/i.test(busy.data.error) &&
      busyRows === 0,
    { busy, busyRows },
  );
  locker.exec("ROLLBACK");
  locker.close();
  locker = null;

  const afterBusy = await post(base, "/api/join", {
    room: roomId,
    base_name: "contended",
    operation_id: busyOperation,
  });
  check(
    "the same valid request succeeds after the external lock is released",
    afterBusy.status === 200 &&
      afterBusy.data.agent_id === "human-contended-1",
    afterBusy,
  );

  const missingReply = await post(base, "/api/post", {
    room: roomId,
    agent_id: afterBusy.data.agent_id,
    body: "reply to nowhere",
    reply_to_seq: 999,
  });
  check(
    "a missing reply target remains HTTP 400",
    missingReply.status === 400 &&
      /reply_to_seq 999 does not exist/.test(missingReply.data.error),
    missingReply,
  );

  const left = await post(base, "/api/leave", {
    room: roomId,
    agent_id: afterBusy.data.agent_id,
  });
  const notJoined = await post(base, "/api/post", {
    room: roomId,
    agent_id: afterBusy.data.agent_id,
    body: "not present",
  });
  check(
    "posting without a present membership remains HTTP 400",
    left.status === 200 &&
      left.data.left === true &&
      notJoined.status === 400 &&
      /join the room first/.test(notJoined.data.error),
    { left, notJoined },
  );

  const badSearchResponse = await fetch(
    `${base}/api/search?room=${roomId}&q=${encodeURIComponent('"unbalanced (')}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  const badSearch = {
    status: badSearchResponse.status,
    data: await badSearchResponse.json(),
  };
  check(
    "invalid FTS input remains HTTP 400",
    badSearch.status === 400,
    badSearch,
  );
  for (const q of ["NEAR(foo bar, nope)", "{foo"]) {
    const response = await fetch(
      `${base}/api/search?room=${roomId}&q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const result = {
      status: response.status,
      data: await response.json(),
    };
    check(
      `alternate FTS parser error remains HTTP 400: ${q}`,
      result.status === 400,
      result,
    );
  }

  const breaker = new Database(DB);
  try {
    breaker.exec(
      "DROP TABLE human_allocations; DROP TABLE messages_fts; " +
        "CREATE VIRTUAL TABLE messages_fts USING fts5(other)",
    );
  } finally {
    breaker.close();
  }
  const unexpected = await post(base, "/api/join", {
    room: roomId,
    base_name: "broken-schema",
    operation_id: randomUUID(),
  });
  check(
    "an unexpected transaction database failure returns HTTP 500",
    unexpected.status === 500 &&
      /no such table: human_allocations/.test(unexpected.data.error),
    unexpected,
  );
  const brokenSearchResponse = await fetch(
    `${base}/api/search?room=${roomId}&q=${encodeURIComponent("foo:bar")}`,
    { signal: AbortSignal.timeout(8_000) },
  );
  const brokenSearch = {
    status: brokenSearchResponse.status,
    data: await brokenSearchResponse.json(),
  };
  check(
    "a missing FTS column stays HTTP 500 even when the query contains a colon",
    brokenSearch.status === 500 &&
      /no such column: (?:f\.)?body/.test(brokenSearch.data.error),
    brokenSearch,
  );
} finally {
  if (locker) {
    if (locker.inTransaction) locker.exec("ROLLBACK");
    locker.close();
  }
  await stopViewer();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exitCode = failures === 0 ? 0 : 1;
