import { z } from "zod";
import { SOLUTION_CLASSES, SolutionClassSchema, type SolutionClass } from "./analysis.js";

/**
 * Dashboard statistics (spec 07, blueprint feature 4). One schema per segment, so the page can
 * stream sections in and parse each with the contract the API serves.
 *
 * Anonymity: a figure derived from a small group is withheld rather than rounded. Where a value
 * can be withheld its field is nullable and a sibling `withheld` says why, so the page can say
 * "fewer than k" instead of showing a zero that would read as a fact.
 */

/** A gap between two messages longer than this counts as this much: the person left and came back. */
export const IDLE_CAP_SECONDS = 300;

export const StatsRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  campaignId: z.string().min(1).optional(),
});
export type StatsRange = z.infer<typeof StatsRangeSchema>;

const WithheldSchema = z.enum(["below_k"]);

export const StatsParticipationSchema = z.object({
  k: z.number().int().positive(),
  campaigns: z.object({ open: z.number().int(), total: z.number().int() }),
  /** Invited people, then those who gave consent, then those who finished. */
  funnel: z.object({
    invited: z.number().int(),
    opened: z.number().int(),
    started: z.number().int(),
    completed: z.number().int(),
  }),
  /** Idle-capped active time of finished interviews, in seconds (D-204). */
  medianActiveSeconds: z.number().nullable(),
  /** How many finished interviews the median is over. */
  medianSessions: z.number().int(),
  identified: z.object({
    identified: z.number().int().nullable(),
    anonymous: z.number().int().nullable(),
    /** Identified share of consented interviews, 0..1. */
    share: z.number().min(0).max(1).nullable(),
    withheld: WithheldSchema.optional(),
  }),
  reminders: z.object({ sent: z.number().int(), invitationsReminded: z.number().int() }),
  /** Where unfinished interviews stand: the area of the last question asked. */
  dropOff: z.object({
    areas: z.array(
      z.object({ areaKey: z.string(), name: z.string(), sessions: z.number().int().positive() }),
    ),
    /** Interviews in areas with fewer than k, pooled so no small group is named. */
    other: z.number().int().nonnegative(),
    unfinished: z.number().int().nonnegative(),
  }),
  withheld: WithheldSchema.optional(),
});
export type StatsParticipation = z.infer<typeof StatsParticipationSchema>;

export const TopOpportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  rankScore: z.number(),
  solutionClass: SolutionClassSchema,
  campaignId: z.string(),
  campaignName: z.string(),
  participants: z.number().int(),
});
export type TopOpportunity = z.infer<typeof TopOpportunitySchema>;

export const StatsDiscoverySchema = z.object({
  /** Opportunities in the newest finished analysis of each campaign, dismissed ones left out. */
  byClass: z.object(
    Object.fromEntries(SOLUTION_CLASSES.map((c) => [c, z.number().int()])) as Record<
      SolutionClass,
      z.ZodNumber
    >,
  ),
  /** Opportunities where AI is not the answer: the report's own predicate (FR-16a). */
  notAi: z.number().int(),
  top: z.array(TopOpportunitySchema),
  evidence: z.object({
    analyses: z.number().int(),
    opportunities: z.number().int(),
    facts: z.number().int(),
    participants: z.number().int(),
  }),
});
export type StatsDiscovery = z.infer<typeof StatsDiscoverySchema>;

export const StatsRequirementsSchema = z.object({
  projectsByStatus: z.record(z.string(), z.number().int()),
  /** Turns to a completed specification; sessions finished with a legacy sentinel are left out. */
  turnsToSpec: z.object({
    median: z.number().nullable(),
    mean: z.number().nullable(),
    sessions: z.number().int(),
  }),
  findings: z.object({
    raised: z.number().int(),
    resolved: z.number().int(),
    /** Resolved or accepted over raised, 0..1; null before any finding. */
    resolvedRatio: z.number().min(0).max(1).nullable(),
    byType: z.record(z.string(), z.number().int()),
  }),
  specVersions: z.number().int(),
});
export type StatsRequirements = z.infer<typeof StatsRequirementsSchema>;

export const LatencyRowSchema = z.object({
  purpose: z.string(),
  calls: z.number().int(),
  /** The whole call, from request to last byte. */
  fullMs: z.object({ p50: z.number(), p95: z.number() }),
  /** Not recorded by the ledger yet; present so the page and the contract do not change when it is. */
  firstTokenMs: z.object({ p50: z.number(), p95: z.number() }).nullable(),
});
export type LatencyRow = z.infer<typeof LatencyRowSchema>;

export const StatsAiSchema = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  calls: z.number().int(),
  latency: z.array(LatencyRowSchema),
  /** `error` is the provider failing, `refused` the model declining, `budgetExceeded` a pause. */
  outcomes: z.object({
    ok: z.number().int(),
    error: z.number().int(),
    refused: z.number().int(),
    budgetExceeded: z.number().int(),
    aborted: z.number().int(),
  }),
  errorRate: z.number().nullable(),
  refusalRate: z.number().nullable(),
  /** (error + refused + budgetExceeded) / calls; an abort is a cancel, not a failure. */
  failureRate: z.number().nullable(),
  cacheHitRate: z.number().nullable(),
  tokensPerInterview: z.number().nullable(),
  interviews: z.number().int(),
});
export type StatsAi = z.infer<typeof StatsAiSchema>;

export const StatsHealthSchema = z.object({
  queues: z.array(
    z.object({
      name: z.string(),
      queued: z.number().int(),
      active: z.number().int(),
      deadLettered: z.number().int(),
    }),
  ),
  depth: z.object({ queued: z.number().int(), active: z.number().int() }),
  /** Dead letters of this organization, most recent first, from the queue's own list. */
  failedJobs: z.number().int(),
  storage: z.object({
    bytes: z.number().int(),
    files: z.number().int(),
    byKind: z.record(z.string(), z.object({ bytes: z.number().int(), files: z.number().int() })),
    quotaBytes: z.number().int().nullable(),
  }),
});
export type StatsHealth = z.infer<typeof StatsHealthSchema>;
