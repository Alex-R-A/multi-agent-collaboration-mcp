#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

import { ChatStore } from "../dist/db.js";

const USAGE = `Usage:
  node scripts/codex-dispatcher-poc.mjs --self-test [--model MODEL] [--model-version VERSION]
  node scripts/codex-dispatcher-poc.mjs --room ROOM --task TASK [--model MODEL] [--model-version VERSION]

The POC owns one Codex App Server process and one Codex thread. It watches
Agent Chat for directed unread messages to that thread's persona. A message
steers the active turn or starts a new turn when the thread is idle.

Options:
  --self-test              Run active-turn and idle-turn delivery checks in an isolated database
  --room ROOM              Existing room to join, or a room name to create
  --task TASK              Initial foreground assignment
  --model MODEL            Codex model (default: gpt-5.6-luna)
  --model-version VERSION  Agent Chat identity version (default: inferred from MODEL)
  --interval-ms MS         Inbox polling interval (default: 500)
  -h, --help               Show this help
`;

function fail(message) {
  throw new Error(message);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = {
    selfTest: false,
    room: undefined,
    task: undefined,
    model: "gpt-5.6-luna",
    modelVersion: undefined,
    intervalMs: 500,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--self-test") args.selfTest = true;
    else if (flag === "--room") args.room = takeValue(argv, index++, flag);
    else if (flag === "--task") args.task = takeValue(argv, index++, flag);
    else if (flag === "--model") args.model = takeValue(argv, index++, flag);
    else if (flag === "--model-version") {
      args.modelVersion = takeValue(argv, index++, flag);
    } else if (flag === "--interval-ms") {
      args.intervalMs = Number(takeValue(argv, index++, flag));
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else fail(`unknown argument: ${flag}`);
  }
  if (!Number.isSafeInteger(args.intervalMs) || args.intervalMs < 100 || args.intervalMs > 60_000) {
    fail("--interval-ms must be an integer from 100 through 60000");
  }
  const inferred = args.model.match(/gpt-(\d+(?:\.\d+)?)/)?.[1];
  args.modelVersion ??= inferred;
  if (!args.modelVersion) fail("--model-version is required when it cannot be inferred from --model");
  if (!args.selfTest && (!args.room || !args.task)) {
    fail("--room and --task are required unless --self-test is used");
  }
  return args;
}

class AppServerClient {
  constructor({ cwd, env, mcpDbPath }) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.stderr = "";
    this.error = null;
    this.ended = false;
    this.closing = false;
    this.failure = new Promise((resolvePromise) => {
      this.notifyFailure = resolvePromise;
    });
    const args = ["app-server"];
    if (mcpDbPath) {
      args.push("-c", `mcp_servers.agent-chat.env.AGENT_CHAT_DB=${JSON.stringify(mcpDbPath)}`);
    }
    args.push("--listen", "stdio://");
    this.child = spawn("codex", args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-20_000);
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.once("error", (error) => {
      this.ended = true;
      this.fail(new Error(`Codex App Server failed to start: ${error.message}`));
    });
    this.child.stdin.on("error", (error) => {
      this.fail(new Error(`Codex App Server stdin failed: ${error.message}`));
    });
    this.child.once("exit", (code, signal) => {
      this.ended = true;
      const detail = this.stderr.trim();
      this.fail(
        new Error(`Codex App Server exited (code=${code}, signal=${signal})${detail ? `: ${detail}` : ""}`),
      );
    });
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.notifyFailure(error);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`Ignoring non-JSON App Server output: ${line}\n`);
      return;
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this.handleServerRequest(message);
      } else {
        for (const listener of this.listeners) listener(message);
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
  }

  handleServerRequest(message) {
    const safeAgentChatToolTitles = new Map([
      ["Identify persona", "identify_persona"],
      ["List rooms", "list_rooms"],
      ["Create room", "create_room"],
      ["Join room", "join_room"],
      ["Who am I", "whoami"],
      ["Catch up on new messages", "catch_up"],
      ["Post message", "post_message"],
    ]);
    if (message.method === "mcpServer/elicitation/request") {
      const meta = message.params?._meta;
      const tool =
        typeof meta?.tool_name === "string"
          ? meta.tool_name
          : safeAgentChatToolTitles.get(meta?.tool_title);
      const schema = message.params?.requestedSchema;
      const properties = schema?.properties;
      const isEmptyForm =
        (message.params?.mode === "form" || message.params?.mode === "openai/form") &&
        schema?.type === "object" &&
        properties !== null &&
        typeof properties === "object" &&
        Object.keys(properties).length === 0;
      const isAllowed =
        message.params?.serverName === "agent-chat" &&
        meta?.codex_approval_kind === "mcp_tool_call" &&
        isEmptyForm &&
        [...safeAgentChatToolTitles.values()].includes(tool);
      if (isAllowed) {
        this.send({ id: message.id, result: { action: "accept", content: {} } });
        return;
      }
      const target = `${message.params?.serverName ?? "unknown"}/${tool ?? "unknown"}`;
      process.stderr.write(
        `Refused MCP approval target=${target} kind=${meta?.codex_approval_kind ?? "missing"} ` +
          `mode=${message.params?.mode ?? "missing"} empty_form=${isEmptyForm} ` +
          `meta_keys=${Object.keys(meta ?? {}).sort().join(",")}\n`,
      );
      this.send({
        id: message.id,
        result: {
          action: "decline",
          content: { message: `POC refuses approval for ${target}` },
        },
      });
      return;
    }
    this.send({ id: message.id, error: { code: -32601, message: "Unsupported client request" } });
  }

  send(message) {
    if (this.error) throw this.error;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "aichat-dispatcher-poc",
        title: "AI Chat Dispatcher POC",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    this.send({ method: "initialized", params: {} });
  }

  async close() {
    this.closing = true;
    this.fail(new Error("Codex App Server client closed"));
    if (this.ended || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolvePromise) => {
      const onExit = () => {
        clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        this.child.off("exit", onExit);
        resolvePromise();
      }, 3_000);
      this.child.once("exit", onExit);
    });
    this.child.kill("SIGTERM");
    await exited;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

