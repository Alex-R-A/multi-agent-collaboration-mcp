// Regression tests for the v0.8.4 review fixes:
//  #2 tools/list advertises post_message `content` WITHOUT excluding objects
//     (the z.custom union arm was dropped from the generated JSON Schema, so
//     schema-validating clients rejected every object body client-side)
//  #3 store-level metadata length caps: a direct caller cannot create a claim
//     key (etc.) that busts the listing byte budgets, which assume the MCP
//     schema caps
//  (#1, #4, and #5 all rested on SESSIONS: a private session cursor lagging
//   its twin, a live session's leave tombstone, and reconciling a crashed twin.
//   A persona has exactly one runtime, so there is no twin to lag, no second
//   cursor to baseline against, and nothing to reconcile; those tests were
//   deleted with the model they tested.)
//  (web gating and the web search probe are covered in web-participate.mjs.)
import { ChatStore } from "../dist/db.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkAgent, mkRoom } from "./persona-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (n, c, x) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  >> " + JSON.stringify(x)}`);
  if (!c) failures++;
};

// --- #2: advertised content schema admits objects; runtime still validates ---
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), "v084-schema-"));
  const DB = join(dir, "t.db");
  const child = spawn("node", [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, AGENT_CHAT_DB: DB },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const R = new Map();
  let buf = "";
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; try { const m = JSON.parse(l); if (m.id !== undefined) R.set(m.id, m); } catch {} } });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const wait = (id) => new Promise((res, rej) => {
    const t = setInterval(() => {
      if (!R.has(id)) return;
      clearInterval(t);
      clearTimeout(dead);
      res(R.get(id));
    }, 15);
    const dead = setTimeout(() => {
      clearInterval(t);
      child.kill("SIGKILL");
      rej(new Error(`MCP reply timeout id ${id}`));
    }, 15_000);
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  await wait(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await wait(2);
  // Inspect the ACTUAL advertised schema, not just runtime acceptance: the
  // bug lived in the generated JSON Schema (object arm dropped from anyOf).
  const tool = list.result.tools.find((t) => t.name === "post_message");
  const content = tool.inputSchema.properties.content;
  const excludesObjects =
    (Array.isArray(content.anyOf) &&
      !content.anyOf.some((a) => !a.type || a.type === "object")) ||
    (typeof content.type === "string" && content.type !== "object") ||
    (Array.isArray(content.type) && !content.type.includes("object"));
  check("#2 advertised content schema does not exclude objects", !excludesObjects, content);
  let id = 2;
  const call = async (name, args) => {
    const i = ++id;
    send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name, arguments: args } });
    return wait(i);
  };
  // Identify first because room administration requires a live persona.
  await call("identify_persona", {
    brand: "testbrand",
    model: "testmodel",
    version: "1.0",
  });
  await call("create_room", { name: "schema-room" });
  await call("join_room", { room: "schema-room" });
  const obj = await call("post_message", { content: { plan: "x", steps: [1, 2] } });
  const str = await call("post_message", { content: "plain" });
  const num = await call("post_message", { content: 42 });
  check("#2 runtime accepts an object body", obj.result && !obj.result.isError, obj.result);
  check("#2 runtime accepts a string body", str.result && !str.result.isError, str.result);
  check(
    "#2 runtime still rejects a number body",
    num.result && num.result.isError === true,
    num.result,
  );
  child.kill();
  rmSync(dir, { recursive: true, force: true });
})();

// --- #3: store-level metadata caps match the MCP schema caps ------------------
{
  const s = new ChatStore(":memory:");
  const r = mkRoom(s, "room", null, null).id;
  mkAgent(s, "a");
  s.joinRoom(r, "a", {});
  const threw = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  check(
    "#3 store rejects a 120k-char claim key",
    /exceeds 500/.test(threw(() => s.claimResource(r, "k".repeat(120_000), "a", 900, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char room name",
    /exceeds 200/.test(threw(() => mkRoom(s, "n".repeat(201), null, null))),
    null,
  );
  check(
    "#3 store rejects a 201-char agent id",
    /exceeds 200/.test(threw(() => mkAgent(s, "i".repeat(201)))),
    null,
  );
  check(
    "#3 store rejects a 201-char mention id",
    /exceeds 200/.test(
      threw(() => s.postMessage(r, "a", "x", "text", ["m".repeat(201)], null, null)),
    ),
    null,
  );
  // At-cap values still pass (the MCP schema allows exactly these lengths).
  const ok = s.claimResource(r, "k".repeat(500), "a", 900, null);
  check("#3 at-cap 500-char key is still granted", ok.granted === true, ok);
  s.close();
}


console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
