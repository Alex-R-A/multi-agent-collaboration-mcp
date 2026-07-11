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