class CodexWorker {
  constructor(client, { cwd, model, ephemeral }) {
    this.client = client;
    this.cwd = cwd;
    this.model = model;
    this.ephemeral = ephemeral;
    this.threadId = null;
    this.activeTurnId = null;
    this.completedTurns = new Map();
    this.turnWaiters = new Map();
    this.agentMessages = new Map();
    this.commandExecutions = new Map();
    this.retainDiagnostics = ephemeral;
    this.collectBootstrapText = true;
    this.removeListener = client.onNotification((message) => this.onNotification(message));
  }

  onNotification({ method, params }) {
    if (params?.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === "turn/started") this.activeTurnId = params.turn.id;
    if (
      (this.collectBootstrapText || this.retainDiagnostics) &&
      method === "item/completed" && params?.item?.type === "agentMessage"
    ) {
      const turnId = params.turnId;
      const prior = this.agentMessages.get(turnId) ?? [];
      prior.push(params.item.text ?? "");
      this.agentMessages.set(turnId, prior);
    }
    if (
      this.retainDiagnostics && (method === "item/started" || method === "item/completed") &&
      params?.item?.type === "commandExecution"
    ) {
      this.commandExecutions.set(params.turnId, params.item);
    }
    if (method === "turn/completed") {
      const turn = params.turn;
      if (this.activeTurnId === turn.id) this.activeTurnId = null;
      this.completedTurns.set(turn.id, turn);
      const waiter = this.turnWaiters.get(turn.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        clearTimeout(waiter.timer);
        waiter.resolve(turn);
      }
    }
  }

  async start() {
    const result = await this.client.request("thread/start", {
      model: this.model,
      cwd: this.cwd,
      ephemeral: this.ephemeral,
    });
    this.threadId = result.thread.id;
    return this.threadId;
  }

