import { z } from "zod";
import { DecisionSchema, FindingSchema } from "./session.js";
import { PathSchema } from "./template.js";

/*
 * Requirements interview (spec 05, contract 18): findings, the live spec rendered from
 * state after each turn, the generated specification document, and the agent bundle.
 */

export const FINDING_TYPES = ["ambiguity", "contradiction", "missing_decision", "over_complexity"] as const;
export const FindingTypeSchema = z.enum(FINDING_TYPES);
export type FindingType = z.infer<typeof FindingTypeSchema>;

export const FINDING_STATUSES = ["open", "raised", "resolved", "accepted", "deferred"] as const;
export const FindingStatusSchema = z.enum(FINDING_STATUSES);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/** What the owner or the participant decides about a finding. `rejected` only exists inside a turn: it triggers one push-back. */
export const FindingOutcomeSchema = z.enum(["resolved", "accepted", "deferred"]);
export type FindingOutcome = z.infer<typeof FindingOutcomeSchema>;

/** What the issue-detection pass returns (no ids, no status: the engine assigns them). */
export const DetectedFindingSchema = FindingSchema.pick({
  type: true,
  section: true,
  path: true,
  description: true,
  resolution: true,
  default: true,
  confidence: true,
});
export type DetectedFinding = z.infer<typeof DetectedFindingSchema>;
/** Lenient like ExtractionResultSchema: a bare array is accepted and malformed findings are dropped. */
export const IssueDetectionResultSchema = z.preprocess(
  (raw) => {
    const list = Array.isArray(raw) ? raw : (raw as { findings?: unknown } | null)?.findings;
    if (!Array.isArray(list)) return raw;
    return { findings: list.filter((f) => DetectedFindingSchema.safeParse(f).success) };
  },
  z.object({ findings: z.array(DetectedFindingSchema) }),
);

export const AGGRESSIVENESS = ["gentle", "standard", "strict"] as const;
export const AggressivenessSchema = z.enum(AGGRESSIVENESS);
export type Aggressiveness = z.infer<typeof AggressivenessSchema>;

// ---------- Specification sections ----------

export const SPEC_SECTION_KEYS = [
  "overview",
  "users",
  "stories",
  "functional",
  "rules",
  "technical",
  "data",
  "integrations",
  "security",
  "nfr",
  "admin",
  "mvp",
  "future",
  "phases",
  "open_questions",
  "diagrams",
] as const;
export const SpecSectionKeySchema = z.enum(SPEC_SECTION_KEYS);
export type SpecSectionKey = z.infer<typeof SpecSectionKeySchema>;

export const SPEC_SECTION_TITLES: Record<SpecSectionKey, string> = {
  overview: "Product overview and problem",
  users: "Target users and roles",
  stories: "User stories",
  functional: "Functional requirements",
  rules: "Business rules",
  technical: "Technical requirements",
  data: "Data requirements",
  integrations: "Integrations",
  security: "Security and privacy",
  nfr: "Non-functional requirements",
  admin: "Administrative surface",
  mvp: "MVP scope",
  future: "Future scope",
  phases: "Implementation phases",
  open_questions: "Open questions",
  diagrams: "Diagrams",
};

/** Sections where a finding counts as technical (held to the gentle rule on the nontechnical path). */
export const TECHNICAL_SECTIONS: ReadonlySet<string> = new Set([
  "technical",
  "data",
  "integrations",
  "security",
  "nfr",
]);

/** Coverage-area keys and free-form section names the model may use, mapped to canonical sections. */
const SECTION_ALIASES: Record<string, SpecSectionKey> = {
  problem: "overview",
  product: "overview",
  product_overview: "overview",
  overview: "overview",
  users: "users",
  roles: "users",
  target_users: "users",
  stories: "stories",
  user_stories: "stories",
  functional: "functional",
  requirements: "functional",
  functional_requirements: "functional",
  acceptance: "functional",
  acceptance_criteria: "functional",
  rules: "rules",
  business_rules: "rules",
  technical: "technical",
  technical_recommended: "technical",
  architecture: "technical",
  data: "data",
  data_model: "data",
  integrations: "integrations",
  security: "security",
  privacy: "security",
  security_privacy: "security",
  nfr: "nfr",
  non_functional: "nfr",
  nonfunctional: "nfr",
  admin: "admin",
  administrative: "admin",
  mvp: "mvp",
  mvp_scope: "mvp",
  future: "future",
  future_scope: "future",
  phases: "phases",
  implementation: "phases",
  implementation_phases: "phases",
  open_questions: "open_questions",
  questions: "open_questions",
  diagrams: "diagrams",
  context: "overview",
};

