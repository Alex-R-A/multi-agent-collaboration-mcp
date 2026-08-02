import { once } from "node:events";
import { BoundedLineTransform } from "../dist/bounded-lines.js";

import { describe, expect, it } from "vitest";

const boundMessage =
  "MCP stdio line content exceeds the configured 8-byte limit (LF delimiter excluded)";

describe("BoundedLineTransform", () => {
  it("emits one frame per LF-delimited line", async () => {
    const input = new BoundedLineTransform(32);
    const frames = [];
    input.on("data", (chunk) => frames.push(chunk.toString("utf8")));

    input.write('{"jsonrpc":"2.0",');
    input.write('"id":1}\n{}\npartial');
    input.end();

    await once(input, "end");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe('{"jsonrpc":"2.0","id":1}\n');
    expect(frames[1]).toBe("{}\n");
  });

  it("counts limit in bytes and allows an exact boundary", async () => {
    const input = new BoundedLineTransform(8);
    const frames = [];
    input.on("data", (chunk) => frames.push(chunk.toString("utf8")));

    input.end("12345678\n");
    await once(input, "end");

    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe("12345678\n");
  });

  it("rejects a line that exceeds the bound across chunks", async () => {
    const input = new BoundedLineTransform(8);
    const failed = once(input, "error");

    input.write("1234");
    input.write("5678");
    input.end("9");

    const [error] = await failed;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "MCP stdio line content exceeds the configured 8-byte limit (LF delimiter excluded)",
    );
  });

  it("emits earlier complete frames before a later oversized frame errors", async () => {
    const input = new BoundedLineTransform(8);
    const frames = [];
    input.on("data", (chunk) => frames.push(chunk.toString("utf8")));
    const failed = once(input, "error");

    input.end("ok\n123456789");

    const [error] = await failed;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(boundMessage);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe("ok\n");
  });

  it("supports multibyte UTF-8 payloads in byte accounting", async () => {
    const input = new BoundedLineTransform(4);
    const frames = [];
    input.on("data", (chunk) => frames.push(chunk.toString("utf8")));
    input.write("あb\n");
    input.write("あ\n");
    input.end();

    await once(input, "end");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe("あb\n");
    expect(frames[1]).toBe("あ\n");
  });

  it("rejects a multibyte frame that exceeds the byte limit", async () => {
    const input = new BoundedLineTransform(4);
    const failed = once(input, "error");

    input.end("ああ\n");

    const [error] = await failed;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "MCP stdio line content exceeds the configured 4-byte limit (LF delimiter excluded)",
    );
  });

  it("does not emit a partial frame without a terminating newline", async () => {
    const input = new BoundedLineTransform(128);
    const frames = [];
    input.on("data", (chunk) => frames.push(chunk.toString("utf8")));

    input.end("partial-without-newline");
    await once(input, "end");
    expect(frames).toHaveLength(0);
  });
});
