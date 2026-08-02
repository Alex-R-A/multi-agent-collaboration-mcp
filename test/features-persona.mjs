// Acceptance coverage for fresh-schema, connection-bound personas.
//
// An LLM identity belongs to one MCP process connection and one exact
// brand/model/version tuple. Repeating that tuple on the same connection
// reuses the identity. Changing it terminally retires the old identity and
// allocates a different immutable agent_id. There is no credential, takeover,
// resume, legacy schema, or tenure counter.
//
// Every database is temporary. Nothing here opens the production database.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  ChatStore,
  ConnectionNonceCollisionError,
  NicknameExhaustedError,
  PersonaLostError,
} from "../dist/db.js";

import { expect, test } from "vitest";

test("features-persona.mjs", async () => {
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_MODULE_URL = pathToFileURL(join(ROOT, "dist", "db.js")).href;
const POLLER = join(ROOT, "dist", "poller.js");
const MCP = join(ROOT, "dist", "index.js");

let failures = 0;
function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${
      condition ? "" : "  >> " + JSON.stringify(detail)
    }`,
  );
  if (!condition) failures++;
}

function caught(fn) {
  try {
    const value = fn();
    return { threw: false, value };
  } catch (error) {
    return {
      threw: true,
      error,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      personaLost: error instanceof PersonaLostError,
      reason: error instanceof PersonaLostError ? error.reason : null,
      missing: error instanceof PersonaLostError ? error.missing : null,
      retired: error instanceof PersonaLostError ? error.retired : null,
    };
  }
}

const dirs = [];
const children = new Set();

function freshStore(prefix = "aichat-persona-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  return { store: new ChatStore(path), path };
}

const TUPLE_A = {
  brand: "Anthropic",
  model: "Claude Opus",
  version: "5.0",
};
const TUPLE_B = {
  brand: "Anthropic",
  model: "Claude Sonnet",
  version: "5.1",
};

function firstIdentity(
  store,
  candidateId,
  tuple = TUPLE_A,
  description = null,
  connectionId = randomUUID(),
) {
  const result = store.identifyPersona({
    connectionId,
    ...tuple,
    description,
    expected: null,
    nextCandidateId: () => candidateId,
  });
  return {
    id: result.persona.id,
    connectionId,
    expected: { agentId: result.persona.id, connectionId },
    result,
  };
}

function identifyAgain(
  store,
  current,
  tuple,
  candidateId,
  opts = {},
) {
  const result = store.identifyPersona({
    connectionId: current.connectionId,
    ...tuple,
    description: opts.description ?? null,
    expected: current.expected,
    nextCandidateId: () => candidateId,
    ...(opts.maxAttempts === undefined
      ? {}
      : { maxAttempts: opts.maxAttempts }),
  });
  return {
    id: result.persona.id,
    connectionId: current.connectionId,
    expected: {
      agentId: result.persona.id,
      connectionId: current.connectionId,
    },
    result,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (
      child &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      return false;
    }
    await sleep(10);
  }
  return false;
}

function trackedSpawn(command, args, options) {
  const child = spawn(command, args, options);
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
}

function lineReader(stream) {
  let buffer = "";
  const queued = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else {
        queued.push(line);
      }
    }
  });
  return (timeoutMs = 8_000) => {
    if (queued.length > 0) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`line read timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
  };
}

async function hardKill(runtime) {
  if (
    !runtime ||
    runtime.child.exitCode !== null ||
    runtime.child.signalCode !== null
  ) {
    return;
  }
  const exited = waitForChildExit(runtime.child);
  runtime.child.kill("SIGKILL");
  await exited;
}

