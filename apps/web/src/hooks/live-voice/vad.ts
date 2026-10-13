import type { LiveVoiceStatus } from "./types";
import type { HearingMode } from "@/lib/api/voice-live";

/**
 * Speech detection from loudness samples, as a pure function.
 *
 * The browser reads the analyser every `POLL_MS` and hands the loudness here with the call's
 * state; what comes back is the next detector state and at most one thing to do. No timers, no
 * audio nodes: a test feeds a sequence of numbers and reads the actions.
 */

/** How often the analyser is read: fine enough to resolve the silence window, cheap enough to ignore. */
export const POLL_MS = 50;

/** End of utterance: this much quiet after something was actually said. */
export const SILENCE_MS = 900;

/** Root-mean-square above which the microphone is carrying speech rather than room noise. */
export const SPEECH_RMS = 0.045;

/**
 * Interrupting takes a clearer signal than starting to talk into silence, and it has to hold for a
 * few polls: the speakers are feeding the microphone, and a cough must not cut the interviewer off.
 */
export const BARGE_RMS = 0.09;
export const BARGE_POLLS = 3;

/** The loudness that fills the level meter. Normal speech sits well below it. */
export const FULL_SCALE_RMS = 0.3;

/** The meter is drawn in steps, and the level only re-renders when the step changes. */
export const METER_STEPS = 8;

/** A detector that never sees silence must not record for ever; the server caps the bytes anyway. */
export const MAX_UTTERANCE_MS = 2 * 60 * 1000;

export interface VadState {
  /** Consecutive polls above the barge threshold while the interviewer is speaking. */
  loudPolls: number;
  /** When the quiet after the last speech began, or null while there has been none. */
  silenceSince: number | null;
}

export const INITIAL_VAD: VadState = { loudPolls: 0, silenceSince: null };

export interface VadInput {
  rms: number;
  now: number;
  status: LiveVoiceStatus;
  mode: HearingMode;
  bargeIn: boolean;
  /** An utterance recording is open (utterance mode). */
  recording: boolean;
  /** How long the open recording has been running. */
  recordingMs: number;
}

export type VadAction =
  | { type: "none" }
  | { type: "begin_utterance" }
  | { type: "end_utterance" }
  /** Cut the interviewer off; `keepTalking` starts recording straight away (utterance mode). */
  | { type: "interrupt"; keepTalking: boolean };

/** The meter step for a loudness, 0 to `METER_STEPS`. */
export function meterStep(rms: number): number {
  return Math.min(METER_STEPS, Math.round((rms / FULL_SCALE_RMS) * METER_STEPS));
}

export function vadStep(state: VadState, input: VadInput): { state: VadState; action: VadAction } {
  const { status } = input;
  if (status === "idle" || status === "connecting" || status === "unavailable") {
    return { state, action: { type: "none" } };
  }

  if (status === "speaking") {
    if (!input.bargeIn) return { state, action: { type: "none" } };
    const loudPolls = input.rms >= BARGE_RMS ? state.loudPolls + 1 : 0;
    const next = { ...state, loudPolls };
    // In stream mode the audio is already on its way; there is no recording to start.
    if (loudPolls >= BARGE_POLLS) {
      return { state: next, action: { type: "interrupt", keepTalking: input.mode === "utterance" } };
    }
    return { state: next, action: { type: "none" } };
  }

  // Stream mode: the provider finds the end of each utterance, not this loop.
  if (input.mode === "stream") return { state, action: { type: "none" } };

  // Listening, or thinking: an answer given while the turn is still running is the ordinary
  // case, not an error, and the server holds it until the turn in flight is done.
  if (input.recording && input.recordingMs >= MAX_UTTERANCE_MS) {
    return { state: { ...state, silenceSince: null }, action: { type: "end_utterance" } };
  }
  if (input.rms >= SPEECH_RMS) {
    return { state: { ...state, silenceSince: null }, action: { type: "begin_utterance" } };
  }
  // Nothing was ever above the threshold, so there is nothing to send: this is what keeps a
  // quiet room from asking the interviewer a question every second.
  if (!input.recording) return { state, action: { type: "none" } };
  const silenceSince = state.silenceSince ?? input.now;
  if (input.now - silenceSince >= SILENCE_MS) {
    return { state: { ...state, silenceSince: null }, action: { type: "end_utterance" } };
  }
  return { state: { ...state, silenceSince }, action: { type: "none" } };
}
