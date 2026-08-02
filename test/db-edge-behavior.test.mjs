import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mkHuman } from "./persona-helpers.mjs";
import { ChatStore, DEFAULT_MAX_BYTES } from "../src/db.ts";

function withStore(fn) {
  const store = new ChatStore(":memory:");
  try {
    fn(store);
  } finally {
    store.close();
  }
}

function identifyPersona(store, seed, connectionId = randomUUID()) {
  return store.identifyPersona({
    connectionId,
    brand: "testbrand",
    model: "testmodel",
    version: "1",
    description: `${seed} persona`,
    expected: null,
    nextCandidateId: () => `${seed}-agent`,
  });
}

describe("ChatStore edge behavior", () => {
  it("does not retire human identities through retireConnection", () => {
    withStore((store) => {
      const bootstrap = identifyPersona(store, "bootstrap");
      const room = store.createRoom("human-room", null, null, bootstrap.persona.id);
      const human = mkHuman(store, "guest-base", 1);
      store.joinRoom(room.id, human, {});

      expect(
        store.retireConnection({ agentId: human, connectionId: randomUUID() }),
      ).toBe(false);
      expect(store.getMembership(room.id, human)?.left_at).toBeNull();
      expect(store.getPersona(human)?.retired_at).toBeNull();
    });
  });

  it("classifies human identities as a binding mismatch", () => {
    withStore((store) => {
      const human = mkHuman(store, "binding-hint", 1);
      expect(
        store.personaLoss({ agentId: human, connectionId: randomUUID() }),
      ).toBe("binding_mismatch");
    });
  });

  it("bounds the complete serialized membership listing", () => {
    withStore((store) => {
      const bootstrap = identifyPersona(store, "agent-list-bootstrap");
      const room = store.createRoom("roster-room", null, null, bootstrap.persona.id);
      store.joinRoom(room.id, bootstrap.persona.id);

      for (let i = 0; i < 420; i++) {
        const seed = `agent-${String(i).padStart(3, "0")}`;
        const agent = store.identifyPersona({
          connectionId: randomUUID(),
          brand: "testbrand",
          model: "testmodel",
          version: "1",
          description: `desc-${seed}-` + "d".repeat(1_900),
          expected: null,
          nextCandidateId: () => `${seed}-agent`,
        }).persona;
        store.joinRoom(room.id, agent.id);
        store.setRole(room.id, agent.id, "writer");
      }

      const listing = store.listAgents(room.id, 120, undefined, 1_000);
      expect(listing.total).toBe(421);
      expect(listing.size_trimmed).toBe(true);
      expect(listing.agents.length).toBeLessThan(listing.total);
      expect(listing.next_after).toBeDefined();
      expect(JSON.stringify(listing).length).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(listing.agents.some((agent) => agent.description_truncated)).toBe(true);
    });
  });

  it("allows a non-holder to release an expired claim", () => {
    withStore((store) => {
      const holder = identifyPersona(store, "expired-holder");
      const intruder = identifyPersona(store, "expired-intruder");
      const room = store.createRoom("expired-room", null, null, holder.persona.id);
      store.joinRoom(room.id, holder.persona.id);
      store.joinRoom(room.id, intruder.persona.id);

      expect(
        store.claimResource(
          room.id,
          "claim:exclusive",
          holder.persona.id,
          60,
          "owned",
        ).granted,
      ).toBe(true);
      store.db
        .prepare(
          "UPDATE claims SET expires_at = datetime('now', '-2 seconds') WHERE room_id = ? AND key = ?",
        )
        .run(room.id, "claim:exclusive");

      expect(
        store.releaseClaim(room.id, "claim:exclusive", intruder.persona.id),
      ).toEqual({ released: true, key: "claim:exclusive" });
      expect(store.listClaims(room.id).total).toBe(0);
    });
  });

  it("orders and filters unread room summaries", () => {
    withStore((store) => {
      const viewer = identifyPersona(store, "unread-summary-viewer");
      const peer = identifyPersona(store, "unread-summary-peer");
      const roomA = store.createRoom("room-a", null, null, viewer.persona.id);
      const roomB = store.createRoom("room-b", null, null, viewer.persona.id);
      const roomC = store.createRoom("room-c", null, null, viewer.persona.id);

      for (const room of [roomA, roomB, roomC]) {
        store.joinRoom(room.id, viewer.persona.id);
        store.joinRoom(room.id, peer.persona.id);
      }
      store.postMessage(roomA.id, peer.persona.id, "a1", "text", null, null, null);
      store.postMessage(
        roomA.id,
        peer.persona.id,
        "a2",
        "text",
        [viewer.persona.id],
        null,
        null,
      );
      store.postMessage(roomA.id, peer.persona.id, "a3", "text", null, null, null);
      store.postMessage(
        roomB.id,
        peer.persona.id,
        "b1",
        "text",
        [viewer.persona.id],
        null,
        null,
      );
      store.postMessage(
        roomB.id,
        peer.persona.id,
        "b2",
        "text",
        [viewer.persona.id],
        null,
        null,
      );
      store.postMessage(roomC.id, peer.persona.id, "c1", "text", null, null, null);

      const topTwo = store.unreadByRoom(viewer.persona.id, 2);
      expect(topTwo).toMatchObject({ truncated: true });
      expect(topTwo.rooms).toMatchObject([
        { room_id: roomB.id, unread: 2, directed: 2 },
        { room_id: roomA.id, unread: 3, directed: 1 },
      ]);

      const withoutA = store.unreadByRoom(viewer.persona.id, 10, roomA.id);
      expect(withoutA.rooms.map((entry) => entry.room_id)).toEqual([
        roomB.id,
        roomC.id,
      ]);

      store.leaveRoom(roomA.id, viewer.persona.id);
      const afterLeave = store.unreadByRoom(viewer.persona.id, 10);
      expect(afterLeave.rooms.map((entry) => entry.room_id)).toEqual([
        roomB.id,
        roomC.id,
      ]);
    });
  });
});
