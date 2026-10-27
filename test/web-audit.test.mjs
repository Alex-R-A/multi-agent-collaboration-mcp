import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ChatStore } from "../src/db.ts";

const source = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to <= from) throw new Error(`missing viewer section ${start}`);
  return source.slice(from, to);
}

function compile(name, start, end, bindings) {
  return Function(
    ...Object.keys(bindings),
    `"use strict";\n${section(start, end)}\nreturn ${name};`,
  )(...Object.values(bindings));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function makeSendHarness(postJson) {
  let agentId = "human-auditor-1";
  const room = { id: 1 };
  const reply = { seq: 7, label: "original reply" };
  const state = {
    current: room,
    roomEpoch: 1,
    sending: false,
    drafts: { 1: "First message" },
    draftReplies: {},
    draftRevisions: { 1: 0 },
    pendingSends: {},
    replyTo: reply,
    searchMode: false,
    historicalWindow: false,
    follow: true,
    newCount: 0,
  };
  const el = {
    composeText: { value: "First message", focus() {} },
    send: { disabled: false },
    composeError: { textContent: "" },
    msgs: {}, older: {}, streamWrap: {}, pinned: {}, search: {}, searchBar: {},
    results: {}, deleteConfirm: {},
  };
  const loads = [];
  const bindings = {
    state,
    el,
    crypto: { randomUUID },
    joinedHere: () => true,
    identity: () => agentId,
    postJson,
    sameRoom: (candidate) => candidate.id === state.current?.id,
    sameView: (candidate, epoch) => candidate.id === state.current?.id && epoch === state.roomEpoch,
    autosize() {},
    clearReply: () => { state.replyTo = null; },
    exitSearch: () => { state.searchMode = false; },
    updateJump() {},
    loadNew: (initial) => loads.push(initial),
  };
  const sendMessage = compile("sendMessage", "async function sendMessage()", "function autosize()", bindings);
  const openRoom = compile("openRoom", "function openRoom(room)", "// The recurring sidebar list", {
    ...bindings,
    localStorage: { setItem() {} }, ROOM_KEY: "room",
    document: { body: { classList: { remove() {} } } },
    renderRoomHead() {}, renderComposer() {}, renderRooms() {}, computeGap() {},
    hidePlaceholder() {}, fetchMarker() {}, fetchRoomDetail() {},
  });
  return { state, el, reply, loads, sendMessage, openRoom, changeIdentity: (id) => { agentId = id; } };
}

test.each([false, true])("a pending send returning to its room preserves edits=%s", async (edited) => {
  const response = deferred();
  const h = makeSendHarness(() => response.promise);
  const sending = h.sendMessage();
  h.openRoom({ id: 2 });
  h.el.composeText.value = "Other room draft";
  h.openRoom({ id: 1 });
  h.loads.length = 0;
  h.state.searchMode = true;
  h.state.historicalWindow = true;
  h.state.follow = false;
  h.state.newCount = 5;
  if (edited) {
    h.el.composeText.value = "Edited after returning";
    h.state.drafts[1] = h.el.composeText.value;
    h.state.draftRevisions[1]++;
    h.state.replyTo = { seq: 8, label: "new reply" };
  }
  response.resolve({ seq: 1 });
  await sending;
  expect(h.el.composeText.value).toBe(edited ? "Edited after returning" : "");
  expect(h.state.drafts[1]).toBe(edited ? "Edited after returning" : undefined);
  expect(h.state.replyTo?.seq ?? null).toBe(edited ? 8 : null);
  expect(h.state.searchMode).toBe(true);
  expect(h.state.historicalWindow).toBe(true);
  expect(h.state.follow).toBe(false);
  expect(h.state.newCount).toBe(5);
  expect(h.loads).toEqual([]);
});

test("a successful old-identity send preserves the new identity's composer", async () => {
  const response = deferred();
  const h = makeSendHarness(() => response.promise);
  const sending = h.sendMessage();
  h.changeIdentity("human-replacement-1");
  h.state.roomEpoch++;
  response.resolve({ seq: 1 });
  await sending;
  expect(h.el.composeText.value).toBe("First message");
  expect(h.state.drafts[1]).toBe("First message");
});

test("unchanged failed payload retries reuse a key; changed body, reply, or identity starts another send", async () => {
  const payloads = [];
  const h = makeSendHarness(async (_url, payload) => {
    payloads.push(payload);
    throw new Error("response lost");
  });
  await h.sendMessage();
  await h.sendMessage();
  expect(payloads[0].client_message_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(payloads[1].client_message_id).toBe(payloads[0].client_message_id);
  h.el.composeText.value = "Changed intent";
  h.state.draftRevisions[1]++;
  await h.sendMessage();
  expect(payloads[2].client_message_id).not.toBe(payloads[1].client_message_id);
  h.state.replyTo = { seq: 8, label: "different parent" };
  await h.sendMessage();
  expect(payloads[3].client_message_id).not.toBe(payloads[2].client_message_id);
  h.changeIdentity("human-replacement-1");
  await h.sendMessage();
  expect(payloads[4].client_message_id).not.toBe(payloads[3].client_message_id);
});

test("room switching preserves each draft's reply and successful offscreen sends consume theirs", async () => {
  const response = deferred();
  const h = makeSendHarness(() => response.promise);
  const sending = h.sendMessage();
  h.openRoom({ id: 2 });
  h.el.composeText.value = "Other room draft";
  h.state.replyTo = { seq: 9, label: "other room reply" };
  response.resolve({ seq: 8 });
  await sending;
  expect(h.el.composeText.value).toBe("Other room draft");
  expect(h.state.replyTo.seq).toBe(9);
  h.openRoom({ id: 1 });
  expect(h.el.composeText.value).toBe("");
  expect(h.state.replyTo).toBeNull();
  h.openRoom({ id: 2 });
  expect(h.el.composeText.value).toBe("Other room draft");
  expect(h.state.replyTo.seq).toBe(9);
});

const requestSourceStart = "async function requestJson(";
const requestSourceEnd = "// ---- utilities";

function makeRequests(fetchImpl, timeout = 1000) {
  return compile("requestJson", requestSourceStart, requestSourceEnd, {
    fetch: fetchImpl,
    AbortController,
    FETCH_TIMEOUT_MS: timeout,
    setTimeout,
    clearTimeout,
  });
}

test("requestJson rejects a malformed successful response body", async () => {
  const request = makeRequests(async () => new Response("{", { status: 200 }));
  await expect(request("/api/read")).rejects.toThrow();
});

test("requestJson rejects an abort while consuming a successful response body", async () => {
  const request = makeRequests(async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), 1);
  await expect(request("/api/read")).rejects.toMatchObject({ name: "AbortError" });
});

test("requestJson preserves HTTP status when an error response is not JSON", async () => {
  const request = makeRequests(async () => new Response("not JSON", { status: 503 }));
  await expect(request("/api/read")).rejects.toMatchObject({ httpStatus: 503, message: "HTTP 503" });
});

function makeReadHarness() {
  const replies = [];
  const state = {
    current: { id: 1 }, roomEpoch: 1, marker: 0, markerIdent: "human-reader-1",
    msgs: [{ seq: 400 }], lastReadSent: 0, follow: true, searchMode: false,
    noOlderHistory: true, gap: false,
  };
  const el = { markall: {}, older: { classList: { toggle() {} } } };
  let agentId = state.markerIdent;
  const bindings = {
    state, el, joinedHere: () => true, identity: () => agentId,
    document: { visibilityState: "visible" }, nearBottom: () => true,
    sameView: (room, epoch) => room.id === state.current?.id && epoch === state.roomEpoch,
    postJson: () => { const result = deferred(); replies.push(result); return result.promise; },
  };
  const computeGap = compile("computeGap", "function computeGap()", "async function fetchMarker()", bindings);
  bindings.computeGap = computeGap;
  const maybeMarkRead = compile("maybeMarkRead", "function maybeMarkRead()", "function noteSeen()", bindings);
  const loadNew = compile("loadNew", "async function loadNew(initial)", "async function loadOlder()", {
    ...bindings, maybeMarkRead, PAGE: 400,
    fetchJson: async () => ({ messages: [] }), noteOk() {}, noteFail() {},
    fetchMarker() {},
  });
  let markAll;
  const markall = { addEventListener: (_event, handler) => { markAll = handler; } };
  const markBindings = { ...bindings, el: { ...el, markall } };
  Function(...Object.keys(markBindings), section('el.markall.addEventListener("click"', 'el.filter.addEventListener("input"'))(
    ...Object.values(markBindings),
  );
  return { state, replies, maybeMarkRead, markAll: () => markAll(), computeGap, loadNew,
    document: bindings.document,
    changeIdentity: (id) => { agentId = id; } };
}

test("successful quiet polling retries a failed read and stops after its acknowledgement", async () => {
  const h = makeReadHarness();
  h.maybeMarkRead();
  h.replies[0].reject(new Error("temporary server failure"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(h.state.lastReadSent).toBe(0);
  await h.loadNew(false);
  expect(h.replies).toHaveLength(2);
  h.replies[1].resolve({ last_read_seq: 400 });
  await Promise.resolve();
  await h.loadNew(false);
  expect(h.state.marker).toBe(400);
  expect(h.replies).toHaveLength(2);
});

test.each(["hidden", "search", "identity", "not-following", "gap"])("quiet poll retry preserves the %s guard", async (guard) => {
  const h = makeReadHarness();
  if (guard === "hidden") h.document.visibilityState = "hidden";
  if (guard === "search") h.state.searchMode = true;
  if (guard === "identity") h.changeIdentity("human-replacement-1");
  if (guard === "not-following") h.state.follow = false;
  if (guard === "gap") h.state.noOlderHistory = false;
  await h.loadNew(false);
  expect(h.replies).toHaveLength(0);
});

test.each(["automatic", "explicit"])("%s read acknowledgements cannot regress the marker", async (kind) => {
  const h = makeReadHarness();
  const first = kind === "automatic" ? h.maybeMarkRead() : h.markAll();
  h.state.msgs = [{ seq: 2400 }];
  const second = kind === "automatic" ? h.maybeMarkRead() : h.markAll();
  h.replies[1].resolve({ last_read_seq: 2400 });
  await second;
  await Promise.resolve();
  h.replies[0].resolve({ last_read_seq: 400 });
  await first;
  await Promise.resolve();
  expect(h.state.marker).toBe(2400);
  h.state.noOlderHistory = false;
  h.state.msgs = [{ seq: 2000 }, { seq: 2400 }];
  h.computeGap();
  expect(h.state.gap).toBe(false);
});

test.each([{}, { last_read_seq: null }, { last_read_seq: -1 }, { last_read_seq: 1.5 }, { last_read_seq: Infinity }, { last_read_seq: Number.MAX_SAFE_INTEGER + 1 }])(
  "invalid acknowledgement %j cannot poison automatic or explicit read state", async (payload) => {
    for (const explicit of [false, true]) {
      const h = makeReadHarness();
      const pending = explicit ? h.markAll() : h.maybeMarkRead();
      h.replies[0].resolve(payload);
      await pending;
      await Promise.resolve();
      expect(h.state.marker).toBe(0);
    }
  },
);

test.each([undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "an invalid existing marker %s cannot initiate a read", (marker) => {
    const h = makeReadHarness();
    h.state.marker = marker;
    h.maybeMarkRead();
    void h.markAll();
    expect(h.replies).toHaveLength(0);
  },
);

test.each(["automatic", "explicit"])("%s acknowledgements cannot update another identity", async (kind) => {
  const h = makeReadHarness();
  const pending = kind === "automatic" ? h.maybeMarkRead() : h.markAll();
  h.changeIdentity("human-next-1");
  h.replies[0].resolve({ last_read_seq: 400 });
  await pending;
  await Promise.resolve();
  expect(h.state.marker).toBe(0);
});

test.each([undefined, null, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "marker bootstrap rejects invalid seq %s and leaves a retryable unknown baseline", async (last_read_seq) => {
    const state = {
      current: { id: 1 }, roomEpoch: 1, marker: -1, markerIdent: null,
      markerLoading: false, markerRetryKey: "", markerRetryAt: 0,
    };
    const fetchMarker = compile("fetchMarker", "async function fetchMarker()", "function maybeMarkRead()", {
      state, identity: () => "human-reader-1", joinedHere: () => true,
      fetchJson: async () => ({ joined: true, last_read_seq }),
      sameView: () => true, computeGap() {}, maybeMarkRead() {},
    });
    await fetchMarker();
    expect(state.marker).toBe(-1);
    expect(state.markerIdent).toBeNull();
    expect(state.markerRetryKey).not.toBe("");
    expect(state.markerLoading).toBe(false);
  },
);

let directory;
let store;
let server;
let base;
let room;
let human;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "aichat-web-audit-"));
  const path = join(directory, "chat.db");
  store = new ChatStore(path);
  const persona = store.identifyPersona({
    connectionId: randomUUID(), brand: "audit", model: "web", version: "1",
    description: null, expected: null, nextCandidateId: () => "audit-bootstrap",
  }).persona;
  room = store.createRoom("web-audit", null, null, persona.id).id;
  server = spawn(process.execPath, [fileURLToPath(new URL("../web/server.mjs", import.meta.url))], {
    env: { ...process.env, AGENT_CHAT_DB: path, AGENT_CHAT_VIEWER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("web server did not start")), 5000);
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error("web server exited")); });
  });
  const joined = await post("/api/join", { room, base_name: "web-auditor", operation_id: randomUUID() });
  expect(joined.status).toBe(200);
  human = joined.data.agent_id;
});

