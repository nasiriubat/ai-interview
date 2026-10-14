import { FactSchema } from "@aidp/shared";
import { z } from "zod";

/**
 * The fixture format of the deterministic eval tier (engineering plan 3.2, D-192).
 *
 * A fixture is a 60-turn participant script with gold labels. Labels say which requirement or fact
 * each turn introduces, so a metric can compare what the engine recorded with what was said. The
 * model side is scripted from the same labels, with deterministic flaws (a missing marker, a
 * requirement filed under rules, ...) injected at named turns: the replay then measures how much of
 * what was said survives the engine's contract, validation and repair, and a regression in that
 * code moves a committed number.
 */

export const PERSONAS = [
  "cooperative",
  "terse",
  "off_topic",
  "contradictory",
  "technical",
  "nontechnical",
] as const;
export const PersonaSchema = z.enum(PERSONAS);
export type Persona = z.infer<typeof PersonaSchema>;

export const FLAWS = [
  "marker_missing",
  "malformed_json",
  "truncated",
  "wrong_section",
  "descriptive_id",
  "rules_flood",
  "no_capture",
  /** The same capability filed again under another id and a reworded title (D-241). */
  "duplicate_capture",
  /** A screen detail (a button label) filed as its own requirement (D-242). */
  "detail_as_fr",
  /** A decision filed as a functional requirement (D-242). */
  "decision_as_fr",
] as const;
export const FlawSchema = z.enum(FLAWS);
export type Flaw = z.infer<typeof FlawSchema>;

export const GoldRequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Words a recorded requirement's title must contain (all, case-insensitive) to count as this one. */
  terms: z.array(z.string()).min(1),
  scope: z.enum(["mvp", "future"]),
  acceptance: z.array(z.string()).default([]),
  introducedAtTurn: z.number().int().positive(),
  /** A later turn that moves the requirement to another scope (a contradiction the owner settles). */
  rescopedAtTurn: z.number().int().positive().optional(),
  finalScope: z.enum(["mvp", "future"]).optional(),
});
export type GoldRequirement = z.infer<typeof GoldRequirementSchema>;

export const GoldFactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  /** Words that must appear in the fact (or in the summary and recent window) for it to be recalled. */
  terms: z.array(z.string()).min(1),
  introducedAtTurn: z.number().int().positive(),
  mustSurviveSummary: z.boolean().default(true),
  /** What a faithful extractor returns for the turn that introduces it. */
  fact: FactSchema,
});
export type GoldFact = z.infer<typeof GoldFactSchema>;

export const GoldFindingSchema = z.object({
  id: z.string(),
  type: z.enum(["ambiguity", "contradiction", "missing_decision", "over_complexity"]),
  section: z.string(),
  turns: z.array(z.number().int().positive()).default([]),
});
export type GoldFinding = z.infer<typeof GoldFindingSchema>;

export const FixtureTurnSchema = z.object({
  n: z.number().int().positive(),
  text: z.string().min(1),
  labels: z
    .object({
      requirements: z.array(z.string()).default([]),
      facts: z.array(z.string()).default([]),
      rescopes: z.array(z.string()).default([]),
      offTopic: z.boolean().default(false),
      /** Section keys other than functional this answer informs (a plain note each). */
      sections: z.array(z.string()).default([]),
    })
    .prefault({}),
});
export type FixtureTurn = z.infer<typeof FixtureTurnSchema>;

export const FixtureSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  templateKey: z.enum(["requirements_discovery", "opportunity_discovery"]),
  persona: PersonaSchema,
  locale: z.string().default("en"),
  path: z.enum(["technical", "nontechnical"]).optional(),
  turns: z.array(FixtureTurnSchema).length(60),
  goldRequirements: z.array(GoldRequirementSchema).default([]),
  goldFacts: z.array(GoldFactSchema).default([]),
  goldFindings: z.array(GoldFindingSchema).default([]),
  modelBehavior: z
    .object({
      /** Turn n (the answer being processed) -> how the interviewer's reply is broken. */
      flaws: z.record(z.string(), FlawSchema).default({}),
      /** What each issue-detection pass returns, in order; later passes return nothing. */
      scans: z.array(z.array(z.unknown())).default([]),
    })
    .prefault({}),
  expect: z.object({
    /** After turn `afterTurn`, at least `covered` areas must be covered. */
    coverage: z.array(z.object({ afterTurn: z.number().int().positive(), covered: z.number().int() })),
    endedWithin: z.number().int().positive(),
  }),
});
export type Fixture = z.infer<typeof FixtureSchema>;
