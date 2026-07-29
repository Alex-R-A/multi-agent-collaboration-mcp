// Bounded sequential test runner. Every file gets its own process group so a
// timeout or failed cleanup cannot orphan nested MCP/web children.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_TIMEOUT_MS = 30_000;
// Per-file overrides. The bound exists to stop a HUNG file from stalling the
// suite, not to cap legitimate work: features-persona spawns a dozen watcher
// children whose reactions are gated by the poller's five-second MINIMUM probe
// interval, so its floor is set by the product, not by the test. Shortening it
// to fit 30s would mean deleting watcher-lifecycle coverage.
const TIMEOUT_OVERRIDES_MS = {
  "features-persona.mjs": 90_000,
};
const files = [
  "bounded-lines.mjs",
  "my-mentions.mjs",
  "features-v05.mjs",
  "fixes-v052.mjs",
  "fixes-v061.mjs",
  "fixes-v063.mjs",
  "fixes-v064.mjs",
  "fixes-v07.mjs",
  "fixes-v071.mjs",
  "fixes-v072.mjs",
  "fixes-v09.mjs",
  "fixes-v078.mjs",
  "fixes-v0710.mjs",
  "fixes-v082.mjs",
  "fixes-v084.mjs",
  "features-v090.mjs",
  "features-v0100.mjs",
  "features-v0110.mjs",
  "features-v0120.mjs",
  "mcp-lifecycle-v0121.mjs",
  "poller-lifecycle-v0121.mjs",
  "web-error-status.mjs",
  "web-participate.mjs",
  "features-persona.mjs",
];

let active = null;
const grouped = process.platform !== "win32";

function killActive(signal = "SIGKILL") {
  if (!active?.pid) return;
  try {
    if (grouped) process.kill(-active.pid, signal);
    else active.kill(signal);
  } catch {}
}

function run(file) {
  const timeoutMs = TIMEOUT_OVERRIDES_MS[file] ?? TEST_TIMEOUT_MS;
  return new Promise((resolve) => {
    const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
    const child = spawn(process.execPath, [path], {
      stdio: "inherit",
      detached: grouped,
      // Keep suite behavior deterministic even when an operator has opted a
      // deployed MCP into longer waits. Tests that cover the opt-in override
      // this explicitly in their child environment.
      env: { ...process.env, AGENT_CHAT_MAX_WAIT_SECONDS: "25" },
    });
    active = child;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killActive();
    }, timeoutMs);
    child.on("error", (error) => {
      spawnError = error;
      killActive();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // The direct test process is gone. Kill anything it failed to reap that
      // still occupies its process group before starting the next file.
      killActive();
      active = null;
      resolve({ file, code, signal, timedOut, spawnError });
    });
  });
}

async function stopFromSignal(code) {
  killActive();
  process.exit(code);
}
process.once("SIGINT", () => void stopFromSignal(130));
process.once("SIGTERM", () => void stopFromSignal(143));
process.once("SIGHUP", () => void stopFromSignal(129));
process.once("exit", () => killActive());

let failed = false;
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  const result = await run(file);
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    const reason = result.timedOut
      ? `timed out after ${TIMEOUT_OVERRIDES_MS[file] ?? TEST_TIMEOUT_MS}ms`
      : result.spawnError
        ? `spawn failed: ${result.spawnError.message}`
        : `exited ${result.code ?? result.signal}`;
    process.stderr.write(`test runner: ${file} ${reason}\n`);
    failed = true;
    break;
  }
}

process.exitCode = failed ? 1 : 0;
