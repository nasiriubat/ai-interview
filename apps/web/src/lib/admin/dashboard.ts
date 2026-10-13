import { z } from "zod";
import type { Stats } from "@/lib/api/schemas";

/*
 * The tenant `/stats` payload as apps/api/src/modules/stats/routes.ts builds it. Parsed rather
 * than rendered generically so the dashboard can say what a number means ("17.5 s", "0.2 %")
 * instead of printing `avgLatencyMs 17,482.887`. Every field is tolerant: a payload missing a
 * group yields nulls, and the page shows what it has.
 */
const Counts = z.record(z.string(), z.number()).catch({});

const TenantStatsSchema = z.looseObject({
  participation: z
    .looseObject({ campaigns: Counts, sessions: Counts, invited: z.number().catch(0) })
    .optional()
    .catch(undefined),
  ai: z
    .looseObject({
      month: z
        .looseObject({
          costCents: z.number().catch(0),
          calls: z.number().catch(0),
          inputTokens: z.number().catch(0),
          outputTokens: z.number().catch(0),
          cacheHitRate: z.number().catch(0),
          avgLatencyMs: z.number().catch(0),
          byStatus: Counts,
        })
        .optional()
        .catch(undefined),
      budget: z.looseObject({ limitCents: z.number(), period: z.string().optional() }).nullish().catch(null),
    })
    .optional()
    .catch(undefined),
});

export interface DashboardNumbers {
  campaigns: { open: number; total: number } | null;
  interviews: {
    invited: number;
    /** Everyone who got past the consent screen, in any later state. */
    started: number;
    active: number;
    completed: number;
    /** completed / started, 0..1; null before anyone started. */
    completionRate: number | null;
    byStatus: Record<string, number>;
  } | null;
  ai: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    avgLatencyMs: number;
    /** Calls that did not end `ok`, 0..1; null with no calls. */
    errorRate: number | null;
  } | null;
}

const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0);

export function dashboardNumbers(stats: Stats): DashboardNumbers {
  const parsed = TenantStatsSchema.safeParse(stats);
  const s = parsed.success ? parsed.data : {};
  const p = s.participation;
  const m = s.ai?.month;
  const sessions = p?.sessions ?? {};
  const started = sum(sessions) - (sessions.created ?? 0) - (sessions.deleted ?? 0);
  const completed = sessions.completed ?? 0;
  const failed = m ? sum(m.byStatus) - (m.byStatus.ok ?? 0) : 0;
  return {
    campaigns: p ? { open: p.campaigns.open ?? 0, total: sum(p.campaigns) } : null,
    interviews: p
      ? {
          invited: p.invited,
          started,
          active: sessions.active ?? 0,
          completed,
          completionRate: started > 0 ? completed / started : null,
          byStatus: sessions,
        }
      : null,
    ai: m
      ? {
          calls: m.calls,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cacheHitRate: m.cacheHitRate,
          avgLatencyMs: m.avgLatencyMs,
          errorRate: m.calls > 0 ? failed / m.calls : null,
        }
      : null,
  };
}

/** The last `days` calendar days (UTC) ending today, each with its spend, gaps filled with 0. */
export function dailySeries(
  rows: { key: string; costCents: number; calls: number }[],
  days: number,
  now: Date = new Date(),
): { day: string; costCents: number; calls: number }[] {
  const byDay = new Map(rows.map((r) => [r.key, r]));
  const out: { day: string; costCents: number; calls: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const day = d.toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, costCents: r?.costCents ?? 0, calls: r?.calls ?? 0 });
  }
  return out;
}
