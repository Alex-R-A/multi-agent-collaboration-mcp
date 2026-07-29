import { once } from "node:events";
import { BoundedLineTransform } from "../dist/bounded-lines.js";

let failures = 0;
function check(name, condition, detail) {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : "  >> " + JSON.stringify(detail)}`,
  );
  if (!condition) failures++;
}

{
  const input = new BoundedLineTransform(32);
  const frames = [];
  input.on("data", (chunk) => frames.push(chunk.toString("utf8")));
  input.write('{"jsonrpc":"2.0",');
  input.write('"id":1}\n{}\npartial');
  input.end();
  await once(input, "end");
  check(
    "fragmented and coalesced input emits exactly one chunk per complete line",
    frames.length === 2 &&
      frames[0] === '{"jsonrpc":"2.0","id":1}\n' &&
      frames[1] === "{}\n",
    frames,
  );
}

{
  const input = new BoundedLineTransform(8);
  const frames = [];
  input.on("data", (chunk) => frames.push(chunk.toString("utf8")));
  input.end("12345678\n");
  await once(input, "end");
  check("the exact byte limit is accepted", frames[0] === "12345678\n", frames);
}

{
  const input = new BoundedLineTransform(8);
  const failed = once(input, "error");
  input.write("1234");
  input.write("5678");
  input.end("9");
  const [error] = await failed;
  check(
    "a frame split across chunks fails as soon as it exceeds the bound",
    error.message ===
      "MCP stdio line content exceeds the configured 8-byte limit (LF delimiter excluded)",
    error.message,
  );
}

{
  const input = new BoundedLineTransform(8);
  const frames = [];
  input.on("data", (chunk) => frames.push(chunk.toString("utf8")));
  const failed = once(input, "error");
  input.end("ok\n123456789");
  const [error] = await failed;
  check(
    "a valid first frame is emitted before a later oversized frame fails",
    frames.length === 1 && frames[0] === "ok\n" &&
      error.message ===
        "MCP stdio line content exceeds the configured 8-byte limit (LF delimiter excluded)",
    { frames, error: error.message },
  );
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
