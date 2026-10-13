"use client";

import * as React from "react";
import { t } from "@/i18n";
import { toSpeechWav } from "@/lib/audio/wav";

/**
 * Recording in the browser (FR-30).
 *
 * Two rules shape this hook. The microphone is asked for when the participant presses record and
 * never on page load, because a permission prompt nobody asked for is how people learn to click
 * "block". And every path out of recording — stop, discard, the length cap, an unmount, a failure
 * while starting — runs through `release`, because a microphone left open after the participant
 * thought they had stopped is a privacy problem, not a leaked object.
 */

/** Long enough for a considered answer; short enough that a recorder left running is caught. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

/** Why recording is not available, kept apart so each one can be explained differently. */
export type RecorderProblem = "unsupported" | "denied" | "no_microphone" | "failed";

export type RecorderStatus = "idle" | "starting" | "recording";

/** Each way the microphone can fail gets its own sentence; all of them end in "type instead". */
export function recorderProblemMessage(problem: RecorderProblem): string {
  const s = t.participant.session;
  switch (problem) {
    case "denied":
      return s.recordDenied;
    case "unsupported":
      return s.recordUnsupported;
    case "no_microphone":
      return s.recordNoMicrophone;
    case "failed":
      return s.recordFailed;
  }
}

export interface RecorderController {
  status: RecorderStatus;
  elapsedMs: number;
  /** True when the length cap stopped the recording, so the participant can be told why. */
  maxedOut: boolean;
  problem: RecorderProblem | null;
  start: () => Promise<void>;
  /** Stops and hands the audio over. */
  stop: () => void;
  /** Stops and throws the audio away. */
  cancel: () => void;
  dismissProblem: () => void;
}

/** In preference order; the first one this browser can produce wins. All are on the API's allowlist. */
const CANDIDATE_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export function recorderOptions(): MediaRecorderOptions {
  const supported = typeof window.MediaRecorder.isTypeSupported === "function";
  const mimeType = supported
    ? CANDIDATE_MIMES.find((m) => window.MediaRecorder.isTypeSupported(m))
    : undefined;
  return mimeType === undefined ? {} : { mimeType };
}

/** `getUserMedia` reports refusal and absence through the error's name. */
export function microphoneProblem(e: unknown): RecorderProblem {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "no_microphone";
  }
  return "failed";
}

export function useRecorder(onRecorded: (audio: Blob, durationMs: number) => void): RecorderController {
  const onRecordedRef = React.useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  const [status, setStatus] = React.useState<RecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [maxedOut, setMaxedOut] = React.useState(false);
  const [problem, setProblem] = React.useState<RecorderProblem | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const startedAtRef = React.useRef(0);
  const discardRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const release = React.useCallback((): void => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const finish = React.useCallback(
    (discard: boolean): void => {
      const recorder = recorderRef.current;
      if (!recorder) return;
      discardRef.current = discard;
      if (recorder.state === "inactive") {
        // Nothing will fire `stop`, so the microphone has to be let go here.
        release();
        setStatus("idle");
        setElapsedMs(0);
        return;
      }
      recorder.stop();
    },
    [release],
  );

  const start = React.useCallback(async (): Promise<void> => {
    if (recorderRef.current) return;
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.getUserMedia || typeof window.MediaRecorder === "undefined") {
      setProblem("unsupported");
      return;
    }
    setProblem(null);
    setMaxedOut(false);
    setElapsedMs(0);
    setStatus("starting");

    let stream: MediaStream;
    try {
      stream = await media.getUserMedia({ audio: true });
    } catch (e) {
      setStatus("idle");
      setProblem(microphoneProblem(e));
      return;
    }
    streamRef.current = stream;

    let recorder: MediaRecorder;
    try {
      recorder = new window.MediaRecorder(stream, recorderOptions());
    } catch {
      release();
      setStatus("idle");
      setProblem("failed");
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;
    startedAtRef.current = Date.now();

    recorder.ondataavailable = (e: BlobEvent): void => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = (): void => {
      discardRef.current = true;
      release();
      setStatus("idle");
      setElapsedMs(0);
      setProblem("failed");
    };
    recorder.onstop = (): void => {
      const durationMs = Date.now() - startedAtRef.current;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      const discarded = discardRef.current;
      release();
      setStatus("idle");
      setElapsedMs(0);
      if (discarded) return;
      // The recorder usually names the container it produced; a browser that does not leaves the
      // chunk's own type, and webm is the last resort because every recorder here can make one.
      const type = [recorder.mimeType, chunks[0]?.type].find((m) => m !== undefined && m !== "");
      const audio = new Blob(chunks, { type: type ?? "audio/webm" });
      // An empty blob means the microphone produced nothing; sending it would buy a confusing
      // "I could not hear anything" from the server a few seconds later.
      if (audio.size === 0) {
        setProblem("failed");
        return;
      }
      // Converted to 16 kHz WAV before upload, so the server can transcribe it itself without
      // ffmpeg (D-75). A browser that cannot decode its own recording sends the original.
      void toSpeechWav(audio).then((wav) => {
        onRecordedRef.current(wav, durationMs);
      });
    };

    recorder.start();
    setStatus("recording");
    timerRef.current = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      if (ms >= MAX_RECORDING_MS) {
        setMaxedOut(true);
        finish(false);
      }
    }, 250);
  }, [finish, release]);

  const stop = React.useCallback((): void => {
    finish(false);
  }, [finish]);
  const cancel = React.useCallback((): void => {
    finish(true);
  }, [finish]);
  const dismissProblem = React.useCallback((): void => {
    setProblem(null);
  }, []);

  React.useEffect(() => {
    return () => {
      // Leaving the page mid-recording throws the audio away, but must not leave the light on.
      discardRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      release();
    };
  }, [release]);

  return { status, elapsedMs, maxedOut, problem, start, stop, cancel, dismissProblem };
}