export function normalizeSectionKey(raw: string): SpecSectionKey | undefined {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return SECTION_ALIASES[key];
}

export const DIAGRAM_TYPES = ["context", "containers", "sequence", "state", "entity"] as const;
export const DiagramTypeSchema = z.enum(DIAGRAM_TYPES);
export type DiagramType = z.infer<typeof DiagramTypeSchema>;

// ---------- Live spec (rendered from state after each turn) ----------

export const SpecFieldSourceSchema = z.enum(["user", "default_accepted", "recommended", "handoff"]);

export const LiveFieldSchema = z.object({
  path: z.string(),
  value: z.unknown(),
  source: SpecFieldSourceSchema,
});
export type LiveField = z.infer<typeof LiveFieldSchema>;

export const LiveSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum(["empty", "draft", "edited"]),
  markdown: z.string(),
  fields: z.array(LiveFieldSchema),
});
export type LiveSection = z.infer<typeof LiveSectionSchema>;

export const MvpChallengeStateSchema = z.object({
  started: z.boolean().default(false),
  done: z.boolean().default(false),
  asked: z.array(z.string()).default([]),
});
export type MvpChallengeState = z.infer<typeof MvpChallengeStateSchema>;

/**
 * What the owner is told about the MVP challenge (D-322). The stored state only says whether the
 * walk started and finished; whether it is still to come, was switched off for this interview, or
 * was passed over because the interview ended first is a different fact, and "Not started" for all
 * three was untrue for the last two.
 */
export const MVP_OUTCOMES = ["off", "pending", "in_progress", "done", "skipped"] as const;
export const MvpOutcomeSchema = z.enum(MVP_OUTCOMES);
export type MvpOutcome = z.infer<typeof MvpOutcomeSchema>;
/** Why a challenge that was meant to run did not finish: the owner finished, or the turn limit came. */
export const MvpEndedBySchema = z.enum(["finish", "turn_limit"]);
export type MvpEndedBy = z.infer<typeof MvpEndedBySchema>;

export const LiveMvpChallengeSchema = MvpChallengeStateSchema.extend({
  outcome: MvpOutcomeSchema.default("pending"),
  endedBy: MvpEndedBySchema.optional(),
});
export type LiveMvpChallenge = z.infer<typeof LiveMvpChallengeSchema>;

/** A diagram as the owner sees it in the live spec: generated, edited over a generated one, or added. */
export const LiveDiagramSchema = z.object({
  key: z.string(),
  title: z.string(),
  type: DiagramTypeSchema,
  mermaid: z.string(),
  description: z.string(),
  status: z.enum(["generated", "edited", "added"]),
  /** False when the renderer was unreachable the last time the source was saved. */
  verified: z.boolean(),
  /** What the generator drew, when the owner has replaced it. */
  original: z.string().optional(),
});
export type LiveDiagram = z.infer<typeof LiveDiagramSchema>;

export const LiveSpecSchema = z.object({
  title: z.string(),
  path: PathSchema.nullable(),
  context: z.record(z.string(), z.string()),
  sections: z.array(LiveSectionSchema),
  /** Editable diagrams (FR-23): the newest version's, with the owner's edits and additions applied. */
  diagrams: z.array(LiveDiagramSchema).default([]),
  findings: z.array(FindingSchema),
  decisions: z.array(DecisionSchema),
  mvpChallenge: LiveMvpChallengeSchema.prefault({}),
  stats: z.object({
    fields: z.number().int().nonnegative(),
    sectionsWithContent: z.number().int().nonnegative(),
    openFindings: z.number().int().nonnegative(),
  }),
});
export type LiveSpec = z.infer<typeof LiveSpecSchema>;

/** Owner edits by section key. Authoritative over generated content (FR-23). */
export const SpecEditSchema = z.object({
  markdown: z.string(),
  editedAt: z.string(),
  editedBy: z.string().nullable().default(null),
  /**
   * Diagram edits live under the key `diagram:<key>` (FR-23) in the same column, so no migration:
   * the Mermaid source goes in `mermaid`, `markdown` stays empty (which every section reader treats
   * as "no edit"), and `description` is the caption and the alt text.
   */
  mermaid: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  type: DiagramTypeSchema.optional(),
  /** When the diagram renderer last accepted this source; absent means it was never verified. */
  validatedAt: z.string().nullable().optional(),
});
export const SpecEditsSchema = z.record(z.string(), SpecEditSchema);
export type SpecEdits = z.infer<typeof SpecEditsSchema>;

// ---------- Generated specification document ----------

