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
  /**
   * Time from the request to the first piece of streamed output (NFR-01). Only for calls that
   * stream and produced output; the p95 of this column is the SLO the dashboards plot.
   */
  firstTokenMs: z.number().int().nonnegative().optional(),
  /**
   * True when the usage is our estimate rather than what the provider reported: an abandoned
   * stream (barge-in, disconnect) or a call that died before a final usage report (D-221). The
   * monthly statement shows the estimated share separately so an invoice can say how much of it
   * is not provider-confirmed.
   */
  estimated: z.boolean().optional(),
  /** `fallback` when the purpose's fallback route served the call because the primary was down (D-228). */
  routeTier: z.enum(["primary", "fallback"]).optional(),
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
