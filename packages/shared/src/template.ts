import { z } from "zod";
import { FactKindSchema } from "./facts.js";
import { WIDGET_TYPES } from "./widgets.js";

export const PrivacyModeSchema = z.enum(["identified", "anonymous", "participant_choice"]);
export type PrivacyMode = z.infer<typeof PrivacyModeSchema>;

export const PathSelectionSchema = z.enum(["none", "technical_or_not"]);
export const PathSchema = z.enum(["technical", "nontechnical"]);
export type Path = z.infer<typeof PathSchema>;

export const ParticipantFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  required: z.boolean().default(false),
});
export type ParticipantField = z.infer<typeof ParticipantFieldSchema>;

export const CoverageAreaSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  doneWhen: z.string().min(1),
  instructions: z.string().default(""),
  maxFollowUps: z.number().int().min(0).max(10).default(3),
  essential: z.boolean().default(false), // kept when the interview is shortened
  paths: z.array(PathSchema).optional(), // omit = both paths
});
export type CoverageArea = z.infer<typeof CoverageAreaSchema>;

export const ContextQuestionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  question: z.string().min(1),
  questionNontechnical: z.string().optional(),
  why: z.string().default(""),
  options: z
    .array(z.object({ key: z.string(), label: z.string(), detail: z.string().optional() }))
    .optional(),
  default: z.string().optional(),
});
export type ContextQuestion = z.infer<typeof ContextQuestionSchema>;

export const AdaptivitySchema = z.object({
  followUpPolicy: z
    .enum(["clarify_ambiguous_and_deepen_processes", "clarify_only", "none"])
    .default("clarify_ambiguous_and_deepen_processes"),
  minimalAnswerThreshold: z.number().int().min(1).max(10).default(3),
  offerPathSwitch: z.boolean().default(true),
  toneByRole: z.boolean().default(true),
});

export const WidgetPolicySchema = z.object({
  allowedTypes: z.array(z.enum(WIDGET_TYPES)).default([...WIDGET_TYPES]),
  maxPerTurns: z.number().int().min(0).max(10).default(1), // at most one widget every N turns; 0 disables
  everyTurns: z.number().int().min(1).max(10).default(2),
});

export const IssueDetectionSchema = z.object({
  enabled: z.boolean().default(false),
  everyTurns: z.number().int().min(1).max(20).default(5),
  aggressiveness: z.enum(["gentle", "standard", "strict"]).default("standard"),
  typesEnabled: z
    .array(z.enum(["ambiguity", "contradiction", "missing_decision", "over_complexity"]))
    .default(["ambiguity", "contradiction", "missing_decision", "over_complexity"]),
  pushBackOnce: z.boolean().default(true),
  mvpChallenge: z.boolean().default(false),
});

export const ChainMappingSchema = z.record(z.string(), z.string());

/** The template is the whole definition of an interview type. The engine reads nothing else. */
export const InterviewTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  name: z.string().min(1),
  language: z.string().default("en"),
  objective: z.string().min(1),
  privacyMode: PrivacyModeSchema,
  participantFields: z.array(ParticipantFieldSchema).default([]),
  pathSelection: PathSelectionSchema.default("none"),
  contextBlock: z.array(ContextQuestionSchema).default([]),
  coverageAreas: z.array(CoverageAreaSchema).min(1),
  aiInstructions: z.string().default(""),
  adaptivity: AdaptivitySchema.prefault({}),
  widgetPolicy: WidgetPolicySchema.prefault({}),
  issueDetection: IssueDetectionSchema.prefault({}),
  outputs: z.array(FactKindSchema).min(1),
  analysisEnabled: z.boolean().default(false),
  chainToKey: z.string().nullable().default(null),
  chainMapping: ChainMappingSchema.nullable().default(null),
  closingQuestion: z.string().default("Is there anything important I did not ask about?"),
  endSummary: z.boolean().default(true),
  maxTurns: z.number().int().min(5).max(500).default(60),
  maxAssistantChars: z.number().int().min(100).max(4000).default(600),
});
export type InterviewTemplate = z.infer<typeof InterviewTemplateSchema>;
export type InterviewTemplateInput = z.input<typeof InterviewTemplateSchema>;
