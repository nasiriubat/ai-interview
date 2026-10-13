import { ProviderError, UnsupportedAudioError } from "@aidp/ai";
import type { LiveHost } from "./host.js";

export type Stage = "transcription" | "speech" | "turn";
export type Fallback = "text" | "recorded" | "captions";

/**
 * Which rung of the chain to drop to.
 *
 * The distinction that matters is between a missing route and a provider having a bad minute.
 * Recorded voice and live voice transcribe through the same `transcription` route, so when that
 * route does not exist, telling the participant to press the record button instead sends them at
 * the one thing guaranteed to fail the same way. The honest answer there is typing. A
 * transcription that merely *failed* is worth retrying by hand, so that one does point at the
 * button. Losing the interviewer's voice is different again: the call still works, in captions.
 */
export function fallbackFor(stage: Stage, unsupported: boolean): Fallback {
  if (stage !== "transcription") return "captions";
  return unsupported ? "text" : "recorded";
}

/** What to tell the browser, and how loudly to log it, for a provider failure at `stage`. */
export function degradation(
  err: unknown,
  stage: Stage,
): { frame: { type: "unavailable"; reason: string; fallback: Fallback }; level: "info" | "warn" } {
  if (err instanceof UnsupportedAudioError) {
    // The route exists but reads WAV only (the on-server Whisper, D-75) and live voice sends WebM.
    // Recorded voice converts to WAV in the browser before uploading, so it does work, and that is
    // where the participant goes; telling them to type would give up a working voice.
    return {
      frame: { type: "unavailable", reason: "transcription_needs_wav", fallback: "recorded" },
      level: "info",
    };
  }
  const unsupported = err instanceof ProviderError && err.code === "unsupported";
  return {
    frame: {
      type: "unavailable",
      reason: unsupported ? `no_${stage}_route` : `${stage}_failed`,
      fallback: fallbackFor(stage, unsupported),
    },
    level: "warn",
  };
}

/**
 * A provider that cannot do its half of the cascade drops the participant down the chain rather
 * than ending the interview.
 */
export function onProviderFailure(host: LiveHost, err: unknown, stage: Stage): void {
  const { frame, level } = degradation(err, stage);
  const sessionId = host.scope.sessionId;
  if (level === "info") {
    host.ctx.log.info({ sessionId }, "live voice: route reads WAV only, using recorded");
  } else {
    host.ctx.log.warn({ err, stage, sessionId }, "live voice degraded");
  }
  host.send(frame);
}
