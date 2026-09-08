import type { BudgetScope, LedgerEntry } from "@aidp/shared";

export interface LedgerSink {
  record(entry: LedgerEntry): Promise<void>;
}

export interface SpendSource {
  /** Spend in cents within the scope, over the calendar month of `at` (period month) or all time (period total). */
  spentCents(scope: BudgetScope, scopeId: string, period: "month" | "total", at: Date): Promise<number>;
}

/** In-memory ledger used by tests, evals and local dev. The database ledger implements the same two interfaces. */
export class InMemoryLedger implements LedgerSink, SpendSource {
  readonly entries: LedgerEntry[] = [];

  async record(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  async spentCents(scope: BudgetScope, scopeId: string, period: "month" | "total", at: Date): Promise<number> {
    return this.entries
      .filter((e) => scopeIdOf(e, scope) === scopeId)
      .filter((e) => period === "total" || sameMonth(e.createdAt, at))
      .reduce((sum, e) => sum + e.costCents, 0);
  }

  totalsByPurpose(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.purpose] = (out[e.purpose] ?? 0) + e.costCents;
    return out;
  }
}

export function scopeIdOf(e: LedgerEntry, scope: BudgetScope): string | undefined {
  if (scope === "tenant") return e.companyId;
  if (scope === "campaign") return e.campaignId;
  return e.interviewId;
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}
