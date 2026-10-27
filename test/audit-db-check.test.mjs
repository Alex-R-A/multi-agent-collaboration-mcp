import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ChatStore } from "../src/db.ts";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

test.each(["", " ", " :memory: "])("anonymous SQLite path %j remains supported", (path) => {
  const store = new ChatStore(path);
  try {
    expect(store.listRooms().rooms).toEqual([]);
  } finally {
    store.close();
  }
});

if (process.platform !== "win32") {
  test.each(["unrelated contents", "SQLite format 3"])("invalid database %j leaves file and neighbors untouched", (contents) => {
    const dir = mkdtempSync(join(tmpdir(), "aichat-invalid-database-"));
    const path = join(dir, "unrelated.txt");
    const paths = [path, `${path}-wal`, `${path}-shm`];
    let store;
    try {
      for (const file of paths) {
        writeFileSync(file, contents);
        chmodSync(file, 0o644);
      }
      expect(() => { store = new ChatStore(path); }).toThrow(/not a database/);
      for (const file of paths) {
        expect(statSync(file).mode & 0o777).toBe(0o644);
        expect(readFileSync(file, "utf8")).toBe(contents);
      }
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("an agent-scoped pending sweep preserves global ordering and pagination", () => {
  const store = new ChatStore(":memory:");
  try {
    const sender = mkAgent(store, "sender");
    const viewer = mkAgent(store, "z-viewer");
    const rooms = Array.from({ length: 3 }, (_, i) => mkRoom(store, `room-${i}`));
    for (const room of rooms) {
      store.joinRoom(room.id, sender);
      store.joinRoom(room.id, viewer);
      store.postMessage(room.id, sender, "target", "text", [viewer], null, null);
    }
    for (let i = 0; i < 105; i++) {
      const other = mkAgent(store, `a-other-${String(i).padStart(3, "0")}`);
      store.joinRoom(rooms[0].id, other);
      store.postMessage(rooms[0].id, sender, "other", "text", [other], null, null);
    }
    const expected = store.pendingDirected(200).pending.filter((row) => row.agent_id === viewer);
    const actual = [];
    let after;
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      const page = store.pendingDirected(1, after, viewer);
      expect(page.pending.every((row) => row.agent_id === viewer)).toBe(true);
      actual.push(...page.pending);
      if (!page.next_after) break;
      expect(page.truncated).toBe(true);
      after = page.next_after;
    }
    // Idle durations can cross a clock second between reads; compare the
    // durable delivery fields that define ordering and pagination.
    const durable = (rows) => rows.map(({ idle_seconds: _idleSeconds, ...row }) => row);
    expect(durable(actual)).toEqual(durable(expected));
    expect(actual).toHaveLength(3);
    expect(store.pendingDirected(200).pending).toHaveLength(108);
    expect(store.pendingDirected(10, undefined, "missing").pending).toEqual([]);
  } finally {
    store.close();
  }
});

test("message slicing preserves codepoint lengths and progress at small caps", () => {
  const store = new ChatStore(":memory:");
  try {
    const author = mkAgent(store, "author");
    const room = mkRoom(store, "slices");
    store.joinRoom(room.id, author);
    const body = "A\u{1f600}\u0001B".repeat(12);
    const posted = store.postMessage(room.id, author, body, "text", null, null, null);
    for (const cap of [1, 2, 3, 9]) {
      let offset = 0;
      let reconstructed = "";
      for (let page = 0; page < body.length; page++) {
        const result = store.getMessage(room.id, posted.seq, offset, cap);
        expect(result.length).toBe([...body].length);
        expect(result.offset).toBe(offset);
        expect(result.next_offset).toBeGreaterThan(offset);
        reconstructed += result.content;
        offset = result.next_offset;
        if (!result.truncated) break;
      }
      expect(reconstructed).toBe(body);
      expect(offset).toBe([...body].length);
    }
    expect(store.getMessage(room.id, posted.seq, 1000, 3)).toMatchObject({
      content: "", length: 48, offset: 1000, next_offset: 1000, truncated: false,
    });
  } finally {
    store.close();
  }
});

test("mentions-only check reports all unread messages in each firing room", () => {
  const dir = mkdtempSync(join(tmpdir(), "aichat-audit-check-"));
  const path = join(dir, "chat.db");
  const store = new ChatStore(path);
  try {
    const reader = mkAgent(store, "reader");
    const writer = mkAgent(store, "writer");
    const firing = mkRoom(store, "firing");
    const ambient = mkRoom(store, "ambient");
    for (const room of [firing, ambient]) {
      store.joinRoom(room.id, reader);
      store.joinRoom(room.id, writer);
      store.postMessage(room.id, writer, "broadcast", "text", null, null, null);
    }
    store.postMessage(firing.id, writer, "directed", "text", [reader], null, null);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../dist/check.js", import.meta.url)),
      "--agent", reader, "--mentions-only", "--db", path,
    ], { encoding: "utf8", timeout: 5000, env: { ...process.env, AGENT_CHAT_DB: path } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      unread: 3,
      unread_mentions: 1,
      rooms_with_updates: [{ room_id: firing.id, name: "firing", unread: 2, directed: 1 }],
    });
    expect(store.getCursor(firing.id, reader).last_read_seq).toBe(0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
