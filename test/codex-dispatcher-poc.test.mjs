import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";
import { afterEach, expect, test, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "scripts", "codex-dispatcher-poc.mjs"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`dispatcher source markers not found: ${start}`);
  return source.slice(from, to);
}

const Dispatcher = Function(
  `"use strict";
${sourceBetween("function deliveryPrompt(roomId)", "async function waitFor(")}
return Dispatcher;`,
)();

function setupWorkerStore(otherRecipients = 0) {
  const store = new ChatStore(":memory:");
  const room = mkRoom(store, `dispatcher-${otherRecipients}`).id;
  const sender = mkAgent(store, "sender");
  store.joinRoom(room, sender, {});
  for (let i = 0; i < otherRecipients; i++) {
    const recipient = `a${String(i).padStart(3, "0")}`;
    mkAgent(store, recipient);
    store.joinRoom(room, recipient, {});
    store.postMessage(room, sender, "other work", "text", [recipient], null, null);
  }
  const workerId = mkAgent(store, "z-worker");
  store.joinRoom(room, workerId, {});
  store.postMessage(room, sender, "target work", "text", [workerId], null, null);
  return { store, room, workerId };
}

function makeWorker() {
  return {
    activeTurnId: null,
    completedTurns: new Map(),
    starts: [],
    async startTurn(prompt) {
      const turnId = `turn-${this.starts.length + 1}`;
      this.starts.push({ prompt, turnId });
      this.activeTurnId = turnId;
      return turnId;
    },
    async steer() {
      return this.activeTurnId;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test("dispatcher pages past other recipients to reach its worker", async () => {
  const { store, workerId } = setupWorkerStore(100);
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: workerId, intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    expect(store.pendingDirected(100).pending.some((row) => row.agent_id === workerId)).toBe(false);
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(1);
    expect(dispatcher.dispatches[0]?.key).toMatch(/:\d+$/);
  } finally {
    store.close();
  }
});

test("dispatcher retries one failed delivery and then reports terminal failure", async () => {
  const { store, room, workerId } = setupWorkerStore();
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: workerId, intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  try {
    await dispatcher.tick();
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(1);

    worker.completedTurns.set("turn-1", { id: "turn-1", status: "failed" });
    worker.activeTurnId = null;
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(2);

    worker.completedTurns.set("turn-2", { id: "turn-2", status: "failed" });
    worker.activeTurnId = null;
    await dispatcher.tick();
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).toContain("Delivery failed");

    store.catchUp(room, workerId, 50, undefined, 100_000);
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(2);
  } finally {
    store.close();
  }
});
