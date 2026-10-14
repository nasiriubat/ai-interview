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
export const OPPORTUNITY_TEXT_MAX = 1200;
/**
 * What the model may write is wider than what is stored: a rationale of 1,300 characters failed the
 * whole cluster's opportunity in a live run (D-304). The pipeline clamps to OPPORTUNITY_TEXT_MAX at
 * a word boundary instead of losing the cluster.
 */
const OPPORTUNITY_TEXT_ACCEPTED = 4000;
export const OpportunityDraftSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(OPPORTUNITY_TEXT_ACCEPTED),
  solutionClass: SolutionClassSchema,
  rationale: z.string().min(1).max(OPPORTUNITY_TEXT_ACCEPTED),
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

/**
 * Where AI is not the answer (FR-16a): a cluster whose best response is a change of process, or no
 * change at all. The report section, the results section and the dashboard tile all use this one
 * predicate so the three can never disagree (blueprint section 0 item 8).
 */
export const NOT_AI_CLASSES = ["process", "none"] as const satisfies readonly SolutionClass[];
export function isNotAi(solutionClass: string): boolean {
  return (NOT_AI_CLASSES as readonly string[]).includes(solutionClass);
}

/**
 * What an admin may change about a generated opportunity. Anchored to the opportunity's evidence
 * fact ids and re-attached by overlap on a later run, so it survives re-clustering (D-151).
 * Renaming is a title (and optional summary) override.
 */
export const OpportunityOverrideSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(1200).optional(),
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
  "department_comparison",
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

/** Most opportunities one merge may combine; more than this is a different decision (D-201). */
export const MAX_MERGE = 6;
/** A split makes two or three parts, never more (D-201). */
export const MAX_SPLIT_PARTS = 3;

/** `POST /analyses/:id/opportunities/merge` */
export const MergeBodySchema = z.object({
  opportunityIds: z.array(z.string().min(1)).min(2).max(MAX_MERGE),
  /** Title of the merged opportunity; defaults to the larger one's. */
  title: z.string().trim().min(1).max(160).optional(),
});
export type MergeBody = z.infer<typeof MergeBodySchema>;

/** `POST /opportunities/:id/split`: a partition of the cluster's fact ids into two or three parts. */
export const SplitBodySchema = z.object({
  parts: z
    .array(z.array(z.string().min(1)).min(1))
    .min(2)
    .max(MAX_SPLIT_PARTS),
});
export type SplitBody = z.infer<typeof SplitBodySchema>;

/** What a stored cluster edit holds. Rename is an override, not an edit. */
export const ClusterEditPayloadSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("merge"),
    /** The member fact ids of each cluster that was merged, as they were when the admin merged. */
    anchors: z.array(z.array(z.string()).min(1)).min(2),
    title: z.string().max(160).optional(),
  }),
  z.object({
    op: z.literal("split"),
    /** All facts of the cluster that was split. */
    source: z.array(z.string()).min(2),
    parts: z.array(z.array(z.string()).min(1)).min(2).max(MAX_SPLIT_PARTS),
  }),
]);
export type ClusterEditPayload = z.infer<typeof ClusterEditPayloadSchema>;

/** The split dialog's starting point: the cluster's facts as text, grouped by similarity. */
export const SplitProposalSchema = z.object({
  facts: z.array(z.object({ id: z.string(), text: z.string(), part: z.number().int().min(0).max(2) })),
  parts: z.number().int().min(2).max(MAX_SPLIT_PARTS),
});
export type SplitProposal = z.infer<typeof SplitProposalSchema>;

/**
 * Department comparison (FR-17). A department appears only when at least k participants stand
 * behind it; smaller ones are pooled into "Other" when the pool itself reaches k, and are
 * otherwise left out without a name or a number.
 */
export const DEPARTMENT_NOT_SHOWN_REASONS = [
  "disabled",
  "no_departments",
  "too_few_eligible",
  "rerun_required",
] as const;
export const DepartmentRowSchema = z.object({
  /** Display name; null for the pool and for the people who gave none. */
  name: z.string().nullable(),
  /** `other` is the pool of departments below k, `unspecified` those who gave none. */
  kind: z.enum(["department", "other", "unspecified"]),
  participants: z.number().int().nonnegative(),
  facts: z.number().int().nonnegative(),
  minutesPerWeek: z.number().nonnegative(),
  /** Opportunities at least k of the department's people described, most shared first. */
  topOpportunities: z.array(
    z.object({
      clusterKey: z.string(),
      title: z.string(),
      /** Share of this department's participants who described it, 0..1. */
      share: z.number().min(0).max(1),
    }),
  ),
  /**
   * Share of this department's participants who described something of each solution class, 0..1.
   * A class is present only when at least k of them did; an absent class is withheld, not zero.
   */
  solutionClassShare: z.object(
    Object.fromEntries(SOLUTION_CLASSES.map((c) => [c, z.number().min(0).max(1).optional()])) as Record<
      SolutionClass,
      z.ZodOptional<z.ZodNumber>
    >,
  ),
});
export type DepartmentRow = z.infer<typeof DepartmentRowSchema>;
export const DepartmentComparisonSchema = z.object({
  shown: z.boolean(),
  k: z.number().int().positive(),
  reason: z.enum(DEPARTMENT_NOT_SHOWN_REASONS).optional(),
  departments: z.array(DepartmentRowSchema),
  /** Departments whose name is withheld, pooled or left out, because fewer than k people stand behind them. */
  belowK: z.number().int().nonnegative(),
});
export type DepartmentComparison = z.infer<typeof DepartmentComparisonSchema>;
