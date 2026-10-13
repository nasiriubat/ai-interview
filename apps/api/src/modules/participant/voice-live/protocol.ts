import { STT_STREAM_SAMPLE_RATE } from "@aidp/shared";
import { z } from "zod";

/**
 * The live voice wire protocol, browser to server. Audio arrives as binary; everything else is one
 * of these frames. Server to browser frames are built where they are sent and named in
 * `docs/spec` (contract 16, "Live voice").
 */
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  /**
   * Speak the question already on screen, without taking a turn.
   *
   * Someone who switches to voice part-way through an interview arrives to a question that has
   * already been asked in text. `start` would ask a new one, which is wrong: they have not
   * answered the current one yet. This reads the existing one aloud so the call begins where the
   * conversation actually is.
   */
  z.object({ type: z.literal("speak_last") }),
  /** The participant stopped talking; transcribe what has been sent and take a turn. */
  z.object({ type: z.literal("utterance"), durationMs: z.number().int().min(0).max(600_000).optional() }),
  /** The participant started talking over the interviewer. */
  z.object({ type: z.literal("barge") }),
  /** Discard buffered audio without taking a turn (they changed their mind). */
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("bye") }),
  /**
   * The browser has switched its capture to what the server asked for in a `mode` frame. Until it
   * says so, binary frames are the old format in flight and are dropped rather than transcribed.
   */
  z.object({ type: z.literal("capture"), mode: z.enum(["stream", "utterance"]) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** How the participant's speech reaches the transcriber; the server decides and says so in `ready`. */
export type HearingMode = "stream" | "utterance";

/** Something the participant said while a turn was running: a recording, or an already-final transcript. */
export type Held = { kind: "audio"; audio: Buffer } | { kind: "text"; text: string };

/** A single utterance may not exceed this before the server stops accepting audio for it. */
export const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

/** Beyond this the socket is closed: something is sending audio that never ends. */
export const MAX_SESSION_BYTES = 200 * 1024 * 1024;

/**
 * Stream mode sends raw PCM16 at 24 kHz, 48 kB a second whether anyone is talking or not, so its
 * ceiling is time rather than utterances: two hours of continuous audio.
 */
export const MAX_STREAM_SESSION_BYTES = 2 * 60 * 60 * STT_STREAM_SAMPLE_RATE * 2;

export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;

/** The longest answer taken from a transcript; the turn schema's own ceiling. */
export const MAX_ANSWER_CHARS = 8000;

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A text frame as a typed command, or undefined for anything malformed (which is ignored). */
export function parseClientFrame(data: Buffer): ClientFrame | undefined {
  const parsed = ClientFrame.safeParse(safeJson(data.toString("utf8")));
  return parsed.success ? parsed.data : undefined;
}