  async startTurn(text) {
    const result = await this.client.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
      cwd: this.cwd,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [this.cwd],
        networkAccess: false,
      },
      model: this.model,
    });
    if (!this.completedTurns.has(result.turn.id)) this.activeTurnId = result.turn.id;
    return result.turn.id;
  }

  async steer(text) {
    const expectedTurnId = this.activeTurnId;
    if (!expectedTurnId) fail("cannot steer an idle worker");
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
    return expectedTurnId;
  }

  waitForTurn(turnId, timeoutMs = 300_000) {
    const completed = this.completedTurns.get(turnId);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        rejectPromise(new Error(`turn ${turnId} did not complete after ${timeoutMs} ms`));
      }, timeoutMs);
      this.turnWaiters.set(turnId, { timer, resolve: resolvePromise, reject: rejectPromise });
    });
  }

  textForTurn(turnId) {
    return (this.agentMessages.get(turnId) ?? []).join("\n");
  }

  commandForTurn(turnId) {
    return this.commandExecutions.get(turnId);
  }

  finishBootstrap() {
    this.collectBootstrapText = false;
    if (!this.retainDiagnostics) this.agentMessages.clear();
  }

  pruneCompletedTurns(deliveries) {
    if (this.retainDiagnostics) return;
    const referenced = new Set(deliveries.map((delivery) => delivery.turnId));
    for (const id of this.completedTurns.keys()) {
      if (!referenced.has(id) && !this.turnWaiters.has(id) && id !== this.activeTurnId) {
        this.completedTurns.delete(id);
      }
    }
  }

  close() {
    this.removeListener();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Codex worker closed"));
    }
    this.turnWaiters.clear();
  }
}

function deliveryPrompt(roomId) {
  return `Agent Chat has directed unread work for you in room ${roomId}. Call catch_up for that room until remaining is zero or stops falling. Act on the new messages, post any requested reply in Agent Chat, and continue your existing assignment. Receiving a chat message does not end the assignment.`;
}