// Store-level identity, schema, rollback, and membership behavior.
try {
  // --- fresh schema and exact identify reuse -------------------------------
  {
    const { store, path } = freshStore();
    const first = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-first",
      TUPLE_A,
      "first description",
    );
    check(
      "a first identify allocates and binds the supplied candidate",
      first.result.bindingReused === false &&
        first.result.identityChanged === false &&
        first.id === "anthropic-claude-opus-v5-0-first",
      first.result,
    );
    const reused = identifyAgain(
      store,
      first,
      TUPLE_A,
      "this-candidate-must-not-be-used",
      { description: "must not rewrite the row" },
    );
    check(
      "the exact tuple on the same connection reuses the same identity",
      reused.id === first.id &&
        reused.result.bindingReused === true &&
        reused.result.identityChanged === false,
      reused.result,
    );
    check(
      "exact reuse does not rewrite the creation-time description",
      store.getPersona(first.id).description === "first description",
      store.getPersona(first.id),
    );
    check(
      "the exact 5.0 string survives store creation and reuse",
      first.result.persona.version === "5.0" &&
        reused.result.persona.version === "5.0" &&
        store.getPersona(first.id).version === "5.0",
      {
        first: first.result.persona.version,
        reused: reused.result.persona.version,
        stored: store.getPersona(first.id).version,
      },
    );
    const nonceCollision = caught(() =>
      store.identifyPersona({
        connectionId: first.connectionId,
        ...TUPLE_B,
        description: null,
        expected: null,
        nextCandidateId: () => "must-not-adopt-colliding-connection",
      }),
    );
    check(
      "an unbound caller cannot adopt a row through a colliding connection nonce",
      nonceCollision.error instanceof ConnectionNonceCollisionError &&
        store.getPersona("must-not-adopt-colliding-connection") === undefined,
      nonceCollision,
    );

    const raw = new Database(path);
    const agentColumns = raw
      .prepare("PRAGMA table_info(agents)")
      .all()
      .map((row) => row.name);
    const leaseColumns = raw
      .prepare("PRAGMA table_info(wait_leases)")
      .all()
      .map((row) => row.name);
    check(
      "the fresh agents schema has exactly the current identity columns",
      agentColumns.join(",") ===
        "id,is_human,brand,model,version,connection_id,human_base,human_ordinal,retired_at,description,created_at",
      agentColumns,
    );
    check(
      "wait leases have exactly the current identity-keyed columns",
      leaseColumns.join(",") ===
        "room_id,agent_id,started_at,expires_at",
      leaseColumns,
    );

    const halfLlm = caught(() =>
      raw
        .prepare(
          `INSERT INTO agents
             (id, is_human, brand, model, version)
           VALUES ('half-llm', 0, 'a', 'b', '1')`,
        )
        .run(),
    );
    check(
      "a direct writer cannot create an unbound LLM row",
      halfLlm.threw,
      halfLlm,
    );
    const malformedHuman = caught(() =>
      raw
        .prepare(
          `INSERT INTO agents
             (id, is_human, brand, human_base, human_ordinal)
           VALUES ('human-alex-1', 1, 'a', 'alex', 1)`,
        )
        .run(),
    );
    check(
      "a direct writer cannot put LLM metadata on a human row",
      malformedHuman.threw,
      malformedHuman,
    );
    const goodHuman = caught(() =>
      raw
        .prepare(
          `INSERT INTO agents
             (id, is_human, human_base, human_ordinal)
           VALUES ('human-alex-1', 1, 'alex', 1)`,
        )
        .run(),
    );
    check("a canonical human row is accepted", !goodHuman.threw, goodHuman);
    const invalidAgentShapes = [
      {
        name: "null primary key",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, brand, model, version, connection_id)
               VALUES (NULL, 0, 'a', 'b', '1', ?)`,
            )
            .run(randomUUID()),
      },
      {
        name: "duplicate live connection",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, brand, model, version, connection_id)
               VALUES ('duplicate-connection', 0, 'a', 'b', '1', ?)`,
            )
            .run(first.connectionId),
      },
      {
        name: "fractional human ordinal",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, human_base, human_ordinal)
               VALUES ('human-fraction-1.5', 1, 'fraction', 1.5)`,
            )
            .run(),
      },
      {
        name: "human id does not match its base and ordinal",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, human_base, human_ordinal)
               VALUES ('human-mismatch-2', 1, 'mismatch', 1)`,
            )
            .run(),
      },
      {
        name: "human base uses the reserved prefix",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, human_base, human_ordinal)
               VALUES ('human-human-name-1', 1, 'human-name', 1)`,
            )
            .run(),
      },
      {
        name: "human ordinal exceeds the JavaScript-safe bound",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, human_base, human_ordinal)
               VALUES ('human-overflow-9007199254740992', 1, 'overflow',
                       9007199254740992)`,
            )
            .run(),
      },
      {
        name: "retired LLM still carries a connection",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, brand, model, version, connection_id,
                  retired_at)
               VALUES ('retired-and-bound', 0, 'a', 'b', '1', ?,
                       datetime('now'))`,
            )
            .run(randomUUID()),
      },
      {
        name: "LLM id enters the human namespace",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, brand, model, version, connection_id)
               VALUES ('human-llm-1', 0, 'a', 'b', '1', ?)`,
            )
            .run(randomUUID()),
      },
      {
        name: "LLM tuple contains a NUL",
        run: () =>
          raw
            .prepare(
              `INSERT INTO agents
                 (id, is_human, brand, model, version, connection_id)
               VALUES ('nul-tuple', 0, ?, 'b', '1', ?)`,
            )
            .run("a\u0000tail", randomUUID()),
      },
    ].map(({ name, run }) => ({ name, ...caught(run) }));
    check(
      "direct writers cannot create any tested invalid agent shape",
      invalidAgentShapes.every((result) => result.threw),
      invalidAgentShapes,
    );
    const invalidConnection = caught(() =>
      store.identifyPersona({
        connectionId: "not-a-uuid",
        ...TUPLE_B,
        description: null,
        expected: null,
        nextCandidateId: () => "invalid-connection",
      }),
    );
    const untrimmedTuple = caught(() =>
      store.identifyPersona({
        connectionId: randomUUID(),
        brand: " Anthropic",
        model: TUPLE_B.model,
        version: TUPLE_B.version,
        description: null,
        expected: null,
        nextCandidateId: () => "untrimmed-tuple",
      }),
    );
    check(
      "the store rejects invalid connection UUIDs and untrimmed tuple fields",
      invalidConnection.threw &&
        /lowercase UUID/.test(invalidConnection.message) &&
        untrimmedTuple.threw &&
        /trimmed, non-empty/.test(untrimmedTuple.message),
      { invalidConnection, untrimmedTuple },
    );
    const mismatchedAllocation = caught(() =>
      raw
        .prepare(
          `INSERT INTO human_allocations
             (operation_id, room_id, human_base, result_agent_id)
           VALUES ('00000000-0000-4000-8000-000000000001', 1, 'sam',
                   'human-alex-1')`,
        )
        .run(),
    );
    check(
      "an allocation record must match the referenced human base",
      mismatchedAllocation.threw,
      mismatchedAllocation,
    );
    const allocationId = "00000000-0000-4000-8000-000000000002";
    raw
      .prepare(
        `INSERT INTO human_allocations
           (operation_id, room_id, human_base, result_agent_id)
         VALUES (?, 1, 'alex', 'human-alex-1')`,
      )
      .run(allocationId);
    const allocationBefore = raw
      .prepare(
        "SELECT human_base, result_agent_id FROM human_allocations WHERE operation_id = ?",
      )
      .get(allocationId);
    const allocationUpdate = caught(() =>
      raw
        .prepare(
          "UPDATE human_allocations SET human_base = 'sam' WHERE operation_id = ?",
        )
        .run(allocationId),
    );
    const allocationDelete = caught(() =>
      raw
        .prepare("DELETE FROM human_allocations WHERE operation_id = ?")
        .run(allocationId),
    );
    const allocationAfter = raw
      .prepare(
        "SELECT human_base, result_agent_id FROM human_allocations WHERE operation_id = ?",
      )
      .get(allocationId);
    check(
      "a matched allocation row rejects update and delete and remains exact",
      allocationBefore?.human_base === "alex" &&
        allocationBefore?.result_agent_id === "human-alex-1" &&
        allocationUpdate.threw &&
        allocationDelete.threw &&
        allocationAfter?.human_base === "alex" &&
        allocationAfter?.result_agent_id === "human-alex-1",
      {
        allocationBefore,
        allocationUpdate,
        allocationDelete,
        allocationAfter,
      },
    );
    raw.close();
    store.close();
  }

  // --- tuple replacement and A-B-A identity allocation --------------------
  {
    const { store, path } = freshStore();
    const a = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-a",
      TUPLE_A,
    );
    const room = store.createRoom("transition-room", null, null, a.id).id;
    store.joinRoom(room, a.id, { role: "writer" });
    store.claimResource(room, "work", a.id, 600, "old work");
    store.beginWaitLease(room, a.id, 30);

    const b = identifyAgain(
      store,
      a,
      TUPLE_B,
      "anthropic-claude-sonnet-v5-1-b",
    );
    const oldRow = store.getPersona(a.id);
    const newRow = store.getPersona(b.id);
    const oldMembership = store.getMembership(room, a.id);
    const raw = new Database(path, { readonly: true });
    const oldLease = raw
      .prepare(
        "SELECT 1 FROM wait_leases WHERE room_id = ? AND agent_id = ?",
      )
      .get(room, a.id);
    raw.close();
    check(
      "a changed tuple allocates a different immutable id",
      b.id !== a.id &&
        b.result.identityChanged === true &&
        b.result.bindingReused === false &&
        b.result.previousAgentId === a.id,
      b.result,
    );
    check(
      "the old identity is retired and its connection is cleared",
      oldRow.retired_at !== null && oldRow.connection_id === null,
      oldRow,
    );
    check(
      "the replacement alone carries the connection",
      newRow.retired_at === null &&
        newRow.connection_id === a.connectionId &&
        newRow.brand === TUPLE_B.brand &&
        newRow.model === TUPLE_B.model &&
        newRow.version === TUPLE_B.version,
      newRow,
    );
    check(
      "transition soft-leaves the old room membership but keeps its role",
      oldMembership.left_at !== null &&
        store.getRole(room, a.id) === "writer",
      {
        membership: oldMembership,
        role: store.getRole(room, a.id),
      },
    );
    check(
      "transition removes the old identity's claims and wait lease",
      store.listClaims(room).total === 0 && oldLease === undefined,
      { claims: store.listClaims(room), oldLease },
    );
    check(
      "transition reports the old room without inheriting its membership",
      b.result.previousRoomCount === 1 &&
        b.result.previousRoomNames?.includes("transition-room") &&
        store.getMembership(room, b.id) === undefined,
      b.result,
    );

    const aAgain = identifyAgain(
      store,
      b,
      TUPLE_A,
      "anthropic-claude-opus-v5-0-a-again",
    );
    check(
      "A-B-A produces three distinct identities",
      new Set([a.id, b.id, aAgain.id]).size === 3 &&
        store.getPersona(a.id).retired_at !== null &&
        store.getPersona(b.id).retired_at !== null &&
        store.getPersona(aAgain.id).retired_at === null,
      [a.id, b.id, aAgain.id],
    );
    const reinsert = caught(() =>
      store.db
        .prepare(
          `INSERT INTO agents
             (id, is_human, brand, model, version, connection_id)
           VALUES (?, 0, ?, ?, ?, ?)`,
        )
        .run(a.id, TUPLE_A.brand, TUPLE_A.model, TUPLE_A.version, randomUUID()),
    );
    check(
      "a retired agent_id remains occupied and cannot be reinserted",
      reinsert.threw,
      reinsert,
    );
    store.close();
  }

  // --- failed transition rolls every retirement side effect back ----------
  {
    const { store, path } = freshStore();
    const current = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-rollback",
      TUPLE_A,
    );
    const room = store.createRoom("rollback-room", null, null, current.id).id;
    store.joinRoom(room, current.id, { role: "reviewer" });
    store.claimResource(room, "held", current.id, 600, "must survive");
    store.beginWaitLease(room, current.id, 30);

    const failed = caught(() =>
      identifyAgain(store, current, TUPLE_B, current.id, {
        maxAttempts: 1,
      }),
    );
    const raw = new Database(path, { readonly: true });
    const lease = raw
      .prepare(
        "SELECT 1 FROM wait_leases WHERE room_id = ? AND agent_id = ?",
      )
      .get(room, current.id);
    raw.close();
    const row = store.getPersona(current.id);
    check(
      "nickname exhaustion aborts the transition",
      failed.threw && failed.error instanceof NicknameExhaustedError,
      failed,
    );
    check(
      "rollback restores the old live binding and membership",
      row.retired_at === null &&
        row.connection_id === current.connectionId &&
        store.getMembership(room, current.id).left_at === null &&
        store.getRole(room, current.id) === "reviewer",
      {
        row,
        membership: store.getMembership(room, current.id),
        role: store.getRole(room, current.id),
      },
    );
    check(
      "rollback restores the old claim and wait lease",
      store.listClaims(room).claims[0]?.holder === current.id &&
        lease !== undefined,
      { claims: store.listClaims(room), lease },
    );
    const reuse = identifyAgain(
      store,
      current,
      TUPLE_A,
      "unused-after-rollback",
    );
    check(
      "the original binding remains exactly reusable after rollback",
      reuse.id === current.id && reuse.result.bindingReused === true,
      reuse.result,
    );
    store.endWaitLease(room, current.id);
    store.close();
  }

  // --- graceful retirement is exact-binding guarded -----------------------
  {
    const { store, path } = freshStore();
    const current = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-retire",
      TUPLE_A,
    );
    const room = store.createRoom("retire-room", null, null, current.id).id;
    store.joinRoom(room, current.id, {});
    store.claimResource(room, "held", current.id, 600, null);
    store.beginWaitLease(room, current.id, 30);

    // Read the three affected rows straight from the file on a separate
    // connection. Store accessors mask what this needs to see: once an identity
    // is retired, listAgents reports watching:false whether or not the lease row
    // survived, so only the raw row proves the delete happened.
    const raw = new Database(path, { readonly: true });
    const rawRows = () => {
      // Report row EXISTENCE separately from left_at. Collapsing a missing row
      // to left_at:null would let a membership DELETE masquerade as a present,
      // never-left membership, and the refusal assertion below would pass on it.
      const membership = raw
        .prepare(
          "SELECT left_at FROM memberships WHERE room_id = ? AND agent_id = ?",
        )
        .get(room, current.id);
      return {
        membershipRow: membership !== undefined,
        left_at: membership === undefined ? "<no row>" : membership.left_at,
        claim: raw
          .prepare(
            "SELECT COUNT(*) AS c FROM claims WHERE room_id = ? AND key = ? AND agent_id = ?",
          )
          .get(room, "held", current.id).c,
        lease: raw
          .prepare(
            "SELECT COUNT(*) AS c FROM wait_leases WHERE room_id = ? AND agent_id = ?",
          )
          .get(room, current.id).c,
      };
    };

    const wrongConnection = store.retireConnection({
      agentId: current.id,
      connectionId: randomUUID(),
    });
    const wrongId = store.retireConnection({
      agentId: "no-such-agent",
      connectionId: current.connectionId,
    });
    const afterRefusals = rawRows();
    check(
      "graceful retirement refuses either guard mismatch",
      wrongConnection === false &&
        wrongId === false &&
        store.getPersona(current.id).retired_at === null,
      { wrongConnection, wrongId, row: store.getPersona(current.id) },
    );
    check(
      "a refused retirement leaves membership, claim, and lease rows untouched",
      afterRefusals.membershipRow === true &&
        afterRefusals.left_at === null &&
        afterRefusals.claim === 1 &&
        afterRefusals.lease === 1,
      afterRefusals,
    );
    const retired = store.retireConnection(current.expected);
    const row = store.getPersona(current.id);
    check(
      "the exact binding retires once and clears the connection",
      retired === true &&
        row.retired_at !== null &&
        row.connection_id === null &&
        store.retireConnection(current.expected) === false,
      row,
    );
    const afterRetire = rawRows();
    check(
      "exact retirement performs all three effects in the file itself",
      afterRetire.membershipRow === true &&
        typeof afterRetire.left_at === "string" &&
        afterRetire.claim === 0 &&
        afterRetire.lease === 0,
      afterRetire,
    );
    check(
      // watching:false here is retired-display masking, NOT lease evidence:
      // listAgents forces it false for any retired row. The raw lease count
      // above is what proves the delete.
      "exact retirement soft-leaves and clears claims and waits",
      store.getMembership(room, current.id).left_at !== null &&
        store.listClaims(room).total === 0 &&
        (() => {
          const listed = store
            .listAgents(room, 5)
            .agents.find((agent) => agent.id === current.id);
          return (
            listed?.retired === true &&
            listed.present === false &&
            listed.active === false &&
            listed.watching === false
          );
        })(),
      {
        membership: store.getMembership(room, current.id),
        claims: store.listClaims(room),
        agents: store.listAgents(room, 5),
      },
    );
    raw.close();
    store.close();
  }

  // --- retired unread memberships never block non-forced pruning ----------
  {
    const { store } = freshStore();
    const retiree = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-prune-retiree",
      TUPLE_A,
    );
    const author = firstIdentity(
      store,
      "openai-gpt-v5-0-prune-author",
      { brand: "OpenAI", model: "GPT", version: "5.0" },
    );
    const liveLaggard = firstIdentity(
      store,
      "google-gemini-v3-prune-laggard",
      { brand: "Google", model: "Gemini", version: "3" },
    );
    const room = store.createRoom(
      "retired-prune-room",
      null,
      null,
      retiree.id,
    ).id;
    for (const identity of [retiree, author, liveLaggard]) {
      store.joinRoom(room, identity.id, {});
    }
    for (const body of ["one", "two", "three"]) {
      store.postMessage(room, author.id, body, "text", null, null, null);
    }
    store.markRead(room, liveLaggard.id, 1);
    store.retireConnection(retiree.expected);

    const refused = store.pruneMessages(room, author.id, 1, false);
    check(
      "prune blockers ignore the retired marker but retain the live laggard",
      refused.refused === true &&
        refused.would_delete_unread === 1 &&
        refused.min_read_seq === 1,
      refused,
    );
    store.markRead(room, liveLaggard.id);
    const pruned = store.pruneMessages(room, author.id, 1, false);
    check(
      "non-forced pruning proceeds once only the retired unread member remains",
      pruned.refused === undefined &&
        pruned.deleted === 2 &&
        pruned.kept === 1,
      pruned,
    );
    store.close();
  }

  // --- membership, cursor, role, claim, and left-room boundaries -----------
  {
    const { store, path } = freshStore();
    const actor = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-member",
      TUPLE_A,
    );
    const peer = firstIdentity(
      store,
      "openai-gpt-v5-0-peer",
      { brand: "OpenAI", model: "GPT", version: "5.0" },
    );
    const one = store.createRoom("membership-one", null, null, actor.id).id;
    const two = store.createRoom("membership-two", null, null, actor.id).id;
    store.joinRoom(one, actor.id, { role: "writer" });
    store.joinRoom(two, actor.id, {});
    store.joinRoom(one, peer.id, {});
    store.joinRoom(two, peer.id, {});
    store.setRole(two, actor.id, "reviewer");
    check(
      "roles are room-local",
      store.getRole(one, actor.id) === "writer" &&
        store.getRole(two, actor.id) === "reviewer",
      {
        one: store.getRole(one, actor.id),
        two: store.getRole(two, actor.id),
      },
    );
    store.setRole(two, actor.id, null);
    check(
      "a null role clears only that room",
      store.getRole(one, actor.id) === "writer" &&
        store.getRole(two, actor.id) === null,
      {
        one: store.getRole(one, actor.id),
        two: store.getRole(two, actor.id),
      },
    );
    const blank = caught(() => store.setRole(one, actor.id, "  "));
    check(
      "blank roles are rejected without disturbing the stored role",
      blank.threw && store.getRole(one, actor.id) === "writer",
      blank,
    );

    store.postMessage(
      one,
      peer.id,
      "peer one",
      "text",
      null,
      null,
      null,
    );
    store.postMessage(
      one,
      peer.id,
      "peer two",
      "text",
      null,
      null,
      null,
    );
    const firstPage = store.catchUp(one, actor.id, 1, undefined, 100_000);
    check(
      "catch_up advances only through the delivered peer page",
      firstPage.messages.length === 1 &&
        firstPage.remaining === 1 &&
        store.getCursor(one, actor.id).last_read_seq ===
          firstPage.new_last_read_seq,
      firstPage,
    );
    store.claimResource(one, "release-after-leave", actor.id, 600, null);
    const markerBeforeLeave = store.getCursor(one, actor.id).last_read_seq;
    store.leaveRoom(one, actor.id);

    const leftCalls = {
      post: () =>
        store.postMessage(
          one,
          actor.id,
          "ghost",
          "text",
          null,
          null,
          null,
        ),
      catch_up: () =>
        store.catchUp(one, actor.id, 50, undefined, 100_000),
      mark_read: () => store.markRead(one, actor.id),
      set_role: () => store.setRole(one, actor.id, "ghost"),
      claim: () => store.claimResource(one, "ghost", actor.id, 60, null),
      wait: () => store.beginWaitLease(one, actor.id, 30),
      set_intro: () => store.setPinned(one, actor.id, "ghost"),
      prune: () => store.pruneMessages(one, actor.id, 1, true),
    };
    for (const [name, fn] of Object.entries(leftCalls)) {
      const result = caught(fn);
      check(
        `${name} is refused while left and names join_room`,
        result.threw &&
          !result.personaLost &&
          /LEFT/.test(result.message) &&
          /join_room/.test(result.message),
        result,
      );
    }
    check(
      "left-room refusals changed no marker, role, message, or intro",
      store.getCursor(one, actor.id).last_read_seq === markerBeforeLeave &&
        store.getRole(one, actor.id) === "writer" &&
        store.readHistory(one, 50).messages.length === 2 &&
        store.getRoom(one).pinned === null,
      {
        cursor: store.getCursor(one, actor.id),
        role: store.getRole(one, actor.id),
        messages: store.readHistory(one, 50).messages,
        room: store.getRoom(one),
      },
    );
    const leftAt = store.getCursor(one, actor.id).left_at;
    store.touch(one, actor.id);
    check(
      "a liveness touch cannot rejoin a left membership",
      leftAt !== null && store.getCursor(one, actor.id).left_at === leftAt,
      { before: leftAt, after: store.getCursor(one, actor.id).left_at },
    );
    const audit = caught(() => store.readHistory(one, 50));
    const release = store.releaseClaim(
      one,
      "release-after-leave",
      actor.id,
    );
    check(
      "a left identity can audit history and release its own claim",
      !audit.threw &&
        release.released === true &&
        store.listClaims(one).total === 0,
      { audit, release },
    );
    store.joinRoom(one, actor.id, {});
    check(
      "rejoin preserves the cursor and role",
      store.getCursor(one, actor.id).last_read_seq === markerBeforeLeave &&
        store.getRole(one, actor.id) === "writer",
      {
        cursor: store.getCursor(one, actor.id),
        role: store.getRole(one, actor.id),
      },
    );
    const resumed = store.catchUp(one, actor.id, 50, undefined, 100_000);
    check(
      "rejoin delivers the unread message at the preserved cursor",
      resumed.messages.length === 1 &&
        resumed.messages[0].content === "peer two",
      resumed,
    );

    const late = firstIdentity(
      store,
      "google-gemini-v3-0-late",
      { brand: "Google", model: "Gemini", version: "3.0" },
    );
    store.joinRoom(one, late.id, { cursorStart: "latest" });
    check(
      "cursor_start latest skips existing backlog only on first join",
      store.catchUp(one, late.id, 50, undefined, 100_000).messages.length ===
        0,
      store.getCursor(one, late.id),
    );
    store.postMessage(
      one,
      peer.id,
      "after late join",
      "text",
      null,
      null,
      null,
    );
    const lateRead = store.catchUp(
      one,
      late.id,
      50,
      undefined,
      100_000,
    );
    const lateMarker = lateRead.new_last_read_seq;
    store.leaveRoom(one, late.id);
    store.postMessage(
      one,
      peer.id,
      "while late is away",
      "text",
      null,
      null,
      null,
    );
    store.joinRoom(one, late.id, { cursorStart: "latest" });
    check(
      "cursor_start on rejoin does not rebaseline the saved marker",
      store.getCursor(one, late.id).last_read_seq === lateMarker &&
        store.catchUp(one, late.id, 50, undefined, 100_000).messages[0]
          ?.content === "while late is away",
      {
        lateMarker,
        current: store.getCursor(one, late.id),
      },
    );

    const raw = new Database(path);
    raw
      .prepare(
        "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
      )
      .run("2000-01-01 00:00:00", two, actor.id);
    store.setRole(two, actor.id, "reviewer");
    const seen = raw
      .prepare(
        "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(two, actor.id).last_seen;
    raw.close();
    check(
      "set_role refreshes liveness in the room it changes",
      seen !== "2000-01-01 00:00:00",
      seen,
    );
    store.close();
  }

  // --- operations captured before transition are fenced at execution -------
  {
    const { store, path } = freshStore();
    const old = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-captured",
      TUPLE_A,
    );
    const peer = firstIdentity(
      store,
      "openai-gpt-v5-0-captured-peer",
      { brand: "OpenAI", model: "GPT", version: "5.0" },
    );
    const room = store.createRoom("captured-room", null, null, old.id).id;
    store.joinRoom(room, old.id, {});
    store.joinRoom(room, peer.id, {});
    store.postMessage(
      room,
      peer.id,
      "unread for captured read",
      "text",
      null,
      null,
      null,
    );
    const cursorBefore = store.getCursor(room, old.id).last_read_seq;

    const workerSource = `
      import { ChatStore, PersonaLostError } from ${JSON.stringify(DB_MODULE_URL)};
      const store = new ChatStore(${JSON.stringify(path)});
      const room = ${JSON.stringify(room)};
      const agent = ${JSON.stringify(old.id)};
      const capturedPost = () =>
        store.postMessage(room, agent, "captured stale post", "text", null, null, null);
      const capturedRead = () =>
        store.catchUp(room, agent, 50, undefined, 100000);
      const render = (fn) => {
        try {
          fn();
          return { threw: false };
        } catch (error) {
          return {
            threw: true,
            persona_lost: error instanceof PersonaLostError,
            reason: error instanceof PersonaLostError ? error.reason : null,
          };
        }
      };
      process.stdout.write(JSON.stringify({
        ready: true,
        live: store.getPersona(agent)?.retired_at === null,
        member: store.getMembership(room, agent)?.left_at === null
      }) + "\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      process.stdout.write(JSON.stringify({
        post: render(capturedPost),
        advancing_read: render(capturedRead)
      }) + "\\n");
      store.close();
    `;
    const worker = trackedSpawn(
      process.execPath,
      ["--input-type=module", "--eval", workerSource],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const nextLine = lineReader(worker.stdout);
    const ready = JSON.parse(await nextLine());
    check(
      "the stale-operation worker captured both operations while live",
      ready.ready === true && ready.live === true && ready.member === true,
      ready,
    );

    identifyAgain(
      store,
      old,
      TUPLE_B,
      "anthropic-claude-sonnet-v5-1-captured",
    );
    worker.stdin.write("execute\n");
    const workerExit = waitForChildExit(worker);
    const result = JSON.parse(await nextLine());
    worker.stdin.end();
    await workerExit;
    check(
      "the captured write and advancing read both fail on the retired id",
      result.post.threw === true &&
        result.post.persona_lost === true &&
        result.post.reason === "retired" &&
        result.advancing_read.threw === true &&
        result.advancing_read.persona_lost === true &&
        result.advancing_read.reason === "retired",
      result,
    );
    check(
      "fencing left no stale post and did not move the old cursor",
      store.getCursor(room, old.id).last_read_seq === cursorBefore &&
        !store
          .readHistory(room, 50)
          .messages.some((message) => message.content === "captured stale post"),
      {
        before: cursorBefore,
        after: store.getCursor(room, old.id).last_read_seq,
        messages: store.readHistory(room, 50).messages,
      },
    );
    store.close();
  }

  // --- retained database NUL guards ---------------------------------------
  {
    const { store, path } = freshStore();
    const actor = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-nul",
      TUPLE_A,
    );
    const room = store.createRoom("nul-room", null, null, actor.id).id;
    store.joinRoom(room, actor.id, {});
    store.claimResource(room, "file:x", actor.id, 600, "clean");
    store.close();

    const raw = new Database(path);
    const rejects = (name, sql, params) => {
      const result = caught(() => raw.prepare(sql).run(...params));
      check(
        name,
        result.threw && /NUL character/.test(result.message),
        result,
      );
    };
    rejects(
      "a raw room update cannot store a NUL",
      "UPDATE rooms SET description = ? WHERE id = ?",
      ["bad\u0000room", room],
    );
    rejects(
      "a raw persona update cannot store a NUL",
      "UPDATE agents SET description = ? WHERE id = ?",
      ["bad\u0000persona", actor.id],
    );
    rejects(
      "a raw claim update cannot store a NUL",
      "UPDATE claims SET note = ? WHERE room_id = ? AND key = ?",
      ["bad\u0000claim", room, "file:x"],
    );
    rejects(
      "a raw message insert cannot store a NUL",
      `INSERT INTO messages
         (room_id, seq, agent_id, body, body_len)
       VALUES (?, 99, ?, ?, 8)`,
      [room, actor.id, "bad\u0000body"],
    );
    raw.close();
  }
} catch (error) {
  console.log(
    "FAIL  store-level suite threw:",
    error && error.stack ? error.stack : error,
  );
  failures++;
}

