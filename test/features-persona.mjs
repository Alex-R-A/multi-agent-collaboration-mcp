// Acceptance coverage for the persona/membership foundation slice.
//
// The model under test: a PERSONA is durable identity (immutable
// brand/model/version, a server-generated resume word, rooms, read positions,
// room-local roles, claims). A RUNTIME is one MCP process. One runtime holds one
// persona; the latest valid resume takes it over and fences the previous
// runtime by incrementing runtime_epoch. Every persona-authored mutation and
// every advancing read re-verifies the runtime's CAPTURED epoch inside the same
// transaction as its write.
//
// Every test uses an isolated temporary AGENT_CHAT_DB. Nothing here opens the
// production database.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ChatStore, PersonaLostError } from "../dist/db.js";
import { mkHuman, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
}

/** Run fn and report which error class came out; never lets a pass happen by
 *  the code silently succeeding. */
function fenced(fn) {
  try {
    fn();
    return { threw: false };
  } catch (e) {
    return { threw: true, personaLost: e instanceof PersonaLostError, message: e.message };
  }
}

const dirs = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "aichat-persona-"));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  return { store: new ChatStore(path), path };
}

const META = { brand: "anthropic", model: "claude-opus", version: "5" };
function seedPersona(store, resumeWord = "amber-otter-1234") {
  const id = "anthropic-claude-opus-v5-" + Math.random().toString(16).slice(2, 8);
  const created = store.tryCreatePersona({
    id,
    ...META,
    resumeWord,
    description: null,
  });
  return { id, resumeWord, created };
}
const attach = (store, id, word = "amber-otter-1234", meta = META) =>
  store.attachPersona({ id, resumeWord: word, ...meta });

