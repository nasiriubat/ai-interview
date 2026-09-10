import { z } from "zod";

/**
 * The settings catalog. Every admin knob in the specification is a typed key with a
 * default and the scopes it may be set at. The admin UI renders from this catalog, the
 * settings service validates against it, and code reads through it. Adding a knob is
 * adding a row here.
 */
export const SETTING_SCOPES = ["platform", "tenant", "template", "campaign"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface SettingDef<T extends z.ZodType = z.ZodType> {
  schema: T;
  default: z.infer<T>;
  scopes: readonly SettingScope[];
  category: string;
  description: string;
}

const def = <T extends z.ZodType>(d: SettingDef<T>): SettingDef<T> => d;

export const SETTINGS = {
  // Engine
  "engine.recentWindowTurns": def({
    schema: z.number().int().min(2).max(40),
    default: 10,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Verbatim turns kept in context",
  }),
  "engine.inputTokenBudget": def({
    schema: z.number().int().min(2000).max(200000),
    default: 12000,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Per-turn input token budget for context assembly",
  }),
  "engine.summarizeEveryTurns": def({
    schema: z.number().int().min(2).max(50),
    default: 6,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "How often the rolling summary is updated",
  }),
  "engine.extractEveryTurns": def({
    schema: z.number().int().min(1).max(20),
    default: 3,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "How often facts are extracted into state",
  }),
  "engine.maxTurns": def({
    schema: z.number().int().min(5).max(500),
    default: 60,
    scopes: ["platform", "tenant", "template", "campaign"],
    category: "engine",
    description: "Hard cap on interviewer turns",
  }),
  // Campaign
  "campaign.completionThreshold": def({
    schema: z.number().int().min(1).max(10000),
    default: 5,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Completed interviews before analysis runs",
  }),
  "campaign.completionThresholdPercent": def({
    schema: z.number().int().min(1).max(100),
    default: 30,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Percent of invited before analysis runs",
  }),
  "campaign.linkExpiryDays": def({
    schema: z.number().int().min(1).max(365),
    default: 30,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Days an invitation or share link stays valid",
  }),
  "campaign.verification": def({
    schema: z.enum(["invitation", "email_code", "open"]),
    default: "email_code",
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "How one response per person is enforced on share links",
  }),
  "campaign.allowedEmailDomains": def({
    schema: z.array(z.string()),
    default: [],
    scopes: ["tenant", "campaign"],
    category: "campaign",
    description: "Restrict share links to these email domains; empty allows all",
  }),
  "campaign.consentText": def({
    schema: z.string().min(1),
    default:
      "This interview is recorded to help your organization understand how work is done. You can pause, stop, or delete your answers at any time.",
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Consent text shown before the first turn",
  }),
  // Privacy
  "privacy.retentionMonths": def({
    schema: z.number().int().min(1).max(120),
    default: 24,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Months before session data is deleted automatically",
  }),
  "privacy.kAnonymity": def({
    schema: z.number().int().min(1).max(50),
    default: 3,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Minimum participants behind any quote or breakdown",
  }),
  "privacy.rawTranscriptsVisibleTo": def({
    schema: z.enum(["nobody", "admins", "admins_when_identified_and_opted_in"]),
    default: "admins_when_identified_and_opted_in",
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Who may open raw transcripts",
  }),
  "privacy.audioRetentionDays": def({
    schema: z.number().int().min(0).max(3650),
    default: 365,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Days audio is kept; 0 deletes after transcription",
  }),
  // Cost
  "cost.warnFraction": def({
    schema: z.number().min(0.1).max(1),
    default: 0.8,
    scopes: ["platform", "tenant"],
    category: "cost",
    description: "Fraction of a budget at which admins are warned",
  }),
  "cost.onBudgetExceeded": def({
    schema: z.enum(["pause", "downgrade"]),
    default: "pause",
    scopes: ["platform", "tenant"],
    category: "cost",
    description: "Pause sessions or downgrade to the cheaper route when a budget is exhausted",
  }),
  "cost.defaultMonthlyBudgetCents": def({
    schema: z.number().int().min(0),
    default: 20000,
    scopes: ["platform"],
    category: "cost",
    description: "Default monthly tenant budget",
  }),
  // Files and voice
  "files.maxSizeMb": def({
    schema: z.number().int().min(1).max(200),
    default: 20,
    scopes: ["platform", "tenant"],
    category: "files",
    description: "Maximum upload size",
  }),
  "files.allowedTypes": def({
    schema: z.array(z.string()),
    default: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/markdown",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/png",
      "image/jpeg",
    ],
    scopes: ["platform", "tenant"],
    category: "files",
    description: "Accepted MIME types",
  }),
  "voice.targetFirstWordMs": def({
    schema: z.number().int().min(300).max(5000),
    default: 1500,
    scopes: ["platform", "tenant"],
    category: "voice",
    description: "Latency target for real-time voice",
  }),
  "voice.bargeIn": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Participant can interrupt the interviewer",
  }),
  // Features
  "features.optionsView": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Widgets and options view",
  }),
  "features.recordedVoice": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Recorded voice answers",
  }),
  "features.realtimeVoice": def({
    schema: z.boolean(),
    default: false,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Live voice mode",
  }),
  "features.fileUpload": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "File attachments",
  }),
  "features.chaining": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Start one template from another's outputs",
  }),
  "features.collaboration": def({
    schema: z.boolean(),
    default: false,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Second person in a requirements session",
  }),
  // Branding
  "branding.productName": def({
    schema: z.string().min(1),
    default: "Discovery",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Name shown to participants",
  }),
  "branding.primaryColor": def({
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    default: "#1f5eff",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Primary color",
  }),
  "branding.emailSender": def({
    schema: z.string(),
    default: "no-reply@example.com",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "From address for invitations",
  }),
  // Analysis
  "analysis.weightsPreset": def({
    schema: z.enum(["balanced", "quick_wins", "strategic", "custom"]),
    default: "balanced",
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Ranking preset for opportunity factors",
  }),
  "analysis.weights": def({
    schema: z.record(z.string(), z.number().min(0).max(5)),
    default: {
      expected_impact: 1,
      affected_employees: 1,
      frequency: 1,
      implementation_complexity: 1,
      data_availability: 1,
      risk: 1,
      ai_suitability: 1,
    },
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Custom factor weights, used when the preset is custom",
  }),
  "analysis.similarityThreshold": def({
    schema: z.number().min(0.3).max(0.99),
    default: 0.72,
    scopes: ["platform", "tenant"],
    category: "analysis",
    description: "Cosine similarity at which facts join a cluster",
  }),
  "analysis.reportSections": def({
    schema: z.array(
      z.enum([
        "executive_summary",
        "participation",
        "work_map",
        "opportunities",
        "quick_wins_vs_strategic",
        "not_ai",
        "next_steps",
      ]),
    ),
    default: [
      "executive_summary",
      "participation",
      "work_map",
      "opportunities",
      "quick_wins_vs_strategic",
      "not_ai",
      "next_steps",
    ],
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Sections included in the organization report",
  }),
  "analysis.preliminaryVisibleToMembers": def({
    schema: z.boolean(),
    default: false,
    scopes: ["platform", "tenant"],
    category: "analysis",
    description: "Members may see results before the completion threshold",
  }),
  "analysis.departmentComparison": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Compare departments when each has at least k participants",
  }),
  "analysis.language": def({
    schema: z.string().min(2).max(5),
    default: "en",
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Language of the report",
  }),
  // Exports
  "exports.bundleFormat": def({
    schema: z.enum(["claude_code", "codex", "generic"]),
    default: "claude_code",
    scopes: ["platform", "tenant"],
    category: "exports",
    description: "Agent bundle flavor",
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  return SETTINGS[key].default as SettingValue<K>;
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(value) as SettingValue<K>;
}

export function settingKeysForScope(scope: SettingScope): SettingKey[] {
  return (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].scopes.includes(scope));
}
