import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLLER = join(ROOT, "dist", "poller.js");
const FIRST_LOCK_READ_EMPTY_MARKER = "AICHAT_TEST_FIRST_LOCK_READ_EMPTY";
const FIRST_LOCK_READ_EMPTY_PRELOAD = `data:text/javascript;base64,${Buffer.from(`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalReadFileSync = fs.readFileSync;
const target = process.env.AICHAT_TEST_INTERCEPT_LOCK_PATH;
let intercepted = false;
fs.readFileSync = function (path, ...args) {
  if (!intercepted && path === target) {
    intercepted = true;
    process.stderr.write("${FIRST_LOCK_READ_EMPTY_MARKER}\\n");
    return "";
  }
  return Reflect.apply(originalReadFileSync, fs, [path, ...args]);
};
syncBuiltinESMExports();
`).toString("base64")}`;

function createFixture(label) {
  const dir = mkdtempSync(join(tmpdir(), "aichat-poller-lock-"));
  const pollerTmp = join(dir, "poller-tmp");
  const dbPath = join(dir, "chat.db");
  let store;
  try {
    mkdirSync(pollerTmp, { mode: 0o700 });
    store = new ChatStore(dbPath);
    const room = mkRoom(store, label).id;
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

    return {
      agent,
      dbPath,
      dir,
      lockPath: join(lockDir, lockName),
      pollerTmp,
      room,
      store,
    };
  } catch (error) {
    try {
      store?.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function pollerArgs(fixture, timeoutSeconds) {
  return [
    POLLER,
    "--agent",
    fixture.agent,
    "--room",
    String(fixture.room),
    "--db",
    fixture.dbPath,
    "--interval",
    "5",
    "--timeout",
    String(timeoutSeconds),
  ];
}

function pollerEnv(fixture, extra = {}) {
  return {
    ...process.env,
    TMPDIR: fixture.pollerTmp,
    TMP: fixture.pollerTmp,
    TEMP: fixture.pollerTmp,
    ...extra,
  };
}

function destroyFixture(fixture) {
  try {
    fixture.store.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("indeterminate watcher lock metadata is handled without unsafe recovery", () => {
  const fixture = createFixture("poller-lock-indeterminate");
  let lockFd;

  try {
    // Hold the file open at the exact point between exclusive publication and
    // metadata write. A concurrent launch must preserve exclusion without
    // inventing a stale owner or advising deletion.
    lockFd = openSync(fixture.lockPath, "wx", 0o600);
    const result = spawnSync(
      process.execPath,
      pollerArgs(fixture, 1),
      {
        encoding: "utf8",
        env: pollerEnv(fixture),
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
    expect(result.stderr).toContain(`lock: ${fixture.lockPath}`);
    expect(result.stderr).not.toContain("stale watcher lock");
    expect(result.stderr).not.toContain("remove only");
    expect(existsSync(fixture.lockPath)).toBe(true);
    expect(readFileSync(fixture.lockPath, "utf8")).toBe("");
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    destroyFixture(fixture);
  }
});

test("transient lock metadata is reread without weakening ownership", () => {
  const fixture = createFixture("poller-lock-transient");
  const published = JSON.stringify({
    pid: process.pid,
    token: "published-owner",
  });

  try {
    writeFileSync(fixture.lockPath, published, { mode: 0o600 });

    const contender = spawnSync(
      process.execPath,
      ["--import", FIRST_LOCK_READ_EMPTY_PRELOAD, ...pollerArgs(fixture, 1)],
      {
        encoding: "utf8",
        env: pollerEnv(fixture, {
          AICHAT_TEST_INTERCEPT_LOCK_PATH: fixture.lockPath,
        }),
        timeout: 5_000,
      },
    );

    expect(contender.error).toBeUndefined();
    expect(contender.status).toBe(2);
    expect(contender.stderr).toContain(FIRST_LOCK_READ_EMPTY_MARKER);
    expect(contender.stderr).toContain(
      `watcher lock references live pid ${process.pid}`,
    );
    expect(contender.stderr).not.toContain(
      "watcher lock metadata could not be read or validated",
    );
    expect(readFileSync(fixture.lockPath, "utf8")).toBe(published);
  } finally {
    destroyFixture(fixture);
  }
});