export const SpecRequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  scope: z.enum(["mvp", "future"]).default("mvp"),
  acceptance: z.array(z.string()).default([]),
  reason: z.string().optional(),
  tracedTo: z.string().optional(),
  /** The participant's own words this requirement rests on (D-240); absent when none was recorded. */
  evidence: z.string().optional(),
  /** True when no verified quote of the participant backs it: the owner is asked to confirm (D-243). */
  needsConfirmation: z.boolean().optional(),
  /** Ids of the near-duplicate requirements folded into this one (D-241). */
  mergedFrom: z.array(z.string()).optional(),
});
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

export const SpecPhaseSchema = z.object({
  key: z.string(),
  name: z.string(),
  goals: z.array(z.string()).default([]),
  tasks: z.array(z.object({ title: z.string(), acceptance: z.array(z.string()).default([]) })).default([]),
  dependencies: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
});
export type SpecPhase = z.infer<typeof SpecPhaseSchema>;

export const SpecDiagramSchema = z.object({
  key: z.string(),
  title: z.string(),
  type: DiagramTypeSchema,
  mermaid: z.string(),
  /** Caption and alt text (FR-23); empty for diagrams the model drew. */
  description: z.string().optional(),
  /** Where the source came from: the generator, or the owner (an edit, or a diagram they added). */
  source: z.enum(["generated", "edited", "added"]).optional(),
  /** What the generator drew, kept when the owner's edit replaced it, so a reset shows the original. */
  original: z.string().optional(),
});
export type SpecDiagram = z.infer<typeof SpecDiagramSchema>;

export const SpecDocumentSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  markdown: z.string(),
  source: z.enum(["generated", "edited", "fallback"]),
  /**
   * Fingerprint of what the section was written from (the live spec's facts and the owner's edit for
   * it). The model rewords a section every time it is regenerated, so the version diff compares
   * this, not the prose: an unchanged basis is an unchanged section (live run bug 6).
   */
  basis: z.string().optional(),
});

export const SpecDocumentSchema = z.object({
  title: z.string(),
  language: z.string().default("en"),
  path: PathSchema.nullable().default(null),
  generatedAt: z.string(),
  context: z.record(z.string(), z.string()).default({}),
  sections: z.array(SpecDocumentSectionSchema),
  requirements: z.array(SpecRequirementSchema).default([]),
  phases: z.array(SpecPhaseSchema).default([]),
  openQuestions: z.array(z.object({ question: z.string(), defaultTaken: z.string() })).default([]),
  mvp: z
    .object({
      in: z.array(z.string()).default([]),
      movedOut: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
      next: z.array(z.string()).default([]),
    })
    .prefault({}),
  diagrams: z.array(SpecDiagramSchema).default([]),
});
export type SpecDocument = z.infer<typeof SpecDocumentSchema>;

export const BUNDLE_FORMATS = ["claude_code", "codex", "generic"] as const;
export const BundleFormatSchema = z.enum(BUNDLE_FORMATS);
export type BundleFormat = z.infer<typeof BundleFormatSchema>;

export const AgentBundleSchema = z.object({
  format: BundleFormatSchema,
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type AgentBundle = z.infer<typeof AgentBundleSchema>;

export const SpecVersionStatusSchema = z.enum(["queued", "running", "done", "failed"]);

export const SpecVersionStatsSchema = z.object({
  sections: z.number().int().nonnegative().default(0),
  requirements: z.number().int().nonnegative().default(0),
  mvp: z.number().int().nonnegative().default(0),
  future: z.number().int().nonnegative().default(0),
  phases: z.number().int().nonnegative().default(0),
  openFindings: z.number().int().nonnegative().default(0),
  promptVersions: z.array(z.string()).default([]),
  generated: z.enum(["model", "fallback"]).optional(),
});
export type SpecVersionStats = z.infer<typeof SpecVersionStatsSchema>;

// ---------- Diff between two versions ----------

export const DiffLineSchema = z.object({
  type: z.enum(["same", "add", "del"]),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const SpecDiffSchema = z.object({
  sections: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      change: z.enum(["added", "removed", "changed"]),
      lines: z.array(DiffLineSchema),
    }),
  ),
  requirements: z.object({
    added: z.array(SpecRequirementSchema),
    removed: z.array(SpecRequirementSchema),
    changed: z.array(z.object({ before: SpecRequirementSchema, after: SpecRequirementSchema })),
  }),
});
export type SpecDiff = z.infer<typeof SpecDiffSchema>;

// ---------- External invitations to a requirements session ----------

export const SessionInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(["sent", "opened", "revoked"]),
  sentAt: z.string(),
  openedAt: z.string().optional(),
  expiresAt: z.string(),
});
export type SessionInvitation = z.infer<typeof SessionInvitationSchema>;