try {
  // --- creation ------------------------------------------------------------
  {
    const { store } = freshStore();
    const { id, created } = seedPersona(store);
    check("creation claims the id", created === true);
    check("creation binds epoch 1", store.currentEpoch(id) === 1, store.currentEpoch(id));
    const row = store.getPersona(id);
    check(
      "creation stores the immutable tuple and word",
      row.brand === "anthropic" &&
        row.model === "claude-opus" &&
        row.version === "5" &&
        row.resume_word === "amber-otter-1234" &&
        row.is_human === 0,
      row,
    );
    // A second create on the SAME id must not silently adopt the existing row:
    // that would hand a new runtime another persona's rooms and claims.
    const again = store.tryCreatePersona({
      id,
      ...META,
      resumeWord: "other-word-9",
      description: null,
    });
    check("duplicate id is refused, not adopted", again === false);
    check(
      "refused duplicate left the original word intact",
      store.getPersona(id).resume_word === "amber-otter-1234",
    );
    store.close();
  }

  // --- schema CHECK: no half-persona from a direct writer -------------------
  {
    const { store, path } = freshStore();
    store.close();
    const raw = new Database(path);
    const halfLlm = fenced(() =>
      raw
        .prepare(
          "INSERT INTO agents (id, is_human, brand, model, version) VALUES ('x', 0, 'a', 'b', 'c')",
        )
        .run(),
    );
    check("direct writer cannot create an LLM row with no resume word", halfLlm.threw, halfLlm);
    const halfHuman = fenced(() =>
      raw
        .prepare(
          "INSERT INTO agents (id, is_human, brand) VALUES ('y', 1, 'anthropic')",
        )
        .run(),
    );
    check("direct writer cannot create a human carrying LLM metadata", halfHuman.threw, halfHuman);
    const human = fenced(() =>
      raw.prepare("INSERT INTO agents (id, is_human) VALUES ('z', 1)").run(),
    );
    check("a well-formed human row is accepted", !human.threw, human);
    raw.close();
  }

  // --- idempotent attach vs valid takeover ---------------------------------
  {
    const { store } = freshStore();
    const { id } = seedPersona(store);
    const first = attach(store, id);
    check("bindingless attach increments to 2", first.epoch === 2, first.epoch);
    const second = attach(store, id);
    check("a second bindingless attach increments again", second.epoch === 3, second.epoch);
    check(
      "takeover returns the persona's stored metadata",
      second.persona.brand === "anthropic" && second.persona.model === "claude-opus",
      second.persona,
    );
    store.close();
  }

  // --- invalid resume word / metadata mismatch -----------------------------
  {
    const { store } = freshStore();
    const { id } = seedPersona(store);
    const before = store.currentEpoch(id);
    const badWord = fenced(() => attach(store, id, "wrong-word-1"));
    check("wrong resume word is rejected", badWord.threw, badWord);
    const badModel = fenced(() =>
      attach(store, id, "amber-otter-1234", { ...META, model: "claude-sonnet" }),
    );
    check("model mismatch is rejected", badModel.threw, badModel);
    const badVersion = fenced(() =>
      attach(store, id, "amber-otter-1234", { ...META, version: "4" }),
    );
    check("version mismatch is rejected", badVersion.threw, badVersion);
    const badBrand = fenced(() =>
      attach(store, id, "amber-otter-1234", { ...META, brand: "openai" }),
    );
    check("brand mismatch is rejected", badBrand.threw, badBrand);
    // The critical property: a REJECTED attach must not have fenced anybody.
    // An increment on the failure path would let a wrong guess kill a live
    // runtime it could never legitimately take over.
    check(
      "no rejected attach incremented the epoch",
      store.currentEpoch(id) === before,
      { before, after: store.currentEpoch(id) },
    );
    const unknown = fenced(() => attach(store, "no-such-persona-v1-zzz"));
    check("unknown persona id is rejected", unknown.threw, unknown);
    store.close();
  }

  // --- stale mutation and stale advancing-read rollback --------------------
  {
    const { store } = freshStore();
    const room = mkRoom(store, "fence", null, null).id;
    const { id } = seedPersona(store);
    const A = 1;
    store.joinRoom(room, id, A, {});
    store.postMessage(room, id, "from A", "text", null, null, null, A, {});
    // A peer supplies unread traffic so the advancing read has something to
    // consume; without it an "advanced: false" result proves nothing.
    const peer = seedPersona(store, "peer-word-1");
    store.joinRoom(room, peer.id, 1, {});
    store.postMessage(room, peer.id, "peer says hi", "text", null, null, null, 1, {});

    const cursorBefore = store.getCursor(room, id).last_read_seq;
    const B = attach(store, id).epoch;
    check("takeover moved the epoch past A's", B > A, { A, B });

    // MANUAL ENUMERATION. This map is the only thing standing between a fenced
    // site and silent non-coverage: a new epoch-fenced method that is not added
    // here is asserted nowhere, and deleting its requireEpoch leaves the whole
    // suite green. That is not hypothetical -- create_room and delete_room were
    // fenced by ruling, shipped correctly, and omitted from this map, and both
    // fences could be deleted with 746 tests still passing. EVERY method that
    // takes (agentId, epoch) and writes belongs here, and the obligation is on
    // whoever adds the next one. A source-to-map parity check would mean parsing
    // TypeScript inside a test, which costs more than it is worth; this comment
    // is the proportionate form.
    const mutations = {
      post: () => store.postMessage(room, id, "stale", "text", null, null, null, A, {}),
      mark_read: () => store.markRead(room, id, A),
      leave: () => store.leaveRoom(room, id, A),
      set_role: () => store.setRole(room, id, A, "sneaky"),
      set_room_intro: () => store.setPinned(room, id, A, "stale intro"),
      claim: () => store.claimResource(room, "k", id, A, 60, null),
      release_claim: () => store.releaseClaim(room, "k", id, A),
      prune: () => store.pruneMessages(room, id, A, 1, true),
      join: () => store.joinRoom(room, id, A, {}),
      liveness_touch: () => store.touch(room, id, A),
      captured_room_touch: () => store.touchJoinedRoom(room, id, A),
      wait_lease: () => store.beginWaitLease(room, id, A, 30),
      // Room administration is GLOBAL and unscoped by membership, which is
      // exactly why it must be fenced: delete_room is the one irreversible
      // operation in the surface, and a runtime the system positively knows is
      // superseded must not reach it.
      create_room: () => store.createRoom("stale-room", null, null, id, A),
      delete_room: () => store.deleteRoom(room, id, A),
    };
    for (const [name, fn] of Object.entries(mutations)) {
      const r = fenced(fn);
      check(`stale ${name} is fenced with persona_lost`, r.threw && r.personaLost, r);
    }
    const staleRead = fenced(() => store.catchUp(room, id, 50, undefined, 100000, A));
    check(
      "stale advancing read is fenced with persona_lost",
      staleRead.threw && staleRead.personaLost,
      staleRead,
    );
    // ROLLBACK, not merely "threw": none of the above may have left a trace.
    //
    // The delete checks come FIRST. Every assertion below reads a row from this
    // room, so an unfenced delete makes them all throw on undefined and the
    // block reports a TypeError instead of naming the irreversible operation
    // that caused it.
    check(
      "stale delete_room left the room standing",
      store.getRoom(room) !== undefined,
      store.getRoom(room),
    );
    check(
      "and left its messages and memberships intact",
      store.readHistory(room, 50).messages.length === 2 &&
        store.getCursor(room, id) !== undefined &&
        store.getCursor(room, peer.id) !== undefined,
      {
        messages: store.readHistory(room, 50).messages.length,
        mine: store.getCursor(room, id),
        peer: store.getCursor(room, peer.id),
      },
    );
    check(
      "no stale operation moved the read cursor",
      store.getCursor(room, id).last_read_seq === cursorBefore,
      { before: cursorBefore, after: store.getCursor(room, id).last_read_seq },
    );
    check("stale leave did not mark the persona absent", store.getCursor(room, id).left_at === null);
    check("stale set_role did not write a role", store.getRole(room, id) === null);
    check("stale set_room_intro did not write", store.getRoom(room).pinned === null);
    check("stale claim did not create a claim", store.listClaims(room, 10, "").total === 0);
    check(
      "stale prune did not delete messages",
      store.readHistory(room, 50).messages.length === 2,
      store.readHistory(room, 50).messages.length,
    );
    check(
      "stale post did not insert",
      !store.readHistory(room, 50).messages.some((m) => m.content === "stale"),
    );
    check(
      "stale create_room left no room behind",
      store.resolveRoom("stale-room") === undefined,
      store.resolveRoom("stale-room"),
    );

    // The winner is unaffected and can still work.
    const good = store.catchUp(room, id, 50, undefined, 100000, B);
    check(
      "the current runtime's advancing read still works",
      good.messages.length === 1 && good.messages[0].from === peer.id,
      good.messages.map((m) => m.from),
    );
    store.close();
  }

  // --- ABA: same runtime, earlier tenure -----------------------------------
  //
  // The case a "is the caller currently bound?" check silently passes: runtime A
  // holds the persona at epoch 5, loses it to B at 6, RE-TAKES it at 7, and then
  // an operation A started back at 5 finally lands. A is authoritative again, so
  // any identity-based check says yes; only the CAPTURED epoch says no. This is
  // the failure that killed the reusable-nonce design.
  {
    const { store } = freshStore();
    const room = mkRoom(store, "aba", null, null).id;
    const { id } = seedPersona(store);
    let e = 1;
    store.joinRoom(room, id, e, {});
    while (store.currentEpoch(id) < 5) e = attach(store, id).epoch;
    const tenureA = store.currentEpoch(id);
    check("A holds the persona at epoch 5", tenureA === 5, tenureA);
    const tenureB = attach(store, id).epoch; // B takes over
    const tenureA2 = attach(store, id).epoch; // A takes it back
    check("A re-took the persona at epoch 7", tenureA2 === 7, { tenureB, tenureA2 });
    check(
      "A is the CURRENT holder again",
      store.currentEpoch(id) === tenureA2,
      store.currentEpoch(id),
    );
    // The in-flight operation from A's FIRST tenure must still fail.
    const inFlight = fenced(() =>
      store.postMessage(room, id, "from tenure 5", "text", null, null, null, tenureA, {}),
    );
    check(
      "an operation captured at epoch 5 fails against 7 even though A is bound again",
      inFlight.threw && inFlight.personaLost,
      inFlight,
    );
    check(
      "the same operation at the CURRENT epoch succeeds",
      store.postMessage(room, id, "from tenure 7", "text", null, null, null, tenureA2, {}).posted,
    );
    store.close();
  }

  // --- room-local role: set, clear, isolation ------------------------------
  {
    const { store } = freshStore();
    const r1 = mkRoom(store, "one", null, null).id;
    const r2 = mkRoom(store, "two", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(r1, id, 1, { role: "reviewer" });
    store.joinRoom(r2, id, 1, {});
    check("join sets the initial room-local role", store.getRole(r1, id) === "reviewer");
    check("the other room has no role", store.getRole(r2, id) === null);
    // Back-date BOTH rooms so a refresh is observable: datetime('now') has
    // one-second resolution, and the joins above already stamped this second.
    const OLD_SEEN = "2000-01-01 00:00:00";
    store.db
      .prepare("UPDATE memberships SET last_seen = ? WHERE agent_id = ?")
      .run(OLD_SEEN, id);
    // Read last_seen with an explicit SELECT. getMembership() returns only
    // last_read_seq/left_at, so `getMembership(...).last_seen` is undefined and
    // any comparison against it passes no matter what the code does.
    const readSeen = store.db.prepare(
      "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
    );
    const seenIn = (roomId) => readSeen.get(roomId, id).last_seen;
    store.setRole(r2, id, 1, "writer");
    check(
      "set_role in room two does not touch room one",
      store.getRole(r1, id) === "reviewer" && store.getRole(r2, id) === "writer",
      { r1: store.getRole(r1, id), r2: store.getRole(r2, id) },
    );
    // A role change is attendance IN THAT ROOM. If set_role did not refresh
    // last_seen, an agent could work exclusively in room two and still read as
    // an unattended seat there while some other room got the liveness credit.
    check(
      "set_role refreshes last_seen in the room whose role it changed",
      seenIn(r2) !== OLD_SEEN,
      { r2: seenIn(r2) },
    );
    check(
      "and refreshes ONLY that room",
      seenIn(r1) === OLD_SEEN,
      { r1: seenIn(r1) },
    );
    store.setRole(r1, id, 1, null);
    check("set_role(null) CLEARS rather than storing an empty string", store.getRole(r1, id) === null);
    check("clearing room one left room two alone", store.getRole(r2, id) === "writer");
    // Omission is not an update: a rejoin without `role` must keep it.
    store.joinRoom(r2, id, 1, {});
    check("rejoin without role keeps the existing role", store.getRole(r2, id) === "writer");
    // A role survives leave/rejoin, like the read position.
    store.leaveRoom(r2, id, 1);
    store.joinRoom(r2, id, 1, {});
    check("role survives leave and rejoin", store.getRole(r2, id) === "writer");
    // The non-membership check must be tested with an EXISTING persona at a
    // VALID epoch. An unknown id trips the epoch guard first, so that version
    // passes with the membership check deleted and proves nothing about it.
    const outsider = seedPersona(store, "outsider-word-2");
    const notMember = fenced(() => store.setRole(r1, outsider.id, 1, "x"));
    check(
      "set_role by an existing persona that never joined the room is refused",
      notMember.threw && !notMember.personaLost && /not a member/.test(notMember.message),
      notMember,
    );
    check(
      "the refusal left no role behind",
      store.getRole(r1, outsider.id) === null,
      store.getRole(r1, outsider.id),
    );
    // NULL is the only unassigned role. A blank string renders as "no role"
    // while still being a set value, so a listing would show a role no filter
    // can match and no reader can see.
    for (const blank of ["", "   ", "\t\n"]) {
      const rejected = fenced(() => store.setRole(r2, id, 1, blank));
      check(
        `set_role rejects a blank role ${JSON.stringify(blank)}`,
        rejected.threw && /non-blank/.test(rejected.message),
        rejected,
      );
    }
    check(
      "the rejected blanks did not disturb the existing role",
      store.getRole(r2, id) === "writer",
      store.getRole(r2, id),
    );
    const blankJoin = fenced(() => store.joinRoom(r1, id, 1, { role: "  " }));
    check("join_room rejects a blank role too", blankJoin.threw, blankJoin);
    store.close();
  }

  // --- the LEFT-participation boundary -------------------------------------
  //
  // Leaving is a factual statement to peers: this seat is empty. Every call
  // that AUTHORS into a room or ADVANCES a durable position must therefore
  // refuse while absent, because each one is visible to the room -- and a
  // silent consumption of directed traffic by someone the room sees as gone is
  // the exact failure. What stays open is what carries no such claim: reading
  // without moving a marker, and releasing a lock you still hold.
  //
  // The refusal must name REJOIN. join_room restores the read position and the
  // room-local role, so the remedy is one call, and an agent told only "you
  // have left" will not reliably infer that.
  {
    const { store } = freshStore();
    const room = mkRoom(store, "boundary", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "boundary-peer-3");
    store.joinRoom(room, id, 1, { role: "writer" });
    store.joinRoom(room, peer.id, 1, {});
    store.postMessage(room, peer.id, "before the leave", "text", null, null, null, 1, {});
    // A SECOND message, so keepLast:1 gives an unguarded prune something real to
    // delete. With one message the early `total <= keepLast` return would make
    // the prune tests pass without ever reaching the guard.
    store.postMessage(room, peer.id, "also before the leave", "text", null, null, null, 1, {});
    store.claimResource(room, "held-across-leave", id, 1, 600, null);
    const markerBefore = store.getCursor(room, id).last_read_seq;
    store.leaveRoom(room, id, 1);

    const gated = {
      post: () => store.postMessage(room, id, "from an empty seat", "text", null, null, null, 1, {}),
      catch_up: () => store.catchUp(room, id, 50, undefined, 100000, 1),
      mark_read: () => store.markRead(room, id, 1),
      set_role: () => store.setRole(room, id, 1, "ghost"),
      claim: () => store.claimResource(room, "new-lock", id, 1, 60, null),
      wait_lease: () => store.beginWaitLease(room, id, 1, 30),
      // The pinned intro is authored room content, read by every joiner.
      set_room_intro: () =>
        store.setPinned(room, id, 1, "hijacked by a departed member"),
      // The room's most destructive scoped write, in both modes: force skips
      // the unread refusal, so it must be stopped by the boundary instead.
      prune: () => store.pruneMessages(room, id, 1, 1, false),
      prune_force: () => store.pruneMessages(room, id, 1, 1, true),
    };
    for (const [name, fn] of Object.entries(gated)) {
      const r = fenced(fn);
      check(
        `${name} is refused while LEFT, and the error names rejoin`,
        r.threw && !r.personaLost && /join_room/.test(r.message) && /LEFT/.test(r.message),
        { name, ...r },
      );
    }
    // ROLLBACK, not merely "threw".
    check(
      "no refused call moved the read marker",
      store.getCursor(room, id).last_read_seq === markerBefore,
      { before: markerBefore, after: store.getCursor(room, id).last_read_seq },
    );
    check("no refused call wrote a role", store.getRole(room, id) === "writer", store.getRole(room, id));
    check(
      "no refused call took the new claim",
      store.listClaims(room).claims.every((c) => c.key !== "new-lock"),
      store.listClaims(room).claims,
    );
    check(
      "and the refused post is not in the room",
      !store
        .readHistory(room, 50, undefined, undefined, 100000)
        .messages.some((m) => m.content === "from an empty seat"),
      null,
    );
    check(
      "the refused set_room_intro did not rewrite the pinned intro",
      store.getRoom(room).pinned === null,
      store.getRoom(room).pinned,
    );
    // The destructive one. Both prune modes ran above; if either had reached
    // the DELETE, keepLast:1 would have taken the older message with it.
    check(
      "the refused prunes destroyed no history",
      store.readHistory(room, 50, undefined, undefined, 100000).messages.length === 2,
      store.readHistory(room, 50, undefined, undefined, 100000).messages.map((m) => m.content),
    );
    // A liveness heartbeat must not perform a state transition join_room owns.
    // touch() is a silent no-op here rather than a throw: it is best-effort and
    // its caller swallows errors, so the assertion is on the ROW, not on a
    // thrown error that would never surface anyway.
    const leftBefore = store.getCursor(room, id).left_at;
    store.touch(room, id, 1);
    check(
      "touch on a LEFT membership does not silently rejoin it",
      typeof leftBefore === "string" && store.getCursor(room, id).left_at === leftBefore,
      { before: leftBefore, after: store.getCursor(room, id).left_at },
    );

    // What a left member KEEPS. Auditing costs the room nothing, and a lock
    // held into a departure must be releasable or it blocks every other writer
    // until its TTL expires.
    const audit = fenced(() =>
      store.readHistory(room, 50, undefined, undefined, 100000),
    );
    check("a left member can still READ history without advancing", !audit.threw, audit);
    check(
      "the non-advancing read did not advance the marker either",
      store.getCursor(room, id).last_read_seq === markerBefore,
      store.getCursor(room, id).last_read_seq,
    );
    const released = fenced(() => store.releaseClaim(room, "held-across-leave", id, 1));
    check("a left member can still RELEASE a claim it holds", !released.threw, released);
    check(
      "and the claim is actually gone, not merely un-erroring",
      store.listClaims(room).claims.every((c) => c.key !== "held-across-leave"),
      store.listClaims(room).claims,
    );

    // Rejoin restores everything the boundary blocked, at the preserved marker.
    store.joinRoom(room, id, 1, {});
    const afterRejoin = fenced(() => store.postMessage(room, id, "back", "text", null, null, null, 1, {}));
    check("rejoining restores authoring", !afterRejoin.threw, afterRejoin);
    check(
      "rejoin preserved the read position and the role",
      store.getCursor(room, id).last_read_seq === markerBefore &&
        store.getRole(room, id) === "writer",
      { marker: store.getCursor(room, id).last_read_seq, role: store.getRole(room, id) },
    );
    store.close();
  }

  // --- agent-chat-check agrees with the boundary, and normalizes its flags --
  //
  // The diagnostic and the watcher take the same flags from the same generated
  // commands, so they must answer the same question the same way. Two ways they
  // did not: check trimmed nothing while the poller trimmed everything, and
  // check reported actionable unread for a room whose catch_up now refuses and
  // whose scoped watcher will not arm.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "check-cli", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "check-peer-9");
    store.joinRoom(room, id, 1, {});
    store.joinRoom(room, peer.id, 1, {});
    store.postMessage(room, peer.id, "unread one", "text", null, null, null, 1, {});
    store.postMessage(room, peer.id, "unread two", "text", null, null, null, 1, {});
    store.close();

    const CHECK = join(ROOT, "dist", "check.js");
    const runCheck = (args) =>
      spawnSync(process.execPath, [CHECK, ...args, "--db", path], {
        encoding: "utf8",
      });

    // A padded value must name the SAME persona the poller would watch.
    // Untrimmed, "  <id>  " matches no membership and the probe exits 2.
    const padded = runCheck(["--agent", `  ${id}  `, "--room", String(room)]);
    let paddedOut = null;
    try {
      paddedOut = JSON.parse(padded.stdout);
    } catch {}
    check(
      "check.js trims a padded --agent and finds the real unread work",
      padded.status === 0 && paddedOut?.unread === 2 && paddedOut?.agent === id,
      { status: padded.status, out: padded.stdout.slice(0, 200), err: padded.stderr.slice(0, 200) },
    );

    const store2 = new ChatStore(path);
    store2.leaveRoom(room, id, 1);
    store2.close();

    // The unread is still REAL -- two peer messages past the marker -- so this
    // cannot pass by the room being empty.
    const afterLeave = runCheck(["--agent", id, "--room", String(room)]);
    check(
      "check.js refuses a scoped agent-marker probe on a room the persona LEFT",
      afterLeave.status === 2 &&
        /has LEFT room/.test(afterLeave.stderr) &&
        /join_room/.test(afterLeave.stderr),
      { status: afterLeave.status, err: afterLeave.stderr.slice(0, 300) },
    );

    // --since is membership-independent by contract and must stay that way:
    // the refusal above is about an unusable READ MARKER, not about the room.
    const since = runCheck(["--room", String(room), "--since", "0"]);
    let sinceOut = null;
    try {
      sinceOut = JSON.parse(since.stdout);
    } catch {}
    check(
      "explicit --since still probes the room without a usable membership",
      since.status === 0 && sinceOut?.unread === 2,
      { status: since.status, out: since.stdout.slice(0, 200), err: since.stderr.slice(0, 200) },
    );
  }

  // --- role is NOT stamped into message envelopes --------------------------
  {
    const { store } = freshStore();
    const room = mkRoom(store, "envelope", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "peer-word-2");
    store.joinRoom(room, id, 1, { role: "reviewer" });
    store.joinRoom(room, peer.id, 1, {});
    store.postMessage(room, peer.id, "hello", "text", null, null, null, 1, {});
    const read = store.catchUp(room, id, 10, undefined, 100000, 1);
    const msg = read.messages[0];
    check(
      "message envelopes carry no from_role/from_type",
      !("from_role" in msg) && !("from_type" in msg),
      Object.keys(msg),
    );
    store.close();
  }

  // --- membership, cursor, role and claim continuity across resume ---------
  {
    const { store } = freshStore();
    const room = mkRoom(store, "continuity", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "peer-word-3");
    store.joinRoom(room, id, 1, { role: "planner" });
    store.joinRoom(room, peer.id, 1, {});
    for (let i = 0; i < 4; i++) {
      store.postMessage(room, peer.id, "m" + i, "text", null, null, null, 1, {});
    }
    store.catchUp(room, id, 2, undefined, 100000, 1);
    const cursor = store.getCursor(room, id).last_read_seq;
    const claim = store.claimResource(room, "build", id, 1, 900, "compiling");
    check("claim granted before the resume", claim.granted === true, claim);

    const e2 = attach(store, id).epoch;
    check("read position survives the resume", store.getCursor(room, id).last_read_seq === cursor);
    check("room-local role survives the resume", store.getRole(room, id) === "planner");
    const claims = store.listClaims(room, 10, "");
    check(
      "the claim survives the resume and is still held by the same persona",
      claims.total === 1 && claims.claims[0].holder === id,
      claims,
    );
    // Continuity is only useful if the NEW runtime can act on it: re-claiming
    // its own key must renew, not be refused as another holder's.
    const renew = store.claimResource(room, "build", id, e2, 900, "still compiling");
    check("the new runtime renews its own inherited claim", renew.granted === true && renew.renewed === true, renew);
    check(
      "the new runtime resumes reading where the old one stopped",
      store.catchUp(room, id, 10, undefined, 100000, e2).messages.length === 2,
    );
    store.close();
  }

  // --- wait lease: cleanup isolation and the stolen-delete inversion -------
  //
  // The ordering that matters is NOT "X cleans up, then Y starts" -- that is
  // trivially safe. It is X's finally-block firing AFTER Y has already taken
  // over and written its own lease. An unguarded delete (or an upsert that
  // failed to overwrite the epoch) removes the WINNER's live row and reports it
  // as not watching.
  {
    const { store } = freshStore();
    const room = mkRoom(store, "leases", null, null).id;
    const { id } = seedPersona(store);
    const X = 1;
    store.joinRoom(room, id, X, {});
    store.beginWaitLease(room, id, X, 30);
    const watchingAsX = store.listAgents(room, 5).agents.find((a) => a.id === id).watching;
    check("X's open wait reads as watching", watchingAsX === true);

    const Y = attach(store, id).epoch;
    store.beginWaitLease(room, id, Y, 30); // winner replaces the row
    // NOW X's finally block runs, late.
    store.endWaitLease(room, id, X);
    const rows = store.listAgents(room, 5).agents.find((a) => a.id === id);
    check(
      "X's late cleanup did NOT delete Y's lease",
      rows.watching === true,
      rows,
    );
    // And Y's own cleanup still works.
    store.endWaitLease(room, id, Y);
    check(
      "Y's own cleanup removes Y's lease",
      store.listAgents(room, 5).agents.find((a) => a.id === id).watching === false,
    );
    // One persona has ONE lease per room: the takeover replaced, never appended.
    const raw = store.raw ?? null;
    void raw;
    store.close();
  }
  {
    // Same shape, checked at the row level: exactly one lease row exists after
    // a takeover, and it carries the WINNER's epoch (the seq 154/157 inversion
    // is precisely an upsert that leaves the loser's epoch in place).
    const { store, path } = freshStore();
    const room = mkRoom(store, "leaserows", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    store.beginWaitLease(room, id, 1, 30);
    const Y = attach(store, id).epoch;
    store.beginWaitLease(room, id, Y, 30);
    store.close();
    const raw = new Database(path, { readonly: true });
    const leases = raw.prepare("SELECT agent_id, epoch FROM wait_leases WHERE room_id = ?").all(room);
    raw.close();
    check(
      "a takeover leaves exactly one lease row, carrying the winner's epoch",
      leases.length === 1 && leases[0].epoch === Y,
      leases,
    );
  }

  // --- human participation: lifecycle and symmetric adoption rejection -----
  {
    const { store } = freshStore();
    mkRoom(store, "humans", null, null);
    mkHuman(store, "alex");
    const human = store.getPersona("alex");
    check(
      "the human carries no tuple and no resume word",
      human.is_human === 1 &&
        human.brand === null &&
        human.model === null &&
        human.version === null &&
        human.resume_word === null,
      human,
    );
    // The opposite direction -- a human NAME colliding with an existing LLM
    // persona -- is refused by the web server, the only surface that creates
    // humans, and is covered there (web-participate.mjs, "a human web join
    // cannot adopt an LLM persona id"). The two checks below are the halves the
    // STORE owns.
    // An LLM resume aimed at a human id.
    const adopt = fenced(() => attach(store, "alex"));
    check("an LLM resume cannot adopt a human id", adopt.threw, adopt);
    // create_persona cannot take a human's name either.
    check(
      "creating an LLM persona cannot take a human's id",
      store.tryCreatePersona({
        id: "alex",
        ...META,
        resumeWord: "x-y-1",
        description: null,
      }) === false,
    );
    check(
      "the human row was not rewritten by any of those attempts",
      store.getPersona("alex").is_human === 1 && store.getPersona("alex").brand === null,
      store.getPersona("alex"),
    );
    store.close();
  }

  // --- cursor_start: new membership only -----------------------------------
  {
    const { store } = freshStore();
    const room = mkRoom(store, "baseline", null, null).id;
    const peer = seedPersona(store, "peer-word-4");
    store.joinRoom(room, peer.id, 1, {});
    for (let i = 0; i < 5; i++) {
      store.postMessage(room, peer.id, "backlog " + i, "text", null, null, null, 1, {});
    }
    const late = seedPersona(store, "late-word-5");
    const joined = store.joinRoom(room, late.id, 1, { cursorStart: "latest" });
    check("a first join reports created", joined.created === true);
    check(
      "cursor_start:latest skips the backlog",
      store.catchUp(room, late.id, 50, undefined, 100000, 1).messages.length === 0,
    );
    store.postMessage(room, peer.id, "after joining", "text", null, null, null, 1, {});
    const after = store.catchUp(room, late.id, 50, undefined, 100000, 1);
    check(
      "messages after the baseline are still delivered",
      after.messages.length === 1 && after.messages[0].content === "after joining",
      after.messages.map((m) => m.content),
    );

    // A REJOIN must never re-baseline: resuming a persona exists precisely to
    // keep the backlog it has not read.
    store.postMessage(room, peer.id, "unread while away", "text", null, null, null, 1, {});
    // Assert the marker VALUE across the rejoin, not just the message count. A
    // NONZERO marker is the case that discriminates: a rejoin that reset to 0
    // and one that re-baselined to latest are different bugs, and a count-only
    // check on a zero marker would miss the first.
    const markerBeforeRejoin = store.getCursor(room, late.id).last_read_seq;
    check(
      "the marker under test is nonzero, so preserving it means something",
      markerBeforeRejoin > 0,
      markerBeforeRejoin,
    );
    const rejoin = store.joinRoom(room, late.id, 1, { cursorStart: "latest" });
    check("a rejoin reports created:false", rejoin.created === false);
    check(
      "a rejoin preserves the exact nonzero marker",
      store.getCursor(room, late.id).last_read_seq === markerBeforeRejoin,
      {
        before: markerBeforeRejoin,
        after: store.getCursor(room, late.id).last_read_seq,
      },
    );
    const stillThere = store.catchUp(room, late.id, 50, undefined, 100000, 1);
    check(
      "cursor_start on a rejoin does NOT discard unread messages",
      stillThere.messages.length === 1 &&
        stillThere.messages[0].content === "unread while away",
      stillThere.messages.map((m) => m.content),
    );

    // Default stays start-at-beginning.
    const beginner = seedPersona(store, "beg-word-6");
    store.joinRoom(room, beginner.id, 1, {});
    check(
      "the default start delivers the whole history",
      store.catchUp(room, beginner.id, 50, undefined, 100000, 1).messages.length === 7,
      store.catchUp(room, beginner.id, 50, undefined, 100000, 1).messages.length,
    );
    store.close();
  }

  // --- the two unreadByRoom callers ----------------------------------------
  //
  // by_room / rooms_with_unread is built by a single shared query whose
  // parameter list is easy to get wrong and which only runs on specific paths:
  // my_mentions always, catch_up only on an EMPTY read. A binding bug there is
  // invisible to every other test in this file.
  {
    const { store } = freshStore();
    const quiet = mkRoom(store, "quiet", null, null).id;
    const busy = mkRoom(store, "busy", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "peer-word-9");
    for (const r of [quiet, busy]) {
      store.joinRoom(r, id, 1, {});
      store.joinRoom(r, peer.id, 1, {});
    }
    store.postMessage(busy, peer.id, "broadcast", "text", null, null, null, 1, {});
    store.postMessage(busy, peer.id, "@you", "text", [id], null, null, 1, {});

    const inbox = store.myMentions(id, 10);
    check(
      "my_mentions returns the directed row and a by_room summary",
      inbox.messages.length === 1 && inbox.by_room.length === 1,
      { messages: inbox.messages.length, by_room: inbox.by_room },
    );
    check(
      "by_room counts total unread and directed separately",
      inbox.by_room[0].room_id === busy &&
        inbox.by_room[0].unread === 2 &&
        inbox.by_room[0].directed === 1,
      inbox.by_room,
    );
    check("my_mentions total_directed is the scalar count", inbox.total_directed === 1, inbox);

    // An empty read of the QUIET room must disclose the busy one.
    const empty = store.catchUp(quiet, id, 50, undefined, 100000, 1, {});
    check(
      "an empty catch_up discloses other rooms with unread",
      empty.messages.length === 0 &&
        Array.isArray(empty.rooms_with_unread) &&
        empty.rooms_with_unread.length === 1 &&
        empty.rooms_with_unread[0].room_id === busy,
      empty.rooms_with_unread,
    );
    store.close();
  }

  // --- non-advancing reads disclose, never fail ----------------------------
  {
    const { store } = freshStore();
    const room = mkRoom(store, "disclose", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "peer-word-7");
    store.joinRoom(room, id, 1, {});
    store.joinRoom(room, peer.id, 1, {});
    store.postMessage(room, peer.id, "@you", "text", [id], null, null, 1, {});
    const stale = 1;
    attach(store, id); // fence the holder at epoch 1
    const peek = fenced(() => store.myMentions(id, 10));
    check("my_mentions (non-advancing) still works after a takeover", !peek.threw, peek);
    const history = fenced(() => store.readHistory(room, 10));
    check("read_history (non-advancing) still works after a takeover", !history.threw, history);
    check(
      "currentEpoch discloses the loss without throwing",
      store.currentEpoch(id) !== stale,
      store.currentEpoch(id),
    );
    store.close();
  }
} catch (e) {
  console.log("FAIL  store-level suite threw:", e && e.stack ? e.stack : e);
  failures++;
}

// --- poller epoch rejection ------------------------------------------------
//
// Two shapes, because they fail differently. Both use the DOCUMENTED
// independent-lifetime mode (no --owner-pid), which is the one that outlives its
// runtime and therefore actually needs the epoch.
function runPoller(args, timeoutMs = 15_000) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "poller.js"), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false });
    });
  });
  // The CHILD is returned alongside the result promise: a readiness barrier has
  // to see the process to give up when it dies instead of waiting out its
  // deadline. Callers that only want the outcome await `.done`.
  return { child, done };
}

