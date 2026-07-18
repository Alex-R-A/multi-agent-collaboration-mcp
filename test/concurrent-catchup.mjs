// Manual, bounded OS-process concurrency check for catch_up.
//
// This coordinator NEVER doubles as a worker. The worker lives in a separate
// file with no child-process imports, so worker fallthrough cannot recurse.
// Run explicitly with: npm run test:concurrency
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";

const WORKER = fileURLToPath(
  new URL("./helpers/concurrent-catchup-worker.mjs", import.meta.url),
);
const ROOM = 1;
const AGENT = "racer";
const N = 120;
const WORKERS = 2;
const LIMIT = 3;
const WORKER_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 128_000;
const WORKER_ROLE_ENV = "AICHAT_CONCURRENCY_WORKER";

// One-generation fuse: if a future edit accidentally points WORKER back at
// this coordinator, its child exits here before it can spawn another child.
if (process.env[WORKER_ROLE_ENV] === "1") {
  throw new Error("concurrency coordinator cannot run in worker role");
}

const tmpDir = mkdtempSync(join(tmpdir(), "aichat-race-"));
const DB = join(tmpDir, "race.db");
const children = new Set();

async function stopChildren() {
  const live = [...children];
  for (const child of live) child.kill("SIGKILL");
  await Promise.all(
    live.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 2_000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
}

let handlingSignal = false;
async function onSignal(code) {
  if (handlingSignal) return;
  handlingSignal = true;
  await stopChildren();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(code);
}
process.once("SIGINT", () => void onSignal(130));
process.once("SIGTERM", () => void onSignal(143));

function runWorker(index, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER, DB, String(startAt), String(ROOM), AGENT, String(LIMIT), String(N + 1)],
      {
        stdio: ["ignore", "pipe", "inherit"],
        env: { ...process.env, [WORKER_ROLE_ENV]: "1" },
      },
    );
    children.add(child);
    let output = "";
    let forcedError = null;
    const timer = setTimeout(() => {
      forcedError = new Error(`concurrency worker ${index} exceeded ${WORKER_TIMEOUT_MS}ms`);
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES && forcedError === null) {
        forcedError = new Error(`concurrency worker ${index} exceeded stdout cap`);
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      forcedError ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (forcedError) return reject(forcedError);
      if (code !== 0) {
        return reject(new Error(`concurrency worker ${index} exited ${code}`));
      }
      try {
        resolve(JSON.parse(output || "[]"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

let failures = 0;
const check = (name, condition, extra) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(extra)}`);
  if (!condition) failures++;
};

try {
  const setup = new ChatStore(DB);
  try {
    setup.createRoom("race", null, null);
    setup.upsertAgent(AGENT, "claude", null, null);
    setup.joinRoom(ROOM, AGENT);
    setup.upsertAgent("poster", "claude", null, null);
    setup.joinRoom(ROOM, "poster");
    for (let i = 1; i <= N; i++) {
      setup.postMessage(ROOM, "poster", `m${i}`, "text", null, null);
    }
  } finally {
    setup.close();
  }

  const startAt = Date.now() + 500;
  const started = Date.now();
  const runs = await Promise.all(
    Array.from({ length: WORKERS }, (_, index) => runWorker(index, startAt)),
  );

  const counts = new Map();
  for (const seqs of runs) {
    for (const seq of seqs) counts.set(seq, (counts.get(seq) ?? 0) + 1);
  }
  const received = [...counts.keys()];
  const duplicates = received.filter((seq) => counts.get(seq) > 1);
  const missing = [];
  for (let seq = 1; seq <= N; seq++) {
    if (!counts.has(seq)) missing.push(seq);
  }
  const total = runs.reduce((sum, seqs) => sum + seqs.length, 0);
  const perWorker = runs.map((seqs) => seqs.length);

  console.log(
    `drained ${N} msgs with ${WORKERS} processes in ${Date.now() - started}ms; per-worker: ${perWorker.join(", ")}`,
  );
  check("no overlap", duplicates.length === 0, duplicates.slice(0, 10));
  check("no loss", missing.length === 0, missing.slice(0, 10));
  check("exactly N deliveries", total === N, { total, N });
  check(
    "real concurrency",
    perWorker.filter((count) => count > 0).length >= 2,
    perWorker,
  );
} finally {
  await stopChildren();
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exitCode = failures === 0 ? 0 : 1;
