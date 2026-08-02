import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ChatStore } from "../src/db.ts";

function identifyPersona(store, candidate) {
  return store.identifyPersona({
    connectionId: randomUUID(),
    brand: "testbrand",
    model: "testmodel",
    version: "1",
    description: null,
    expected: null,
    nextCandidateId: () => candidate,
  }).persona;
}

function roomScopedCounts(store, roomId) {
  const count = (table) =>
    store.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_id = ?`)
      .get(roomId).count;
  return {
    memberships: count("memberships"),
    messages: count("messages"),
    claims: count("claims"),
    wait_leases: count("wait_leases"),
  };
}

test("deleteRoom purges room-scoped rows without deleting personas", () => {
  const store = new ChatStore(":memory:");
  try {
    const creator = identifyPersona(store, "delete-room-creator");
    const actor = identifyPersona(store, "delete-room-actor");
    const room = store.createRoom("delete-room-cascade", null, null, creator.id);
    store.joinRoom(room.id, creator.id);
    store.joinRoom(room.id, actor.id);
    store.postMessage(room.id, actor.id, "first", "text", null, null, null);
    store.postMessage(room.id, creator.id, "second", "text", null, null, null);
    store.claimResource(room.id, "resource:cleanup", actor.id, 120, "owned");
    store.beginWaitLease(room.id, actor.id, 15);

    expect(roomScopedCounts(store, room.id)).toEqual({
      memberships: 2,
      messages: 2,
      claims: 1,
      wait_leases: 1,
    });
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM messages_fts").get().count,
    ).toBe(2);

    expect(store.deleteRoom(room.id, creator.id)).toEqual({
      messages: 2,
      members: 2,
    });
    expect(store.getRoom(room.id)).toBeUndefined();
    expect(roomScopedCounts(store, room.id)).toEqual({
      memberships: 0,
      messages: 0,
      claims: 0,
      wait_leases: 0,
    });
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM messages_fts").get().count,
    ).toBe(0);
    expect(store.getPersona(creator.id)).toBeDefined();
    expect(store.getPersona(actor.id)).toBeDefined();
    expect(() => store.catchUp(room.id, actor.id, 10)).toThrow(
      /room .*no longer exists/,
    );
    expect(() => store.listClaims(room.id)).toThrow(
      /room .*no longer exists.*create_room/,
    );
  } finally {
    store.close();
  }
});
