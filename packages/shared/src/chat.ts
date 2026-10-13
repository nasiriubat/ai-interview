import { z } from "zod";
import { EffortSchema } from "./providers.js";

export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    base64: z.string(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(ContentPartSchema)]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  system: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  maxOutputTokens: z.number().int().positive(),
  effort: EffortSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Mark the system prompt as a stable, cacheable prefix on providers that support it. */
  cachePrefix: z.boolean().default(false),
  /**
   * "off" asks the provider not to spend hidden reasoning tokens on this call. Set by ModelCaller
   * for every purpose whose route does not ask for high effort; an adapter that has no such
   * control ignores it (live run 2026-10-14: a reasoning-capable model burned the output cap on
   * thoughts and returned truncated JSON in 74% of extraction calls).
   */
  reasoning: z.enum(["off"]).optional(),
});
/**
 * What an adapter receives. `signal` is not part of the wire contract (it cannot be validated or
 * serialized); `ModelCaller` sets it from the caller's own signal so that a client that leaves
 * stops the request instead of being billed for an answer nobody reads.
 */
export type ChatRequest = z.infer<typeof ChatRequestSchema> & {
  signal?: AbortSignal;
  /**
   * Called by an adapter once per HTTP attempt of a structured call, with what the provider
   * reported (or nothing, when the attempt was rejected before any work). ModelCaller turns each
   * report into its own ledger row, so a rejected strict-schema first attempt and a failed
   * validation are booked, not lost (live run 2026-10-14, bug 7).
   */
  onAttempt?: (attempt: AttemptReport) => void;
};

export interface AttemptReport {
  /** What the provider billed for this attempt; empty when it refused the request outright. */
  usage: Usage;
  /** True when the attempt produced the value that was returned. */
  ok: boolean;
  /** Why an attempt did not count, for the ledger's reader. */
  note?: "rejected" | "invalid" | "truncated";
  latencyMs: number;
}

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
});

export const StopReasonSchema = z.enum(["end_turn", "max_tokens", "refusal", "other"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export type ChatEvent =
  { type: "text"; text: string } | { type: "done"; usage: Usage; stopReason: StopReason; model: string };

export interface TranscriptionInput {
  data: Uint8Array;
  mime: string;
  filename: string;
  /** The language the audio is in, when it is known for certain. Forces it. */
  language?: string;
  /**
   * The languages the speaker is likely to use (ISO 639-1), when `language` is not known: the
   * interview's own language first. A provider that identifies the language itself chooses among
   * these instead of among all of them, which is what keeps a one-word Finnish answer from being
   * heard as Estonian. Providers that cannot use it ignore it.
   */
  languages?: string[];
}
/**
 * Streaming speech-to-text (FR-30a, D-77): the `stt_stream` purpose.
 *
 * The caller pushes raw audio as it is captured and reads transcripts as they form. Audio is
 * always PCM16, little-endian, mono, at {@link STT_STREAM_SAMPLE_RATE}: that is the one format the
 * OpenAI Realtime transcription API accepts ("Only a 24kHz sample rate is supported"), and fixing
 * it here keeps every adapter and the browser agreeing without negotiation.
 */
export const STT_STREAM_SAMPLE_RATE = 24_000;

export interface SttStreamInput {
  /** ISO 639-1 code of the language the participant is expected to speak. */
  language?: string;
  /** Silence that ends an utterance, in milliseconds, for providers that detect turns themselves. */
  silenceMs?: number;
}

/**
 * What a streaming transcription session reports. Transport-agnostic: the adapter maps its
 * provider's socket events onto these and nothing downstream knows which provider it was.
 *
 * - `speech_started` / `speech_stopped`: the provider's voice activity detector changed its mind.
 *   `speech_started` doubles as a barge-in signal while the interviewer is talking.
 * - `partial`: the transcript of the utterance in progress so far. `text` is the whole growing
 *   text of the item, not a delta, so a consumer that misses one frame loses nothing.
 * - `final`: the utterance is complete. `usage` carries what the provider billed, when it said.
 * - `error`: `fatal` means the session is gone and no further events will come.
 */
export const SttStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speech_started") }),
  z.object({ type: z.literal("speech_stopped") }),
  z.object({ type: z.literal("partial"), itemId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("final"),
    itemId: z.string(),
    text: z.string(),
    durationSeconds: z.number().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
    usage: UsageSchema.optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string(), fatal: z.boolean() }),
]);
export type SttStreamEvent = z.infer<typeof SttStreamEventSchema>;

/** One open streaming transcription. Owned by whoever opened it; always end it with close or abort. */
export interface SttStreamSession {
  /** Appends PCM16 audio. Ignored once the session is closed. */
  push(pcm16: Uint8Array): void;
  /** Every event the session reports, ending when it closes. */
  readonly events: AsyncIterable<SttStreamEvent>;
  /** Ends the session politely: the socket is closed and the event stream finishes. */
  close(): void;
}

/**
 * One request to speak a piece of text (FR-30a).
 *
 * `format` is what the browser will play. `opus` in a WebM container is the default because it is
 * what every current browser decodes, is small enough to start playing within the latency target
 * on a slow connection, and is what a self-hosted Piper or an OpenAI-compatible endpoint will
 * produce on request.
 */
export interface SpeechInput {
  text: string;
  /** Provider-specific voice name; the route's model decides which voices exist. */
  voice?: string;
  format?: "opus" | "mp3" | "wav" | "pcm";
  /** 0.25 to 4.0 where the provider supports it. A voice interview usually wants slightly quick. */
  speed?: number;
  language?: string;
}

/**
 * Spoken audio, as a stream.
 *
 * A stream and not a buffer because the whole point is the first word: the spec asks for it inside
 * 1.5 seconds, and waiting for a provider to finish synthesizing three sentences before playing
 * any of them spends that budget several times over.
 */
export interface SpeechOutput {
  audio: AsyncIterable<Uint8Array>;
  mime: string;
}

export interface Transcript {
  text: string;
  durationSeconds?: number;
  /**
   * 0..1, where the provider reports one. The spec asks for transcription confidence to be traced
   * per turn and shown in stats, because a low-confidence transcript is the most likely cause of
   * an interviewer asking a question that makes no sense to the person who just spoke.
   */
  confidence?: number;
}