/**
 * The singleton lock path a watcher with these arguments will take, derived the
 * same way poller.ts derives it. realpath because the poller canonicalizes the
 * database path before hashing, and macOS temp dirs are symlinked.
 */
function pollerLockPath(dbPath, agentId, roomId, epoch, mentionsOnly = false) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const dir = join(
    tmpdir(),
    uid === null ? "agent-chat-pollers" : `agent-chat-pollers-${uid}`,
  );
  const name =
    createHash("sha256")
      .update(
        JSON.stringify([
          realpathSync(dbPath),
          agentId,
          roomId,
          epoch,
          mentionsOnly,
        ]),
      )
      .digest("hex") + ".lock";
  return join(dir, name);
}

/**
 * Wait until a watcher has OBSERVABLY armed, instead of sleeping a fixed
 * interval and hoping.
 *
 * The watcher writes its singleton lock after opening the database and before
 * its first probe, so the lock appearing is the earliest instant at which a
 * write made afterwards is guaranteed to be seen by some later probe. A fixed
 * sleep makes the opposite promise: it is correct only while the machine stays
 * as fast as the machine it was tuned on, and when it stops being correct the
 * test does not fail, it flakes.
 *
 * Returns false on timeout or on the child dying first, so the caller asserts
 * readiness rather than assuming it.
 */