// Poller helpers and acceptance coverage.
function runPoller(args, timeoutMs = 18_000) {
  const child = trackedSpawn(process.execPath, [POLLER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", out, err, timedOut: true });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, timedOut: false });
    });
  });
  return { child, done };
}

function pollerLockPath(
  dbPath,
  agentId,
  roomId,
  watcherClass,
  mentionsOnly = false,
) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dir = join(
    tmpdir(),
    uid === null ? "agent-chat-pollers" : `agent-chat-pollers-${uid}`,
  );
  const key = JSON.stringify([
    realpathSync(dbPath),
    agentId,
    roomId,
    watcherClass,
    mentionsOnly,
  ]);
  return join(
    dir,
    createHash("sha256").update(key).digest("hex") + ".lock",
  );
}

async function waitForArmed(path, child, timeoutMs = 6_000) {
  return waitUntil(() => existsSync(path), timeoutMs, child);
}

try {
  // --- diagnostic and owned singleton classes -----------------------------
  {
    const { store, path } = freshStore("aichat-poller-lock-");
    const actor = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-lock",
      TUPLE_A,
    );
    const room = store.createRoom("lock-room", null, null, actor.id).id;
    store.joinRoom(room, actor.id, {});
    const raw = new Database(path);
    raw
      .prepare(
        "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
      )
      .run("2000-01-01 00:00:00", room, actor.id);
    store.close();

    const diagnosticPath = pollerLockPath(
      path,
      actor.id,
      room,
      "diagnostic",
    );
    const ownedPath = pollerLockPath(path, actor.id, room, "owned");
    const common = [
      "--agent",
      actor.id,
      "--room",
      String(room),
      "--interval",
      "5",
      "--timeout",
      "12",
      "--ok-on-timeout",
      "--db",
      path,
    ];
    const diagnostic = runPoller(common);
    const diagnosticReady = await waitForArmed(
      diagnosticPath,
      diagnostic.child,
    );
    const seenAfterDiagnostic = raw
      .prepare(
        "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
      )
      .get(room, actor.id).last_seen;
    check(
      "a diagnostic watcher arms without writing liveness",
      diagnosticReady &&
        seenAfterDiagnostic === "2000-01-01 00:00:00",
      { diagnosticReady, seenAfterDiagnostic },
    );

    const otherOwner = trackedSpawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const owned = runPoller([
      ...common,
      "--owner-pid",
      String(process.pid),
    ]);
    const ownedReady = await waitForArmed(ownedPath, owned.child);
    const heartbeatReady = await waitUntil(() => {
      const row = raw
        .prepare(
          "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
        )
        .get(room, actor.id);
      return row.last_seen !== "2000-01-01 00:00:00";
    }, 3_000, owned.child);
    check(
      "owned and diagnostic watcher classes coexist and only owned heartbeats",
      diagnosticReady &&
        ownedReady &&
        heartbeatReady &&
        diagnosticPath !== ownedPath &&
        existsSync(diagnosticPath) &&
        existsSync(ownedPath),
      {
        diagnosticReady,
        ownedReady,
        heartbeatReady,
        diagnosticPath,
        ownedPath,
      },
    );

    const duplicateDiagnostic = runPoller(common, 5_000);
    const duplicateOwned = runPoller(
      [...common, "--owner-pid", String(otherOwner.pid)],
      5_000,
    );
    const [duplicateDiagnosticResult, duplicateOwnedResult] =
      await Promise.all([duplicateDiagnostic.done, duplicateOwned.done]);
    check(
      "a duplicate within each watcher class is rejected",
      duplicateDiagnosticResult.code === 2 &&
        /watcher lock references live pid/.test(duplicateDiagnosticResult.err) &&
        duplicateOwnedResult.code === 2 &&
        /watcher lock references live pid/.test(duplicateOwnedResult.err),
      {
        diagnostic: duplicateDiagnosticResult,
        owned: duplicateOwnedResult,
      },
    );

    diagnostic.child.kill("SIGTERM");
    owned.child.kill("SIGTERM");
    otherOwner.kill("SIGTERM");
    await Promise.all([diagnostic.done, owned.done]);
    const locksCleaned = await waitUntil(
      () => !existsSync(diagnosticPath) && !existsSync(ownedPath),
      2_000,
    );
    check(
      "normal poller termination cleans both class locks",
      locksCleaned,
      {
        diagnostic: existsSync(diagnosticPath),
        owned: existsSync(ownedPath),
      },
    );
    raw.close();
  }

  // --- a live poller still wakes on real peer traffic ----------------------
  {
    const { store, path } = freshStore("aichat-poller-live-");
    const actor = firstIdentity(
      store,
      "anthropic-claude-opus-v5-0-poller-live",
      TUPLE_A,
    );
    const peer = firstIdentity(
      store,
      "openai-gpt-v5-0-poller-live-peer",
      { brand: "OpenAI", model: "GPT", version: "5.0" },
    );
    const room = store.createRoom("poller-live", null, null, actor.id).id;
    store.joinRoom(room, actor.id, {});
    store.joinRoom(room, peer.id, {});
    const running = runPoller([
      "--agent",
      actor.id,
      "--room",
      String(room),
      "--interval",
      "5",
      "--timeout",
      "12",
      "--ok-on-timeout",
      "--db",
      path,
    ]);
    const lock = pollerLockPath(
      path,
      actor.id,
      room,
      "diagnostic",
    );
    const ready = await waitForArmed(lock, running.child);
    check("the live-traffic poller objectively armed", ready, lock);
    store.postMessage(
      room,
      peer.id,
      "wake",
      "text",
      null,
      null,
      null,
    );
    const result = await running.done;
    let output = null;
    try {
      output = JSON.parse(result.out.trim());
    } catch {}
    check(
      "a live poller reports peer traffic",
      result.code === 0 &&
        output?.has_updates === true &&
        output.room_id === room,
      result,
    );
    store.close();
  }

  // --- already-armed pollers exit on missing and retired identities --------
  {
    const makeFixture = (suffix) => {
      const { store, path } = freshStore(`aichat-poller-${suffix}-`);
      const actor = firstIdentity(
        store,
        `anthropic-claude-opus-v5-0-${suffix}`,
        TUPLE_A,
      );
      const room = store.createRoom(
        `poller-${suffix}`,
        null,
        null,
        actor.id,
      ).id;
      store.joinRoom(room, actor.id, {});
      const setup = new Database(path);
      setup
        .prepare(
          "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
        )
        .run("2000-01-01 00:00:00", room, actor.id);
      setup.close();
      const running = runPoller([
        "--agent",
        actor.id,
        "--owner-pid",
        String(process.pid),
        "--interval",
        "5",
        "--timeout",
        "12",
        "--ok-on-timeout",
        "--db",
        path,
      ]);
      const observer = new Database(path, { readonly: true });
      return {
        store,
        path,
        actor,
        room,
        running,
        observer,
        lastSeen: observer.prepare(
          "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
        ),
        lock: pollerLockPath(
          path,
          actor.id,
          null,
          "owned",
        ),
      };
    };

    const missing = makeFixture("missing");
    const retired = makeFixture("retired");
    const [missingReady, retiredReady] = await Promise.all([
      waitUntil(() => {
        const row = missing.lastSeen.get(
          missing.room,
          missing.actor.id,
        );
        return (
          existsSync(missing.lock) &&
          row?.last_seen !== "2000-01-01 00:00:00"
        );
      }, 3_000, missing.running.child),
      waitUntil(() => {
        const row = retired.lastSeen.get(
          retired.room,
          retired.actor.id,
        );
        return (
          existsSync(retired.lock) &&
          row?.last_seen !== "2000-01-01 00:00:00"
        );
      }, 3_000, retired.running.child),
    ]);
    check(
      "both loss pollers completed startup before identity mutation",
      missingReady && retiredReady,
      { missingReady, retiredReady },
    );

    const raw = new Database(missing.path);
    raw.transaction(() => {
      raw
        .prepare("DELETE FROM memberships WHERE agent_id = ?")
        .run(missing.actor.id);
      raw.prepare("DELETE FROM agents WHERE id = ?").run(missing.actor.id);
    }).immediate();
    raw.close();
    const retiredNow = retired.store.retireConnection(
      retired.actor.expected,
    );
    check(
      "the retired fixture changed only after its watcher armed",
      retiredReady && retiredNow === true,
      { retiredReady, retiredNow },
    );

    const [missingResult, retiredResult] = await Promise.all([
      missing.running.done,
      retired.running.done,
    ]);
    check(
      "an armed watcher exits when its identity is missing",
      missingResult.code === 2 &&
        /no longer exists/.test(missingResult.err) &&
        !missingResult.timedOut,
      missingResult,
    );
    check(
      "an armed watcher exits retired_identity before membership diagnostics",
      retiredResult.code === 2 &&
        /retired_identity/.test(retiredResult.err) &&
        !/left_all_rooms|no_room_memberships/.test(retiredResult.err) &&
        !retiredResult.timedOut,
      retiredResult,
    );
    missing.observer.close();
    retired.observer.close();
    missing.store.close();
    retired.store.close();
  }
} catch (error) {
  console.log(
    "FAIL  poller suite threw:",
    error && error.stack ? error.stack : error,
  );
  failures++;
}

