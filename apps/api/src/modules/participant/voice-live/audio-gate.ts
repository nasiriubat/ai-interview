import { MAX_UTTERANCE_BYTES } from "./protocol.js";

/**
 * Byte accounting and buffering for one call's inbound audio.
 *
 * Pure bookkeeping, no socket: the session asks `admit` whether a chunk may be counted, and closes
 * the connection itself when the answer is no. Two ceilings exist because the two hearing modes
 * spend audio differently (see `MAX_SESSION_BYTES` and `MAX_STREAM_SESSION_BYTES`).
 */
export class AudioGate {
  private readonly chunks: Buffer[] = [];
  private utteranceBytes = 0;
  private total = 0;

  /** Everything admitted over the call, for the `audioBytes` metric. */
  get sessionBytes(): number {
    return this.total;
  }

  /** Counts audio against the call's ceiling; false when the call has exceeded it. */
  admit(byteLength: number, ceiling: number): boolean {
    this.total += byteLength;
    return this.total <= ceiling;
  }

  /** Buffers one chunk of the utterance in progress; the tail past the per-utterance cap is dropped. */
  append(data: Buffer): void {
    if (this.utteranceBytes + data.byteLength > MAX_UTTERANCE_BYTES) return; // drop the tail, keep the head
    this.chunks.push(data);
    this.utteranceBytes += data.byteLength;
  }

  /** The buffered utterance, emptying the buffer. */
  take(): Buffer {
    const audio = Buffer.concat(this.chunks);
    this.reset();
    return audio;
  }

  /** Puts a held recording back as the utterance in progress. */
  restore(audio: Buffer): void {
    this.chunks.push(audio);
    this.utteranceBytes = audio.byteLength;
  }

  reset(): void {
    this.chunks.length = 0;
    this.utteranceBytes = 0;
  }

  /**
   * Stream mode sends PCM16 straight on. An odd byte count would shift every later sample by half
   * a sample, which is noise rather than speech, so the stray byte is cut.
   */
  static evenPcm(data: Buffer): Uint8Array {
    const even = data.byteLength % 2 === 0 ? data : data.subarray(0, data.byteLength - 1);
    return new Uint8Array(even.buffer, even.byteOffset, even.byteLength);
  }
}
