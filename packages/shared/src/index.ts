import { z } from "zod";

// ---------- Purposes: every model call is made for exactly one of these ----------
export const PURPOSES = [
  "interview_turn",
  "resume_summary",
  "extraction",
  "clustering",
  "spec_turn",
  "spec_generation",
  "transcription",
  "file_ingest",
  "vision_ingest",
] as const;
export const PurposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof PurposeSchema>;

// ---------- Providers ----------
export const PROVIDER_KINDS = ["anthropic", "openai", "openrouter", "litellm", "openai_compatible"] as const;
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
  // USD per million tokens, when the provider publishes prices
  inputPerMtok: z.number().nonnegative().optional(),
  cachedInputPerMtok: z.number().nonnegative().optional(),
  outputPerMtok: z.number().nonnegative().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const RouteSchema = z.object({
  companyId: z.string().nullable(), // null = platform default
  purpose: PurposeSchema,
  providerId: z.string(),
  model: z.string(),
  effort: EffortSchema.optional(),
  maxOutputTokens: z.number().int().positive(),
  batchAllowed: z.boolean().default(false),
});
export type Route = z.infer<typeof RouteSchema>;

// ---------- Chat contract (modality-agnostic) ----------
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
  // Mark the system prompt as a stable, cacheable prefix on providers that support it.
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
export const emptyUsage = (): Usage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

export const StopReasonSchema = z.enum(["end_turn", "max_tokens", "refusal", "other"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "done"; usage: Usage; stopReason: StopReason; model: string };

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

// ---------- Ledger and budgets ----------
export const CallStatusSchema = z.enum(["ok", "error", "refused", "budget_exceeded"]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

export const LedgerEntrySchema = z.object({
  companyId: z.string(),
  purpose: PurposeSchema,
  providerId: z.string(),
  model: z.string(),
  promptVersion: z.string().optional(),
  usage: UsageSchema,
  latencyMs: z.number().int().nonnegative(),
  status: CallStatusSchema,
  costCents: z.number().nonnegative(),
  ref: z.object({ type: z.string(), id: z.string() }).optional(),
  campaignId: z.string().optional(),
  interviewId: z.string().optional(),
  createdAt: z.date(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const BudgetScopeSchema = z.enum(["tenant", "campaign", "interview"]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetLimitSchema = z.object({
  scope: BudgetScopeSchema,
  scopeId: z.string(),
  limitCents: z.number().nonnegative(),
  period: z.enum(["month", "total"]),
});
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;

// ---------- Facts extracted from interviews (Workflow 1) ----------
export const TaskFactSchema = z.object({
  kind: z.literal("task"),
  name: z.string(),
  frequency: z.enum(["hourly", "daily", "weekly", "monthly", "rarely"]),
  minutesPerOccurrence: z.number().nonnegative(),
  tools: z.array(z.string()),
  painScore: z.number().int().min(0).max(10),
  quote: z.string().optional(),
});
export const PainPointFactSchema = z.object({
  kind: z.literal("pain_point"),
  description: z.string(),
  cause: z.string().optional(),
  affectedTask: z.string().optional(),
  severity: z.number().int().min(0).max(10),
  quote: z.string().optional(),
});
export const OpportunityFactSchema = z.object({
  kind: z.literal("opportunity"),
  title: z.string(),
  description: z.string(),
  automationType: z.enum(["ai_assist", "full_automation", "integration", "process_change", "other"]),
  relatedTasks: z.array(z.string()),
  estimatedMinutesSavedPerWeek: z.number().nonnegative().optional(),
  dataNeeded: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
export const FactSchema = z.discriminatedUnion("kind", [TaskFactSchema, PainPointFactSchema, OpportunityFactSchema]);
export type Fact = z.infer<typeof FactSchema>;
export const ExtractionResultSchema = z.object({ facts: z.array(FactSchema) });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
