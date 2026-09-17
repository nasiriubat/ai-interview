import { z } from "zod";
import { MessageSchema, ProgressSchema } from "./schemas";

/*
 * The frames of the live voice cascade (FR-30a), as `apps/api/src/modules/participant/voice-live.ts`
 * writes them. Text frames are JSON; binary frames are audio and never reach this file.
 *
 * Parsed with zod for the same reason the SSE events are: the socket is the one API surface the
 * browser reads without the proxy in front of it, and a frame the client cannot make sense of must
 * be ignored rather than thrown at the participant mid-sentence.
 */

/** The socket is up and the tenant's knobs are known. */
const ReadyFrameSchema = z.object({
  type: z.literal("ready"),
  captions: z.boolean().default(false),
  bargeIn: z.boolean().default(false),
});

/**
 * One interviewer turn — the same payload the SSE stream sends, so it becomes an ordinary message.
 *
 * Only the interviewer's turns arrive this way: the server takes the turn with the answer already
 * transcribed, so nothing echoes the participant's own message back. Their words reach this client
 * as a `caption` and nowhere else.
 */
const TurnFrameSchema = z.object({
  type: z.literal("turn"),
  message: MessageSchema,
  ended: z.boolean().default(false),
  progress: ProgressSchema.default({ areas: [] }),
  /** What the interviewer speaks instead of the written message; the list still shows `message`. */
  voiceShortForm: z.string().optional(),
});

const CaptionFrameSchema = z.object({
  type: z.literal("caption"),
  role: z.enum(["user", "assistant"]),
  text: z.string().default(""),
  confidence: z.number().optional(),
});

/** Audio for this turn starts now; binary frames follow until `speech_end`. */
const SpeechStartFrameSchema = z.object({
  type: z.literal("speech_start"),
  mime: z.string().default("audio/ogg"),
  shortened: z.boolean().default(false),
});

const SpeechEndFrameSchema = z.object({
  type: z.literal("speech_end"),
  interrupted: z.boolean().default(false),
});

/** Question asked to first audible word, the number spec 09 puts a target on. */
const FirstWordFrameSchema = z.object({ type: z.literal("first_word"), ms: z.number().default(0) });

/** The utterance transcribed to nothing. */
const NotHeardFrameSchema = z.object({ type: z.literal("not_heard") });

const EndedFrameSchema = z.object({
  type: z.literal("ended"),
  summaryAvailable: z.boolean().default(false),
});

const ErrorFrameSchema = z.object({
  type: z.literal("error"),
  code: z.string().default("error"),
  message: z.string().default(""),
});

/**
 * A rung of the spec's real-time → recorded → text chain.
 *
 * `recorded` means the cascade cannot hear at all, so the call ends and the push-to-record button
 * comes back. `captions` means only the voice is missing, so the call carries on in text.
 */
const UnavailableFrameSchema = z.object({
  type: z.literal("unavailable"),
  reason: z.string().default(""),
  fallback: z.enum(["recorded", "captions"]).catch("recorded"),
});

export const ServerFrameSchema = z.discriminatedUnion("type", [
  ReadyFrameSchema,
  TurnFrameSchema,
  CaptionFrameSchema,
  SpeechStartFrameSchema,
  SpeechEndFrameSchema,
  FirstWordFrameSchema,
  NotHeardFrameSchema,
  EndedFrameSchema,
  ErrorFrameSchema,
  UnavailableFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type TurnFrame = z.infer<typeof TurnFrameSchema>;

/** What the browser sends back. Audio goes as binary; everything else is one of these. */
export type ClientFrame =
  /**
   * Read the question already on screen aloud. Sent once, as soon as the call is up.
   *
   * It takes no turn, stores nothing and never touches the turn lock, and it opens the interview
   * when nothing has been asked yet — so it is the right frame whether the participant started in
   * voice or switched to it halfway through. `{type:"start"}` exists on the server too, but it
   * runs an engine turn, which mid-interview would ask the same question a second time.
   */
  | { type: "speak_last" }
  | { type: "utterance"; durationMs?: number }
  | { type: "barge" }
  | { type: "cancel" }
  | { type: "bye" };

/** Parses one text frame, or `undefined` when it is not something this client understands. */
export function toServerFrame(data: string): ServerFrame | undefined {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = ServerFrameSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
