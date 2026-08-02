// Focused poller lifecycle regressions. Single-fire children only; each carries
// an explicit deadline and the suite runner owns the enclosing process group.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("poller-lifecycle-v0121.mjs", async () => {
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLLER = join(ROOT, "dist", "poller.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pollerTmp = tmpdir();
let failures = 0;
function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
}

function startPoller(args) {
  const child = spawn(process.execPath, [POLLER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // Never share watcher locks with deployed MCP/poller processes. All
    // lifecycle fixtures live under this test's recursively-cleaned temp dir.
    env: {
      ...process.env,
      TMPDIR: pollerTmp,
      TMP: pollerTmp,
      TEMP: pollerTmp,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // `close`, unlike `exit`, fires only after both output pipes are drained.
  // Attach immediately so a fast argument error cannot beat registration.
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const wait = (timeoutMs = 4_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`poller did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      void closed.then(({ code, signal }) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  return { child, wait, output: () => ({ stdout, stderr }) };
}

async function waitForLock(path, child, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    if (child.exitCode !== null) return false;
    await sleep(20);
  }
  return false;
}

const dir = mkdtempSync(join(tmpdir(), "aichat-poller-life-"));
pollerTmp = join(dir, "poller-tmp");
mkdirSync(pollerTmp, { mode: 0o700 });
const DB = join(dir, "chat.db");
let store;
let lockPath = null;
let ownedLockPath = null;
let expectedLockPaths = [];
const active = new Set();
const remainingLocks = () => expectedLockPaths.filter((path) => existsSync(path));
try {
  store = new ChatStore(DB);
  const room = mkRoom(store, "poller-life", null, null).id;
  for (const id of ["me", "peer"]) {
    mkAgent(store, id);
    store.joinRoom(room, id, {});
  }
  const canonical = realpathSync(DB);
  const diagnosticLockName =
    createHash("sha256")
      .update(JSON.stringify([canonical, "me", room, "diagnostic", false]))
      .digest("hex") + ".lock";
  const ownedLockName =
    createHash("sha256")
      .update(JSON.stringify([canonical, "me", room, "owned", false]))
      .digest("hex") + ".lock";
  const lockDir = join(
    pollerTmp,
    typeof process.getuid === "function"
      ? `agent-chat-pollers-${process.getuid()}`
      : "agent-chat-pollers",
  );
  lockPath = join(lockDir, diagnosticLockName);
  ownedLockPath = join(lockDir, ownedLockName);
  expectedLockPaths = [lockPath, ownedLockPath];
  const base = [
    "--agent",
    "me",
    "--room",
    String(room),
    "--db",
    DB,
    "--interval",
    "5",
  ];

  // The initial probe is quiet. A message arrives during the final sleep; the
  // deadline pass must probe once more rather than report a false timeout.
  const finalProbe = startPoller([...base, "--timeout", "2", "--ok-on-timeout"]);
  active.add(finalProbe.child);
  const finalLock = await waitForLock(lockPath, finalProbe.child);
  await sleep(150);
  const postedAt = Date.now();
  store.postMessage(
    room,
    "peer",
    "during-final-sleep",
    "text",
    null,
    null,
    null,
  );
  const finalResult = await finalProbe.wait(3_500);
  const finalDelay = Date.now() - postedAt;
  active.delete(finalProbe.child);
  let finalJson = null;
  try {
    finalJson = JSON.parse(finalResult.stdout.trim());
  } catch {}
  check("poller reached its active locked state", finalLock, finalProbe.output());
  check(
    "deadline performs a final probe before reporting quiet",
    finalResult.code === 0 && finalJson?.has_updates === true && finalDelay >= 1_000,
    { finalResult, finalJson, finalDelay },
  );
  store.markRead(room, "me");

  // A dead owner leaves the lock fail-closed. The error must make the manual
  // recovery precise without deleting or replacing the stale file itself.
  const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadOwnerPid = deadOwner.pid;
  await new Promise((resolve) => deadOwner.once("close", resolve));
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadOwnerPid, token: "stale-lock-test" }),
    { mode: 0o600 },
  );
  const stale = startPoller([...base, "--timeout", "1"]);
  active.add(stale.child);
  const staleResult = await stale.wait(2_000);
  active.delete(stale.child);
  const staleLockRemained = existsSync(lockPath);
  const staleInstruction =
    `stale watcher lock file: ${lockPath}; ` +
    "remove only this exact file, then retry";
  check(
    "dead-owner lock stays fail-closed and reports exact manual recovery",
    staleResult.code === 2 &&
      staleLockRemained &&
      staleResult.stderr.includes(staleInstruction),
    { staleResult, staleLockRemained, staleInstruction },
  );
  rmSync(lockPath);
  const staleRetry = startPoller([...base, "--timeout", "1"]);
  active.add(staleRetry.child);
  const staleRetryResult = await staleRetry.wait(2_500);
  active.delete(staleRetry.child);
  check(
    "removing the named stale lock allows the watcher retry",
    staleRetryResult.code === 124 && remainingLocks().length === 0,
    { staleRetryResult, remainingLocks: remainingLocks() },
  );

  // A generated watcher whose MCP owner is already dead must reject before
  // presenting the seat as recently listening.
  const observer = new Database(DB);
  observer
    .prepare(
      "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
    )
    .run("2000-01-01 00:00:00", room, "me");
  const deadOwnerWatcher = startPoller([
    ...base,
    "--owner-pid",
    String(deadOwnerPid),
    "--timeout",
    "10",
  ]);
  active.add(deadOwnerWatcher.child);
  const deadOwnerResult = await deadOwnerWatcher.wait(2_000);
  active.delete(deadOwnerWatcher.child);
  const seenAfterDeadOwner = observer
    .prepare(
      "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
    )
    .get(room, "me").last_seen;
  observer.close();
  check(
    "an already-dead MCP owner cannot refresh watcher liveness",
    deadOwnerResult.code === 2 &&
      /owner MCP process.*ended/.test(deadOwnerResult.stderr) &&
      seenAfterDeadOwner === "2000-01-01 00:00:00" &&
      remainingLocks().length === 0,
    { deadOwnerResult, seenAfterDeadOwner, remainingLocks: remainingLocks() },
  );

  // A genuine duplicate remains fail-closed, but reports the exact lock so a
  // PID-reuse false positive is diagnosable. Both children are bounded and
  // explicitly reaped here.
  if (process.platform !== "win32") {
    const primary = startPoller([...base, "--timeout", "10"]);
    active.add(primary.child);
    const primaryLock = await waitForLock(lockPath, primary.child);
    const duplicate = startPoller([...base, "--timeout", "1"]);
    active.add(duplicate.child);
    const duplicateResult = await duplicate.wait(2_000);
    active.delete(duplicate.child);
    primary.child.kill("SIGTERM");
    const primaryResult = await primary.wait(2_000);
    active.delete(primary.child);
    check("duplicate watcher test established the primary lock", primaryLock, primary.output());
    check(
      "live-pid lock error names the inspectable lock without claiming ownership proof",
      duplicateResult.code === 2 &&
        duplicateResult.stderr.includes("watcher lock references live pid") &&
        !duplicateResult.stderr.includes("equivalent watcher") &&
        expectedLockPaths.some((path) => duplicateResult.stderr.includes(path)) &&
        primaryResult.code === 143 && remainingLocks().length === 0,
      { duplicateResult, primaryResult, remainingLocks: remainingLocks() },
    );
  }

  // SIGHUP used to bypass finally and strand the fail-closed lock.
  if (process.platform !== "win32") {
    const hungup = startPoller([...base, "--timeout", "10"]);
    active.add(hungup.child);
    const hupLock = await waitForLock(lockPath, hungup.child);
    hungup.child.kill("SIGHUP");
    const hupResult = await hungup.wait(2_000);
    active.delete(hungup.child);
    check("SIGHUP test established the watcher lock", hupLock, hungup.output());
    check(
      "SIGHUP exits 129 and removes the fail-closed lock",
      hupResult.code === 129 && remainingLocks().length === 0,
      { hupResult, remainingLocks: remainingLocks() },
    );
  }
  const replacement = startPoller([...base, "--timeout", "1"]);
  active.add(replacement.child);
  const replacementResult = await replacement.wait(2_500);
  active.delete(replacement.child);
  check(
    "a replacement watcher starts normally after SIGHUP cleanup",
    replacementResult.code === 124,
    replacementResult,
  );

  // A closed result pipe raises EPIPE at the quiet result write. It must exit
  // under the documented error code and clean the lock, not crash outside
  // finally and poison all later watches.
  const brokenPipe = startPoller([
    ...base,
    "--timeout",
    "1",
    "--ok-on-timeout",
  ]);
  active.add(brokenPipe.child);
  const pipeLock = await waitForLock(lockPath, brokenPipe.child);
  brokenPipe.child.stdout.destroy();
  const pipeResult = await brokenPipe.wait(2_500);
  active.delete(brokenPipe.child);
  check("EPIPE test established the watcher lock", pipeLock, brokenPipe.output());
  check(
    "broken stdout exits 2 and removes the watcher lock",
    pipeResult.code === 2 && remainingLocks().length === 0,
    { pipeResult, remainingLocks: remainingLocks() },
  );

  // Generated commands are bound to their issuing MCP PID. Once that owner
  // dies, a long-timeout watcher retires within one five-second heartbeat.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  active.add(owner);
  const ownerPid = owner.pid;
  const ownerBound = startPoller([
    ...base,
    "--owner-pid",
    String(ownerPid),
    "--timeout",
    "10",
  ]);
  active.add(ownerBound.child);
  const ownerLock = await waitForLock(ownedLockPath, ownerBound.child);
  const diagnosticBesideOwner = startPoller([...base, "--timeout", "10"]);
  active.add(diagnosticBesideOwner.child);
  const diagnosticLock = await waitForLock(
    lockPath,
    diagnosticBesideOwner.child,
  );
  owner.kill("SIGTERM");
  const ownerDeadline = Date.now() + 2_000;
  while (owner.exitCode === null && Date.now() < ownerDeadline) await sleep(20);
  if (owner.exitCode !== null) active.delete(owner);
  const ownerResult = await ownerBound.wait(6_500);
  active.delete(ownerBound.child);
  diagnosticBesideOwner.child.kill("SIGTERM");
  const diagnosticResult = await diagnosticBesideOwner.wait(2_000);
  active.delete(diagnosticBesideOwner.child);
  check(
    "owned and diagnostic watchers coexist; owned watcher retires with its MCP owner",
    ownerLock && diagnosticLock && ownerResult.code === 2 &&
      /owner MCP process.*ended/.test(ownerResult.stderr) &&
      diagnosticResult.code === 143 &&
      remainingLocks().length === 0,
    {
      ownerLock,
      diagnosticLock,
      ownerResult,
      diagnosticResult,
      remainingLocks: remainingLocks(),
    },
  );
} catch (error) {
  check("poller lifecycle harness completed", false, String(error));
} finally {
  for (const child of active) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const path of new Set(expectedLockPaths)) rmSync(path, { force: true });
  try {
    store?.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);

expect(failures).toBe(0);
});
