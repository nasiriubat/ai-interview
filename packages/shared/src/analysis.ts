import { z } from "zod";

/** Spec 04. Solution class: where a cluster of work belongs; `none` is a first-class outcome (FR-16a). */
export const SOLUTION_CLASSES = ["ai", "automation", "software", "process", "none"] as const;
export const SolutionClassSchema = z.enum(SOLUTION_CLASSES);
export type SolutionClass = z.infer<typeof SolutionClassSchema>;

export const FACTOR_KEYS = [
  "expected_impact",
  "affected_employees",
  "frequency",
  "implementation_complexity",
  "data_availability",
  "risk",
  "ai_suitability",
] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

export const FactorSchema = z.object({ score: z.number().int().min(1).max(5), rationale: z.string().min(1) });
export const FactorsSchema = z.object(
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, FactorSchema])) as Record<FactorKey, typeof FactorSchema>,
);
export type Factors = z.infer<typeof FactorsSchema>;

export const WeightsSchema = z.object(
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, z.number().min(0).max(5)])) as Record<FactorKey, z.ZodNumber>,
);
export type Weights = z.infer<typeof WeightsSchema>;
export const WEIGHT_PRESETS: Record<"balanced" | "quick_wins" | "strategic", Weights> = {
  balanced: {
    expected_impact: 1,
    affected_employees: 1,
    frequency: 1,
    implementation_complexity: 1,
    data_availability: 1,
    risk: 1,
    ai_suitability: 1,
  },
  quick_wins: {
    expected_impact: 1,
    affected_employees: 1,
    frequency: 1.5,
    implementation_complexity: 2,
    data_availability: 1.5,
    risk: 1.5,
    ai_suitability: 0.5,
  },
  strategic: {
    expected_impact: 2,
    affected_employees: 2,
    frequency: 1,
    implementation_complexity: 0.5,
    data_availability: 1,
    risk: 1,
    ai_suitability: 1,
  },
};

/** Weighted mean on a 0..100 scale so ranks are comparable across weight presets. */
export function rankScore(factors: Factors, weights: Weights): number {
  let sum = 0;
  let total = 0;
  for (const k of FACTOR_KEYS) {
    sum += factors[k].score * weights[k];
    total += 5 * weights[k];
  }
  return total === 0 ? 0 : Math.round((sum / total) * 1000) / 10;
}

/** Output of the cluster naming pass: which fact ids belong together and what to call them. */
export const ClusterDraftSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(600),
  factIds: z.array(z.string()).min(1),
});
export const ClusteringResultSchema = z.object({ clusters: z.array(ClusterDraftSchema) });
export type ClusterDraft = z.infer<typeof ClusterDraftSchema>;

/**
 * Output of the merge pass (clustering prompt v2). The model sees draft clusters under short ids
 * and answers only with what it changes: groups of draft ids that are one thing, and names for
 * drafts worth naming. Nothing echoes a fact id, so the answer is a few tokens per merge however
 * many facts the campaign holds.
 */
export const ClusterMergeResultSchema = z.object({
  merges: z
    .array(
      z.object({
        ids: z.array(z.string()).min(2),
        name: z.string().min(1).max(120),
        summary: z.string().max(600).default(""),
      }),
    )
    .default([]),
  names: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(120),
        summary: z.string().max(600).default(""),
      }),
    )
    .default([]),
});
export type ClusterMergeResult = z.infer<typeof ClusterMergeResultSchema>;

/** Output of the opportunity pass for one cluster. */
export const OpportunityDraftSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(1200),
  solutionClass: SolutionClassSchema,
  rationale: z.string().min(1).max(1200),
  factors: FactorsSchema,
  dataNeeded: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  whyNotAi: z.string().max(600).optional(), // required by prompt when solutionClass is process or none
});
export type OpportunityDraft = z.infer<typeof OpportunityDraftSchema>;

export const ClusterStatsSchema = z.object({
  participants: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  roles: z.array(z.string()).default([]),
  departments: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  minutesPerWeekTotal: z.number().nonnegative().default(0),
  quotes: z.array(z.string()).default([]), // present only when participants >= k
});
export type ClusterStats = z.infer<typeof ClusterStatsSchema>;

export const OpportunityStatusSchema = z.enum(["new", "shortlisted", "promoted", "dismissed"]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

/** What an admin may change about a generated opportunity; kept across re-runs by cluster key. */
export const OpportunityOverrideSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  solutionClass: SolutionClassSchema.optional(),
  factors: FactorsSchema.partial().optional(),
  note: z.string().max(1000).optional(),
});
export type OpportunityOverride = z.infer<typeof OpportunityOverrideSchema>;

export const REPORT_SECTIONS = [
  "executive_summary",
  "participation",
  "work_map",
  "opportunities",
  "quick_wins_vs_strategic",
  "not_ai",
  "next_steps",
] as const;
export const ReportSectionSchema = z.enum(REPORT_SECTIONS);
export type ReportSection = z.infer<typeof ReportSectionSchema>;

/** The typed hand-off from a discovered opportunity into a requirements session (FR-66). */
export const HandoffSchema = z.object({
  sourceOpportunityId: z.string(),
  problem: z.string(),
  affectedUsers: z.array(z.string()),
  existingProcess: z.array(z.string()),
  tools: z.array(z.string()),
  constraints: z.string(),
  expectedBenefit: z.string(),
  evidenceQuotes: z.array(z.string()),
});
export type Handoff = z.infer<typeof HandoffSchema>;
