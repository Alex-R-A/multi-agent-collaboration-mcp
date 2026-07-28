import { randomUUID } from "node:crypto";

// Test-only setup for the connection-bound persona model.
//
// Production supplies both the connection UUID and generated nickname
// candidates. Tests keep candidates short and readable so failures name the
// participant involved, but still create every LLM through identifyPersona.
const bindingsByStore = new WeakMap();
const bootstrapIdByStore = new WeakMap();

export const TEST_META = {
  brand: "testbrand",
  model: "testmodel",
  version: "1",
};

function storeBindings(store) {
  let bindings = bindingsByStore.get(store);
  if (bindings === undefined) {
    bindings = new Map();
    bindingsByStore.set(store, bindings);
  }
  return bindings;
}

/** Identify an LLM with a generated connection UUID and a readable candidate.
 * Repeating the same store/id declaration exercises exact binding reuse. */
export function mkAgent(store, candidateId, opts = {}) {
  const bindings = storeBindings(store);
  const prior = bindings.get(candidateId);
  const connectionId = prior?.connectionId ?? randomUUID();
  const result = store.identifyPersona({
    connectionId,
    brand: opts.brand ?? TEST_META.brand,
    model: opts.model ?? TEST_META.model,
    version: opts.version ?? TEST_META.version,
    description: opts.description ?? null,
    expected: prior?.expected ?? null,
    nextCandidateId: () => candidateId,
  });
  if (result.persona.id !== candidateId) {
    throw new Error(
      `test setup expected candidate ${candidateId}, got ${result.persona.id}`,
    );
  }
  if (
    prior !== undefined &&
    (!result.bindingReused || result.identityChanged)
  ) {
    throw new Error(`test setup did not reuse binding for ${candidateId}`);
  }
  bindings.set(candidateId, {
    connectionId,
    expected: { agentId: result.persona.id, connectionId },
  });
  return result.persona.id;
}

/** Insert a canonical human participant, matching the web writer's row shape. */
export function mkHuman(store, base, ordinal = 1) {
  const id = `human-${base}-${ordinal}`;
  store.db
    .prepare(
      `INSERT INTO agents
         (id, is_human, human_base, human_ordinal)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, base, ordinal);
  return id;
}

/** Identify the persona and join it to a room. */
export function mkMember(store, roomId, candidateId, opts = {}) {
  const id = mkAgent(store, candidateId, opts);
  store.joinRoom(
    roomId,
    id,
    opts.role !== undefined ? { role: opts.role } : {},
  );
  return id;
}

// Room administration requires a live persona but no room membership.
const BOOTSTRAP_ID = "testbrand-testmodel-v1-bootstrap";

function bootstrapId(store) {
  let id = bootstrapIdByStore.get(store);
  if (id === undefined) {
    id = `${BOOTSTRAP_ID}-${randomUUID().slice(0, 8)}`;
    bootstrapIdByStore.set(store, id);
  }
  return id;
}

/** Create a room from a current test persona. */
export function mkRoom(store, name, description = null, pinned = null) {
  const agentId = mkAgent(store, bootstrapId(store));
  return store.createRoom(name, description, pinned, agentId);
}

/** Delete a room from a current test persona. */
export function rmRoom(store, roomId) {
  const agentId = mkAgent(store, bootstrapId(store));
  return store.deleteRoom(roomId, agentId);
}
