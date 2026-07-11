// A high surrogate not immediately followed by a low, or a low not preceded
// by a high: either is an unpaired (lone) surrogate. JavaScript strings can
// contain these malformed UTF-16 code units even though they are not valid
// Unicode scalar values.
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Reject a string that contains malformed UTF-16. */
export function assertWellFormedUtf16(value: string, field: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new Error(
      `${field} contains a lone surrogate (malformed UTF-16); fix the encoding`,
    );
  }
}

/**
 * Reject a lone surrogate in any string value or object key anywhere in a
 * PARSED JSON value. Used at the store boundary for direct callers of
 * postMessage(format:"json"): their already-serialized body hides a nested lone
 * surrogate as an ASCII "\\uXXXX" escape that a raw-string check cannot see, and
 * JSON.parse reconstructs it for readers. The MCP handler validates earlier and
 * more cheaply via stringifyWellFormedJson (pre-escape, single pass); this is
 * the defense-in-depth walk for everyone else.
 */
export function assertWellFormedJsonValue(value: unknown, field: string): void {
  if (typeof value === "string") {
    assertWellFormedUtf16(value, `${field} string`);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertWellFormedJsonValue(v, field);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const k of Object.keys(value)) {
      assertWellFormedUtf16(k, `${field} object key`);
      assertWellFormedJsonValue((value as Record<string, unknown>)[k], field);
    }
  }
}

/**
 * Serialize structured content while rejecting lone surrogates in every JSON
 * string value and object key. A plain JSON.stringify would escape a lone
 * surrogate to ASCII (for example, "\\ud800"), hiding it from the storage
 * guard; JSON.parse would then recreate the malformed value for readers.
 *
 * The replacer validates values during JSON.stringify's own traversal, before
 * they are escaped. This covers nested objects, arrays, keys, and toJSON output
 * without a second recursive walk or a second in-memory representation.
 * Embedded NUL is deliberately allowed here: JSON escapes it for storage and
 * it is valid Unicode. Only malformed UTF-16 is a reader-interoperability risk.
 */
export function stringifyWellFormedJson(value: unknown, field: string): string {
  const encoded = JSON.stringify(value, function (key, child) {
    // Array keys are generated decimal indexes and cannot contain malformed
    // UTF-16. Avoid running the regex on every element of a wide array.
    if (!Array.isArray(this)) {
      assertWellFormedUtf16(key, `${field} object key`);
    }
    // JSON.stringify unboxes String objects only AFTER the replacer runs.
    // They cannot arrive over JSON-RPC, but handling them keeps this shared
    // serializer correct for in-process callers and for toJSON return values.
    let stringValue: string | null = null;
    if (typeof child === "string") {
      stringValue = child;
    } else if (
      typeof child === "object" &&
      child !== null &&
      child instanceof String
    ) {
      stringValue = String.prototype.valueOf.call(child);
    }
    if (stringValue !== null) {
      assertWellFormedUtf16(stringValue, `${field} string`);
    }
    return child;
  });
  if (encoded === undefined) {
    throw new Error(`${field} is not JSON-serializable`);
  }
  return encoded;
}
