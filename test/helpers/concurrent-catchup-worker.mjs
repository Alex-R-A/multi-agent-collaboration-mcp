// Bounded worker for concurrent-catchup.mjs. This file deliberately cannot
// spawn processes; keeping worker and coordinator roles separate prevents a
// control-flow mistake from becoming recursive process creation.
import { ChatStore } from "../../dist/db.js";

const [dbPath, startText, roomText, agentId, limitText, maxCallsText] =
  process.argv.slice(2);
const startAt = Number(startText);
const roomId = Number(roomText);
const limit = Number(limitText);
const maxCalls = Number(maxCallsText);
const now = Date.now();
if (
  !dbPath ||
  !agentId ||
  !Number.isSafeInteger(startAt) ||
  startAt < now - 5_000 ||
  startAt > now + 5_000 ||
  !Number.isSafeInteger(roomId) ||
  roomId < 1 ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 50 ||
  !Number.isSafeInteger(maxCalls) ||
  maxCalls < 1 ||
  maxCalls > 500
) {
  throw new Error("invalid bounded concurrency-worker arguments");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (error) =>
  error &&
  (error.code === "SQLITE_BUSY" || /SQLITE_BUSY/.test(String(error.message)));

const store = new ChatStore(dbPath);
const seqs = [];
let calls = 0;
const deadline = Date.now() + 15_000;
try {
  await sleep(Math.max(0, startAt - Date.now()));
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("worker exceeded its 15-second wall-clock deadline");
    }
    if (++calls > maxCalls) {
      throw new Error(`worker exceeded catch_up call cap ${maxCalls}`);
    }
    let result;
    for (let attempt = 1; ; attempt++) {
      try {
        result = store.catchUp(roomId, agentId, limit);
        break;
      } catch (error) {
        if (!isBusy(error) || attempt >= 3 || Date.now() >= deadline) {
          throw error;
        }
        await sleep(Math.min(25, attempt));
      }
    }
    if (result.messages.length === 0) break;
    for (const message of result.messages) seqs.push(message.seq);
    await sleep(1);
  }
} finally {
  store.close();
}

await new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(seqs), (error) => {
    if (error) reject(error);
    else resolve();
  });
});
