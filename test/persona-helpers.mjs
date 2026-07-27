// Test-only convenience for the persona model.
//
// Production code generates persona ids from brand/model/version. Tests want
// short readable ids ("a", "b", "peer") so an assertion failure names something
// legible, so they claim an explicit id through the same atomic create path the
// server uses. This is a TEST helper on purpose: nothing in src/ accepts a
// caller-chosen persona id.
//
// Every persona created here is at runtime_epoch 1, so EPOCH1 is the correct
// captured epoch for any call in a test that never resumes.
export const EPOCH1 = 1;

/** Create an LLM persona with a caller-chosen id. Idempotent: a second call for
 *  the same id is a no-op, matching how tests re-declare a participant. */
export function mkAgent(store, id, opts = {}) {
  store.tryCreatePersona({
    id,
    brand: opts.brand ?? "testbrand",
    model: opts.model ?? "testmodel",
    version: opts.version ?? "1",
    // A FIXED-length word: several tests deliberately use maximal 200-char ids,
    // and deriving the word from the id pushed it past its own length cap.
    resumeWord: opts.resumeWord ?? "test-resume-word",
    description: opts.description ?? null,
  });
  return id;
}

/** Create a human participant (the web population) with the same INSERT the web
 *  server uses: a bare agents row, is_human = 1, no LLM metadata and no resume
 *  word. The store has no human-creation method -- humans exist only on the web
 *  surface -- so this writes the row directly. It goes through the store's own
 *  connection because a ":memory:" store cannot be reopened by path, and `db`
 *  is private only to TypeScript, which never sees this file. */
export function mkHuman(store, id) {
  store.db
    .prepare(
      "INSERT INTO agents (id, is_human) VALUES (?, 1) ON CONFLICT(id) DO NOTHING",
    )
    .run(id);
  return id;
}

/** Create the persona and join it to a room in one step, at epoch 1. */
export function mkMember(store, roomId, id, opts = {}) {
  mkAgent(store, id, opts);
  store.joinRoom(roomId, id, EPOCH1, opts.role !== undefined ? { role: opts.role } : {});
  return id;
}

/** Metadata every mkAgent() persona is created with. An MCP session binds one
 *  of them by calling resume_persona with these values. */
export const TEST_META = { brand: "testbrand", model: "testmodel", version: "1" };
export const TEST_WORD = "test-resume-word";

/** resume_persona arguments for a persona created by mkAgent(). Tests use it to
 *  give an MCP runtime a KNOWN, readable id; real clients get a generated one
 *  from create_persona. */
export function bindArgs(id) {
  return { agent_id: id, resume_word: TEST_WORD, ...TEST_META };
}

/** A persona that exists only so tests can call the room-administration tools,
 *  which are epoch-fenced and therefore require a live binding. It joins no
 *  room, so it never appears in a room-scoped listing or member count. */
const BOOTSTRAP_ID = "testbrand-testmodel-v1-bootstrap";

/** Create a room the way a real runtime must: from a bound, current persona. */
export function mkRoom(store, name, description = null, pinned = null) {
  mkAgent(store, BOOTSTRAP_ID);
  return store.createRoom(name, description, pinned, BOOTSTRAP_ID, EPOCH1);
}

/** Delete a room from a bound, current persona (same fence as mkRoom). */
export function rmRoom(store, roomId) {
  mkAgent(store, BOOTSTRAP_ID);
  return store.deleteRoom(roomId, BOOTSTRAP_ID, EPOCH1);
}
