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
export const IssueDetectionResultSchema = z.object({ findings: z.array(DetectedFindingSchema) });

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

export const LiveSpecSchema = z.object({
  title: z.string(),
  path: PathSchema.nullable(),
  context: z.record(z.string(), z.string()),
  sections: z.array(LiveSectionSchema),
  findings: z.array(FindingSchema),
  decisions: z.array(DecisionSchema),
  mvpChallenge: MvpChallengeStateSchema,
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
});
export type SpecDiagram = z.infer<typeof SpecDiagramSchema>;

export const SpecDocumentSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  markdown: z.string(),
  source: z.enum(["generated", "edited", "fallback"]),
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
