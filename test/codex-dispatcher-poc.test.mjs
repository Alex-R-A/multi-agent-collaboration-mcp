import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import readline from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatStore } from "../dist/db.js";
import { windowsJobLaunch } from "../scripts/windows-job.mjs";
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
const makeClient = (child, spawnChild = () => child, platform = process.platform, launchWindows = windowsJobLaunch) => Function(
  "spawn", "readline", "process", "windowsJobLaunch",
  `"use strict";\n${sourceBetween("class AppServerClient", "class CodexWorker")}\nreturn AppServerClient;`,
)(spawnChild, readline, new Proxy(process, {
  get: (target, key) => key === "platform" ? platform : Reflect.get(target, key),
}), launchWindows);

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
  let pending = false;
  const store = { pendingDirected: () => ({ pending: pending ? [{ room_id: 1, room_name: "one", oldest_seq: 1 }] : [] }) };
  const dispatcher = new Dispatcher({ store, worker, agentId: "target", intervalMs: 1_000 });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await dispatcher.tick();
  expect(worker.completedTurns.has("first")).toBe(true);
  resolveStart({ turn: { id: "first" } });
  await firstStart;
  expect(worker.activeTurnId).toBeNull();
  await dispatcher.tick();
  expect(worker.completedTurns.size).toBe(0);
  pending = true;
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

test("Windows client owns the job wrapper and preserves App Server arguments", async () => {
  const child = fakeChild();
  const spawnChild = vi.fn(() => child);
  const wrapped = { file: "C:\\Windows\\powershell.exe", args: ["encoded-launch"] };
  const launchWindows = vi.fn(() => wrapped);
  const Client = makeClient(child, spawnChild, "win32", launchWindows);
  const env = { AGENT_CHAT_DB: "unused" };
  const db = "C:\\chat's work\\data.db";
  const client = new Client({ cwd: ROOT, env, mcpDbPath: db });
  try {
    expect(launchWindows).toHaveBeenCalledWith("codex", [
      "app-server", "-c", `mcp_servers.agent-chat.env.AGENT_CHAT_DB=${JSON.stringify(db)}`,
      "--listen", "stdio://",
    ]);
    expect(spawnChild).toHaveBeenCalledWith(wrapped.file, wrapped.args, {
      cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true,
    });
    await client.close();
    expect(child.signalCode).toBe("SIGTERM");
    expect(client.close()).toBe(client.closePromise);
  } finally {
    await client.close();
  }
});

