import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

test("indeterminate watcher lock metadata is handled without unsafe recovery", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const poller = join(root, "dist", "poller.js");
  const dir = mkdtempSync(join(tmpdir(), "aichat-poller-lock-"));
  const pollerTmp = join(dir, "poller-tmp");
  const dbPath = join(dir, "chat.db");
  let lockFd;
  let store;

  try {
    mkdirSync(pollerTmp, { mode: 0o700 });
    store = new ChatStore(dbPath);
    const room = mkRoom(store, "poller-lock-metadata").id;
    const agent = mkAgent(store, "me");
    store.joinRoom(room, agent, {});

    const canonicalDbPath = realpathSync(dbPath);
    const lockName =
      createHash("sha256")
        .update(
          JSON.stringify([
            canonicalDbPath,
            agent,
            room,
            "diagnostic",
            false,
          ]),
        )
        .digest("hex") + ".lock";
    const lockDir = join(
      pollerTmp,
      typeof process.getuid === "function"
        ? `agent-chat-pollers-${process.getuid()}`
        : "agent-chat-pollers",
    );
    mkdirSync(lockDir, { mode: 0o700 });
    const lockPath = join(lockDir, lockName);

    // Hold the file open at the exact point between exclusive publication and
    // metadata write. A concurrent launch must preserve exclusion without
    // inventing a stale owner or advising deletion.
    lockFd = openSync(lockPath, "wx", 0o600);
    const result = spawnSync(
      process.execPath,
      [
        poller,
        "--agent",
        agent,
        "--room",
        String(room),
        "--db",
        dbPath,
        "--interval",
        "5",
        "--timeout",
        "1",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: pollerTmp,
          TMP: pollerTmp,
          TEMP: pollerTmp,
        },
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "watcher lock metadata could not be read or validated",
    );
    expect(result.stderr).toContain("may be initializing or stale");
    expect(result.stderr).toContain("Retry without removing it");
    expect(result.stderr).toContain(`lock: ${lockPath}`);
    expect(result.stderr).not.toContain("stale watcher lock");
    expect(result.stderr).not.toContain("remove only");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("");
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
