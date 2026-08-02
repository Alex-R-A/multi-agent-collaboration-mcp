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

test("thread previews truncate by codepoint without splitting UTF-16", () => {
  const store = new ChatStore(":memory:");
  try {
    const author = identifyPersona(store, "thread-preview-author");
    const room = store.createRoom("thread-preview-room", null, null, author.id);
    store.joinRoom(room.id, author.id);

    const root = store.postMessage(room.id, author.id, "root", "text", null, null, null);
    const reply = store.postMessage(
      room.id,
      author.id,
      "😀".repeat(10),
      "text",
      null,
      root.seq,
      null,
    );

    const thread = store.getThread(room.id, root.seq, 4, 1);
    expect(thread?.replies).toHaveLength(1);
    expect(thread?.replies[0]).toMatchObject({
      seq: reply.seq,
      truncated: true,
      length: 10,
      content: "😀",
    });
    expect(thread?.replies[0]?.content).toHaveLength(2);
  } finally {
    store.close();
  }
});
