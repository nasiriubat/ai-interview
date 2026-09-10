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
export interface Transcript {
  text: string;
  durationSeconds?: number;
}
