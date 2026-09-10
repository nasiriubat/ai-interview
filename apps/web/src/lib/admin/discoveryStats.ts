import { SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import { z } from "zod";
import type { Stats } from "@/lib/api/schemas";

/*
 * `/stats` is not spelled out in the contract. The dashboard renders discovery tiles only
 * when it recognizes these shapes (README, contract gaps):
 *   stats.discovery.opportunitiesByClass: { ai: n, automation: n, ... }
 *   stats.discovery.topOpportunities: [{ id?, title, rankScore, solutionClass?, campaignId?, campaignName? }]
 * Both may also sit at the top level. Anything else falls through to the generic groups.
 */

const TopOpportunitySchema = z.looseObject({
  id: z.string().optional(),
  title: z.string(),
  rankScore: z.number(),
  solutionClass: z.string().optional(),
  campaignId: z.string().optional(),
  campaignName: z.string().optional(),
});
export type TopOpportunity = z.infer<typeof TopOpportunitySchema>;

const BY_CLASS_KEYS = ["opportunitiesByClass", "byClass", "bySolutionClass"] as const;
const TOP_KEYS = ["topOpportunities", "topByRank", "top"] as const;

export interface DiscoveryStats {
  byClass: Record<SolutionClass, number> | null;
  top: TopOpportunity[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (source[k] !== undefined) return source[k];
  return undefined;
}

function without(source: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => !keys.has(k)));
}

function parseByClass(raw: unknown): Record<SolutionClass, number> | null {
  if (!isRecord(raw)) return null;
  const out = Object.fromEntries(SOLUTION_CLASSES.map((c) => [c, 0])) as Record<SolutionClass, number>;
  let any = false;
  for (const c of SOLUTION_CLASSES) {
    const v = raw[c];
    if (typeof v === "number") {
      out[c] = v;
      any = true;
    }
  }
  return any ? out : null;
}

function parseTop(raw: unknown): TopOpportunity[] | null {
  const parsed = z.array(TopOpportunitySchema).safeParse(raw);
  if (!parsed.success || parsed.data.length === 0) return null;
  return [...parsed.data].sort((a, b) => b.rankScore - a.rankScore).slice(0, 5);
}

/**
 * Extracts the discovery tiles and returns the remaining stats so the generic renderer
 * does not show the same numbers twice.
 */
export function extractDiscoveryStats(stats: Stats): { discovery: DiscoveryStats | null; rest: Stats } {
  const group = isRecord(stats.discovery) ? stats.discovery : null;
  const sources = group ? [group, stats] : [stats];
  let byClass: Record<SolutionClass, number> | null = null;
  let top: TopOpportunity[] | null = null;
  for (const source of sources) {
    byClass ??= parseByClass(pick(source, BY_CLASS_KEYS));
    top ??= parseTop(pick(source, TOP_KEYS));
  }
  const consumed = new Set<string>([...(byClass ? BY_CLASS_KEYS : []), ...(top ? TOP_KEYS : [])]);
  const rest = without(stats, consumed);
  if (group) {
    const strippedGroup = without(group, consumed);
    if (Object.keys(strippedGroup).length > 0) rest.discovery = strippedGroup;
    else delete rest.discovery;
  }
  return { discovery: byClass || top ? { byClass, top } : null, rest };
}
