import type { HearingMode } from "./protocol.js";

const avg = (total: number, n: number): number | null => (n > 0 ? Math.round(total / n) : null);

/** The signals spec 09 asks to trace per session, counted over the call and written once at the end. */
export class VoiceMetrics {
  turns = 0;
  interruptions = 0;
  streamFallbacks = 0;
  private firstWordMsTotal = 0;
  private firstWordSamples = 0;
  private firstPartialMsTotal = 0;
  private firstPartialSamples = 0;

  /** The number the spec puts a target on: question asked to first audible word. */
  firstWord(ms: number): void {
    this.firstWordMsTotal += ms;
    this.firstWordSamples++;
  }

  /** Stream mode: the participant starts talking to the first word of their caption. */
  firstPartial(ms: number): void {
    this.firstPartialMsTotal += ms;
    this.firstPartialSamples++;
  }

  /** The row to store, or undefined for a call that never took a turn. */
  snapshot(
    mode: HearingMode,
    audioBytes: number,
  ):
    | {
        turns: number;
        interruptions: number;
        avgFirstWordMs: number | null;
        avgFirstPartialMs: number | null;
        mode: HearingMode;
        streamFallbacks: number;
        audioBytes: number;
      }
    | undefined {
    if (this.turns === 0) return undefined;
    return {
      turns: this.turns,
      interruptions: this.interruptions,
      avgFirstWordMs: avg(this.firstWordMsTotal, this.firstWordSamples),
      avgFirstPartialMs: avg(this.firstPartialMsTotal, this.firstPartialSamples),
      mode,
      streamFallbacks: this.streamFallbacks,
      audioBytes,
    };
  }
}
