import type { RecorderProblem } from "../useRecorder";
import type { HearingMode, TurnFrame, VoiceFallback } from "@/lib/api/voice-live";

export type LiveVoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "unavailable";

/** The recorder's problems plus the one only a live call has: the socket went away for good. */
export type LiveVoiceProblem = RecorderProblem | "lost";

export interface LiveVoiceCallbacks {
  /** One interviewer turn — the same payload the SSE stream carries, so it becomes a normal message. */
  onTurn: (turn: TurnFrame) => void;
  /**
   * What the participant was heard to say. This is the only way their own words reach the browser:
   * the server takes the turn with the answer already transcribed, so no `turn` frame echoes it.
   */
  onHeard: (text: string) => void;
  onEnded: (summaryAvailable: boolean) => void;
  /** A turn that failed, in the same shape the interview's own error alert takes. */
  onError: (code: string, message: string) => void;
  /**
   * The call is over because the cascade cannot hear, and this is the rung of spec 09's chain that
   * is still standing: `recorded` when transcription merely failed, `text` when there is no
   * transcription route at all and the microphone would fail the same way.
   *
   * The hook does not decide what to offer instead — it has already released the device and closed
   * the socket. `reason` is the server's word for why, for logs and for wording.
   */
  onUnavailable: (fallback: Exclude<VoiceFallback, "captions">, reason: string) => void;
}

export interface LiveVoiceController {
  status: LiveVoiceStatus;
  /** Microphone loudness, 0 to 1, quantized to the meter's steps. */
  level: number;
  /** Whether the server sends captions. When it does not, nothing the participant says is shown. */
  captions: boolean;
  /** The server's voice is gone; the call carries on in text (the middle rung of the chain). */
  textOnly: boolean;
  /** The last utterance transcribed to nothing, so the participant can be asked to try again. */
  notHeard: boolean;
  /**
   * Stream mode: what the participant has said so far in the utterance in progress. Visual only —
   * it changes several times a second, so it is never put in a live region; the finished caption
   * reaches the message list, which announces it once.
   */
  partial: string;
  /** How speech is being captured in this call. */
  mode: HearingMode;
  problem: LiveVoiceProblem | null;
  start: () => void;
  end: () => void;
  /** Cuts the interviewer off now: the same thing barge-in does, from a button. */
  stopSpeaking: () => void;
  dismissProblem: () => void;
}
