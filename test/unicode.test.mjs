import { describe, expect, it } from "vitest";

import {
  assertWellFormedUtf16,
  assertWellFormedJsonValue,
  stringifyWellFormedJson,
} from "../src/unicode.ts";

describe("unicode validation and serialization", () => {
  it("accepts well-formed UTF-16 strings", () => {
    expect(() => assertWellFormedUtf16("abc", "payload")).not.toThrow();
    expect(() =>
      assertWellFormedUtf16("line-\uD834\uDF06-end", "payload"),
    ).not.toThrow();
  });

  it("rejects lone surrogates in UTF-16 strings", () => {
    expect(() => assertWellFormedUtf16("\uD800", "payload")).toThrow(
      "payload contains a lone surrogate (malformed UTF-16); fix the encoding",
    );
    expect(() => assertWellFormedUtf16("\uDEAD", "payload")).toThrow(
      "payload contains a lone surrogate (malformed UTF-16); fix the encoding",
    );
  });

  it("validates nested JSON values before serialization", () => {
    expect(() =>
      assertWellFormedJsonValue({ a: [{ b: "ok" }, { b: "fine" }], c: 1 }, "payload"),
    ).not.toThrow();

    expect(() =>
      assertWellFormedJsonValue({ a: ["ok", "\uD800"] }, "payload"),
    ).toThrow(/payload string contains a lone surrogate/);
    expect(() =>
      assertWellFormedJsonValue({ ["\uDEAD-key"]: "ok" }, "payload"),
    ).toThrow(/payload object key contains a lone surrogate/);
  });

  it("stringifyWellFormedJson serializes valid values and blocks malformed keys and strings", () => {
    expect(stringifyWellFormedJson("safe", "payload")).toBe('"safe"');
    expect(
      stringifyWellFormedJson({ nested: [{ value: "x" }, "y"] }, "payload"),
    ).toBe('{"nested":[{"value":"x"},"y"]}');

    expect(() => stringifyWellFormedJson({ ["bad-\uD800-key"]: "ok" }, "payload")).toThrow(
      /payload object key contains a lone surrogate/,
    );
    expect(() =>
      stringifyWellFormedJson({ nested: [{ value: "\uD800" }] }, "payload"),
    ).toThrow(/payload string contains a lone surrogate/);
  });

  it("rejects values that are not JSON-serializable", () => {
    expect(() => stringifyWellFormedJson(undefined, "payload")).toThrow(
      "payload is not JSON-serializable",
    );
  });

  it("checks UTF-16 on String objects passed into JSON stringify", () => {
    expect(() =>
      stringifyWellFormedJson({ value: new String("\uD800") }, "payload"),
    ).toThrow(/payload string contains a lone surrogate/);
  });

  it("allows embedded NUL while still rejecting malformed surrogates", () => {
    expect(stringifyWellFormedJson("a\u0000b", "payload")).toBe('"a\\u0000b"');
    expect(stringifyWellFormedJson({ text: "a\u0000b" }, "payload")).toContain(
      "\\u0000",
    );
  });
});
