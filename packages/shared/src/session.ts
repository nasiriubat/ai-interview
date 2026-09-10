import { z } from "zod";
import { FactSchema } from "./facts.js";
import { PathSchema } from "./template.js";
import { WidgetSchema } from "./widgets.js";

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
  phase: z.enum(["path", "context", "areas", "closing", "summary", "done"]).default("areas"),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

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
