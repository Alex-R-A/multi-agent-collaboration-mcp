import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import readline from "node:readline";
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
const CodexWorker = Function(
  `"use strict";\n${sourceBetween("class CodexWorker", "function deliveryPrompt(roomId)")}\nreturn CodexWorker;`,
)();
const makeClient = (child) => Function(
  "spawn", "readline",
  `"use strict";\n${sourceBetween("class AppServerClient", "class CodexWorker")}\nreturn AppServerClient;`,
)(() => child, readline);

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
  };
  return child;
}

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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

test("dispatcher selects its worker before paging", async () => {
  const { store, workerId } = setupWorkerStore(100);
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: workerId, intervalMs: 1_000, retainDiagnostics: true });
  const pending = vi.spyOn(store, "pendingDirected");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    expect(store.pendingDirected(100).pending.some((row) => row.agent_id === workerId)).toBe(false);
    await dispatcher.tick();
    expect(pending).toHaveBeenCalledWith(100, undefined, workerId);
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

test("completed turns that leave work unread are retried and reported", async () => {
  const { store, room, workerId } = setupWorkerStore();
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: workerId, intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await dispatcher.tick();
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(1);
    worker.completedTurns.set("turn-1", { id: "turn-1", status: "completed" });
    worker.activeTurnId = null;
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(2);
    worker.completedTurns.set("turn-2", { id: "turn-2", status: "completed" });
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

test("consumed work is not redelivered when its turn completes", async () => {
  const { store, room, workerId } = setupWorkerStore();
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: workerId, intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await dispatcher.tick();
    store.catchUp(room, workerId, 50, undefined, 100_000);
    worker.completedTurns.set("turn-1", { id: "turn-1", status: "completed" });
    worker.activeTurnId = null;
    await dispatcher.tick();
    expect(worker.starts).toHaveLength(1);
    expect(dispatcher.deliveries.size).toBe(0);
  } finally {
    store.close();
  }
});

test("dispatcher follows every target page using the target filter", async () => {
  const calls = [];
  const store = { pendingDirected(limit, after, agentId) {
    calls.push({ limit, after, agentId });
    return after
      ? { pending: [{ room_id: 2, room_name: "two", oldest_seq: 1 }] }
      : { pending: [{ room_id: 1, room_name: "one", oldest_seq: 1 }], next_after: { room_id: 1 } };
  } };
  const worker = makeWorker();
  const dispatcher = new Dispatcher({ store, worker, agentId: "target", intervalMs: 1_000, retainDiagnostics: true });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await dispatcher.tick();
  expect(calls).toEqual([
    { limit: 100, after: undefined, agentId: "target" },
    { limit: 100, after: { room_id: 1 }, agentId: "target" },
  ]);
  expect(dispatcher.dispatches.map((entry) => entry.key)).toEqual(["1:1", "2:1"]);
});

test("completion before start response leaves the worker idle for directed work", async () => {
  let resolveStart;
  const methods = [];
  const client = {
    onNotification: () => () => {},
    request(method) {
      methods.push(method);
      if (methods.length === 1) return new Promise((resolve) => { resolveStart = resolve; });
      return Promise.resolve({ turn: { id: "second" } });
    },
  };
  const worker = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: false });
  worker.threadId = "thread";
  const firstStart = worker.startTurn("initial task");
  worker.onNotification({ method: "turn/started", params: { turn: { id: "first" } } });
  worker.onNotification({ method: "turn/completed", params: { turn: { id: "first", status: "completed" } } });
  resolveStart({ turn: { id: "first" } });
  await firstStart;
  expect(worker.activeTurnId).toBeNull();
  const store = { pendingDirected: () => ({ pending: [{ room_id: 1, room_name: "one", oldest_seq: 1 }] }) };
  const dispatcher = new Dispatcher({ store, worker, agentId: "target", intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await dispatcher.tick();
  expect(methods).toEqual(["turn/start", "turn/start"]);
  worker.close();
});

test("normal dispatcher releases completed turn data over repeated deliveries", async () => {
  const client = { onNotification: () => () => {}, request: async () => ({ turn: { id: `t${++client.n}` } }), n: 0 };
  const worker = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: false });
  worker.threadId = "thread";
  worker.onNotification({ method: "item/completed", params: { turnId: "bootstrap", item: { type: "agentMessage", text: "bootstrap output" } } });
  expect(worker.textForTurn("bootstrap")).toBe("bootstrap output");
  worker.finishBootstrap();
  let pending = true;
  const store = { pendingDirected: () => ({ pending: pending ? [{ room_id: 1, room_name: "one", oldest_seq: client.n + 1 }] : [] }) };
  const dispatcher = new Dispatcher({ store, worker, agentId: "target", intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (let i = 0; i < 100; i++) {
    pending = true;
    await dispatcher.tick();
    const id = `t${i + 1}`;
    worker.onNotification({ method: "item/completed", params: { turnId: id, item: { type: "agentMessage", text: "retained payload" } } });
    worker.onNotification({ method: "item/completed", params: { turnId: id, item: { type: "commandExecution" } } });
    worker.onNotification({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
    pending = false;
    await dispatcher.tick();
  }
  expect(worker.agentMessages.size).toBe(0);
  expect(worker.commandExecutions.size).toBe(0);
  expect(worker.completedTurns.size).toBe(0);
  expect(dispatcher.dispatches).toHaveLength(0);
  worker.close();
});

test("self-test diagnostics and referenced completed turns remain available", () => {
  const client = { onNotification: () => () => {} };
  const worker = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: true });
  worker.finishBootstrap();
  worker.onNotification({ method: "item/completed", params: { turnId: "t", item: { type: "agentMessage", text: "output" } } });
  worker.onNotification({ method: "item/completed", params: { turnId: "t", item: { type: "commandExecution", status: "completed" } } });
  worker.onNotification({ method: "turn/completed", params: { turn: { id: "t", status: "completed" } } });
  worker.pruneCompletedTurns([]);
  expect(worker.textForTurn("t")).toBe("output");
  expect(worker.commandForTurn("t").status).toBe("completed");
  expect(worker.completedTurns.has("t")).toBe(true);
  worker.close();
  const normal = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: false });
  normal.completedTurns.set("kept", { id: "kept" });
  normal.completedTurns.set("removed", { id: "removed" });
  normal.pruneCompletedTurns([{ turnId: "kept" }]);
  expect([...normal.completedTurns.keys()]).toEqual(["kept"]);
  normal.close();
});