// Minimal JSON-RPC client for real MCP-process coverage.
function startMcp(dbPath) {
  const child = trackedSpawn(process.execPath, [MCP], {
    env: { ...process.env, AGENT_CHAT_DB: dbPath },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        replies.set(message.id, message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params, timeoutMs = 10_000) => {
    const id = nextId++;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    if (replies.has(id)) {
      const reply = replies.get(id);
      replies.delete(id);
      return Promise.resolve(reply);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`MCP reply ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.set(id, { resolve, reject, timer });
    });
  };
  const init = async () => {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "features-persona-test", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );
  };
  const call = async (name, args, timeoutMs = 10_000) => {
    const reply = await request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    const text = reply.result?.content?.[0]?.text;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return {
      data,
      isError: reply.result?.isError === true || reply.error !== undefined,
      rpcError: reply.error,
    };
  };
  const listTools = async () => {
    const reply = await request("tools/list", {});
    return reply.result?.tools ?? [];
  };
  return { child, init, call, listTools };
}

try {
  // --- real MCP identify, transition, wait fencing, and cleanup isolation --
  {
    const { store, path } = freshStore("aichat-mcp-wait-");
    store.close();
    const runtime = startMcp(path);
    await runtime.init();

    const tools = await runtime.listTools();
    const names = tools.map((tool) => tool.name);
    const identifySchema = tools.find(
      (tool) => tool.name === "identify_persona",
    )?.inputSchema;
    const identifyProperties = Object.keys(
      identifySchema?.properties ?? {},
    ).sort();
    check(
      "the MCP exposes only the current identity entry point",
      names.includes("identify_persona") &&
        !names.includes("create_persona") &&
        !names.includes("resume_persona") &&
        identifySchema?.properties?.version?.type === "string" &&
        identifySchema?.additionalProperties === false &&
        identifyProperties.join(",") === "brand,description,model,version",
      {
        names,
        identifyProperties,
        additionalProperties: identifySchema?.additionalProperties,
        version: identifySchema?.properties?.version,
      },
    );
    const forbiddenIdentity = await runtime.call("identify_persona", {
      ...TUPLE_A,
      agent_id: "copied-nickname",
    });
    check(
      "identify_persona rejects a caller-supplied nickname field",
      forbiddenIdentity.isError === true,
      forbiddenIdentity,
    );
    const numericVersion = await runtime.call("identify_persona", {
      brand: TUPLE_A.brand,
      model: TUPLE_A.model,
      version: 5,
    });
    check(
      "identify_persona rejects a numeric version instead of losing .0",
      numericVersion.isError === true,
      numericVersion,
    );

    const first = await runtime.call("identify_persona", {
      ...TUPLE_A,
      description: "MCP identity A",
    });
    const oldId = first.data.agent_id;
    check(
      "MCP first identify allocates a canonical nickname",
      first.isError !== true &&
        /^anthropic-claude-opus-v5-0-[0-9a-f]{6}$/.test(oldId) &&
        first.data.binding_reused === false &&
        first.data.identity_changed === false &&
        first.data.version === "5.0" &&
        first.data.previous_retired === undefined &&
        first.data.retired === undefined,
      first.data,
    );
    const reuse = await runtime.call("identify_persona", TUPLE_A);
    check(
      "MCP exact identify is idempotent",
      reuse.isError !== true &&
        reuse.data.agent_id === oldId &&
        reuse.data.binding_reused === true &&
        reuse.data.identity_changed === false &&
        reuse.data.version === "5.0" &&
        reuse.data.previous_retired === undefined &&
        reuse.data.retired === undefined,
      reuse.data,
    );

    const createdRoom = await runtime.call("create_room", {
      name: "mcp-wait-room",
    });
    const roomId = createdRoom.data.room_id;
    const initialJoin = await runtime.call("join_room", {
      room: "mcp-wait-room",
      role: "writer",
    });
    const observer = new Database(path, { readonly: true });
    const storedConnectionId = observer
      .prepare("SELECT connection_id FROM agents WHERE id = ?")
      .get(oldId).connection_id;
    const lease = (agentId) =>
      observer
        .prepare(
          "SELECT started_at, expires_at FROM wait_leases WHERE room_id = ? AND agent_id = ?",
        )
        .get(roomId, agentId);

    let oldPending = true;
    const oldWait = runtime
      .call("catch_up", { wait_seconds: 10 }, 16_000)
      .then((result) => {
        oldPending = false;
        return result;
      });
    const oldArmed = await waitUntil(
      () => lease(oldId) !== undefined,
      3_000,
      runtime.child,
    );
    check(
      "the old wait has a database lease before transition",
      oldArmed && oldPending,
      { oldArmed, oldPending, lease: lease(oldId) },
    );

    const transition = await runtime.call("identify_persona", TUPLE_B);
    const newId = transition.data.agent_id;
    check(
      "MCP tuple transition retires the old id and allocates a new one",
      transition.isError !== true &&
        transition.data.identity_changed === true &&
        transition.data.previous_agent_id === oldId &&
        newId !== oldId &&
        observer
          .prepare(
            "SELECT retired_at FROM agents WHERE id = ?",
          )
          .get(oldId).retired_at !== null,
      transition.data,
    );
    check(
      "MCP transition scopes the retired boolean to the previous identity",
      transition.data.previous_retired === true &&
        typeof transition.data.previous_retired === "boolean" &&
        transition.data.retired === undefined &&
        typeof transition.data.previous_retired_note === "string" &&
        /terminally retired/.test(transition.data.previous_retired_note),
      transition.data,
    );

    // Send both frames immediately. The server's handler-start gate runs the
    // synchronous join before the wait captures its room and writes its lease.
    const successorJoin = runtime.call("join_room", {
      room: "mcp-wait-room",
      role: "reviewer",
    });
    let successorPending = true;
    const successorWait = runtime
      .call("catch_up", { wait_seconds: 3 }, 9_000)
      .then((result) => {
        successorPending = false;
        return result;
      });
    const successorJoinResult = await successorJoin;
    const successorBeforeOldCleanup = await waitUntil(
      () => oldPending && lease(newId) !== undefined,
      3_000,
      runtime.child,
    );
    check(
      "the successor lease exists while the old wait is still pending",
      successorBeforeOldCleanup && oldPending && successorPending,
      {
        successorBeforeOldCleanup,
        oldPending,
        successorPending,
        successorLease: lease(newId),
      },
    );

    const cleanupProbe = new ChatStore(path);
    cleanupProbe.endWaitLease(roomId, oldId);
    cleanupProbe.close();
    check(
      "old-id lease cleanup cannot delete the successor identity's lease",
      lease(oldId) === undefined && lease(newId) !== undefined,
      { oldLease: lease(oldId), successorLease: lease(newId) },
    );

    const oldResult = await oldWait;
    check(
      "the armed old wait returns terminal retired persona_lost",
      oldResult.isError === true &&
        oldResult.data.code === "persona_lost" &&
        oldResult.data.terminal === true &&
        oldResult.data.missing === false &&
        oldResult.data.retired === true,
      oldResult.data,
    );
    check(
      "the actual old wait exit leaves the successor lease intact",
      successorPending && lease(newId) !== undefined,
      { successorPending, successorLease: lease(newId) },
    );
    const successorResult = await successorWait;
    check(
      "the successor wait completes normally and cleans its own lease",
      successorResult.isError !== true &&
        successorResult.data.timed_out === true &&
        lease(newId) === undefined,
      { successorResult: successorResult.data, lease: lease(newId) },
    );
    const who = await runtime.call("whoami", {});
    check(
      "the stale wait error did not clear the current binding",
      who.isError !== true &&
        who.data.bound === true &&
        who.data.agent_id === newId &&
        who.data.persona_lost === undefined,
      who.data,
    );
    check(
      "successful identity responses never expose the stored connection nonce",
      typeof storedConnectionId === "string" &&
        [first, reuse, initialJoin, transition, successorJoinResult, who].every(
          (result) => !JSON.stringify(result.data).includes(storedConnectionId),
        ),
      { storedConnectionId },
    );
    observer.close();
    await hardKill(runtime);
  }

  // --- compound final-read loss keeps persona_lost precedence -------------
  {
    const { store, path } = freshStore("aichat-final-read-loss-");
    store.close();
    const runtime = startMcp(path);
    await runtime.init();
    const first = await runtime.call("identify_persona", TUPLE_A);
    const oldId = first.data.agent_id;
    const created = await runtime.call("create_room", {
      name: "final-read-loss",
    });
    const roomId = created.data.room_id;
    await runtime.call("join_room", { room: "final-read-loss" });

    const adminStore = new ChatStore(path);
    const admin = firstIdentity(adminStore, "final-read-loss-admin");
    const observer = new Database(path, { readonly: true });
    const leaseExists = observer.prepare(
      "SELECT 1 FROM wait_leases WHERE room_id = ? AND agent_id = ?",
    );
    let waitPending = true;
    const startedMs = Date.now();
    const waiting = runtime
      .call("catch_up", { wait_seconds: 1 }, 5_000)
      .then((result) => {
        waitPending = false;
        return result;
      });
    const armed = await waitUntil(
      () => leaseExists.get(roomId, oldId) !== undefined,
      3_000,
      runtime.child,
    );
    // Retire and delete after the first 500 ms probe but before the 1 s
    // deadline. The deadline path skips another probe and reaches the final
    // advancing read, which must preserve PersonaLostError precedence.
    await sleep(600);
    const pendingBeforeMutation = waitPending;
    const transition = await runtime.call("identify_persona", TUPLE_B);
    const deletion = caught(() => adminStore.deleteRoom(roomId, admin.id));
    const pendingAfterDeletion = waitPending;
    const result = await waiting;
    const elapsedMs = Date.now() - startedMs;
    check(
      "compound final-read loss reports persona_lost, not room deletion",
      armed &&
        pendingBeforeMutation &&
        pendingAfterDeletion &&
        transition.data.previous_agent_id === oldId &&
        deletion.threw === false &&
        elapsedMs >= 900 &&
        result.isError === true &&
        result.data.code === "persona_lost" &&
        result.data.retired === true &&
        !/room .*deleted/i.test(result.data.error),
      {
        armed,
        pendingBeforeMutation,
        pendingAfterDeletion,
        transition: transition.data,
        deletion,
        elapsedMs,
        result: result.data,
      },
    );
    observer.close();
    adminStore.close();
    await hardKill(runtime);
  }

  // --- handler loss disclosure shares thread/search response budgets ------
  {
    const { store, path } = freshStore("aichat-loss-budget-");
    store.close();
    const runtime = startMcp(path);
    await runtime.init();
    const identified = await runtime.call("identify_persona", TUPLE_A);
    const agentId = identified.data.agent_id;
    const threadRoom = await runtime.call("create_room", {
      name: "loss-budget-thread",
    });
    await runtime.call("join_room", { room: "loss-budget-thread" });
    const searchRoom = await runtime.call("create_room", {
      name: "loss-budget-search",
    });
    await runtime.call("join_room", { room: "loss-budget-search" });

    const fixture = new ChatStore(path);
    const author = firstIdentity(fixture, "budget-author");
    fixture.joinRoom(threadRoom.data.room_id, author.id, {});
    fixture.joinRoom(searchRoom.data.room_id, author.id, {});

    const threadRoot = fixture.postMessage(
      threadRoom.data.room_id,
      author.id,
      "root",
      "text",
      null,
      null,
      null,
    ).seq;
    for (let i = 0; i < 100; i++) {
      fixture.postMessage(
        threadRoom.data.room_id,
        author.id,
        "thread819 " + "x".repeat(819),
        "text",
        null,
        threadRoot,
        null,
      );
    }

    const searchRoot = fixture.postMessage(
      searchRoom.data.room_id,
      author.id,
      "root",
      "text",
      null,
      null,
      null,
    ).seq;
    for (let i = 0; i < 100; i++) {
      fixture.postMessage(
        searchRoom.data.room_id,
        author.id,
        "needle820 " + "x".repeat(820),
        "text",
        null,
        searchRoot,
        null,
        { priority: i === 0 },
      );
    }

    const disclosure = {
      persona_lost: true,
      missing: false,
      retired: true,
    };
    const unreservedThreadChars = JSON.stringify({
      ...disclosure,
      ...fixture.getThread(threadRoom.data.room_id, threadRoot, 3),
    }).length;
    const unreservedSearchChars = JSON.stringify({
      ...disclosure,
      ...fixture.searchMessages(
        searchRoom.data.room_id,
        "needle820",
        100,
        0,
      ),
    }).length;
    check(
      "loss-budget fixtures exceed the handler budget without a reserve",
      unreservedThreadChars > 100_000 && unreservedSearchChars > 100_000,
      { unreservedThreadChars, unreservedSearchChars },
    );

    const connectionId = fixture.db
      .prepare("SELECT connection_id FROM agents WHERE id = ?")
      .get(agentId).connection_id;
    const retired = fixture.retireConnection({ agentId, connectionId });
    const thread = await runtime.call("get_thread", {
      room: "loss-budget-thread",
      seq: threadRoot,
    });
    const search = await runtime.call("search_messages", {
      query: "needle820",
      limit: 100,
    });
    const historyAtMinimum = await runtime.call("read_history", {
      limit: 500,
      max_bytes: 1000,
    });
    const mentionsAtMinimum = await runtime.call("my_mentions", {
      limit: 500,
      max_bytes: 1000,
    });
    const threadChars = JSON.stringify(thread.data).length;
    const searchChars = JSON.stringify(search.data).length;
    check(
      "get_thread and search_messages reserve their persona-loss disclosure",
      retired === true &&
        thread.isError !== true &&
        search.isError !== true &&
        thread.data.persona_lost === true &&
        thread.data.retired === true &&
        search.data.persona_lost === true &&
        search.data.retired === true &&
        threadChars <= 100_000 &&
        searchChars <= 100_000,
      {
        retired,
        threadChars,
        searchChars,
        threadLoss: {
          persona_lost: thread.data.persona_lost,
          missing: thread.data.missing,
          retired: thread.data.retired,
        },
        searchLoss: {
          persona_lost: search.data.persona_lost,
          missing: search.data.missing,
          retired: search.data.retired,
        },
      },
    );
    check(
      "existing disclosure reserves still accept the public minimum budget",
      historyAtMinimum.isError !== true &&
        mentionsAtMinimum.isError !== true &&
        historyAtMinimum.data.persona_lost === true &&
        mentionsAtMinimum.data.persona_lost === true &&
        JSON.stringify(historyAtMinimum.data).length <= 1000 &&
        JSON.stringify(mentionsAtMinimum.data).length <= 1000,
      {
        history: historyAtMinimum.data,
        mentions: mentionsAtMinimum.data,
      },
    );
    fixture.close();
    await hardKill(runtime);
  }

  // --- all-digit room names are refused by the STORE, not just the handler --
  // resolveRoom is id-first, so a room named "42" is shadowed by room id 42 and
  // delete_room("42") retargets. The rule therefore has to hold for a direct
  // store caller, not only for one arriving through the MCP handler.
  {
    const { store, path } = freshStore("aichat-numeric-room-");
    const owner = firstIdentity(store, "anthropic-claude-opus-v5-0-num001");
    const raw = new Database(path);
    const roomCount = () =>
      raw.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
    const named = (name) =>
      raw.prepare("SELECT COUNT(*) AS c FROM rooms WHERE name = ?").get(name).c;
    // Measured separately at each step: sharing one baseline would make the
    // rejection and the acceptance a single assertion in two halves.
    const before = roomCount();
    const numeric = caught(() => store.createRoom("42", null, null, owner.id));
    const afterNumeric = roomCount();
    const legal = store.createRoom("room-42", null, null, owner.id);
    const afterLegal = roomCount();
    check(
      "direct store createRoom refuses an all-digit name and inserts no row",
      numeric.threw === true &&
        /all digits/.test(numeric.message) &&
        afterNumeric === before &&
        named("42") === 0,
      { message: numeric.message, before, afterNumeric, rows42: named("42") },
    );
    check(
      "digits inside a name stay legal and the row is stored byte-exact",
      legal.name === "room-42" &&
        afterLegal === afterNumeric + 1 &&
        named("room-42") === 1,
      { legal, afterNumeric, afterLegal },
    );
    raw.close();
    store.close();
  }

  // --- workflow education surfaces, over a real MCP process ----------------
  {
    const { store, path } = freshStore("aichat-workflow-");
    store.close();
    const runtime = startMcp(path);
    await runtime.init();

    const tools = await runtime.listTools();
    const waitDesc =
      tools.find((tool) => tool.name === "wait_for_messages")?.description ?? "";
    check(
      "wait_for_messages says the CALLER runs it and drops the 'do not run' reading",
      /for YOU to run/i.test(waitDesc) &&
        /does not execute it/i.test(waitDesc) &&
        !/\(do not run\)/i.test(waitDesc),
      { waitDesc },
    );

    // A persona has no memberships at identify time, so a WATCHER COMMAND here
    // could only exit 2 -- but the build stamp is independent of that and stays,
    // because staleness is worth knowing on the first response. Assert the one
    // absence and the two required presences by name; an exact-shape assertion
    // would break on unrelated additions and prove less.
    const first = await runtime.call("identify_persona", TUPLE_A);
    check(
      "first identify drops the unusable watcher command but keeps the build stamp",
      first.isError !== true &&
        typeof first.data.agent_id === "string" &&
        typeof first.data.next === "string" &&
        first.data.poller_cmd === undefined &&
        first.data.server_build !== undefined &&
        typeof first.data.server_stale === "boolean",
      {
        poller_cmd: first.data.poller_cmd,
        server_build: first.data.server_build,
        server_stale: first.data.server_stale,
      },
    );
    const reuse = await runtime.call("identify_persona", TUPLE_A);
    check(
      "exact re-identify has the same shape",
      reuse.isError !== true &&
        reuse.data.binding_reused === true &&
        reuse.data.agent_id === first.data.agent_id &&
        reuse.data.poller_cmd === undefined &&
        reuse.data.server_build !== undefined &&
        typeof reuse.data.server_stale === "boolean",
      {
        poller_cmd: reuse.data.poller_cmd,
        server_build: reuse.data.server_build,
      },
    );
    // isError alone would pass even if the row had been written and the error
    // raised afterwards, so read the persisted state directly.
    const numericRoom = await runtime.call("create_room", { name: "7" });
    const mcpRaw = new Database(path);
    const numericRows = mcpRaw
      .prepare("SELECT COUNT(*) AS c FROM rooms WHERE name = ?")
      .get("7").c;
    mcpRaw.close();
    check(
      "create_room rejects an all-digit name AND persists no row for it",
      numericRoom.isError === true &&
        /all digits/.test(JSON.stringify(numericRoom.data)) &&
        numericRows === 0,
      { data: numericRoom.data, numericRows },
    );

    await runtime.call("create_room", { name: "workflow-room" });
    const joined = await runtime.call("join_room", { room: "workflow-room" });
    const joinNext = joined.data.next ?? "";
    const catchIndex = joinNext.indexOf("catch_up");
    const armIndex = joinNext.indexOf("poller_cmd");
    const workIndex = joinNext.indexOf("work");
    check(
      "join_room keeps the handoff and teaches drain-then-arm with its mechanism",
      joined.isError !== true &&
        typeof joined.data.poller_cmd === "string" &&
        joined.data.server_build !== undefined &&
        /remaining/.test(joinNext) &&
        catchIndex >= 0 &&
        catchIndex < armIndex &&
        armIndex < workIndex &&
        /exit immediately/i.test(joinNext) &&
        /cannot launch/i.test(joinNext),
      { next: joinNext, poller_cmd: joined.data.poller_cmd },
    );
    check(
      "join_room states what active and watching do NOT prove",
      /active/.test(joined.data.presence_note ?? "") &&
        /watching/.test(joined.data.presence_note ?? "") &&
        /detached poller/i.test(joined.data.presence_note ?? "") &&
        /agent may be working/i.test(joined.data.presence_note ?? "") &&
        /exited watcher/i.test(joined.data.presence_note ?? "") &&
        /model is reading/i.test(joined.data.presence_note ?? "") &&
        /or will wake/i.test(joined.data.presence_note ?? ""),
      { presence_note: joined.data.presence_note },
    );

    // A second runtime supplies the unread the watcher must find. Asserting the
    // post landed FIRST is what keeps the poller check below non-vacuous: a
    // watcher that found nothing, or died, would otherwise pass an absence test.
    const peer = startMcp(path);
    await peer.init();
    await peer.call("identify_persona", TUPLE_B);
    await peer.call("join_room", { room: "workflow-room" });
    const posted = await peer.call("post_message", { content: "wake up" });
    check(
      "the peer post landed, so the watcher has something to find",
      posted.isError !== true && typeof posted.data.seq === "number",
      posted.data,
    );

    const hitRun = spawnSync(
      process.execPath,
      [
        POLLER,
        "--agent",
        first.data.agent_id,
        "--interval",
        "5",
        "--timeout",
        "5",
        "--ok-on-timeout",
      ],
      {
        env: { ...process.env, AGENT_CHAT_DB: path },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    let hitJson = null;
    try {
      hitJson = JSON.parse(hitRun.stdout.trim());
    } catch {}
    const hitNext = hitJson?.next ?? "";
    const hitCatchIndex = hitNext.indexOf("catch_up");
    const hitRearmIndex = hitNext.indexOf("re-run");
    const hitWorkIndex = hitNext.indexOf("work");
    check(
      "poller hit stdout carries the catch_up-then-rearm ORDER and its mechanism",
      hitRun.status === 0 &&
        hitJson?.has_updates === true &&
        typeof hitJson?.next === "string" &&
        /remaining/.test(hitNext) &&
        hitCatchIndex >= 0 &&
        hitCatchIndex < hitRearmIndex &&
        hitRearmIndex < hitWorkIndex &&
        /before sleeping/i.test(hitNext),
      {
        status: hitRun.status,
        out: hitRun.stdout,
        err: hitRun.stderr,
        parsed: hitJson,
      },
    );

    await hardKill(peer);
    await hardKill(runtime);
  }

  // --- every public loss state uses the same two exclusive booleans --------
  for (const kind of ["missing", "retired", "binding_mismatch"]) {
    const { store, path } = freshStore(`aichat-loss-${kind}-`);
    store.close();
    const runtime = startMcp(path);
    await runtime.init();
    const identified = await runtime.call("identify_persona", TUPLE_A);
    const agentId = identified.data.agent_id;
    const raw = new Database(path);
    const connectionId = raw
      .prepare("SELECT connection_id FROM agents WHERE id = ?")
      .get(agentId).connection_id;
    let replacementConnectionId = null;
    if (kind === "missing") {
      raw.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    } else if (kind === "retired") {
      raw
        .prepare(
          `UPDATE agents
              SET connection_id = NULL, retired_at = datetime('now')
            WHERE id = ?`,
        )
        .run(agentId);
    } else {
      replacementConnectionId = randomUUID();
      raw
        .prepare("UPDATE agents SET connection_id = ? WHERE id = ?")
        .run(replacementConnectionId, agentId);
    }
    raw.close();

    const disclosure = await runtime.call("whoami", {});
    const failure = await runtime.call("identify_persona", TUPLE_A);
    const expectedMissing = kind === "missing";
    const expectedRetired = kind === "retired";
    check(
      `${kind} non-advancing disclosure has the public loss booleans`,
      disclosure.isError !== true &&
        disclosure.data.persona_lost === true &&
        disclosure.data.missing === expectedMissing &&
        disclosure.data.retired === expectedRetired &&
        !(disclosure.data.missing && disclosure.data.retired) &&
        ![connectionId, replacementConnectionId]
          .filter(Boolean)
          .some((id) => JSON.stringify(disclosure.data).includes(id)),
      disclosure.data,
    );
    check(
      `${kind} failing identify has the same exclusive public booleans`,
      failure.isError === true &&
        failure.data.code === "persona_lost" &&
        failure.data.missing === expectedMissing &&
        failure.data.retired === expectedRetired &&
        !(failure.data.missing && failure.data.retired) &&
        ![connectionId, replacementConnectionId]
          .filter(Boolean)
          .some((id) => JSON.stringify(failure.data).includes(id)),
      failure.data,
    );
    await hardKill(runtime);
  }

  // --- SIGKILL leaves an orphan, and a fresh connection gets a new id -------
  {
    const { store, path } = freshStore("aichat-hard-kill-");
    store.close();
    const firstRuntime = startMcp(path);
    await firstRuntime.init();
    const first = await firstRuntime.call("identify_persona", TUPLE_A);
    const firstId = first.data.agent_id;
    await firstRuntime.call("create_room", { name: "hard-kill-room" });
    await firstRuntime.call("join_room", { room: "hard-kill-room" });
    const raw = new Database(path);
    const before = raw
      .prepare(
        `SELECT a.connection_id, a.retired_at, m.left_at
           FROM agents a
           JOIN memberships m ON m.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(firstId);
    const killed = new Promise((resolve) =>
      firstRuntime.child.once("exit", (code, signal) =>
        resolve({ code, signal }),
      ),
    );
    firstRuntime.child.kill("SIGKILL");
    const killedResult = await killed;
    const orphan = raw
      .prepare(
        `SELECT a.connection_id, a.retired_at, m.left_at
           FROM agents a
           JOIN memberships m ON m.agent_id = a.id
          WHERE a.id = ?`,
      )
      .get(firstId);
    check(
      "SIGKILL leaves the old identity bound and present",
      killedResult.signal === "SIGKILL" &&
        before.connection_id !== null &&
        orphan.connection_id === before.connection_id &&
        orphan.retired_at === null &&
        orphan.left_at === null,
      { killedResult, before, orphan },
    );

    const secondRuntime = startMcp(path);
    await secondRuntime.init();
    const second = await secondRuntime.call("identify_persona", TUPLE_A);
    const liveRows = raw
      .prepare(
        `SELECT id, connection_id, retired_at FROM agents
          WHERE brand = ? AND model = ? AND version = ?
          ORDER BY id`,
      )
      .all(TUPLE_A.brand, TUPLE_A.model, TUPLE_A.version);
    check(
      "a fresh connection allocates a new id instead of adopting the orphan",
      second.isError !== true &&
        second.data.agent_id !== firstId &&
        liveRows.length === 2 &&
        liveRows.every(
          (row) => row.connection_id !== null && row.retired_at === null,
        ) &&
        new Set(liveRows.map((row) => row.connection_id)).size === 2,
      { firstId, second: second.data, liveRows },
    );
    raw.close();
    await hardKill(secondRuntime);
  }
} catch (error) {
  console.log(
    "FAIL  MCP suite threw:",
    error && error.stack ? error.stack : error,
  );
  failures++;
}

for (const child of children) {
  try {
    child.kill("SIGKILL");
  } catch {}
}
for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);

expect(failures).toBe(0);
}, 90_000);
