import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CHECK = join(ROOT, "..", "dist", "check.js");
const POLLER = join(ROOT, "..", "dist", "poller.js");

function run(command, args) {
  const result = spawnSync("node", [command, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe("CLI argument validation for check", () => {
  it("rejects empty agent values and missing scope dependencies", () => {
    const emptyAgent = run(CHECK, ["--agent", ""]);
    expect(emptyAgent.status).toBe(2);
    expect(emptyAgent.stderr).toContain("requires a non-empty value");

    const missingAgent = run(CHECK, ["--room", "main"]);
    expect(missingAgent.status).toBe(2);
    expect(missingAgent.stderr).toContain("--agent is required");

    const mentionsOnlyNeedsAgent = run(CHECK, ["--mentions-only", "--room", "main"]);
    expect(mentionsOnlyNeedsAgent.status).toBe(2);
    expect(mentionsOnlyNeedsAgent.stderr).toContain("--mentions-only requires --agent");
  });

  it("rejects malformed --since inputs and unsupported usage", () => {
    const sinceNoRoom = run(CHECK, ["--agent", "hero", "--since", "3"]);
    expect(sinceNoRoom.status).toBe(2);
    expect(sinceNoRoom.stderr).toContain("--since requires --room");

    const sinceNotNumeric = run(CHECK, [
      "--agent",
      "hero",
      "--room",
      "main",
      "--since",
      "3.14",
    ]);
    expect(sinceNotNumeric.status).toBe(2);
    expect(sinceNotNumeric.stderr).toContain("--since must be a non-negative integer");
  });

  it("rejects unknown flags and keeps help output stable", () => {
    const unknown = run(CHECK, ["--hero"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown argument: --hero");

    const help = run(CHECK, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });
});

describe("CLI argument validation for poller", () => {
  it("rejects missing and malformed arguments", () => {
    const missingAgent = run(POLLER, ["--timeout", "1"]);
    expect(missingAgent.status).toBe(2);
    expect(missingAgent.stderr).toContain("--agent is required");

    const emptyAgent = run(POLLER, ["--agent", ""]);
    expect(emptyAgent.status).toBe(2);
    expect(emptyAgent.stderr).toContain("requires a non-empty value");

    const unsupportedSince = run(POLLER, ["--agent", "hero", "--since", "1"]);
    expect(unsupportedSince.status).toBe(2);
    expect(unsupportedSince.stderr).toContain("--since is intentionally unsupported");
  });

  it("rejects invalid range and inline flag usage", () => {
    const lowInterval = run(POLLER, ["--agent", "hero", "--interval", "4"]);
    expect(lowInterval.status).toBe(2);
    expect(lowInterval.stderr).toContain("between 5 and 3600");

    const nonNumericOwner = run(POLLER, ["--agent", "hero", "--owner-pid", "nope"]);
    expect(nonNumericOwner.status).toBe(2);
    expect(nonNumericOwner.stderr).toContain("must be an integer");

    const mentionsWithValue = run(POLLER, [
      "--agent",
      "hero",
      "--mentions-only=1",
    ]);
    expect(mentionsWithValue.status).toBe(2);
    expect(mentionsWithValue.stderr).toContain("--mentions-only takes no value");

    const timeoutWithValue = run(POLLER, [
      "--agent",
      "hero",
      "--ok-on-timeout=1",
    ]);
    expect(timeoutWithValue.status).toBe(2);
    expect(timeoutWithValue.stderr).toContain("--ok-on-timeout takes no value");
  });

  it("reports help with exit 0", () => {
    const help = run(POLLER, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });
});
