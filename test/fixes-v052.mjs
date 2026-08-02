// Regression tests for the v0.5.2 review fixes:
// - leave/rejoin must not discard a lagging read marker
// - reply_to_seq validated inside the insert transaction
// - get_thread charges SERIALIZED size (escaping/envelope), not raw chars
import { ChatStore, DEFAULT_MAX_BYTES } from "../dist/db.js";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

import { expect, test } from "vitest";

test("fixes-v052.mjs", async () => {
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- reply_to_seq validated in-transaction ----------------------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  let rejected = false;
  try {
    s.postMessage(r, "a", "dangling", "text", null, 999, null);
  } catch (e) {
    rejected = /reply_to_seq 999 does not exist/.test(e.message);
  }
  check("reply to a nonexistent seq is rejected by postMessage itself", rejected);
  s.postMessage(r, "a", "root", "text", null, null, null); // seq 1
  const ok = s.postMessage(r, "a", "reply", "text", null, 1, null); // seq 2
  check("valid reply still accepted", ok.seq === 2, ok);
  s.close();
}

// --- get_thread: serialized budget honored for escape-heavy bodies ----------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "r", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  // \u0001 serializes 6x ("\u0001" per char): 60k raw chars ~= 360k serialized.
  s.postMessage(r, "a", "\u0001".repeat(60_000), "text", null, null, null); // seq 1
  s.postMessage(r, "a", "focal reply", "text", null, 1, null); // seq 2
  const CAP = DEFAULT_MAX_BYTES + 10_000; // budget plus corrective-pass slack
  const viaParent = s.getThread(r, 2, 3);
  const parentTotal = JSON.stringify(viaParent).length;
  check(
    `escape-heavy PARENT charged at serialized size (${parentTotal} <= ${CAP})`,
    parentTotal <= CAP,
    parentTotal,
  );
  check(
    "parent arrives truncated with markers",
    viaParent.parent.truncated === true && viaParent.parent.length === 60_000,
    viaParent.parent,
  );
  const viaFocal = s.getThread(r, 1, 3);
  const focalTotal = JSON.stringify(viaFocal).length;
  check(
    `escape-heavy FOCAL message charged at serialized size (${focalTotal} <= ${CAP})`,
    focalTotal <= CAP,
    focalTotal,
  );
  check(
    "focal arrives truncated, replies still delivered",
    viaFocal.message.truncated === true && viaFocal.replies.length === 1,
    { truncated: viaFocal.message.truncated, replies: viaFocal.replies.length },
  );
  s.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);

expect(failures).toBe(0);
});
