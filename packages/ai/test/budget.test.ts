import { describe, expect, it } from "vitest";
import { BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import type { LedgerEntry } from "@aidp/shared";

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  companyId: "c1",
  purpose: "interview_turn",
  providerId: "p",
  model: "m",
  usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  latencyMs: 1,
  status: "ok",
  costCents: 0,
  createdAt: new Date("2026-09-08T10:00:00Z"),
  ...over,
});

describe("BudgetGuard", () => {
  it("blocks when the estimate would push tenant spend over the monthly limit", async () => {
    const ledger = new InMemoryLedger();
    await ledger.record(entry({ costCents: 90 }));
    const guard = new BudgetGuard(new StaticBudgetLimits([{ scope: "tenant", scopeId: "c1", limitCents: 100, period: "month" }]), ledger, {
      now: () => new Date("2026-09-09T00:00:00Z"),
    });
    const res = await guard.check({ companyId: "c1" }, 20);
    expect(res.allowed).toBe(false);
    expect(res.blockedBy).toMatchObject({ scope: "tenant", spentCents: 90 });
  });

  it("ignores last month's spend for monthly limits", async () => {
    const ledger = new InMemoryLedger();
    await ledger.record(entry({ costCents: 90, createdAt: new Date("2026-08-31T23:00:00Z") }));
    const guard = new BudgetGuard(new StaticBudgetLimits([{ scope: "tenant", scopeId: "c1", limitCents: 100, period: "month" }]), ledger, {
      now: () => new Date("2026-09-09T00:00:00Z"),
    });
    expect((await guard.check({ companyId: "c1" }, 20)).allowed).toBe(true);
  });

  it("warns at 80 percent and checks campaign and interview scopes too", async () => {
    const ledger = new InMemoryLedger();
    await ledger.record(entry({ costCents: 70, campaignId: "camp", interviewId: "int" }));
    const guard = new BudgetGuard(
      new StaticBudgetLimits([
        { scope: "tenant", scopeId: "c1", limitCents: 10_000, period: "month" },
        { scope: "campaign", scopeId: "camp", limitCents: 100, period: "total" },
        { scope: "interview", scopeId: "int", limitCents: 75, period: "total" },
      ]),
      ledger,
      { now: () => new Date("2026-09-09T00:00:00Z") },
    );
    const res = await guard.check({ companyId: "c1", campaignId: "camp", interviewId: "int" }, 10);
    expect(res.allowed).toBe(false);
    expect(res.blockedBy?.scope).toBe("interview");
    expect(res.warnings.map((w) => w.scope)).toEqual(["campaign"]);
  });
});