test("Windows launcher keeps paths and metacharacters out of PowerShell source", () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  const args = ["", "two words", "quote\"", "trailing\\", "$(bad); & ` ' \u03bb"];
  try {
    const launch = windowsJobLaunch("C:\\space's dir\\codex.exe", args);
    expect(launch.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(launch.args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(launch.args.at(-1), "base64").toString("utf16le");
    const encodedConfig = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
    expect(encodedConfig).toBeDefined();
    const config = JSON.parse(Buffer.from(encodedConfig, "base64").toString("utf8"));
    expect(config).toEqual({
      source: join(ROOT, "scripts", "windows-job.cs"),
      command: "C:\\space's dir\\codex.exe", arguments: args,
    });
    expect(script).not.toContain("$(bad)");
    expect(script).not.toContain("space's dir");
  } finally {
    vi.unstubAllEnvs();
  }
});

function runDispatcher(env, onChild = () => {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts/codex-dispatcher-poc.mjs"), "--room", "lifecycle", "--task", "test"], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    onChild(child);
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

test.each(["initialize", "thread/start", "turn/start", "turn/steer"])("a timed-out %s terminates the client and rejects later control requests", async (method) => {
  vi.useFakeTimers();
  const child = fakeChild();
  const Client = makeClient(child);
  const client = new Client({ cwd: ROOT, env: {} });
  const requests = [];
  child.stdin.on("data", (chunk) => requests.push(JSON.parse(chunk.toString())));
  const request = client.request(method, {}, 5);
  const rejected = expect(request).rejects.toThrow(`${method} timed out`);
  await vi.advanceTimersByTimeAsync(5);
  await rejected;
  try {
    expect(client.error?.message).toContain(`${method} timed out`);
    expect((await client.failure).message).toContain(`${method} timed out`);
    await expect(client.request("turn/start")).rejects.toThrow(`${method} timed out`);
    expect(requests).toHaveLength(1);
    expect(child.signalCode).toBe("SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await client.close();
  }
});

test("a lost start response cannot be blindly retried or revived by a late notification", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const Client = makeClient(child);
  const client = new Client({ cwd: ROOT, env: {} });
  const request = client.request.bind(client);
  client.request = (method, params) => request(method, params, 5);
  const requests = [];
  child.stdin.on("data", (chunk) => requests.push(JSON.parse(chunk.toString())));
  const worker = new CodexWorker(client, { cwd: ROOT, model: "test", ephemeral: false });
  worker.threadId = "thread";
  const dispatcher = new Dispatcher({
    store: { pendingDirected: () => ({ pending: [{ room_id: 1, room_name: "one", oldest_seq: 1 }] }) },
    worker, agentId: "target", intervalMs: 500,
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const firstTick = dispatcher.tick();
    await vi.advanceTimersByTimeAsync(5);
    await firstTick;
    expect(client.error?.message).toContain("turn/start timed out");
    expect(dispatcher.deliveries.size).toBe(0);
    client.receive(JSON.stringify({ method: "turn/started", params: { threadId: "thread", turn: { id: "unknown-first" } } }));
    await dispatcher.tick();
    expect(worker.activeTurnId).toBeNull();
    expect(requests.map((entry) => entry.method)).toEqual(["turn/start"]);
  } finally {
    worker.close();
    await client.close();
  }
});

test.each([false, true])("real main holds foreground startup before dispatching directed work, active=%s", async (active) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-start-order-"));
  let processChild;
  let resultPromise;
  try {
    const path = join(dir, "chat.db");
    const store = new ChatStore(path);
    try {
      const room = mkRoom(store, "lifecycle");
      const workerId = mkAgent(store, "z-worker");
      const sender = mkAgent(store, "sender");
      store.joinRoom(room.id, workerId);
      store.joinRoom(room.id, sender);
      store.postMessage(room.id, sender, "initial directed work", "text", [workerId], null, null);
    } finally {
      store.close();
    }
    const trace = join(dir, "trace.jsonl");
    const release = join(dir, "release");
    const executable = join(dir, "codex");
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
import readline from "node:readline";
let bootstrapped = false;
const send = (value, callback) => process.stdout.write(JSON.stringify(value) + "\\n", callback);
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread" } } });
  if (request.method === "turn/start" && !bootstrapped) {
    bootstrapped = true;
    send({ method: "item/completed", params: { threadId: "thread", turnId: "bootstrap", item: { type: "agentMessage", text: "AGENT_CHAT_PERSONA=z-worker" } } });
    send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "bootstrap", status: "completed" } } });
    send({ id: request.id, result: { turn: { id: "bootstrap" } } });
  } else if (request.method === "turn/start" && request.params.input[0].text === "test") {
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: "foreground" } } });
    if (!${active}) send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "foreground", status: "completed" } } });
    record({ kind: "foreground-held", method: request.method });
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      send({ id: request.id, result: { turn: { id: "foreground" } } });
    }, 10);
  } else if (request.method === "turn/start" || request.method === "turn/steer") {
    record({ kind: "delivery", method: request.method, expectedTurnId: request.params.expectedTurnId });
    send({ id: request.id, result: { turn: { id: "delivery" } } }, () => {
      if (existsSync(${JSON.stringify(release)})) process.exit(7);
    });
  }
});
`);
    chmodSync(executable, 0o700);
    resultPromise = runDispatcher({ ...process.env, PATH: dir, AGENT_CHAT_DB: path }, (child) => { processChild = child; });
    const entries = () => readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await vi.waitFor(() => expect(entries().some((entry) => entry.kind === "foreground-held")).toBe(true), { timeout: 3_000, interval: 10 });
    expect(entries().map((entry) => entry.kind)).toEqual(["foreground-held"]);
    writeFileSync(release, "release");
    const result = await resultPromise;
    expect(result.timedOut).toBe(false);
    expect(entries()).toEqual([
      { kind: "foreground-held", method: "turn/start" },
      { kind: "delivery", method: active ? "turn/steer" : "turn/start", ...(active ? { expectedTurnId: "foreground" } : {}) },
    ]);
    expect(result.stdout).toContain("Foreground assignment started turn=foreground");
  } finally {
    if (processChild?.exitCode === null && processChild?.signalCode === null) processChild.kill("SIGTERM");
    if (resultPromise) await resultPromise;
    rmSync(dir, { recursive: true, force: true });
  }
});

function processRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  // An orphan may briefly remain a zombie until its new parent reaps it.
  // Zombies have terminated; treating kill(pid, 0) as liveness misreports them.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
  if (state.error) throw state.error;
  return state.status === 0 && !state.stdout.trim().startsWith("Z");
}

test.skipIf(process.platform === "win32").each(["normal", "forced", "already-exited"])("owned process-group cleanup terminates a ready descendant on %s close", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-owned-group-"));
  let client;
  let descendant;
  try {
    const fixture = join(dir, "fixture.mjs");
    writeFileSync(fixture, `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
