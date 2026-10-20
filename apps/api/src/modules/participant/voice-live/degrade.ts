import { ProviderError, UnsupportedAudioError } from "@aidp/ai";
import { AppError } from "../../../lib/errors.js";
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
 * A turn the API refused (`AppError`: another turn still running, the session finished) is that
 * turn failing, and nothing is wrong with the cascade. It goes to the browser as an `error` frame,
 * which leaves the call listening with its voice, instead of `unavailable`, which for a turn would
 * have dropped the call to captions and silenced the interviewer for the rest of it.
 */
export function refusal(err: unknown): { type: "error"; code: string; message: string } | undefined {
  if (!(err instanceof AppError)) return undefined;
  return {
    type: "error",
    code: err.code,
    message:
      err.code === "conflict"
        ? "That answer arrived while the last one was still being answered. Please say it again."
        : "That answer could not be taken. Please try again.",
  };
}

/**
 * A provider that cannot do its half of the cascade drops the participant down the chain rather
 * than ending the interview.
 */
export function onProviderFailure(host: LiveHost, err: unknown, stage: Stage): void {
  const sessionId = host.scope.sessionId;
  const refused = refusal(err);
  if (refused) {
    host.ctx.log.info({ sessionId, stage, code: refused.code }, "live voice: turn refused");
    host.send(refused);
    return;
  }
  const { frame, level } = degradation(err, stage);
  if (level === "info") {
    host.ctx.log.info({ sessionId }, "live voice: route reads WAV only, using recorded");
  } else {
    host.ctx.log.warn({ err, stage, sessionId }, "live voice degraded");
  }
  host.send(frame);
}
