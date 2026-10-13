import type { BudgetLimit, BudgetScope } from "@aidp/shared";
import type { SpendSource } from "./ledger.js";

export interface BudgetLimitSource {
  limitsFor(scopes: { scope: BudgetScope; scopeId: string }[]): Promise<BudgetLimit[]>;
}

export interface BudgetCheck {
  allowed: boolean;
  /** The limit that blocked the call, when not allowed. */
  blockedBy?: BudgetLimit & { spentCents: number };
  /** Limits past the warning threshold (default 80 percent) after this call. */
  warnings: (BudgetLimit & { spentCents: number; fraction: number })[];
}

export interface BudgetGuardOptions {
  warnFraction?: number;
  now?: () => Date;
}

/**
 * Enforces tenant, campaign and session budgets before a model call.
 * Uses a conservative estimate for the pending call so a budget is never exceeded
 * by more than one call's worst case.
 */
export class BudgetGuard {
  private readonly warnFraction: number;
  private readonly now: () => Date;

  constructor(
    private readonly limits: BudgetLimitSource,
    private readonly spend: SpendSource,
    opts: BudgetGuardOptions = {},
  ) {
    this.warnFraction = opts.warnFraction ?? 0.8;
    this.now = opts.now ?? (() => new Date());
  }

  async check(
    ctx: { companyId: string; campaignId?: string; sessionId?: string },
    estimateCents: number,
  ): Promise<BudgetCheck> {
    const scopes: { scope: BudgetScope; scopeId: string }[] = [{ scope: "tenant", scopeId: ctx.companyId }];
    if (ctx.campaignId) scopes.push({ scope: "campaign", scopeId: ctx.campaignId });
    if (ctx.sessionId) scopes.push({ scope: "session", scopeId: ctx.sessionId });
    const limits = await this.limits.limitsFor(scopes);
    const at = this.now();
    const result: BudgetCheck = { allowed: true, warnings: [] };
    for (const limit of limits) {
      const spentCents = await this.spend.spentCents(limit.scope, limit.scopeId, limit.period, at);
      const projected = spentCents + estimateCents;
      if (projected > limit.limitCents) {
        result.allowed = false;
        result.blockedBy ??= { ...limit, spentCents };
        continue;
      }
      const fraction = limit.limitCents === 0 ? 1 : projected / limit.limitCents;
      if (fraction >= this.warnFraction) result.warnings.push({ ...limit, spentCents, fraction });
    }
    return result;
  }
}

/** Static limits, for tests and local dev. */
export class StaticBudgetLimits implements BudgetLimitSource {
  constructor(private readonly all: BudgetLimit[]) {}
  async limitsFor(scopes: { scope: BudgetScope; scopeId: string }[]): Promise<BudgetLimit[]> {
    return this.all.filter((l) => scopes.some((s) => s.scope === l.scope && s.scopeId === l.scopeId));
  }
}

export class BudgetExceededError extends Error {
  /**
   * Whether anyone was told that this budget is exhausted: set by the caller that raised the
   * alert, read by whatever renders the refusal to a participant. It starts false, so a message
   * built from it can never claim that someone was told when nobody was.
   */
  notified = false;

  constructor(public readonly check: BudgetCheck) {
    const b = check.blockedBy;
    super(
      b
        ? `Budget exceeded for ${b.scope} ${b.scopeId}: ${b.spentCents.toFixed(2)} of ${b.limitCents} cents used`
        : "Budget exceeded",
    );
    this.name = "BudgetExceededError";
  }
}
