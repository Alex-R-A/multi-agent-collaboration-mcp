// Bounded sequential Vitest supervisor. Every file gets its own process group
// so a timeout or failed cleanup cannot orphan nested MCP/web children.
import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createVitest } from "vitest/node";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VITEST = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
const TEST_TIMEOUT_MS = 30_000;
// The bound stops a hung file from stalling the suite. features-persona spawns
// watcher children whose reactions are gated by the poller's five-second probe
// interval, so its higher bound is product-driven rather than a blanket escape.
const TIMEOUT_OVERRIDES_MS = {
  "test/features-persona.mjs": 90_000,
};

let active = null;
const grouped = process.platform !== "win32";

function displayPath(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function killActive(signal = "SIGKILL") {
  if (!active?.pid) return;
  try {
    if (grouped) process.kill(-active.pid, signal);
    else active.kill(signal);
  } catch {}
}

async function discoverFiles() {
  const context = await createVitest("test", {
    root: ROOT,
    run: true,
    watch: false,
  });
  try {
    const specifications = await context.getRelevantTestSpecifications();
    return [...new Set(specifications.map((specification) => specification.moduleId))].sort(
      (left, right) => displayPath(left).localeCompare(displayPath(right)),
    );
  } finally {
    await context.close();
  }
}

function run(file) {
  const name = displayPath(file);
  const timeoutMs = TIMEOUT_OVERRIDES_MS[name] ?? TEST_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, "run", file], {
      cwd: ROOT,
      stdio: "inherit",
      detached: grouped,
      // Keep suite behavior deterministic even when an operator has opted a
      // deployed MCP into longer waits. Tests covering the opt-in override this
      // explicitly in their child environment.
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
      // The direct Vitest process is gone. Kill any descendants it failed to
      // reap that still occupy its process group before starting the next file.
      killActive();
      active = null;
      resolve({ file: name, code, signal, timedOut, spawnError, timeoutMs });
    });
  });
}

function stopFromSignal(code) {
  killActive();
  process.exit(code);
}
process.once("SIGINT", () => stopFromSignal(130));
process.once("SIGTERM", () => stopFromSignal(143));
process.once("SIGHUP", () => stopFromSignal(129));
process.once("exit", () => killActive());

const files = await discoverFiles();
if (files.length === 0) {
  process.stderr.write("test runner: no test files discovered\n");
  process.exitCode = 1;
} else {
  let failed = false;
  for (const file of files) {
    process.stdout.write(`\n=== ${displayPath(file)} ===\n`);
    const result = await run(file);
    if (result.code !== 0 || result.timedOut || result.spawnError) {
      const reason = result.timedOut
        ? `timed out after ${result.timeoutMs}ms`
        : result.spawnError
          ? `spawn failed: ${result.spawnError.message}`
          : `exited ${result.code ?? result.signal}`;
      process.stderr.write(`test runner: ${result.file} ${reason}\n`);
      failed = true;
      break;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
