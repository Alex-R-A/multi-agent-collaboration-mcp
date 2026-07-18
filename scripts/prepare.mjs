// npm runs the `prepare` script in two very different places: a git-dependency
// install (src/ present: build it) and inside an extracted PUBLISHED tarball
// (src/ and tsconfig.json deliberately not shipped; dist/ already is).
// Running tsc unconditionally made `npm install` fail inside the tarball.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!existsSync(new URL("../src", import.meta.url))) {
  process.exit(0); // packaged tarball: dist is prebuilt, nothing to do
}
const root = fileURLToPath(new URL("..", import.meta.url));
// Invoke the two build programs directly. `npm run build` adds an npm process
// and a shell between this watchdog and tsc; killing only that parent on a
// timeout can leave the compiler running. These direct children do not spawn
// long-lived descendants (stamp-build's git probes have their own 10s caps).
const steps = [
  fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  fileURLToPath(new URL("./stamp-build.mjs", import.meta.url)),
];

const grouped = process.platform !== "win32";
let active = null;
function killActive() {
  if (!active?.pid) return;
  try {
    if (grouped) process.kill(-active.pid, "SIGKILL");
    else active.kill("SIGKILL");
  } catch {}
}
function stopFromSignal(code) {
  killActive();
  process.exit(code);
}
process.once("SIGHUP", () => stopFromSignal(129));
process.once("SIGINT", () => stopFromSignal(130));
process.once("SIGTERM", () => stopFromSignal(143));
process.once("exit", killActive);

async function runStep(script) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: "inherit",
      detached: grouped,
      // prepare.mjs may be invoked by absolute path from any directory. Keep
      // tsc's project discovery inside this repository rather than compiling a
      // caller's unrelated (and potentially huge) working tree.
      cwd: root,
    });
    active = child;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killActive();
    }, 120_000);
    child.once("error", (error) => {
      spawnError = error;
      killActive();
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      killActive();
      active = null;
      resolve({ code, signal, timedOut, spawnError });
    });
  });
}

for (const script of steps) {
  const result = await runStep(script);
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    const reason = result.timedOut
      ? "timed out after 120000ms"
      : result.spawnError
        ? `spawn failed: ${result.spawnError.message}`
        : `exited ${result.code ?? result.signal}`;
    process.stderr.write(`build step ${script} ${reason}\n`);
    process.exitCode = 1;
    break;
  }
}
