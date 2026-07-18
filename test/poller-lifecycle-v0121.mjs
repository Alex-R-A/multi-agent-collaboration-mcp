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
import { ChatStore } from "../dist/db.js";

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
let expectedLockPaths = [];
const active = new Set();
const remainingLocks = () => expectedLockPaths.filter((path) => existsSync(path));
try {
  store = new ChatStore(DB);
  const room = store.createRoom("poller-life", null, null).id;
  for (const id of ["me", "peer"]) {
    store.upsertAgent(id, null, null, null);
    store.joinRoom(room, id);
  }
  const canonical = realpathSync(DB);
  const lockName =
    createHash("sha256")
      .update(JSON.stringify([canonical, "me", room, null, false]))
      .digest("hex") + ".lock";
  lockPath = join(
    pollerTmp,
    typeof process.getuid === "function"
      ? `agent-chat-pollers-${process.getuid()}`
      : "agent-chat-pollers",
    lockName,
  );
  expectedLockPaths = [
    lockPath,
    join(pollerTmp, "agent-chat-pollers", lockName),
  ];
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
  store.postMessage(room, "peer", "during-final-sleep", "text", null, null);
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

  // A pre-upgrade poller owns only the legacy path. The new build must honor
  // that lock before touching its UID path, or a rolling deploy can create a
  // duplicate watcher for the same scope.
  const legacyLockPath = join(pollerTmp, "agent-chat-pollers", lockName);
  writeFileSync(
    legacyLockPath,
    JSON.stringify({ pid: process.pid, token: "pre-upgrade-fixture" }),
  );
  const migrationBlocked = startPoller([...base, "--timeout", "1"]);
  active.add(migrationBlocked.child);
  const migrationResult = await migrationBlocked.wait(2_000);
  active.delete(migrationBlocked.child);
  check(
    "a legacy-version lock still blocks a post-upgrade duplicate",
    migrationResult.code === 2 && migrationResult.stderr.includes(legacyLockPath) &&
      (lockPath === legacyLockPath || !existsSync(lockPath)),
    { migrationResult, uidLockExists: existsSync(lockPath) },
  );
  rmSync(legacyLockPath, { force: true });

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
      "duplicate watcher error names its inspectable lock",
      duplicateResult.code === 2 &&
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
    "an equivalent watcher starts normally after SIGHUP cleanup",
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
  const ownerLock = await waitForLock(lockPath, ownerBound.child);
  owner.kill("SIGTERM");
  const ownerDeadline = Date.now() + 2_000;
  while (owner.exitCode === null && Date.now() < ownerDeadline) await sleep(20);
  if (owner.exitCode !== null) active.delete(owner);
  const ownerResult = await ownerBound.wait(6_500);
  active.delete(ownerBound.child);
  check(
    "generated watcher retires after its MCP owner ends",
    ownerLock && ownerResult.code === 2 &&
      /owner MCP process.*ended/.test(ownerResult.stderr) &&
      remainingLocks().length === 0,
    { ownerLock, ownerResult, remainingLocks: remainingLocks() },
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
process.exitCode = failures === 0 ? 0 : 1;
