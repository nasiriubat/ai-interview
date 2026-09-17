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
  /** Encrypted at rest and never returned in plain text; the API answers with SECRET_SENTINEL. */
  secret?: boolean;
}

/**
 * Placeholder the API returns instead of a secret value, and accepts back on a write to mean
 * "leave this one as it is". A literal value equal to the sentinel can therefore not be stored.
 */
export const SECRET_SENTINEL = "__unchanged__";

const def = <T extends z.ZodType>(d: SettingDef<T>): SettingDef<T> => d;

/** An SMTP connection string the server is willing to dial: a real host, an SMTP scheme, a sane port. */
export function isSmtpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return false;
  if (!url.hostname) return false;
  if (url.port !== "" && !/^\d{1,5}$/.test(url.port)) return false;
  return url.port === "" || Number(url.port) > 0;
}

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
  // Enforced by the daily `privacy.retention-sweep` job (packages/core/src/privacy/retention.ts).
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
  // Enforced by the nightly sweep since phase 4. The transcript is the durable record and stays
  // with the session; this is only about how long the recording of someone's voice is kept, which
  // is the more identifying of the two.
  "privacy.audioRetentionDays": def({
    schema: z.number().int().min(0).max(3650),
    default: 365,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Days a voice recording is kept; 0 deletes it as soon as it is transcribed",
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
  "voice.captions": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Show what was said and heard as text during a live voice interview",
  }),
  "voice.voiceName": def({
    schema: z.string().max(80),
    default: "alloy",
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Which of the speech model's voices the interviewer uses",
  }),
  "voice.speakingRate": def({
    schema: z.number().min(0.5).max(2),
    default: 1.05,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    // Slightly quick: an interviewer that reads at a measured pace sounds like it is dictating.
    description: "Speaking rate of the interviewer's voice, 1 is the model's normal pace",
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
    default: "",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Deprecated: superseded by email.from, which falls back to this when it is unset",
  }),
  // Email. The port resolves these per send, tenant first and platform second, and falls back
  // to EMAIL_SMTP_URL and EMAIL_FROM from the environment when neither scope sets them.
  "email.smtpUrl": def({
    // Validated rather than free text: this string becomes an outbound connection from inside the
    // platform network, so an unchecked value is a port scanner with an authenticated trigger.
    schema: z.string().refine((v) => v === "" || isSmtpUrl(v), {
      message: "Must be smtp://host:port or smtps://host:port",
    }),
    default: "",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "smtp://user:pass@host:587; empty falls back to the environment, then the console",
    secret: true,
  }),
  "email.from": def({
    schema: z.string(),
    default: "no-reply@example.com",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "Envelope sender for outgoing mail",
  }),
  "email.replyTo": def({
    schema: z.string(),
    default: "",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "Optional reply-to address",
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
  // Requirements interview (ADM-REQ). Cadence, finding types and push-back are template fields.
  "requirements.aggressivenessTechnical": def({
    schema: z.enum(["template", "gentle", "standard", "strict"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Issue-detection aggressiveness on the technical path (template = the template's own value)",
  }),
  "requirements.aggressivenessNontechnical": def({
    schema: z.enum(["template", "gentle", "standard", "strict"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description:
      "Issue-detection aggressiveness on the nontechnical path (template = the template's own value)",
  }),
  "requirements.mvpChallenge": def({
    schema: z.enum(["template", "mandatory", "optional", "off"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "MVP challenge before finalizing: mandatory, optional (the user may end it early), or off",
  }),
  "requirements.specSections": def({
    schema: z.array(
      z.enum([
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
      ]),
    ),
    default: [
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
    ],
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Specification sections, in order",
  }),
  "requirements.diagramTypes": def({
    schema: z.array(z.enum(["context", "containers", "sequence", "state", "entity"])),
    default: ["context", "containers", "sequence", "state", "entity"],
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Diagram types generated into the specification",
  }),
  // Exports
  "exports.bundleFormat": def({
    schema: z.enum(["claude_code", "codex", "generic"]),
    default: "claude_code",
    scopes: ["platform", "tenant", "template"],
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

export function isSecretSetting(key: SettingKey): boolean {
  return SETTINGS[key].secret === true;
}

export function secretSettingKeys(): SettingKey[] {
  return (Object.keys(SETTINGS) as SettingKey[]).filter(isSecretSetting);
}

/** Replaces any secret that holds a value with the sentinel, so a map may safely leave the API. */
export function maskSecretSettings(
  values: Partial<Record<SettingKey, unknown>>,
): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = { ...values };
  for (const key of secretSettingKeys()) {
    if (!(key in out)) continue;
    const v = out[key];
    out[key] = typeof v === "string" && v.length > 0 ? SECRET_SENTINEL : v;
  }
  return out;
}