afterAll(async () => {
  if (server?.exitCode === null && server?.signalCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function post(path, payload) {
  const response = await fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() };
}

test.each([false, true])("a lost committed HTTP response deduplicates after room revisit=%s", async (revisit) => {
  const parent = revisit
    ? await post("/api/post", { room, agent_id: human, body: "retry parent" })
    : null;
  let dropFirst = true;
  const proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(base + req.url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.concat(chunks),
    });
    const body = await upstream.text();
    if (dropFirst) { dropFirst = false; res.destroy(); return; }
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(body);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const via = `http://127.0.0.1:${proxy.address().port}`;
  const requestJson = makeRequests((url, options) => fetch(via + url, options));
  const h = makeSendHarness((url, payload) => requestJson(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }));
  h.changeIdentity(human);
  h.state.current = { id: room };
  h.state.replyTo = parent ? { seq: parent.data.seq, label: "retry parent" } : null;
  h.el.composeText.value = `lost-response-${randomUUID()}`;
  const body = h.el.composeText.value;
  try {
    await h.sendMessage();
    expect(h.el.composeError.textContent).not.toBe("");
    expect(h.el.composeText.value).toBe(body);
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = ?").get(body).c).toBe(1);
    const key = h.state.pendingSends[room].clientMessageId;
    if (revisit) {
      h.openRoom({ id: room + 1 });
      h.openRoom({ id: room });
      expect(h.el.composeText.value).toBe(body);
      expect(h.state.replyTo?.seq).toBe(parent.data.seq);
    }
    await h.sendMessage();
    expect(h.el.composeText.value).toBe("");
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = ?").get(body).c).toBe(1);
    const stored = store.db.prepare("SELECT reply_to_seq, client_message_id FROM messages WHERE body = ?").get(body);
    expect(stored.reply_to_seq).toBe(parent?.data.seq ?? null);
    expect(stored.client_message_id).toBe(key);
    h.el.composeText.value = body;
    h.state.draftRevisions[room]++;
    await h.sendMessage();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE body = ?").get(body).c).toBe(2);
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("HTTP post idempotency matches the exact payload and precedes pruned-parent validation", async () => {
  const parent = await post("/api/post", { room, agent_id: human, body: "parent" });
  const clientMessageId = randomUUID();
  const payload = { room, agent_id: human, body: "reply", reply_to_seq: parent.data.seq, client_message_id: clientMessageId };
  const first = await post("/api/post", payload);
  expect(first.status).toBe(200);
  const mismatch = await post("/api/post", { ...payload, body: "different" });
  expect(mismatch.status).toBe(400);
  store.db.prepare("DELETE FROM messages WHERE room_id = ? AND seq = ?").run(room, parent.data.seq);
  const retried = await post("/api/post", payload);
  expect(retried.status).toBe(200);
  expect(retried.data.seq).toBe(first.data.seq);
  expect(store.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND client_message_id = ?").get(room, clientMessageId).c).toBe(1);
});

test.each([null, "", 42, "x".repeat(201), "bad\u0001key", "bad\ud800key"])("invalid HTTP post key %j is rejected", async (client_message_id) => {
  const result = await post("/api/post", { room, agent_id: human, body: "invalid key", client_message_id });
  expect(result.status).toBe(400);
});

test.each([
  ["a".repeat(200), ["a".repeat(200)]],
  ["a".repeat(201), null],
  ["a".repeat(200) + ".suffix", null],
  ["a".repeat(200) + "-suffix", null],
  ["a".repeat(200) + ".---", ["a".repeat(200)]],
  ["short....---", ["short"]],
])("HTTP mentions validate the complete token %s", async (token, expected) => {
  const result = await post("/api/post", { room, agent_id: human, body: `mention @${token}` });
  expect(result.status).toBe(200);
  const row = store.db.prepare("SELECT mentions FROM messages WHERE room_id = ? AND seq = ?").get(room, result.data.seq);
  expect(JSON.parse(row.mentions)).toEqual(expected);
});

test("HTTP mentions retain distinct tokens in order and cap recipients at 100", async () => {
  const ids = Array.from({ length: 105 }, (_, index) => `recipient-${index}`);
  const result = await post("/api/post", {
    room, agent_id: human, body: ids.flatMap((id) => [`@${id}`, `@${id}.`]).join(" "),
  });
  expect(result.status).toBe(200);
  const row = store.db.prepare("SELECT mentions FROM messages WHERE room_id = ? AND seq = ?").get(room, result.data.seq);
  expect(JSON.parse(row.mentions)).toEqual(ids.slice(0, 100));
});

function makeRenderHarness() {
  const expanded = [];
  const createElement = (tag) => ({
    tag, children: [], listeners: {}, textContent: "", open: false,
    classList: { add() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    addEventListener(event, listener) { this.listeners[event] = listener; },
  });
  const json = {
    parse: JSON.parse,
    stringify(value, replacer, space) {
      if (space === 2) expanded.push(value);
      return JSON.stringify(value, replacer, space);
    },
  };
  const renderBody = compile("renderBody", "function prettyJsonLength(", "// Fetch one anchored page", {
    document: { createElement }, JSON: json,
    linkify: (node, text) => { node.textContent = text; },
  });
  return { renderBody, expanded, container: createElement("article") };
}

test("collapsed deep JSON keeps its exact count without constructing indentation until opened", () => {
  const h = makeRenderHarness();
  const body = "[".repeat(1000) + "0" + "]".repeat(1000);
  const expected = JSON.stringify(JSON.parse(body), null, 2);
  h.renderBody(h.container, { format: "json", body });
  expect(h.expanded).toHaveLength(0);
  const [fold] = h.container.children;
  expect(fold.tag).toBe("details");
  const [summary, pre] = fold.children;
  expect(summary.textContent).toBe(`json  /  ${expected.length} chars`);
  expect(pre.textContent).toBe("");
  fold.listeners.toggle();
  expect(h.expanded).toHaveLength(0);
  fold.open = true;
  fold.listeners.toggle();
  expect(pre.textContent).toBe(expected);
  fold.open = false;
  fold.listeners.toggle();
  fold.open = true;
  fold.listeners.toggle();
  expect(h.expanded).toHaveLength(1);
});

const prettyJsonLength = compile("prettyJsonLength", "function prettyJsonLength(", "function renderBody(", {});

test.each([
  "null", "true", "false", "0", "-0", "1e400", "1e-400", "1.25", '""',
  '"quote\\\" backslash\\\\ newline\\n control\\u0001 astral\\ud83d\\ude00"',
  "[]", "{}", "[[],{},null,true,1]", '{"a":1,"b":[2,{"c":"text"}]}',
  '{"\\n\\\"":true,"__proto__":{"constructor":[]}}',
])("pretty size equals native serialization for parsed JSON %s", (body) => {
  const value = JSON.parse(body);
  expect(prettyJsonLength(value)).toBe(JSON.stringify(value, null, 2).length);
});

test("pretty size is exact for deep mixed containers and wide arrays", () => {
  const deep = JSON.parse('{"nested":['.repeat(1000) + '"leaf"' + ']}'.repeat(1000));
  expect(prettyJsonLength(deep)).toBe(JSON.stringify(deep, null, 2).length);
  const wide = Array.from({ length: 1000 }, (_, index) => ({ [String(index)]: [index, null, "x\ny"] }));
  expect(prettyJsonLength(wide)).toBe(JSON.stringify(wide, null, 2).length);
});

test.each([598, 599])("JSON folding keeps its 600-character boundary for a %i-character string", (length) => {
  const h = makeRenderHarness();
  const body = JSON.stringify("x".repeat(length));
  h.renderBody(h.container, { format: "json", body });
  const [node] = h.container.children;
  expect(node.tag).toBe(length === 598 ? "pre" : "details");
  expect(h.expanded).toHaveLength(length === 598 ? 1 : 0);
  if (length === 598) expect(node.textContent).toBe(body);
});

test.each(["{broken", "[1,2", "plain text"])("invalid JSON retains text fallback for %s", (body) => {
  const h = makeRenderHarness();
  h.renderBody(h.container, { format: "json", body });
  expect(h.expanded).toHaveLength(0);
  expect(h.container.children[0].children[0].textContent).toBe(body);
});
