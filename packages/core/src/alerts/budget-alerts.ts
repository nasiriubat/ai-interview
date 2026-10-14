import type { BudgetCheck, CallContext } from "@aidp/ai";
import { withTenant } from "@aidp/db";
import type { BudgetLimit, BudgetScope } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { AlertPort } from "./port.js";

type Limit = BudgetLimit & { spentCents: number };

/** `USD 166.00`: the ledger is in hundredths of the currency the price table is entered in (D-323). */
export function formatCents(cents: number, currency = "USD"): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

/** 80, 90: the tier a fraction falls in, so one condition has one key however many calls see it. */
export function warningTier(fraction: number): number {
  return Math.min(90, Math.max(10, Math.floor(fraction * 10) * 10));
}

const LOCAL_WARNING_TTL_MS = 10 * 60_000;
const LOCAL_EXCEEDED_TTL_MS = 60_000;

/**
 * Turns the two budget hooks of `ModelCaller` into alerts (D-90).
 *
 * A campaign past 80 percent sees this on every model call it makes, and a participant who keeps
 * pressing send on a paused interview sees the refusal each time. The router dedupes across
 * processes, in the database; the small per-process memory here only keeps those calls from
 * looking up the campaign's name and hitting the table to learn the same thing again.
 */
export class BudgetAlerts {
  private readonly seenWarnings = new Map<string, number>();
  private readonly seenExceeded = new Map<string, { at: number; notified: boolean }>();

  constructor(
    private readonly deps: {
      db: PrismaClient;
      alerts: AlertPort;
      publicWebUrl: string;
      /** The tenant's `branding.currency`; USD when absent. */
      currencyOf?: (companyId: string) => Promise<string>;
      now?: () => Date;
      log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Fire and forget: a warning must never slow the call that triggered it. */
  warn(ctx: CallContext, warnings: (Limit & { fraction: number })[]): void {
    for (const w of warnings) {
      const key = this.key("budget.warning", w, warningTier(w.fraction));
      const at = this.now().getTime();
      const seen = this.seenWarnings.get(key);
      if (seen !== undefined && at - seen < LOCAL_WARNING_TTL_MS) continue;
      this.seenWarnings.set(key, at);
      void this.raiseWarning(ctx, w, key).catch((err: unknown) => {
        this.deps.log?.warn("budget warning alert failed", { err: String(err) });
      });
    }
  }

  private async raiseWarning(ctx: CallContext, w: Limit & { fraction: number }, key: string): Promise<void> {
    const subject = await this.describe(ctx.companyId, w.scope, w.scopeId);
    const pct = Math.round(w.fraction * 100);
    const cur = await this.currency(ctx.companyId);
    await this.deps.alerts.raise({
      kind: "budget.warning",
      key,
      companyId: ctx.companyId,
      title: `Budget at ${pct}%: ${subject.label}`,
      message: `The budget for ${subject.label} is at ${pct}% (${formatCents(w.spentCents, cur)} of ${formatCents(w.limitCents, cur)}). Interviews continue; at 100% they pause.`,
      context: {
        scope: w.scope,
        scopeId: w.scopeId,
        spentCents: Math.round(w.spentCents),
        limitCents: w.limitCents,
        percent: pct,
      },
      links: [{ label: "Budgets", url: this.adminUrl("budgets") }],
    });
  }

  /** Awaited by the caller: the answer decides what the participant is told. */
  async exceeded(ctx: CallContext, check: BudgetCheck): Promise<{ notified: boolean }> {
    const blocked = check.blockedBy;
    if (!blocked) return { notified: false };
    const key = this.key("budget.exceeded", blocked);
    const at = this.now().getTime();
    const seen = this.seenExceeded.get(key);
    if (seen && at - seen.at < LOCAL_EXCEEDED_TTL_MS) return { notified: seen.notified };

    const subject = await this.describe(ctx.companyId, blocked.scope, blocked.scopeId);
    const cur = await this.currency(ctx.companyId);
    const result = await this.deps.alerts.raise({
      kind: "budget.exceeded",
      key,
      companyId: ctx.companyId,
      title: `Budget used up: ${subject.label}`,
      message: `The budget for ${subject.label} is used up (${formatCents(blocked.spentCents, cur)} of ${formatCents(blocked.limitCents, cur)}). Interviews under it are paused until the budget is raised${blocked.period === "month" ? " or the month rolls over" : ""}.`,
      context: {
        scope: blocked.scope,
        scopeId: blocked.scopeId,
        spentCents: Math.round(blocked.spentCents),
        limitCents: blocked.limitCents,
      },
      links: [{ label: "Budgets", url: this.adminUrl("budgets") }],
    });
    // Only a success is remembered. A failure must be tried again by the next refused call, since
    // the router has already given the claim back and the channel may have recovered.
    if (result.delivered) this.seenExceeded.set(key, { at, notified: true });
    return { notified: result.delivered };
  }

  private async currency(companyId: string): Promise<string> {
    try {
      return (await this.deps.currencyOf?.(companyId)) ?? "USD";
    } catch {
      return "USD";
    }
  }

  private key(
    kind: string,
    limit: { scope: BudgetScope; scopeId: string; period: string },
    tier?: number,
  ): string {
    const period = limit.period === "month" ? this.now().toISOString().slice(0, 7) : "total";
    return [kind, limit.scope, limit.scopeId, period, ...(tier === undefined ? [] : [String(tier)])].join(
      ":",
    );
  }

  /** A human label for the scope, looked up inside the tenant so row-level security applies. */
  private async describe(companyId: string, scope: BudgetScope, scopeId: string): Promise<{ label: string }> {
    try {
      return await withTenant(companyId, async () => {
        if (scope === "campaign") {
          const c = await this.deps.db.campaign.findFirst({
            where: { id: scopeId, companyId },
            select: { name: true },
          });
          if (c) return { label: `campaign "${c.name}"` };
        }
        if (scope === "tenant") {
          const t = await this.deps.db.company.findUnique({
            where: { id: companyId },
            select: { name: true },
          });
          if (t) return { label: `workspace "${t.name}"` };
        }
        return { label: scope === "session" ? "one interview" : `${scope} ${scopeId}` };
      });
    } catch {
      return { label: `${scope} ${scopeId}` };
    }
  }

  private adminUrl(path: string): string {
    return `${this.deps.publicWebUrl.replace(/\/+$/, "")}/admin/${path}`;
  }
}
