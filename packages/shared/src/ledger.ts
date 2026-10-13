import { z } from "zod";
import { UsageSchema } from "./chat.js";
import { PurposeSchema } from "./purposes.js";

export const CallStatusSchema = z.enum(["ok", "error", "refused", "budget_exceeded", "aborted"]);
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
  sessionId: z.string().optional(),
  createdAt: z.date(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const BudgetScopeSchema = z.enum(["tenant", "campaign", "session"]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetLimitSchema = z.object({
  scope: BudgetScopeSchema,
  scopeId: z.string(),
  limitCents: z.number().nonnegative(),
  period: z.enum(["month", "total"]),
});
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;