test("child exit rejects pending and future requests and clears timers", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const Client = makeClient(child);
  const client = new Client({ cwd: ROOT, env: {} });
  const pending = client.request("initialize");
  const rejection = expect(pending).rejects.toThrow("exited");
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await rejection;
  await expect(client.request("later")).rejects.toThrow("exited");
  expect(vi.getTimerCount()).toBe(0);
  expect((await client.failure).message).toContain("exited");
  await client.close();
});

test("spawn errors reject requests and worker close cancels turn wait timers", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const Client = makeClient(child);
  const client = new Client({ cwd: ROOT, env: {} });
  const pending = client.request("initialize");
  const rejection = expect(pending).rejects.toThrow("failed to start");
  child.emit("error", new Error("ENOENT"));
  await rejection;
  await expect(client.request("later")).rejects.toThrow("failed to start");
  const worker = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: false });
  const turn = worker.waitForTurn("uncompleted");
  const turnRejected = expect(turn).rejects.toThrow("closed");
  worker.close();
  await turnRejected;
  await client.close();
  expect(vi.getTimerCount()).toBe(0);
});

test("close clears its timer when the child exits immediately", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const Client = makeClient(child);
  const client = new Client({ cwd: ROOT, env: {} });
  await client.close();
  expect(child.signalCode).toBe("SIGTERM");
  expect(vi.getTimerCount()).toBe(0);
});

function runDispatcher(env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts/codex-dispatcher-poc.mjs"), "--room", "lifecycle", "--task", "test"], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5_000);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

test("missing executable fails and exits promptly through the real main path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-lifecycle-"));
  try {
    const result = await runDispatcher({ ...process.env, PATH: dir, AGENT_CHAT_DB: join(dir, "chat.db") });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Codex App Server failed to start");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-bootstrap child exit terminates the real main path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-lifecycle-"));
  try {
    const dbPath = join(dir, "chat.db");
    const store = new ChatStore(dbPath);
    const room = mkRoom(store, "lifecycle");
    const workerId = mkAgent(store, "z-worker");
    store.joinRoom(room.id, workerId);
    store.close();
    const fakeCodex = join(dir, "codex");
    writeFileSync(fakeCodex, `#!${process.execPath}
import readline from "node:readline";
let turns = 0;
const send = (value, callback) => process.stdout.write(JSON.stringify(value) + "\\n", callback);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread" } } });
  if (request.method === "turn/start") {
    turns++;
    const id = "turn-" + turns;
    if (turns === 1) {
      send({ method: "turn/started", params: { threadId: "thread", turn: { id } } });
      send({ method: "item/completed", params: { threadId: "thread", turnId: id, item: { type: "agentMessage", text: "AGENT_CHAT_PERSONA=z-worker" } } });
      send({ method: "turn/completed", params: { threadId: "thread", turn: { id, status: "completed" } } });
      send({ id: request.id, result: { turn: { id } } });
    } else {
      send({ id: request.id, result: { turn: { id } } }, () => setTimeout(() => process.exit(7), 50));
    }
  }
});
`);
    chmodSync(fakeCodex, 0o700);
    const result = await runDispatcher({ ...process.env, PATH: dir, AGENT_CHAT_DB: dbPath });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Worker ready");
    expect(result.stdout).toContain("Foreground assignment started");
    expect(result.stderr).toContain("Codex App Server exited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
