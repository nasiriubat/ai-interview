import { z } from "zod";
import { FactSchema } from "./facts.js";
import { PathSchema } from "./template.js";
import { WidgetSchema } from "./widgets.js";

/** A finding raised by issue detection in a requirements session (spec 05, FR-21b). Lives in state. */
/**
 * What "the participant asked to finish" writes into `turnCount`, so the engine's turn cap is
 * already reached and the next turn closes the interview. It used to be written as
 * `Number.MAX_SAFE_INTEGER >> 1`, which JavaScript evaluates as a 32-bit shift to -1: the stored
 * state then failed its own `nonnegative()` check and the session answered 500 from then on.
 * Any value above every template's `maxTurns` works; a small constant keeps it a valid int32.
 */
export const COMPLETION_REQUESTED_TURN_COUNT = 1_000_000;

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
export const SessionStateSchema = z.object({
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
  shortened: z.boolean().default(false),
  flaggedForAdmin: z.string().optional(),
  phase: z
    .enum(["path", "context", "areas", "findings", "mvp_challenge", "closing", "summary", "done"])
    .default("areas"),
  // Requirements sessions (spec 05): findings raised by issue detection, and the MVP challenge walk.
  findings: z.array(FindingSchema).default([]),
  lastIssueScanTurn: z.number().int().nonnegative().default(0),
  finalIssueScanDone: z.boolean().default(false),
  mvpChallenge: z
    .object({
      started: z.boolean().default(false),
      done: z.boolean().default(false),
      asked: z.array(z.string()).default([]),
    })
    .prefault({}),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

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
