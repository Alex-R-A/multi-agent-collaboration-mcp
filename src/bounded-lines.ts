import { Transform, type TransformCallback } from "node:stream";

/**
 * A legal 10 MB message body can expand substantially when JSON escapes
 * control characters. Keep enough room for that envelope while putting a
 * hard ceiling below the SDK's otherwise unlimited stdio line buffer.
 */
export const MAX_MCP_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Turn arbitrarily chunked input into one Buffer per LF-delimited frame. One
 * geometrically grown owned buffer keeps both payload and fragment metadata
 * bounded; retaining upstream subarray views would let millions of tiny
 * writes consume far more memory than their payload. This prevents the MCP
 * SDK's ReadBuffer from repeatedly Buffer.concat-ing a growing partial line
 * (quadratic copying) and rejects a line before unbounded JSON.parse memory.
 */
export class BoundedLineTransform extends Transform {
  private buffer = Buffer.alloc(0);
  private bytes = 0;

  constructor(private readonly maxLineBytes = MAX_MCP_FRAME_BYTES) {
    super();
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error("maxLineBytes must be a positive safe integer");
    }
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    let offset = 0;

    while (offset < input.length) {
      const newline = input.indexOf(0x0a, offset);
      const end = newline === -1 ? input.length : newline;
      const part = input.subarray(offset, end);
      if (this.bytes + part.length > this.maxLineBytes) {
        this.reset(true);
        callback(
          new Error(
            `MCP stdio frame exceeds the ${this.maxLineBytes}-byte safety limit`,
          ),
        );
        return;
      }
      if (part.length > 0) {
        this.ensureCapacity(this.bytes + part.length);
        part.copy(this.buffer, this.bytes);
        this.bytes += part.length;
      }

      if (newline === -1) break;
      this.pushCompletedLine();
      offset = newline + 1;
    }

    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.reset(true);
    callback(error);
  }

  private pushCompletedLine(): void {
    const frame = Buffer.allocUnsafe(this.bytes + 1);
    this.buffer.copy(frame, 0, 0, this.bytes);
    frame[this.bytes] = 0x0a;
    // Do not permanently retain a maximum-size allocation after one unusual
    // request. Normal small-frame capacity is reused to avoid allocation churn.
    this.reset(this.buffer.length > 1024 * 1024);
    this.push(frame);
  }

  private ensureCapacity(required: number): void {
    if (this.buffer.length >= required) return;
    const doubled = this.buffer.length > 0 ? this.buffer.length * 2 : 64 * 1024;
    const capacity = Math.min(
      this.maxLineBytes,
      Math.max(required, doubled),
    );
    const grown = Buffer.allocUnsafe(capacity);
    this.buffer.copy(grown, 0, 0, this.bytes);
    this.buffer = grown;
  }

  private reset(release = false): void {
    if (release) this.buffer = Buffer.alloc(0);
    this.bytes = 0;
  }
}
