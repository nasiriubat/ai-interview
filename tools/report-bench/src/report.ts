/**
 * The report under test, in a shape the grader owns. The product's analysis payload is read
 * tolerantly (fields may be renamed or added while the analysis changes); anything missing becomes
 * null or empty and the grader says so instead of crashing.
 */
export interface BenchOpportunity {
  id: string;
  title: string;
  summary: string;
  solutionClass: string;
  rankScore: number | null;
  /** Distinct participants the report says are behind the item. */
  participants: number | null;
  roles: string[];
  departments: string[];
  quotes: string[];
  whyNotAi: string | null;
}

export interface BenchReport {
  /** Where it came from: an analysis id, a file path, a label. */
  source: string;
  markdown: string;
  /** The k-anonymity threshold in force, when known. */
  k: number | null;
  opportunities: BenchOpportunity[];
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Reads `GET /analyses/:id` (or a saved copy) into a BenchReport. */
export function fromAnalysisDetail(raw: unknown, source: string, k: number | null): BenchReport {
  const body = rec(raw);
  const report = rec(body.report);
  const opps = Array.isArray(body.opportunities) ? body.opportunities : [];
  return {
    source,
    markdown: s(report.markdown) || s(body.markdown),
    k,
    opportunities: opps.map((o, i) => {
      const r = rec(o);
      const stats = rec(r.stats);
      return {
        id: s(r.id) || `opp_${i + 1}`,
        title: s(r.title),
        summary: s(r.summary),
        solutionClass: s(r.solutionClass),
        rankScore: n(r.rankScore),
        participants: n(stats.participants) ?? n(r.participants),
        roles: strings(stats.roles),
        departments: strings(stats.departments),
        quotes: strings(stats.quotes),
        whyNotAi: s(r.whyNotAi) || null,
      };
    }),
  };
}

/** Accepts either a saved BenchReport or a raw analysis payload. */
export function readReport(raw: unknown, source: string, k: number | null): BenchReport {
  const r = rec(raw);
  if (typeof r.markdown === "string" && Array.isArray(r.opportunities) && "source" in r) {
    return raw as BenchReport;
  }
  return fromAnalysisDetail(raw, source, k);
}

/**
 * Report order: by rank score, highest first, the way the report ranks them; items without a score
 * keep their position after the scored ones.
 */
export function rankedOpportunities(report: BenchReport): BenchOpportunity[] {
  return report.opportunities
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const as = a.o.rankScore;
      const bs = b.o.rankScore;
      if (as !== null && bs !== null && as !== bs) return bs - as;
      if (as === null && bs !== null) return 1;
      if (bs === null && as !== null) return -1;
      return a.i - b.i;
    })
    .map((x) => x.o);
}