if (${JSON.stringify(mode)} === "forced") process.on("SIGTERM", () => {});
descendant.once("message", () => {
  process.stdout.write(JSON.stringify({ method: "fixture/ready", params: { pid: descendant.pid } }) + "\\n", () => {
    if (${JSON.stringify(mode)} === "already-exited") process.exit(0);
  });
});
setInterval(() => {}, 1000);
`);
    const Client = makeClient(null, (_command, _args, options) => spawn(process.execPath, [fixture], options));
    client = new Client({ cwd: dir, env: { ...process.env, AGENT_CHAT_DB: join(dir, "unused.db") } });
    const exited = once(client.child, "exit");
    descendant = await new Promise((resolve) => client.onNotification((message) => resolve(message.params.pid)));
    expect(processRunning(descendant)).toBe(true);
    if (mode === "already-exited") await exited;
    await client.close();
    await exited;
    await vi.waitFor(() => expect(processRunning(descendant)).toBe(false), { timeout: 2_000, interval: 10 });
    if (mode === "forced") expect(client.child.signalCode).toBe("SIGKILL");
  } finally {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL"); } catch {}
    }
    if (client?.child.exitCode === null && client?.child.signalCode === null) {
      const exited = once(client.child, "exit");
      client.child.kill("SIGKILL");
      await exited;
    }
    if (client) await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows job preserves raw stdio, argument boundaries and native exit status", async () => {
  const args = ["", "two words", "a\"b", "slash\\", "quoted\\\"tail\\", "$(bad); & ` ' \u03bb"];
  const stderr = Buffer.from([0, 13, 10, 255, 128, 65]);
  const input = Buffer.from([0, 10, 13, 34, 255, 128, 32]);
  const program = `process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n");
process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.on("end", () => process.stdout.end(() => process.stderr.end(Buffer.from(${JSON.stringify([...stderr])}), () => process.exit(23))));`;
  const launch = windowsJobLaunch(process.execPath, ["-e", program, ...args]);
  const child = spawn(launch.file, launch.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const errors = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const closed = once(child, "close");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    child.stdin.end(input);
    expect(await closed).toEqual([23, null]);
    expect(Buffer.concat(stdout)).toEqual(Buffer.concat([Buffer.from(`${JSON.stringify(args)}\n`), input]));
    expect(Buffer.concat(errors)).toEqual(stderr);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

test.skipIf(process.platform !== "win32").each(["normal", "forced", "already-exited"])("Windows job terminates nested ready descendants on %s close", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "dispatcher-windows-job-"));
  let client;
  let closed;
  try {
    const fixture = join(dir, "fixture.mjs");
    const leaf = "process.send('ready'); setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);";
    const middle = `const { spawn } = require("node:child_process");
const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
leaf.once("message", () => { process.send({ middle: process.pid, leaf: leaf.pid }); leaf.disconnect(); leaf.unref(); });
setTimeout(() => process.exit(0), 20000);`;
    writeFileSync(fixture, `import { spawn } from "node:child_process";
const middle = spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
middle.once("message", (pids) => {
  middle.disconnect(); middle.unref();
  process.stdout.write(JSON.stringify({ method: "fixture/ready", params: pids }) + "\\n");
});
process.stdin.on("data", () => process.exit(23));
setTimeout(() => process.exit(0), 20000);
`);
    const launchWindows = vi.fn(() => windowsJobLaunch(process.execPath, [fixture]));
    const spawnChild = (file, args, options) => {
      // An unwired client must fail before it can launch a real Codex session.
      expect(file).toMatch(/WindowsPowerShell.*powershell\.exe$/);
      return spawn(file, args, options);
    };
    const Client = makeClient(null, spawnChild, "win32", launchWindows);
    client = new Client({ cwd: dir, env: { ...process.env } });
    const exited = once(client.child, "exit");
    closed = once(client.child, "close");
    let pids;
    client.onNotification(({ params }) => { pids = params; });
    await vi.waitFor(() => {
      if (client.error) throw client.error;
      expect(pids).toBeDefined();
    }, { timeout: 10_000, interval: 20 });
    expect(launchWindows).toHaveBeenCalledOnce();
    expect(processRunning(pids.middle)).toBe(true);
    expect(processRunning(pids.leaf)).toBe(true);
    if (mode === "already-exited") {
      client.child.stdin.write("exit\n");
      expect(await exited).toEqual([23, null]);
    } else if (mode === "forced") {
      client.child.kill("SIGKILL");
      await exited;
    }
    await client.close();
    await exited;
    await vi.waitFor(() => {
      expect(processRunning(pids.middle)).toBe(false);
      expect(processRunning(pids.leaf)).toBe(false);
    }, { timeout: 3_000, interval: 20 });
  } finally {
    if (client) await client.close();
    if (closed) await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