async function waitForArmed(lockPath, child, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(lockPath)) return true;
    if (child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

try {
  // Shape 1: an EXPLICIT takeover while the watcher is armed.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "watch-explicit", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    store.close();
    const armed = runPoller([
      "--agent", id, "--room", String(room), "--epoch", "1",
      "--interval", "5", "--timeout", "12", "--ok-on-timeout", "--db", path,
    ]);
    const ready = await waitForArmed(
      pollerLockPath(path, id, room, 1),
      armed.child,
    );
    check("the explicit-takeover watcher armed", ready, "no lock within 6s");
    const s2 = new ChatStore(path);
    attach(s2, id);
    s2.close();
    const result = await armed.done;
    check(
      "an armed watcher exits 2 with stale_binding after an explicit takeover",
      result.code === 2 && /stale_binding/.test(result.err),
      result,
    );
  }

  // Shape 2: BINDINGLESS attach with no explicit "takeover" in sight. The
  // previous runtime died cleanly and a fresh one resumed. If attach did not
  // increment on this path, the orphaned watcher would keep firing forever into
  // a seat nobody occupies -- and every listed test would still pass.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "watch-bindingless", null, null).id;
    const { id, resumeWord } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    store.close();
    const orphan = runPoller([
      "--agent", id, "--epoch", "1",
      "--interval", "5", "--timeout", "12", "--ok-on-timeout", "--db", path,
    ]);
    // An UNSCOPED watch: room is null in the singleton key.
    const orphanReady = await waitForArmed(
      pollerLockPath(path, id, null, 1),
      orphan.child,
    );
    check("the orphan watcher armed", orphanReady, "no lock within 6s");
    // A brand-new runtime with only the id, word, and metadata -- no knowledge
    // that any watcher exists.
    const s2 = new ChatStore(path);
    const resumed = s2.attachPersona({ id, resumeWord, ...META });
    s2.close();
    check("bindingless resume incremented the epoch", resumed.epoch === 2, resumed.epoch);
    const result = await orphan.done;
    check(
      "an all-rooms orphan watcher exits stale_binding because bindingless attach increments",
      result.code === 2 && /stale_binding/.test(result.err),
      result,
    );
  }

  // Control: a watcher at the CURRENT epoch is not killed by the check, and
  // still fires on real traffic. Without this, every test above would pass if
  // the poller simply always exited 2.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "watch-live", null, null).id;
    const { id } = seedPersona(store);
    const peer = seedPersona(store, "peer-word-8");
    store.joinRoom(room, id, 1, {});
    store.joinRoom(room, peer.id, 1, {});
    store.close();
    const armed = runPoller([
      "--agent", id, "--room", String(room), "--epoch", "1",
      "--interval", "5", "--timeout", "12", "--ok-on-timeout", "--db", path,
    ]);
    const liveReady = await waitForArmed(
      pollerLockPath(path, id, room, 1),
      armed.child,
    );
    check("the current-epoch control watcher armed", liveReady, "no lock within 6s");
    const s2 = new ChatStore(path);
    s2.postMessage(room, peer.id, "wake up", "text", null, null, null, 1, {});
    s2.close();
    const result = await armed.done;
    let parsed = null;
    try {
      parsed = JSON.parse(result.out.trim().split("\n")[0]);
    } catch {}
    check(
      "a current-epoch watcher still fires on real traffic",
      result.code === 0 && parsed && parsed.has_updates === true && parsed.room_id === room,
      result,
    );
  }
  // --- the watcher's liveness heartbeat ------------------------------------
  //
  // A GENERATED watcher (one carrying both --owner-pid and --epoch) refreshes
  // its persona's last_seen so an armed seat does not read as offline while its
  // model sits between turns. That reverses a deliberate invariant -- the
  // watcher used to be strictly query_only -- so each condition under which it
  // must NOT write is asserted separately. Every case below sets last_seen to a
  // known old value first, so "unchanged" is a real observation rather than the
  // absence of any value at all.
  const OLD_SEEN = "2000-01-01 00:00:00";
  const heartbeatCase = async (label, { epochArg, ownerPid, leave = false, expectRefresh }) => {
    const { store, path } = freshStore();
    const room = mkRoom(store, "hb-" + label.slice(0, 12), null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    if (leave) store.leaveRoom(room, id, 1);
    store.close();
    const raw = new Database(path);
    raw
      .prepare("UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?")
      .run(OLD_SEEN, room, id);
    const args = ["--agent", id, "--room", String(room)];
    if (epochArg !== undefined) args.push("--epoch", String(epochArg));
    if (ownerPid !== undefined) args.push("--owner-pid", String(ownerPid));
    args.push("--interval", "5", "--timeout", "2", "--ok-on-timeout", "--db", path);
    const result = await runPoller(args).done;
    const row = raw
      .prepare("SELECT last_seen, left_at FROM memberships WHERE room_id = ? AND agent_id = ?")
      .get(room, id);
    raw.close();
    const refreshed = row.last_seen !== OLD_SEEN;
    check(
      label,
      refreshed === expectRefresh,
      { last_seen: row.last_seen, left_at: row.left_at, exit: result.code, err: result.err.slice(0, 200) },
    );
    return row;
  };

  const armedRow = await heartbeatCase(
    "a generated watcher (owner-pid + epoch) refreshes last_seen on arm",
    { epochArg: 1, ownerPid: process.pid, expectRefresh: true },
  );
  check(
    "the heartbeat did not touch left_at",
    armedRow.left_at === null,
    armedRow,
  );
  await heartbeatCase(
    "a watcher at a STALE epoch does not refresh liveness",
    { epochArg: 99, ownerPid: process.pid, expectRefresh: false },
  );
  await heartbeatCase(
    "a diagnostic watcher with no --owner-pid does not write at all",
    { epochArg: 1, expectRefresh: false },
  );
  await heartbeatCase(
    "a watcher with no --epoch does not write at all",
    { ownerPid: process.pid, expectRefresh: false },
  );
  // A LEFT membership must stay left and stay stale: the heartbeat's WHERE
  // clause excludes it, and it never clears left_at, so an armed watcher cannot
  // put a departed persona back in the room.
  const leftRow = await heartbeatCase(
    "a watcher does not refresh a membership the persona has LEFT",
    { epochArg: 1, ownerPid: process.pid, leave: true, expectRefresh: false },
  );
  check(
    "and the left membership is still left",
    leftRow.left_at !== null,
    leftRow,
  );
  // A SCOPED watcher refreshes only the room it watches. The heartbeat means
  // "a listener is reachable HERE"; spraying it across every room the persona
  // is in would make unwatched rooms read as attended, and a peer deciding
  // whether anyone is listening in room B would be told yes on the strength of
  // a watcher that can never deliver room B's traffic. Predicate coherence:
  // where it DELIVERS must equal where it reports LISTENING.
  {
    const { store, path } = freshStore();
    const watched = mkRoom(store, "hb-scope-watched", null, null).id;
    const unwatched = mkRoom(store, "hb-scope-unwatched", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(watched, id, 1, {});
    store.joinRoom(unwatched, id, 1, {});
    store.close();
    const raw = new Database(path);
    raw
      .prepare("UPDATE memberships SET last_seen = ? WHERE agent_id = ?")
      .run(OLD_SEEN, id);
    await runPoller([
      "--agent", id, "--room", String(watched), "--epoch", "1",
      "--owner-pid", String(process.pid),
      "--interval", "5", "--timeout", "2", "--ok-on-timeout", "--db", path,
    ]).done;
    const seen = (roomId) =>
      raw
        .prepare("SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?")
        .get(roomId, id).last_seen;
    const watchedSeen = seen(watched);
    const unwatchedSeen = seen(unwatched);
    raw.close();
    check(
      "a scoped heartbeat refreshes the watched room",
      watchedSeen !== OLD_SEEN,
      watchedSeen,
    );
    check(
      "a scoped heartbeat does NOT refresh another room the persona is in",
      unwatchedSeen === OLD_SEEN,
      { watched: watchedSeen, unwatched: unwatchedSeen },
    );
  }

  // An ALREADY-ARMED scoped watcher must notice a leave that happens after it
  // started. Checking presence only at arm time would leave a watcher running
  // for hours against a seat the room can see is empty -- the same disagreement
  // between delivery and visibility, just reached from the other direction.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "watch-then-leave", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    store.close();
    const armed = runPoller([
      "--agent", id, "--room", String(room), "--epoch", "1",
      "--interval", "5", "--timeout", "20", "--ok-on-timeout", "--db", path,
    ]);
    const ready = await waitForArmed(
      pollerLockPath(path, id, room, 1),
      armed.child,
    );
    check("the watch-then-leave watcher armed while present", ready, "no lock within 6s");
    const s2 = new ChatStore(path);
    s2.leaveRoom(room, id, 1);
    s2.close();
    const result = await armed.done;
    check(
      "a watcher armed BEFORE the leave exits with a left_room diagnostic",
      result.code === 2 && /left_room/.test(result.err) && !result.timedOut,
      { code: result.code, err: result.err.slice(0, 200), timedOut: result.timedOut },
    );
  }

  // Owner death: the watcher exits rather than lingering to heartbeat for a
  // runtime that no longer exists. PID 2147483647 is the parser's ceiling and
  // is not a live process here.
  {
    const { store, path } = freshStore();
    const room = mkRoom(store, "hb-ownerdead", null, null).id;
    const { id } = seedPersona(store);
    store.joinRoom(room, id, 1, {});
    store.close();
    const raw = new Database(path);
    raw
      .prepare("UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?")
      .run(OLD_SEEN, room, id);
    const result = await runPoller([
      "--agent", id, "--room", String(room), "--epoch", "1",
      "--owner-pid", "2147483647",
      "--interval", "5", "--timeout", "5", "--ok-on-timeout", "--db", path,
    ]).done;
    const row = raw
      .prepare("SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?")
      .get(room, id);
    raw.close();
    check(
      "a watcher whose owner is already gone exits without heartbeating",
      result.code === 2 && /has ended/.test(result.err) && row.last_seen === OLD_SEEN,
      { exit: result.code, err: result.err.slice(0, 160), last_seen: row.last_seen },
    );
  }
} catch (e) {
  console.log("FAIL  poller suite threw:", e && e.stack ? e.stack : e);
  failures++;
}

