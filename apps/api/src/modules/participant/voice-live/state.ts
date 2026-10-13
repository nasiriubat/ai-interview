import type { SttStreamSession } from "@aidp/shared";
import type { HearingMode, Held } from "./protocol.js";

/** The tenant's voice knobs, read once when the call opens. */
export interface SessionOpts {
  captions: boolean;
  bargeIn: boolean;
  voice: string;
  speed: number;
}

/**
 * Where the call is, from the participant's point of view. Derived from the state below rather
 * than stored, so it cannot disagree with it; the transitions that matter are the ones a test can
 * now name (`closed` is terminal, a held utterance only exists while `thinking` or `speaking`).
 */
export type Phase = "closed" | "speaking" | "thinking" | "listening";

/**
 * The mutable state of one call, in one place, shared by the collaborators that act on it
 * (hearing, turn driver, speech output). Nothing here touches a socket or a database.
 */
export class LiveState {
  closed = false;
  /** A turn (or a transcription ahead of one) is in flight. */
  busy = false;
  /**
   * Something said while a turn was still running.
   *
   * Dropping it would be wrong in the most ordinary case there is: the participant hears the
   * question, starts answering immediately, and the interviewer is still speaking. Barge-in means
   * exactly that is expected. It is held and answered as soon as the turn in flight ends.
   */
  pending: Held | undefined;
  /** Aborts the synthesis in flight. Replaced on every turn, called on barge-in. */
  speaking: AbortController | undefined;
  mode: HearingMode = "utterance";
  /** The provider's transcription socket, in stream mode. */
  stt: SttStreamSession | undefined;
  /** Binary frames are dropped until the browser confirms it changed capture format. */
  awaitingCapture = false;
  /** The provider said the participant stopped; a final transcript (or a failure) is owed. */
  awaitingFinal = false;
  speechStartedAt: number | undefined;
  partialSeen = false;
  opts: SessionOpts = { captions: true, bargeIn: true, voice: "alloy", speed: 1 };

  get phase(): Phase {
    if (this.closed) return "closed";
    if (this.speaking) return "speaking";
    if (this.busy) return "thinking";
    return "listening";
  }

  /**
   * Keeps the most recent thing said during a turn. If they said two things while the interviewer
   * was talking, the second is the one they meant; answering the first would put the conversation
   * a turn behind.
   */
  hold(item: Held): void {
    this.pending = item;
  }

  /** Takes what was held, if the call is still open. */
  takeHeld(): Held | undefined {
    const held = this.pending;
    if (!held || this.closed) return undefined;
    this.pending = undefined;
    return held;
  }

  /** The socket is gone or about to be: stop everything that is still running for it. */
  close(): void {
    this.closed = true;
    this.speaking?.abort();
    this.stt?.close();
  }
}
