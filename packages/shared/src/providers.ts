import { z } from "zod";
import { PurposeSchema } from "./purposes.js";

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "openrouter",
  "litellm",
  "openai_compatible",
  "stt",
  "tts",
  "realtime",
] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(), // null = platform-level, visible to all tenants
  kind: ProviderKindSchema,
  name: z.string(),
  baseUrl: z.url().optional(),
  apiKey: z.string(), // decrypted before it reaches the ai package
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const CapabilitiesSchema = z.object({
  caching: z.boolean(),
  structuredOutput: z.boolean(),
  effort: z.boolean(),
  batch: z.boolean(),
  vision: z.boolean(),
  transcription: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive().optional(),
  inputPerMtok: z.number().nonnegative().optional(),
  cachedInputPerMtok: z.number().nonnegative().optional(),
  outputPerMtok: z.number().nonnegative().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const RouteSchema = z.object({
  companyId: z.string().nullable(),
  purpose: PurposeSchema,
  providerId: z.string(),
  model: z.string(),
  effort: EffortSchema.optional(),
  maxOutputTokens: z.number().int().positive(),
  batchAllowed: z.boolean().default(false),
});
export type Route = z.infer<typeof RouteSchema>;