// --- two-runtime MCP integration -------------------------------------------
//
// Everything above is store-level. This drives two real MCP processes over
// stdio, which is the only place the tool surface, the in-memory binding, and
// the persona_lost rendering are exercised together.
function startMcp(dbPath) {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: dbPath },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const replies = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
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
  const waitFor = (id, timeoutMs = 8_000) => {
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
      waiters.set(id, { resolve, timer });
    });
  };
  let nextId = 1;
  const call = async (name, args) => {
    const id = nextId++;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n",
    );
    const reply = await waitFor(id);
    const text = reply.result?.content?.[0]?.text;
    return { data: text ? JSON.parse(text) : null, isError: reply.result?.isError === true };
  };
  const init = async () => {
    const id = nextId++;
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "persona-test", version: "1" },
        },
      }) + "\n",
    );
    await waitFor(id);
  };
  return { child, call, init };
}

let A = null;
let B = null;
try {
  const dir = mkdtempSync(join(tmpdir(), "aichat-persona-mcp-"));
  dirs.push(dir);
  const DB = join(dir, "chat.db");
  const seed = new ChatStore(DB);
  const roomName = "twin";
  mkRoom(seed, roomName, null, null);
  seed.close();
  // A read-only handle kept open for epoch assertions during the MCP exchange.
  const store0 = new ChatStore(DB);

  A = startMcp(DB);
  await A.init();
  const created = await A.call("create_persona", {
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
    description: "runtime A",
  });
  check(
    // {6}, not +: the token is ONE fixed width, so an id has one shape. The
    // allocator retries on collision rather than widening.
    "create_persona returns a canonical normalized id with a 6-hex token",
    /^anthropic-claude-opus-v5-0-[0-9a-f]{6}$/.test(created.data.agent_id),
    created.data.agent_id,
  );
  check("create_persona returns a resume word", typeof created.data.resume_word === "string" && created.data.resume_word.length > 0, created.data);
  // The word is meant to be READ ALOUD and written down, which is why it is
  // adjective-noun-number rather than a hex blob. No entropy assertion here:
  // a statistical test on one sample is noise, and a test-only randomness seam
  // would be a hole in the one value that cannot be recovered.
  check(
    "the resume word has the documented readable shape",
    /^[a-z]+-[a-z]+-\d{1,5}$/.test(created.data.resume_word),
    created.data.resume_word,
  );
  check("create_persona binds epoch 1", created.data.runtime_epoch === 1, created.data);
  // ONE name for the persona's free text on EVERY persona response. A bare
  // `description` sitting beside brand/model/version reads as the room's in
  // join_room and whoami, which return both strings; asserting its ABSENCE is
  // what stops the two names drifting back apart.
  check(
    "create_persona echoes persona_description and no bare description",
    created.data.persona_description === "runtime A" &&
      !("description" in created.data),
    created.data,
  );
  const ID = created.data.agent_id;
  const WORD = created.data.resume_word;

  // A runtime that already holds a persona may not create or switch to another.
  const second = await A.call("create_persona", { brand: "x", model: "y", version: "1" });
  check("a bound runtime cannot create a second persona", second.isError === true, second.data);
  // The switch guard must be tested with a SECOND VALID persona. An unknown id
  // with a made-up word is refused by the credential check whether or not the
  // guard exists, so that case proves nothing: it passes with the guard
  // deleted. Mint a real persona from another runtime, with real credentials
  // that WOULD succeed, and confirm A still refuses to become it.
  const other = startMcp(DB);
  await other.init();
  const otherPersona = await other.call("create_persona", {
    brand: "OpenAI",
    model: "GPT",
    version: "9",
  });
  try {
    other.child.kill("SIGKILL");
  } catch {}
  const switched = await A.call("resume_persona", {
    agent_id: otherPersona.data.agent_id,
    resume_word: otherPersona.data.resume_word,
    brand: "OpenAI",
    model: "GPT",
    version: "9",
  });
  check(
    "a bound runtime cannot switch to a DIFFERENT VALID persona",
    switched.isError === true &&
      /already holds/.test(JSON.stringify(switched.data)),
    switched.data,
  );
  check(
    "the refused switch did not touch the other persona's epoch",
    store0.currentEpoch(otherPersona.data.agent_id) === 1,
    store0.currentEpoch(otherPersona.data.agent_id),
  );

  const joined = await A.call("join_room", { room: roomName, role: "writer" });
  check("A joins and gets its room-local role back", joined.data.role === "writer", joined.data);
  check(
    "the poller command A is handed carries its epoch",
    / --epoch '1'/.test(joined.data.poller_cmd),
    joined.data.poller_cmd,
  );
  // Every response that hands out a poller command states which build minted
  // it. The command is run OUT of process against dist/poller.js on disk, so
  // "which build am I" is the one thing the caller cannot otherwise learn at
  // the moment it matters.
  const identifiesBuild = (d) =>
    typeof d.server_build?.version === "string" &&
    typeof d.server_build?.commit === "string" &&
    typeof d.server_build?.built_at === "string" &&
    typeof d.server_build?.artifact_hash === "string" &&
    d.server_build.artifact_hash.length > 0 &&
    typeof d.server_stale === "boolean" &&
    // The tests run against a stamped build, so the on-disk stamp is readable
    // and latest_build must be present and must MATCH: this suite never runs
    // against a rebuilt tree mid-flight.
    d.latest_build?.artifact_hash === d.server_build.artifact_hash &&
    d.server_stale === false &&
    // Guidance appears only when stale, so a fresh build must not carry it.
    d.reconnect_guidance === undefined;
  check(
    "join_room's handoff carries full build identity",
    identifiesBuild(joined.data),
    joined.data,
  );
  const waitCmd = await A.call("wait_for_messages", {});
  check(
    "wait_for_messages' handoff carries full build identity",
    identifiesBuild(waitCmd.data) && / --epoch '1'/.test(waitCmd.data.command),
    waitCmd.data,
  );
  // A STALE build must still hand out a working command. Withholding the only
  // out-of-turn watching mechanism because someone rebuilt the tree would trade
  // a working watcher for a warning, so staleness is REPORTED, never enforced.
  //
  // A carries the hash it loaded at startup; rewriting the on-disk stamp makes
  // buildStatus() see a newer deployment without restarting anything. The stamp
  // is shared state, so the original bytes go back in a finally -- and the suite
  // runs its files one at a time, so no other test can observe the window.
  {
    const stampPath = join(ROOT, "dist", "build-info.json");
    const original = readFileSync(stampPath, "utf8");
    let staleWait;
    try {
      writeFileSync(
        stampPath,
        JSON.stringify({
          ...JSON.parse(original),
          commit: "beefcafe-newer",
          artifact_hash: "0".repeat(64),
        }),
      );
      staleWait = await A.call("wait_for_messages", {});
    } finally {
      writeFileSync(stampPath, original);
    }
    check(
      "a stale build still returns the command, and says what to reconnect to",
      staleWait.isError !== true &&
        / --epoch '1'/.test(staleWait.data.command) &&
        staleWait.data.server_stale === true &&
        staleWait.data.latest_build.commit === "beefcafe-newer" &&
        staleWait.data.latest_build.artifact_hash === "0".repeat(64) &&
        staleWait.data.server_build.artifact_hash !== "0".repeat(64) &&
        /reconnect/i.test(staleWait.data.reconnect_guidance),
      staleWait.data,
    );
    check(
      "restoring the stamp clears staleness again",
      (await A.call("wait_for_messages", {})).data.server_stale === false,
      readFileSync(stampPath, "utf8").slice(0, 120),
    );
  }
  const posted = await A.call("post_message", { content: "A is here" });
  check("A can post", posted.data.posted === true, posted.data);

  // Idempotent re-attach from the SAME runtime: no fencing, no increment.
  const reattach = await A.call("resume_persona", {
    agent_id: ID,
    resume_word: WORD,
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  check(
    "re-resuming from the holding runtime is idempotent",
    reattach.data.reattached === true && reattach.data.runtime_epoch === 1,
    reattach.data,
  );
  check(
    "the re-attach branch uses persona_description too",
    reattach.data.persona_description === "runtime A" &&
      !("description" in reattach.data),
    reattach.data,
  );
  check(
    "the re-attach branch's handoff carries full build identity",
    identifiesBuild(reattach.data),
    reattach.data,
  );
  const stillWorks = await A.call("post_message", { content: "A still works" });
  check("the idempotent re-attach did not fence A", stillWorks.data.posted === true, stillWorks.data);

  // The idempotent path must still VALIDATE. Its obvious use is a holder
  // checking that the word it wrote down works; returning success without
  // looking would confirm a mistranscribed word, and the holder would find out
  // only after a crash, when it is the one thing that cannot be recovered.
  const badReattach = await A.call("resume_persona", {
    agent_id: ID,
    resume_word: "mistranscribed-word-9",
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  check(
    "a re-attach with a WRONG word is rejected even though nothing is taken over",
    badReattach.isError === true,
    badReattach.data,
  );
  const badMetaReattach = await A.call("resume_persona", {
    agent_id: ID,
    resume_word: WORD,
    brand: "Anthropic",
    model: "Claude Sonnet",
    version: "5.0",
  });
  // A CHANGED MODEL is not a bad credential, and the two must not render alike.
  // The re-attach branch is the one a long-running runtime hits: it holds the
  // persona and re-verifies with a tuple that has since changed under it.
  check(
    "a re-attach with a changed model returns new_persona_required, not a rejection",
    badMetaReattach.isError === true &&
      badMetaReattach.data.code === "new_persona_required" &&
      badMetaReattach.data.persona_model.model === "Claude Opus" &&
      badMetaReattach.data.your_model.model === "Claude Sonnet" &&
      /create_persona/.test(badMetaReattach.data.recover) &&
      Array.isArray(badMetaReattach.data.persona_rooms) &&
      badMetaReattach.data.persona_rooms.includes(roomName),
    badMetaReattach.data,
  );
  check(
    "a WRONG WORD stays a distinct rejection with no new_persona_required code",
    badReattach.data.code === undefined &&
      /resume word/.test(badReattach.data.error),
    badReattach.data,
  );
  // ...and rejecting it must not have fenced the holder or moved the epoch.
  const afterBad = await A.call("post_message", { content: "A survived a bad re-attach" });
  check(
    "a rejected re-attach neither fences the holder nor increments",
    afterBad.data.posted === true && store0.currentEpoch(ID) === 1,
    { posted: afterBad.data.posted, epoch: store0.currentEpoch(ID) },
  );

  // Runtime B takes over.
  B = startMcp(DB);
  await B.init();
  const wrongWord = await B.call("resume_persona", {
    agent_id: ID,
    resume_word: "definitely-wrong-1",
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  check(
    "B is refused with a wrong resume word, and NOT as a model change",
    wrongWord.isError === true && wrongWord.data.code === undefined,
    wrongWord.data,
  );
  const wrongMeta = await B.call("resume_persona", {
    agent_id: ID,
    resume_word: WORD,
    brand: "Anthropic",
    model: "Claude Sonnet",
    version: "5.0",
  });
  check(
    "the takeover path reports a changed model as new_persona_required too",
    wrongMeta.isError === true &&
      wrongMeta.data.code === "new_persona_required" &&
      wrongMeta.data.persona_rooms.includes(roomName),
    wrongMeta.data,
  );
  check(
    "a refused model change did not fence the holder or move the epoch",
    store0.currentEpoch(ID) === 1,
    store0.currentEpoch(ID),
  );
  const stillA = await A.call("post_message", { content: "A survived the failed attempts" });
  check("failed resume attempts did not fence A", stillA.data.posted === true, stillA.data);

  const tookOver = await B.call("resume_persona", {
    agent_id: ID,
    resume_word: WORD,
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  check("B takes over at epoch 2", tookOver.data.runtime_epoch === 2, tookOver.data);
  check(
    "the takeover branch uses persona_description too",
    tookOver.data.persona_description === "runtime A" &&
      !("description" in tookOver.data),
    tookOver.data,
  );
  check(
    "the takeover branch's handoff carries full build identity",
    identifiesBuild(tookOver.data),
    tookOver.data,
  );
  check(
    "the takeover response hands B a fresh poller command at the new epoch",
    / --epoch '2'/.test(tookOver.data.poller_cmd),
    tookOver.data.poller_cmd,
  );

  // --- A is fenced, but its non-advancing READS still work and disclose -----
  //
  // These run BEFORE any failing write, because failFrom clears the dead
  // binding: once A has been told persona_lost, it has nothing left to read
  // with. That ordering is the whole point of disclosure -- the fenced runtime
  // finds out from a read, while it still has the binding to ask with.
  //
  // The assertion that matters is NOT "the call succeeded". A call that returns
  // ordinary-looking data is precisely the failure mode: the previous version
  // of this section checked only that store methods did not throw and that
  // currentEpoch had moved, which passed with the MCP disclosure layer entirely
  // absent. So every check below reads the actual TOOL RESPONSE.
  const ROOM = joined.data.room_id;
  const markerBefore = store0.getMembership(ROOM, ID).last_read_seq;
  // Explicit SELECT: getMembership() returns last_read_seq/left_at only, so
  // reading .last_seen off it yields undefined and the assertion below would
  // compare undefined to undefined and pass however the code behaved.
  const readSeen = store0.db.prepare(
    "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
  );
  const seenNow = () => readSeen.get(ROOM, ID).last_seen;
  // Back-date it first. datetime('now') has one-second resolution, so a
  // still-live heartbeat firing in the same second as the last legitimate one
  // would rewrite the IDENTICAL string and this assertion would pass on a
  // coincidence rather than on the fence.
  store0.db
    .prepare(
      "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
    )
    .run("2000-01-01 00:00:00", ROOM, ID);
  const seenBefore = seenNow();
  const discloses = (r) =>
    r.isError !== true &&
    r.data.persona_lost === true &&
    r.data.your_epoch === 1 &&
    r.data.current_epoch === 2;
  const staleReads = {
    whoami: await A.call("whoami", {}),
    list_agents: await A.call("list_agents", {}),
    my_mentions: await A.call("my_mentions", {}),
    read_history: await A.call("read_history", {}),
    get_message: await A.call("get_message", { seq: posted.data.seq }),
    get_thread: await A.call("get_thread", { seq: posted.data.seq }),
    search_messages: await A.call("search_messages", { query: "here" }),
    list_claims: await A.call("list_claims", {}),
  };
  for (const [name, result] of Object.entries(staleReads)) {
    check(
      `${name} discloses persona_lost with both epochs after a takeover`,
      discloses(result),
      result.data,
    );
  }
  // Disclosure is ADDITIVE. A response that dropped its payload to carry the
  // tag would be a different kind of lie.
  check(
    "a disclosing read still returns its normal payload",
    Array.isArray(staleReads.read_history.data.messages) &&
      Array.isArray(staleReads.list_agents.data.agents) &&
      staleReads.whoami.data.agent_id === ID &&
      staleReads.get_message.data.seq === posted.data.seq,
    {
      history: staleReads.read_history.data.messages?.length,
      agents: staleReads.list_agents.data.agents?.length,
    },
  );
  check(
    "none of the stale reads advanced the read marker",
    store0.getMembership(ROOM, ID).last_read_seq === markerBefore,
    { before: markerBefore, after: store0.getMembership(ROOM, ID).last_read_seq },
  );
  // Liveness is not refreshed by a fenced runtime: store.touch is epoch-fenced
  // and its PersonaLostError is swallowed by the best-effort heartbeat, so the
  // seat does not read as freshly active because a zombie kept reading it.
  //
  // A's reads CANNOT demonstrate that. touchSession() is throttled to one write
  // per 30 seconds and A already spent its allowance on the post above, so
  // within a test's lifetime A attempts no touch at all: this assertion holds
  // with the fence in touch() deleted outright (verified by mutation). It is
  // kept only as a state check on the reads just made; the fence is proved
  // below, on a runtime whose throttle has never fired.
  check(
    "stale reads leave last_seen untouched",
    typeof seenBefore === "string" && seenNow() === seenBefore,
    { before: seenBefore, after: seenNow() },
  );
  // The throttle skips its write while session.roomId is null, and roomId is
  // set AFTER join_room's touchSession() runs -- so a runtime's first touch
  // ATTEMPT is its first tool call after joining. Fence C before that call, and
  // the attempt reaches store.touch() holding a dead epoch. Delete the fence
  // and this refreshes last_seen.
  {
    const victim = seedPersona(store0, "cobalt-heron-77");
    const C = startMcp(DB);
    const fencer = startMcp(DB);
    try {
      await C.init();
      const creds = { agent_id: victim.id, resume_word: victim.resumeWord, ...META };
      const cBound = await C.call("resume_persona", creds);
      const cJoin = await C.call("join_room", { room: roomName });
      check(
        "the un-throttled runtime bound and joined before any touch",
        cBound.isError !== true && cJoin.data.room_id === ROOM,
        { cBound: cBound.data, cJoin: cJoin.data },
      );
      store0.db
        .prepare(
          "UPDATE memberships SET last_seen = ? WHERE room_id = ? AND agent_id = ?",
        )
        .run("2000-01-01 00:00:00", ROOM, victim.id);
      await fencer.init();
      const stolen = await fencer.call("resume_persona", creds);
      check(
        "a second runtime took the persona, fencing C",
        stolen.isError !== true && stolen.data.runtime_epoch > cBound.data.runtime_epoch,
        { stolen: stolen.data, cEpoch: cBound.data.runtime_epoch },
      );
      const zombieRead = await C.call("whoami", {});
      const seenAfter = store0.db
        .prepare(
          "SELECT last_seen FROM memberships WHERE room_id = ? AND agent_id = ?",
        )
        .get(ROOM, victim.id).last_seen;
      check(
        "a fenced runtime's first touch attempt cannot refresh last_seen",
        zombieRead.data.persona_lost === true && seenAfter === "2000-01-01 00:00:00",
        { seenAfter, zombieRead: zombieRead.data },
      );
    } finally {
      for (const runtime of [C, fencer]) {
        try {
          runtime.child.kill("SIGKILL");
        } catch {}
      }
    }
  }

  const fencedPost = await A.call("post_message", { content: "A is a zombie" });
  check(
    "A's next post is rendered as terminal persona_lost",
    fencedPost.isError === true &&
      fencedPost.data.code === "persona_lost" &&
      fencedPost.data.terminal === true &&
      fencedPost.data.your_epoch === 1 &&
      fencedPost.data.current_epoch === 2,
    fencedPost.data,
  );
  const fencedRead = await A.call("catch_up", {});
  check(
    "A's advancing read is refused too (its binding was cleared, so it must rebind)",
    fencedRead.isError === true,
    fencedRead.data,
  );

  // B inherits everything.
  const bJoin = await B.call("join_room", { room: roomName });
  check("B inherits A's room-local role", bJoin.data.role === "writer", bJoin.data);
  check("B inherits A's membership, not a fresh one", bJoin.data.new_membership === false, bJoin.data);
  const bPost = await B.call("post_message", { content: "B has the persona" });
  check("B can post under the persona", bPost.data.posted === true, bPost.data);
  check(
    "both runtimes' accepted posts are under ONE identity",
    bPost.data.seq > posted.data.seq,
    { a: posted.data.seq, b: bPost.data.seq },
  );

  // set_role over the tool surface, including the explicit clear.
  const roleSet = await B.call("set_role", { role: "reviewer" });
  check("set_role updates the room-local role", roleSet.data.role === "reviewer", roleSet.data);
  const roleCleared = await B.call("set_role", { role: null });
  check("set_role(null) clears it", roleCleared.data.cleared === true && roleCleared.data.role === null, roleCleared.data);
  // my_mentions needs a PERSONA, not an active room -- that is what makes it
  // usable after a leave -- so its unbound guidance must name binding.
  const C = startMcp(DB);
  await C.init();
  const unboundInbox = await C.call("my_mentions", {});
  check(
    "my_mentions unbound points at create_persona/resume_persona, not join_room",
    unboundInbox.isError === true &&
      /create_persona|resume_persona/.test(JSON.stringify(unboundInbox.data)) &&
      !/join a room first/.test(JSON.stringify(unboundInbox.data)),
    unboundInbox.data,
  );
  await B.call("leave_room", {});
  const roomlessInbox = await B.call("my_mentions", {});
  check(
    "my_mentions works with a persona and NO active room",
    roomlessInbox.isError !== true && Array.isArray(roomlessInbox.data.messages),
    roomlessInbox.data,
  );
  await B.call("join_room", { room: roomName });
  try {
    C.child.kill("SIGKILL");
  } catch {}

  const whoami = await B.call("whoami", {});
  check("whoami reports no role after the clear", whoami.data.role === null, whoami.data);
  check(
    "whoami reports the persona tuple and epoch",
    whoami.data.brand === "Anthropic" && whoami.data.runtime_epoch === 2,
    whoami.data,
  );

  // SHOWN ONCE. create_persona is the only response that may ever carry the
  // word: it is the one credential with no recovery path, so a later response
  // echoing it turns every transcript, log, and context window that saw a
  // routine listing into a copy of it.
  const laterResponses = {
    resume_persona: tookOver.data,
    whoami: whoami.data,
    join_room: bJoin.data,
    list_agents: (await B.call("list_agents", {})).data,
    list_rooms: (await B.call("list_rooms", {})).data,
    read_history: (await B.call("read_history", {})).data,
    my_mentions: (await B.call("my_mentions", {})).data,
    server_info: (await B.call("server_info", {})).data,
    get_message: (await B.call("get_message", { seq: bPost.data.seq })).data,
  };
  for (const [name, data] of Object.entries(laterResponses)) {
    const text = JSON.stringify(data);
    // The VALUE must never reappear anywhere. The FIELD NAME is separate:
    // server_info publishes resume_word's length cap and documents the tool in
    // its manual, which is the point of server_info, so only the data-bearing
    // tools are held to carrying no such key at all.
    check(
      `${name} does not echo the resume word`,
      !text.includes(WORD) &&
        (name === "server_info" || !/resume_word/.test(text)),
      { tool: name, valueLeaked: text.includes(WORD) },
    );
  }

  // whoami answers "which identity am I" even with NO active room. Reporting
  // just joined:false there hid the brand, model, version and epoch from a
  // runtime that had only left a room.
  await B.call("leave_room", {});
  const roomless = await B.call("whoami", {});
  check(
    "whoami reports the full persona with no active room",
    roomless.data.bound === true &&
      roomless.data.joined === false &&
      roomless.data.agent_id === ID &&
      roomless.data.brand === "Anthropic" &&
      roomless.data.model === "Claude Opus" &&
      roomless.data.version === "5.0" &&
      roomless.data.runtime_epoch === 2 &&
      roomless.data.room_id === undefined &&
      roomless.data.role === undefined,
    roomless.data,
  );
  const rejoined = await B.call("join_room", { room: roomName });
  check(
    "join_room returns the persona tuple and BOTH descriptions, unambiguously named",
    rejoined.data.brand === "Anthropic" &&
      rejoined.data.model === "Claude Opus" &&
      rejoined.data.version === "5.0" &&
      "persona_description" in rejoined.data &&
      "room_description" in rejoined.data &&
      !("description" in rejoined.data),
    rejoined.data,
  );
} catch (e) {
  console.log("FAIL  MCP suite threw:", e && e.stack ? e.stack : e);
  failures++;
} finally {
  for (const c of [A, B]) {
    try {
      c?.child.kill("SIGKILL");
    } catch {}
  }
}

// --- simultaneous VALID resume from two processes ---------------------------
//
// Two runtimes racing with the SAME correct credentials is the case the epoch
// exists for. Both attempts are legitimate, so neither may be rejected on
// credentials; what must hold is that the increments SERIALIZE -- distinct
// consecutive epochs, never a shared one -- and that whoever landed last owns
// the persona while the other is fenced. Two personas silently sharing an epoch
// would mean two live runtimes each believing they hold it, both writing.
let racers = [];
try {
  const dir = mkdtempSync(join(tmpdir(), "aichat-persona-race-"));
  dirs.push(dir);
  const DB = join(dir, "chat.db");
  const seed = new ChatStore(DB);
  mkRoom(seed, "raceroom", null, null);
  seed.close();
  const obs = new ChatStore(DB);

  const owner = startMcp(DB);
  await owner.init();
  const made = await owner.call("create_persona", {
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  const RID = made.data.agent_id;
  const RWORD = made.data.resume_word;
  const creds = {
    agent_id: RID,
    resume_word: RWORD,
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  };
  racers = [owner, startMcp(DB), startMcp(DB)];
  await Promise.all([racers[1].init(), racers[2].init()]);

  // Fired without awaiting either, so both resumes are in flight at once.
  const [r1, r2] = await Promise.all([
    racers[1].call("resume_persona", creds),
    racers[2].call("resume_persona", creds),
  ]);
  const epochs = [r1.data?.runtime_epoch, r2.data?.runtime_epoch].sort();
  check(
    "both simultaneous valid resumes succeed",
    r1.isError !== true && r2.isError !== true,
    { r1: r1.data, r2: r2.data },
  );
  check(
    "they serialize into DISTINCT consecutive epochs, never a shared one",
    epochs[0] === 2 && epochs[1] === 3,
    epochs,
  );
  check(
    "the persona's stored epoch is the later of the two",
    obs.currentEpoch(RID) === 3,
    obs.currentEpoch(RID),
  );

  // Latest wins: the runtime that got epoch 2 is fenced, the one that got 3 is
  // not. Identify them by result rather than by call order, which is the race.
  const loser = r1.data.runtime_epoch === 2 ? racers[1] : racers[2];
  const winner = r1.data.runtime_epoch === 2 ? racers[2] : racers[1];
  // join_room is itself a fenced write, so the loser is stopped there -- and
  // failFrom then CLEARS the dead binding, which is why the assertion has to be
  // on this call and not on a later post: after this, the runtime has no
  // persona to post under at all.
  const loserJoin = await loser.call("join_room", { room: "raceroom" });
  check(
    "the earlier-serialized runtime is fenced at its first write",
    loserJoin.isError === true &&
      loserJoin.data.code === "persona_lost" &&
      loserJoin.data.terminal === true &&
      loserJoin.data.your_epoch === 2 &&
      loserJoin.data.current_epoch === 3,
    loserJoin.data,
  );
  const loserAfter = await loser.call("post_message", { content: "from the loser" });
  check(
    "and its binding is cleared, so it must rebind rather than retry",
    loserAfter.isError === true && /no persona bound/.test(JSON.stringify(loserAfter.data)),
    loserAfter.data,
  );
  await winner.call("join_room", { room: "raceroom" });
  const winnerPost = await winner.call("post_message", { content: "from the winner" });
  check("the later-serialized runtime holds the persona", winnerPost.data.posted === true, winnerPost.data);
  obs.close();
} catch (e) {
  console.log("FAIL  simultaneous-resume suite threw:", e && e.stack ? e.stack : e);
  failures++;
} finally {
  for (const c of racers) {
    try {
      c?.child.kill("SIGKILL");
    } catch {}
  }
}

// --- retained NUL-reject triggers on a FRESH database -----------------------
//
// These triggers survived the rewrite because they enforce a live storage
// invariant, not a migration concern: the web viewer writes directly, and
// SQLite's substr()/length() truncate at a NUL, so an embedded NUL turns every
// listing preview into silent data loss. The store's own asserts cover its
// callers; these prove the DATABASE refuses an independent writer too, which is
// the only thing that protects against a writer that is not this code.
try {
  const dir = mkdtempSync(join(tmpdir(), "aichat-persona-nul-"));
  dirs.push(dir);
  const DB = join(dir, "chat.db");
  const s = new ChatStore(DB);
  const room = mkRoom(s, "nulroom", null, null).id;
  const { id: who } = seedPersona(s);
  s.joinRoom(room, who, 1, {});
  s.claimResource(room, "file:x", who, 1, 900, "clean note");
  s.close();

  const raw = new Database(DB);
  const rejects = (label, sql, params) => {
    let message = "";
    try {
      raw.prepare(sql).run(params);
    } catch (e) {
      message = String(e?.message ?? e);
    }
    check(label, /NUL character/.test(message), message || "NO ERROR RAISED");
  };
  rejects(
    "a raw UPDATE cannot put a NUL in a room description",
    "UPDATE rooms SET description = ? WHERE id = ?",
    ["bad\u0000desc", room],
  );
  rejects(
    "a raw UPDATE cannot put a NUL in a room's pinned intro",
    "UPDATE rooms SET pinned = ? WHERE id = ?",
    ["bad\u0000pin", room],
  );
  rejects(
    "a raw UPDATE cannot put a NUL in a persona description",
    "UPDATE agents SET description = ? WHERE id = ?",
    ["bad\u0000about", who],
  );
  rejects(
    "a raw UPDATE cannot put a NUL in a claim note",
    "UPDATE claims SET note = ? WHERE room_id = ? AND key = ?",
    ["bad\u0000note", room, "file:x"],
  );
  rejects(
    "a raw INSERT cannot put a NUL in a message body",
    "INSERT INTO messages (room_id, seq, agent_id, body, body_len) VALUES (?, 999, ?, ?, 8)",
    [room, who, "bad\u0000body"],
  );
  // The rejections must have changed nothing.
  const after = raw
    .prepare("SELECT description, pinned FROM rooms WHERE id = ?")
    .get(room);
  check(
    "a rejected NUL write leaves the row untouched",
    after.description === null && after.pinned === null,
    after,
  );
  raw.close();
} catch (e) {
  console.log("FAIL  NUL trigger suite threw:", e && e.stack ? e.stack : e);
  failures++;
}

// --- mid-wait takeover over real MCP ---------------------------------------
//
// The advancing read at the end of a wait was always fenced, so a wait that got
// TRAFFIC noticed a takeover. A QUIET one did not: with no epoch in the probe, a
// runtime fenced at second 3 of a 20-second wait sat there to the deadline,
// holding a lease that told every peer it was watching. This drives that exact
// shape through two real MCP processes.
let D = null;
let E = null;
try {
  const dir = mkdtempSync(join(tmpdir(), "aichat-persona-wait-"));
  dirs.push(dir);
  const DB = join(dir, "chat.db");
  const seed = new ChatStore(DB);
  mkRoom(seed, "waitroom", null, null);
  seed.close();
  const obs = new Database(DB, { readonly: true });
  const leaseStatement = obs.prepare(
    "SELECT epoch FROM wait_leases WHERE room_id = ? AND agent_id = ?",
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  D = startMcp(DB);
  await D.init();
  const mine = await D.call("create_persona", {
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  const PID = mine.data.agent_id;
  const PWORD = mine.data.resume_word;
  const room = (await D.call("join_room", { room: "waitroom" })).data.room_id;

  // D arms a long, QUIET wait. No message is ever posted to this room, so the
  // only thing that can end it early is the epoch fence.
  let loserPending = true;
  const startedMs = Date.now();
  const loserWait = D.call("catch_up", { wait_seconds: 20 }).then((r) => {
    loserPending = false;
    return r;
  });
  const leaseRow = () => leaseStatement.get(room, PID);
  let armed = null;
  for (let i = 0; i < 100 && !armed; i++) {
    armed = leaseRow();
    if (!armed) await sleep(20);
  }
  check("the loser's wait lease is recorded at its own epoch", armed?.epoch === 1, armed);

  // E takes the persona over and opens its own wait, so a WINNER lease exists
  // on the same (room, persona) key before the loser's cleanup can run.
  E = startMcp(DB);
  await E.init();
  const stolen = await E.call("resume_persona", {
    agent_id: PID,
    resume_word: PWORD,
    brand: "Anthropic",
    model: "Claude Opus",
    version: "5.0",
  });
  await E.call("join_room", { room: "waitroom" });
  // Short enough to keep the suite fast, long enough to still be OPEN while the
  // loser's cleanup runs -- which is the window this test exists to inspect.
  const winnerWait = E.call("catch_up", { wait_seconds: 5 });

  // PRECONDITION, asserted rather than assumed: the winner's lease must be in
  // place while the loser is still waiting. Without this the next check passes
  // trivially whenever the loser happens to clean up first, which proves
  // nothing about whose row was deleted.
  let observedWinnerLeaseWhileLoserPending = false;
  for (let i = 0; i < 100 && loserPending; i++) {
    const row = leaseRow();
    if (row?.epoch === 2) {
      observedWinnerLeaseWhileLoserPending = true;
      break;
    }
    await sleep(10);
  }
  check(
    "the winner's lease replaced the loser's while the loser was still waiting",
    observedWinnerLeaseWhileLoserPending && stolen.data.runtime_epoch === 2,
    { observedWinnerLeaseWhileLoserPending, epoch: stolen.data.runtime_epoch },
  );

  const loserResult = await loserWait;
  const elapsed = Date.now() - startedMs;
  check(
    "a quiet wait ends with TERMINAL persona_lost, not at its deadline",
    loserResult.isError === true &&
      loserResult.data.code === "persona_lost" &&
      loserResult.data.terminal === true &&
      loserResult.data.your_epoch === 1 &&
      loserResult.data.current_epoch === 2,
    loserResult.data,
  );
  check(
    "it ends within a few probe intervals, not after the full 20s wait",
    elapsed < 5_000,
    { elapsed_ms: elapsed },
  );
  // The loser's finally has run by the time its response arrived. Its DELETE is
  // guarded on the epoch it captured, so it cannot take the winner's row.
  check(
    "the loser's cleanup did not remove the winner's lease",
    leaseRow()?.epoch === 2,
    leaseRow(),
  );

  // The winner is untouched: still waiting, still able to finish normally.
  const winnerResult = await winnerWait;
  check(
    "the winner's own wait completes normally",
    winnerResult.isError !== true && winnerResult.data.timed_out === true,
    winnerResult.data,
  );
  obs.close();

  // --- the EPOCH-CLEAR RACE -------------------------------------------------
  //
  // failFrom tears down the session binding when it renders persona_lost. That
  // is right for the runtime that just died, and wrong for a runtime that has
  // ALREADY recovered: a slow call started at an old epoch can land its error
  // after a resume re-established the binding, and clearing on the agent id
  // alone would tear down a binding that is live. The agent then has to resume
  // a second time for no reason, and any watcher it was handed is orphaned.
  //
  // Construction: F arms a long wait at epoch 1, G takes the persona (2), F
  // takes it back (3). F's outstanding wait is now doomed at a SUPERSEDED
  // epoch, and its error arrives while F holds a live one.
  {
    const dir2 = mkdtempSync(join(tmpdir(), "aichat-persona-race-"));
    dirs.push(dir2);
    const RDB = join(dir2, "chat.db");
    const rseed = new ChatStore(RDB);
    mkRoom(rseed, "raceroom", null, null);
    rseed.close();
    const F = startMcp(RDB);
    const G = startMcp(RDB);
    try {
      await F.init();
      await G.init();
      const p = await F.call("create_persona", {
        brand: "Anthropic",
        model: "Claude Opus",
        version: "5.0",
      });
      const creds = {
        agent_id: p.data.agent_id,
        resume_word: p.data.resume_word,
        brand: "Anthropic",
        model: "Claude Opus",
        version: "5.0",
      };
      await F.call("join_room", { room: "raceroom" });
      let stalePending = true;
      const staleWait = F.call("catch_up", { wait_seconds: 20 }).then((r) => {
        stalePending = false;
        return r;
      });
      // Arm observed, not assumed: the wait must hold epoch 1 before anything
      // takes the persona, or the race being tested never sets up.
      const robs = new Database(RDB, { readonly: true });
      const rlease = robs.prepare(
        "SELECT epoch FROM wait_leases WHERE room_id = ? AND agent_id = ?",
      );
      const rroom = 1;
      let rarmed = null;
      for (let i = 0; i < 200 && !rarmed; i++) {
        rarmed = rlease.get(rroom, p.data.agent_id);
        if (!rarmed) await sleep(20);
      }
      robs.close();
      check("the race fixture armed a wait at epoch 1", rarmed?.epoch === 1, rarmed);

      await G.call("resume_persona", creds);          // epoch 2: F is fenced
      const recovered = await F.call("resume_persona", creds); // epoch 3: F is back
      // PRECONDITION: F's recovery must complete while the doomed wait is still
      // OPEN. Replies share one ordered stdio pipe, so arrival order is
      // completion order -- if the wait had already returned, the clear would
      // have been the ordinary same-epoch one and this proves nothing.
      const recoveredWhileStale = stalePending;
      check(
        "F recovered to a new epoch while its old wait was still open",
        recoveredWhileStale &&
          recovered.isError !== true &&
          recovered.data.runtime_epoch === 3 &&
          recovered.data.previous_epoch === 1,
        { recoveredWhileStale, data: recovered.data },
      );

      const staleResult = await staleWait;
      check(
        "the superseded wait still fails with persona_lost naming ITS epoch",
        staleResult.isError === true &&
          staleResult.data.code === "persona_lost" &&
          staleResult.data.your_epoch === 1 &&
          staleResult.data.current_epoch === 3,
        staleResult.data,
      );
      // The whole point: that error must NOT have torn down epoch 3.
      const who = await F.call("whoami", {});
      check(
        "the stale error did not clear F's recovered binding",
        who.data.bound === true &&
          who.data.runtime_epoch === 3 &&
          who.data.persona_lost === undefined,
        who.data,
      );
      const stillWrites = await F.call("post_message", {
        room: "raceroom",
        content: "F never had to resume twice",
      });
      check(
        "and F can still write under it without resuming again",
        stillWrites.isError !== true && stillWrites.data.posted === true,
        stillWrites.data,
      );
    } finally {
      for (const c of [F, G]) {
        try {
          c.child.kill("SIGKILL");
        } catch {}
      }
    }
  }
} catch (e) {
  console.log("FAIL  mid-wait takeover suite threw:", e && e.stack ? e.stack : e);
  failures++;
} finally {
  for (const c of [D, E]) {
    try {
      c?.child.kill("SIGKILL");
    } catch {}
  }
}

for (const d of dirs) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
