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
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

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
  language?: string;
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
