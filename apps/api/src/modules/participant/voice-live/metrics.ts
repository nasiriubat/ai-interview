import type { HearingMode } from "./protocol.js";

const avg = (total: number, n: number): number | null => (n > 0 ? Math.round(total / n) : null);

/**
 * Where each sample goes as it happens, for the histograms (D-222). The per-call averages below
 * are what a session row stores; the SLO needs the distribution, so every sample is also sent here.
 */
export interface VoiceSink {
  firstWord(ms: number, mode: HearingMode): void;
  firstPartial(ms: number, mode: HearingMode): void;
  event(event: "interruption" | "stream_fallback"): void;
}

/** The signals spec 09 asks to trace per session, counted over the call and written once at the end. */
export class VoiceMetrics {
  turns = 0;
  interruptions = 0;
  streamFallbacks = 0;
  constructor(private readonly sink?: VoiceSink) {}

  interruption(): void {
    this.interruptions++;
    this.sink?.event("interruption");
  }

  streamFallback(): void {
    this.streamFallbacks++;
    this.sink?.event("stream_fallback");
  }

  private firstWordMsTotal = 0;
  private firstWordSamples = 0;
  private firstPartialMsTotal = 0;
  private firstPartialSamples = 0;

  /** The number the spec puts a target on: question asked to first audible word. */
  firstWord(ms: number, mode: HearingMode = "utterance"): void {
    this.firstWordMsTotal += ms;
    this.firstWordSamples++;
    this.sink?.firstWord(ms, mode);
  }

  /** Stream mode: the participant starts talking to the first word of their caption. */
  firstPartial(ms: number, mode: HearingMode = "stream"): void {
    this.firstPartialMsTotal += ms;
    this.firstPartialSamples++;
    this.sink?.firstPartial(ms, mode);
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
