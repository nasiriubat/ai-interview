import { z } from "zod";

const Frequency = z.enum(["hourly", "daily", "weekly", "monthly", "rarely"]);

export const TaskFactSchema = z.object({
  kind: z.literal("task"),
  name: z.string(),
  frequency: Frequency,
  minutesPerOccurrence: z.number().nonnegative(),
  tools: z.array(z.string()),
  painScore: z.number().int().min(0).max(10),
  quote: z.string().optional(),
});
export const ProcessFactSchema = z.object({
  kind: z.literal("process"),
  name: z.string(),
  steps: z.array(z.string()).min(1),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  manualSteps: z.array(z.string()).default([]),
  frequency: Frequency.optional(),
  quote: z.string().optional(),
});
export const InformationFlowFactSchema = z.object({
  kind: z.literal("information_flow"),
  from: z.string(),
  to: z.string(),
  what: z.string(),
  channel: z.string().optional(),
  waitTime: z.string().optional(),
  quote: z.string().optional(),
});
export const PainPointFactSchema = z.object({
  kind: z.literal("pain_point"),
  description: z.string(),
  cause: z.string().optional(),
  affectedTask: z.string().optional(),
  severity: z.number().int().min(0).max(10),
  quote: z.string().optional(),
});
export const OpportunityCandidateFactSchema = z.object({
  kind: z.literal("opportunity_candidate"),
  title: z.string(),
  description: z.string(),
  relatedTasks: z.array(z.string()),
  estimatedMinutesSavedPerWeek: z.number().nonnegative().optional(),
  dataNeeded: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
export const SpecFieldFactSchema = z.object({
  kind: z.literal("spec_field"),
  section: z.string(),
  path: z.string(), // dotted path inside the section
  value: z.unknown(),
  source: z.enum(["user", "default_accepted", "recommended", "handoff"]),
});

export const FactSchema = z.discriminatedUnion("kind", [
  TaskFactSchema,
  ProcessFactSchema,
  InformationFlowFactSchema,
  PainPointFactSchema,
  OpportunityCandidateFactSchema,
  SpecFieldFactSchema,
]);
export type Fact = z.infer<typeof FactSchema>;
export const FACT_KINDS = [
  "task",
  "process",
  "information_flow",
  "pain_point",
  "opportunity_candidate",
  "spec_field",
] as const;
export const FactKindSchema = z.enum(FACT_KINDS);
export type FactKind = z.infer<typeof FactKindSchema>;

export const ExtractionResultSchema = z.object({ facts: z.array(FactSchema) });
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
