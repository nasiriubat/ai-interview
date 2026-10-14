import { z } from "zod";
import { FactSchema } from "./facts.js";
import { PathSchema } from "./template.js";
import { WidgetSchema } from "./widgets.js";

/** A finding raised by issue detection in a requirements session (spec 05, FR-21b). Lives in state. */
/**
 * What "the participant asked to finish" used to write into `turnCount`, so the engine's turn cap
 * was already reached and the next turn closed the interview.
 *
 * Legacy, read-only: nothing writes this any more: finishing sets `SessionState.finishRequested` (D-170).
 * It stays exported so `SessionStateSchema` can recognise a session stored before that change and
 * migrate it lazily (the flag is set, the sentinel is removed from `turnCount`).
 */
export const COMPLETION_REQUESTED_TURN_COUNT = 1_000_000;

/**
 * A control operation: something the participant did to the interview rather than something they
 * said (D-170). Carried in the turn request as `control`, applied by the engine as a state
 * operation and never stored as a message, so it cannot reach extraction, the summary or a
 * transcript as if it were an answer.
 *
 * - `skip_area`: stop asking about an area; the engine acknowledges it and moves on.
 * - `return_area`: come back to an area that was skipped (or any open one); asked next.
 * - `finish`: "I'm done". The next turn is the closing one.
 */
export const TurnControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("skip_area"), areaKey: z.string().min(1).max(120) }),
  z.object({ type: z.literal("return_area"), areaKey: z.string().min(1).max(120) }),
  z.object({ type: z.literal("finish") }),
]);
export type TurnControl = z.infer<typeof TurnControlSchema>;

/**
 * The resume recap, cached in state so a page refresh never calls the model again (D-172).
 * `upToSeq` is the last message sequence the recap was written for; it is regenerated only when
 * new turns have been added since.
 */
export const RecapCacheSchema = z.object({
  text: z.string(),
  upToSeq: z.number().int().nonnegative(),
  source: z.enum(["model", "fallback"]),
});
export type RecapCache = z.infer<typeof RecapCacheSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  type: z.enum(["ambiguity", "contradiction", "missing_decision", "over_complexity"]),
  section: z.string(),
  path: z.string().optional(),
  description: z.string(),
  resolution: z.string(),
  default: z.string(),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  status: z.enum(["open", "raised", "resolved", "accepted", "deferred"]).default("open"),
  pushedBack: z.boolean().default(false),
  raisedTurn: z.number().int().nonnegative().optional(),
  decidedTurn: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CoverageStatusSchema = z.enum(["untouched", "partial", "covered", "skipped"]);
export const CoverageEntrySchema = z.object({
  status: CoverageStatusSchema.default("untouched"),
  known: z.string().default(""),
  missing: z.string().default(""),
  followUpsUsed: z.number().int().nonnegative().default(0),
});

export const OpenThreadSchema = z.object({
  id: z.string(),
  areaKey: z.string(),
  topic: z.string(),
  priority: z.number().int().min(1).max(5),
  resolved: z.boolean().default(false),
});

export const ProfileSchema = z.object({
  role: z.string().optional(),
  seniority: z.string().optional(),
  department: z.string().optional(),
  path: PathSchema.optional(),
  technicalSignals: z.number().int().default(0), // positive = technical, negative = nontechnical
  prefersShortAnswers: z.boolean().default(false),
  minimalAnswerStreak: z.number().int().nonnegative().default(0),
  notes: z.string().default(""),
});

export const DecisionSchema = z.object({
  key: z.string(),
  question: z.string(),
  choice: z.string(),
  source: z.enum(["user", "default_accepted", "recommended"]),
});

