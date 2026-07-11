// Proves the catch_up no-overlap guarantee under real OS-process concurrency.
//
// Several processes drain the SAME agent's backlog at the same time, each
// looping catch_up until empty. catch_up advances the shared read marker inside
// one IMMEDIATE transaction, so the processes must partition the backlog: every
// message seq is delivered to exactly one process, exactly once. A duplicate
// across processes would mean two reads saw the same marker (overlap) -- the bug
// the atomic transaction prevents. A gap would mean a lost message.
//
// Run: node test/concurrent-catchup.mjs   (exits non-zero on failure)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";

const SELF = fileURLToPath(import.meta.url);
const ROOM = 1;
const AGENT = "racer";
const N = 1200; // messages in the backlog
const WORKERS = 4; // concurrent draining processes
const LIMIT = 3; // small page so each worker makes many racing calls

function isBusy(e) {
  return e && (e.code === "SQLITE_BUSY" || /SQLITE_BUSY/.test(String(e.message)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- worker mode: drain the backlog, print every seq this process received ----
if (process.argv[2] === "worker") {
  const startAt = Number(process.argv[4]);
  const DB = process.argv[5]; // unique db path passed by the spawner
  const store = new ChatStore(DB); // open the connection first...
  await sleep(Math.max(0, startAt - Date.now())); // ...then all workers start together
  const seqs = [];
  for (;;) {
    let r;
    // Bounded retries: unbounded, a lock-leak regression turns this suite
    // into an infinite CI hang instead of a failure.
    let attempts = 0;
    for (;;) {
      try {
        r = store.catchUp(ROOM, AGENT, LIMIT);
        break;
      } catch (e) {
        if (isBusy(e) && ++attempts < 2000) continue; // lock contention: retry
        throw e;
      }
    }
    if (r.messages.length === 0) break;
    for (const m of r.messages) seqs.push(m.seq);
    // Yield the write lock between calls; SQLite's busy handler is unfair, so
    // without this one process tends to monopolize the lock and drain it all.
    await sleep(1);
  }
  store.close();
  process.stdout.write(JSON.stringify(seqs));
  process.exit(0);
}

// ---- spawner mode ----
const tmpDir = mkdtempSync(join(tmpdir(), "aichat-race-"));
const DB = join(tmpDir, "race.db");
const setup = new ChatStore(DB);
setup.createRoom("race", null, null);
setup.upsertAgent(AGENT, "claude", null, null);
setup.joinRoom(ROOM, AGENT);
// Messages are authored by a different agent: catch_up excludes the caller's
// own messages, so the drainer (AGENT) must not be the author.
setup.upsertAgent("poster", "claude", null, null);
setup.joinRoom(ROOM, "poster");
for (let i = 1; i <= N; i++) setup.postMessage(ROOM, "poster", `m${i}`, "text", null, null);
setup.close();

// Open all worker connections, then release them at the same wall-clock instant
// so they genuinely contend instead of one finishing before the rest boot.
const startAt = Date.now() + 800;
const t0 = Date.now();
const runs = await Promise.all(
  Array.from({ length: WORKERS }, (_, i) =>
    new Promise((resolve) => {
      const p = spawn("node", [SELF, "worker", String(i), String(startAt), DB], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", (code) => resolve({ code, seqs: JSON.parse(out || "[]") }));
    }),
  ),
);
const ms = Date.now() - t0;

// every seq, across all workers, must appear exactly once
const counts = new Map();
for (const { seqs } of runs) for (const s of seqs) counts.set(s, (counts.get(s) ?? 0) + 1);

const received = [...counts.keys()];
const duplicates = received.filter((s) => counts.get(s) > 1);
const missing = [];
for (let s = 1; s <= N; s++) if (!counts.has(s)) missing.push(s);
const total = runs.reduce((a, r) => a + r.seqs.length, 0);
const perWorker = runs.map((r) => r.seqs.length);
const crashed = runs.filter((r) => r.code !== 0).length;

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  >> " + JSON.stringify(extra)}`);
  if (!cond) failures++;
};

console.log(`drained ${N} msgs with ${WORKERS} processes in ${ms}ms; per-worker: ${perWorker.join(", ")}`);
check("no overlap (no seq delivered to two processes)", duplicates.length === 0, duplicates.slice(0, 10));
check("no loss (every seq delivered)", missing.length === 0, missing.slice(0, 10));
check("exactly N deliveries total", total === N, { total, N });
// At least two processes must have drained part of the backlog, otherwise no
// genuine concurrency occurred and the no-overlap result would be vacuous.
check("real concurrency: >= 2 processes participated", perWorker.filter((c) => c > 0).length >= 2, perWorker);
check("all workers exited cleanly (no masked crash)", crashed === 0, { crashed, codes: runs.map((r) => r.code) });

rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
