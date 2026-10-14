import type { BudgetCheck, CallContext } from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BudgetAlerts, formatCents } from "../src/alerts/budget-alerts.js";
import type { Alert } from "../src/alerts/port.js";

/*
 * D-323. A budget notice said "EUR 166.00" of an amount that was in whatever unit the price table
 * was entered in, which is US dollars. The unit now comes from the tenant's `branding.currency`.
 */

function rig(currencyOf?: (companyId: string) => Promise<string>): {
  alerts: BudgetAlerts;
  raised: Alert[];
} {
  const raised: Alert[] = [];
  const alerts = new BudgetAlerts({
    // describe() reaches for the database inside a try; a failure there falls back to a plain label.
    db: {} as PrismaClient,
    alerts: {
      raise: (a: Alert) => {
        raised.push(a);
        return Promise.resolve({ delivered: true });
      },
      resolve: () => Promise.resolve(),
    } as never,
    publicWebUrl: "https://app.example",
    ...(currencyOf ? { currencyOf } : {}),
  });
  return { alerts, raised };
}

const exhausted = {
  allowed: false,
  warnings: [],
  blockedBy: {
    scope: "tenant",
    scopeId: "t1",
    period: "month",
    spentCents: 16_600,
    limitCents: 16_600,
  },
} as unknown as BudgetCheck;
const ctx = { companyId: "t1" } as CallContext;

describe("budget notices name the currency of the figures", () => {
  it("formats cents with the code it is given, and USD otherwise", () => {
    expect(formatCents(16_600)).toBe("USD 166.00");
    expect(formatCents(16_600, "EUR")).toBe("EUR 166.00");
  });

  it("uses the tenant's branding.currency in the message", async () => {
    const { alerts, raised } = rig(() => Promise.resolve("SEK"));
    await alerts.exceeded(ctx, exhausted);
    expect(raised[0]?.message).toContain("SEK 166.00 of SEK 166.00");
    expect(raised[0]?.message).not.toContain("EUR");
  });

  it("says USD, the unit the shipped prices are in, when no currency is known", async () => {
    const { alerts, raised } = rig();
    await alerts.exceeded(ctx, exhausted);
    expect(raised[0]?.message).toContain("USD 166.00");
  });

  it("does not lose the alert when the currency lookup fails", async () => {
    const { alerts, raised } = rig(() => Promise.reject(new Error("settings down")));
    await alerts.exceeded(ctx, exhausted);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.message).toContain("USD 166.00");
  });
});