class Dispatcher {
  constructor({ store, worker, agentId, intervalMs, retainDiagnostics = false }) {
    this.store = store;
    this.worker = worker;
    this.agentId = agentId;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.deliveries = new Map();
    this.maxDeliveryAttempts = 2; // initial attempt plus one retry
    this.dispatches = [];
    this.retainDiagnostics = retainDiagnostics;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const matches = [];
      let after;
      for (;;) {
        const page = this.store.pendingDirected(100, after, this.agentId);
        matches.push(...page.pending);
        if (!page.next_after) break;
        after = page.next_after;
      }
      const liveKeys = new Set(matches.map((entry) => `${entry.room_id}:${entry.oldest_seq}`));
      for (const [key, delivery] of this.deliveries) {
        if (!liveKeys.has(key)) {
          this.deliveries.delete(key);
          continue;
        }
        const turn = this.worker.completedTurns.get(delivery.turnId);
        if (!turn) continue;
        if (delivery.attempts < this.maxDeliveryAttempts) {
          delivery.turnId = null;
          continue;
        }
        if (!delivery.failureReported) {
          process.stderr.write(
            `Delivery failed key=${key} turn=${delivery.turnId} status=${turn.status}; ` +
              `retry limit reached with unread work\n`,
          );
          delivery.failureReported = true;
        }
      }
      for (const entry of matches) {
        const key = `${entry.room_id}:${entry.oldest_seq}`;
        const prior = this.deliveries.get(key);
        if (prior?.turnId) continue;
        const mode = this.worker.activeTurnId ? "steer" : "start";
        const prompt = deliveryPrompt(entry.room_id);
        const turnId = mode === "steer"
          ? await this.worker.steer(prompt)
          : await this.worker.startTurn(prompt);
        this.deliveries.set(key, {
          attempts: (prior?.attempts ?? 0) + 1,
          turnId,
          failureReported: false,
        });
        if (this.retainDiagnostics) this.dispatches.push({ key, mode, turnId, atMs: Date.now() });
        process.stdout.write(
          `Dispatched room=${entry.room_name} seq=${entry.oldest_seq} mode=${mode} turn=${turnId}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`Dispatcher error: ${error.message}\n`);
    } finally {
      this.worker.pruneCompletedTurns?.([...this.deliveries.values()]);
      this.running = false;
    }
  }
}

async function waitFor(check, description, timeoutMs = 180_000, intervalMs = 100, signal) {
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error("dispatcher stopped");
    const value = check();
    if (value) return { value, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= timeoutMs) fail(`${description} timed out after ${timeoutMs} ms`);
    await new Promise((resolvePromise) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolvePromise();
      };
      const timer = setTimeout(done, intervalMs);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

async function bootstrapWorker(worker, store, { room, model, modelVersion }) {
  const prompt = `Use the agent-chat MCP. Identify yourself with brand "openai", model "${model}", version "${modelVersion}", and description "Codex worker controlled by the Agent Chat dispatcher POC". List rooms. If room "${room}" does not exist, create it. Join room "${room}" as "worker" with cursor_start "latest". Call whoami. Do not launch the background poller. Do not modify project files. In your final response, print AGENT_CHAT_PERSONA=<your exact agent_id>.`;
  const turnId = await worker.startTurn(prompt);
  const turn = await worker.waitForTurn(turnId);
  if (turn.status !== "completed") fail(`bootstrap turn ended with status ${turn.status}`);
  const text = worker.textForTurn(turnId);
  const agentId = text.match(/AGENT_CHAT_PERSONA=([A-Za-z0-9_-]+)/)?.[1];
  if (!agentId) fail(`bootstrap did not return an Agent Chat persona; final response was: ${text}`);
  const roomRow = store.getRoomByName(room);
  if (!roomRow) fail(`worker did not create or join room ${room}; final response was: ${text}`);
  const member = store.listAgents(roomRow.id, 60, agentId, 10).agents.find((entry) => entry.id === agentId);
  if (!member) fail(`persona ${agentId} is not a member of room ${room}`);
  return { agentId, roomRow };
}

function makeSender(store, roomId) {
  const connectionId = randomUUID();
  const senderId = `poc-sender-${randomUUID().slice(0, 8)}`;
  const result = store.identifyPersona({
    connectionId,
    brand: "poc",
    model: "dispatcher",
    version: "1.0",
    description: "Isolated dispatcher POC sender",
    expected: null,
    nextCandidateId: () => senderId,
    maxAttempts: 1,
  });
  store.joinRoom(roomId, result.persona.id, { cursorStart: "latest", role: "test sender" });
  return result.persona.id;
}

function postToken(store, roomId, senderId, agentId, token) {
  return store.postMessage(
    roomId,
    senderId,
    `${token}: Reply in Agent Chat with this exact token, then continue your assignment.`,
    "text",
    [agentId],
    null,
    null,
    { priority: true, clientMessageId: token },
  );
}

function findAcknowledgement(store, roomId, agentId, token) {
  return store
    .readHistory(roomId, 100)
    .messages.find((message) => message.from === agentId && String(message.content).includes(token));
}

async function runSelfTest({ store, worker, dispatcher, roomRow, agentId, senderId, signal }) {
  const activeToken = `POC_ACTIVE_${randomUUID().slice(0, 8)}`;
  const taskTurnId = await worker.startTurn(
    "Run a foreground shell command that waits eight seconds and prints foreground-complete. Do not modify files. After it returns, handle any steered Agent Chat notice before completing this turn.",
  );
  await waitFor(() => worker.commandForTurn(taskTurnId), "foreground command start", 180_000, 100, signal);
  const activePostedAt = Date.now();
  postToken(store, roomRow.id, senderId, agentId, activeToken);
  const activeAck = await waitFor(
    () => findAcknowledgement(store, roomRow.id, agentId, activeToken),
    "active-turn acknowledgement",
    180_000, 100, signal,
  );
  const taskTurn = await worker.waitForTurn(taskTurnId);
  if (taskTurn.status !== "completed") fail(`foreground turn ended with status ${taskTurn.status}`);
  const command = worker.commandForTurn(taskTurnId);
  if (
    command?.status !== "completed" ||
    command.exitCode !== 0 ||
    !command.aggregatedOutput?.includes("foreground-complete")
  ) {
    fail(`foreground command did not complete successfully: ${JSON.stringify(command)}`);
  }
  const activeDispatch = dispatcher.dispatches.find(
    (entry) => entry.mode === "steer" && entry.turnId === taskTurnId,
  );
  if (!activeDispatch) fail("active message was acknowledged without a recorded turn/steer dispatch");

  const idleToken = `POC_IDLE_${randomUUID().slice(0, 8)}`;
  const idlePostedAt = Date.now();
  postToken(store, roomRow.id, senderId, agentId, idleToken);
  const idleAck = await waitFor(
    () => findAcknowledgement(store, roomRow.id, agentId, idleToken),
    "idle-turn acknowledgement",
    180_000, 100, signal,
  );
  const idleDispatch = dispatcher.dispatches.find((entry) => entry.mode === "start");
  if (!idleDispatch) fail("idle message was acknowledged without a recorded turn/start dispatch");
  const idleTurn = await worker.waitForTurn(idleDispatch.turnId);
  if (idleTurn.status !== "completed") fail(`idle delivery turn ended with status ${idleTurn.status}`);

  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      thread_id: worker.threadId,
      agent_id: agentId,
      active: {
        dispatch: "turn/steer",
        delivery_ms: activeDispatch.atMs - activePostedAt,
        acknowledgement_ms: activeAck.elapsedMs,
      },
      idle: {
        dispatch: "turn/start",
        delivery_ms: idleDispatch.atMs - idlePostedAt,
        acknowledgement_ms: idleAck.elapsedMs,
      },
    })}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(process.cwd());
  let isolatedDirectory;
  let mcpDbPath;
  if (args.selfTest) {
    isolatedDirectory = mkdtempSync(join(tmpdir(), "aichat-dispatcher-poc-"));
    mcpDbPath = join(isolatedDirectory, "chat.db");
    args.room = `dispatcher-poc-${randomUUID().slice(0, 8)}`;
  }

  const store = new ChatStore(mcpDbPath);
  const client = new AppServerClient({ cwd, env: { ...process.env }, mcpDbPath });
  const worker = new CodexWorker(client, {
    cwd,
    model: args.model,
    ephemeral: args.selfTest,
  });
  let dispatcher;
  let shuttingDown = false;
  const stopSignal = new AbortController();
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopSignal.abort();
    dispatcher?.stop();
    worker.close();
    store.close();
    await client.close();
    if (isolatedDirectory) rmSync(isolatedDirectory, { recursive: true, force: true });
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(143)));

  try {
    const run = async () => {
      await client.initialize();
      await worker.start();
      const { agentId, roomRow } = await bootstrapWorker(worker, store, {
        room: args.room,
        model: args.model,
        modelVersion: args.modelVersion,
      });
      worker.finishBootstrap();
      process.stdout.write(
        `Worker ready thread=${worker.threadId} agent=${agentId} room=${roomRow.name}\n`,
      );
      dispatcher = new Dispatcher({
        store,
        worker,
        agentId,
        intervalMs: args.intervalMs,
        retainDiagnostics: args.selfTest,
      });
      dispatcher.start();

      if (args.selfTest) {
        const senderId = makeSender(store, roomRow.id);
        await runSelfTest({ store, worker, dispatcher, roomRow, agentId, senderId, signal: stopSignal.signal });
        return;
      }

      const taskTurnId = await worker.startTurn(args.task);
      process.stdout.write(`Foreground assignment started turn=${taskTurnId}\n`);
      await new Promise(() => {});
    };
    await Promise.race([
      run(),
      client.failure.then((error) => { throw error; }),
    ]);
  } finally {
    await shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