/** Layer 2 of the context: the engine's memory. Small, structured, always present. */
const SessionStateObjectSchema = z.object({
  coverage: z.record(z.string(), CoverageEntrySchema).default({}),
  contextAnswers: z.record(z.string(), z.string()).default({}),
  /** How many times each context question has been asked; guards against a model that never records the answer. */
  contextAsks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  profile: ProfileSchema.prefault({}),
  openThreads: z.array(OpenThreadSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  facts: z.array(FactSchema).default([]),
  turnCount: z.number().int().nonnegative().default(0),
  lastWidgetTurn: z.number().int().nonnegative().default(0),
  summaryUpToSeq: z.number().int().nonnegative().default(0),
  lastExtractedSeq: z.number().int().nonnegative().default(0),
  lastAreaKey: z.string().optional(),
  closingAsked: z.boolean().default(false),
  /** The participant asked to finish: the next turn is the closing question (D-170). */
  finishRequested: z.boolean().default(false),
  /** An area the participant asked to come back to; `chooseFocus` consumes it once and clears it. */
  requestedAreaKey: z.string().optional(),
  /** The cached resume recap; never part of the transcript or the model's context (D-172). */
  recap: RecapCacheSchema.optional(),
  shortened: z.boolean().default(false),
  flaggedForAdmin: z.string().optional(),
  phase: z
    .enum(["path", "context", "areas", "findings", "mvp_challenge", "closing", "summary", "done"])
    .default("areas"),
  // Requirements sessions (spec 05): findings raised by issue detection, and the MVP challenge walk.
  findings: z.array(FindingSchema).default([]),
  lastIssueScanTurn: z.number().int().nonnegative().default(0),
  finalIssueScanDone: z.boolean().default(false),
  /** Times the completeness check sent the interview back for missing requirements (D-191). */
  completenessAsks: z.number().int().nonnegative().default(0),
  mvpChallenge: z
    .object({
      started: z.boolean().default(false),
      done: z.boolean().default(false),
      asked: z.array(z.string()).default([]),
    })
    .prefault({}),
});

/**
 * Layer 2 of the context (above), with one migration: a state stored while "I'm done" was a
 * `turnCount` sentinel is read as `finishRequested` with the counter brought back to the highest
 * turn number anything else recorded (the exact count of a legacy session is not recoverable from
 * the document alone).
 */
export const SessionStateSchema = SessionStateObjectSchema.transform((s) =>
  s.turnCount >= COMPLETION_REQUESTED_TURN_COUNT
    ? { ...s, finishRequested: true, turnCount: Math.max(s.lastWidgetTurn, s.lastIssueScanTurn) }
    : s,
);
export type SessionState = z.infer<typeof SessionStateObjectSchema>;

/** What the model may report about a raised finding. `rejected` triggers one push-back when the engine is confident. */
export const FindingOutcomeDeltaSchema = z.object({
  id: z.string(),
  outcome: z.enum(["resolved", "accepted", "deferred", "rejected"]),
  note: z.string().optional(),
});

/** What the model returns alongside the message. Applied by the engine, never trusted blindly. */
export const StateDeltaSchema = z.object({
  coverage: z
    .record(
      z.string(),
      z.object({
        status: CoverageStatusSchema.optional(),
        known: z.string().optional(),
        missing: z.string().optional(),
      }),
    )
    .default({}),
  contextAnswers: z.record(z.string(), z.string()).default({}),
  profile: ProfileSchema.partial().default({}),
  newThreads: z.array(OpenThreadSchema.omit({ id: true, resolved: true })).default([]),
  resolvedThreadIds: z.array(z.string()).default([]),
  decisions: z.array(DecisionSchema).default([]),
  facts: z.array(FactSchema).default([]),
  flagForAdmin: z.string().optional(),
  findingOutcomes: z.array(FindingOutcomeDeltaSchema).default([]),
  /** The user asked to stop the MVP challenge early (honored unless the challenge is mandatory). */
  endMvpChallenge: z.boolean().optional(),
});
export type StateDelta = z.infer<typeof StateDeltaSchema>;

/** The structured output of one interviewer turn. */
export const TurnObjectSchema = z.object({
  message: z.string().min(1),
  widget: WidgetSchema.optional(),
  voiceShortForm: z.string().max(300).optional(),
  areaKey: z.string().optional(),
  stateDelta: StateDeltaSchema.prefault({}),
  reason: z.string().max(300).default(""),
  endInterview: z.boolean().default(false),
});
export type TurnObject = z.infer<typeof TurnObjectSchema>;

export const ModalitySchema = z.enum(["text", "voice", "file", "widget"]);
export type Modality = z.infer<typeof ModalitySchema>;

/**
 * What a staff screen may know about a session (`GET /sessions/:id`). An explicit view rather than
 * the database row: a row spread into a response carried the campaign's link hash, the invitees'
 * addresses of a requirements session and the participant's fields to every staff role. Fastify
 * serialises through this schema, so a field added to the table is not exposed until it is listed
 * here (D-144).
 */
export const StaffSessionViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  sourceKind: z.string(),
  campaignId: z.string().nullable(),
  templateId: z.string(),
  templateKey: z.string().nullable(),
  templateVersion: z.number(),
  path: z.string().nullable(),
  modePreference: z.string(),
  consentVersion: z.string().nullable(),
  consentedAt: z.date().nullable(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  campaign: z.object({ id: z.string(), name: z.string(), participationMode: z.string() }).nullable(),
  /** Empty unless the viewer may read the transcript: it is the transcript, condensed. */
  summary: z.string(),
  /** The whole state when the transcript is visible, otherwise coverage alone. */
  state: z.record(z.string(), z.unknown()),
  /** Null when the viewer may not read the transcript. */
  messages: z.array(z.unknown()).nullable(),
  /** The engine flagged the interview for hostility or distress (D-173). */
  flagged: z.boolean(),
  flaggedAt: z.date().nullable(),
  flagAckedAt: z.date().nullable(),
  /**
   * Model prose about the participant, so it is shown only to a viewer who may read the
   * transcript; everyone else gets `flagged: true` and no reason.
   */
  flagReason: z.string().nullable(),
  transcriptVisible: z.boolean(),
});
export type StaffSessionView = z.infer<typeof StaffSessionViewSchema>;

export const StaffSessionResponseSchema = z.object({
  session: StaffSessionViewSchema,
  messages: z.array(z.unknown()).nullable(),
  transcriptVisible: z.boolean(),
});
