// Focused poller lifecycle regressions. Single-fire children only; each carries
// an explicit deadline and the suite runner owns the enclosing process group.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLLER = join(ROOT, "dist", "poller.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const DB = join(dir, "chat.db");
let store;
let lockPath = null;
const active = new Set();
try {
  store = new ChatStore(DB);
  const room = store.createRoom("poller-life", null, null).id;
  for (const id of ["me", "peer"]) {
    store.upsertAgent(id, null, null, null);
    store.joinRoom(room, id);
  }
  const canonical = realpathSync(DB);
  lockPath = join(
    tmpdir(),
    "agent-chat-pollers",
    createHash("sha256")
      .update(JSON.stringify([canonical, "me", room, null, false]))
      .digest("hex") + ".lock",
  );
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
      hupResult.code === 129 && !existsSync(lockPath),
      { hupResult, lockExists: existsSync(lockPath) },
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
    pipeResult.code === 2 && !existsSync(lockPath),
    { pipeResult, lockExists: existsSync(lockPath) },
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
      !existsSync(lockPath),
    { ownerLock, ownerResult, lockExists: existsSync(lockPath) },
  );
} catch (error) {
  check("poller lifecycle harness completed", false, String(error));
} finally {
  for (const child of active) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (lockPath) rmSync(lockPath, { force: true });
  try {
    store?.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
