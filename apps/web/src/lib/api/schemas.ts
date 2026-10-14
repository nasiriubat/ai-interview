import {
  AgentBundleSchema,
  BudgetLimitSchema,
  ClusterStatsSchema,
  CoverageStatusSchema,
  DecisionSchema,
  FACTOR_KEYS,
  FactSchema,
  type FactorKey,
  FindingSchema,
  HandoffSchema,
  InterviewTemplateSchema,
  listEnvelope,
  LiveDiagramSchema as SharedLiveDiagramSchema,
  LiveSectionSchema as SharedLiveSectionSchema,
  ModalitySchema,
  ModelInfoSchema,
  OpportunityOverrideSchema,
  OpportunityStatusSchema,
  ParticipantFieldSchema,
  PathSchema,
  PathSelectionSchema,
  PrivacyModeSchema,
  ProviderKindSchema,
  RouteSchema,
  SolutionClassSchema,
  SpecDocumentSchema,
  SpecRequirementSchema,
  SpecVersionStatsSchema,
  WidgetResponseSchema,
  WidgetSchema,
} from "@aidp/shared";
import { z } from "zod";
import { DEFAULT_ALLOWED_TYPES, DEFAULT_MAX_SIZE_MB } from "../attachments";

/*
 * Response schemas for the Phase 1 contract (docs/spec/16). Where the contract spells a
 * shape out, the schema is exact. Where it only names a route, the schema is tolerant:
 * loose objects with the fields the UI relies on marked optional. Assumptions are listed
 * under "Contract gaps" in apps/web/README.md.
 */

const iso = z.string();

/** Unwraps `{ items | rows | entries | data | <key>: [] }` envelopes so lists validate either way. */
export function listOf<T extends z.ZodType>(item: T, key?: string): z.ZodType<z.output<T>[]> {
  return z.preprocess((raw) => {
    if (Array.isArray(raw)) return raw as unknown[];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      for (const k of [key, "items", "rows", "entries", "data"]) {
        const candidate = k ? obj[k] : undefined;
        if (Array.isArray(candidate)) return candidate as unknown[];
      }
    }
    return raw;
  }, z.array(item));
}

/**
 * A page of a list (contract 19): the list keeps its old key, `total`, `limit` and `offset`
 * sit beside it. A bare array (an API that has not been upgraded yet) parses as one page
 * with unknown totals, so a screen keeps working either way.
 */
export interface Paged<T> {
  items: T[];
  total: number | null;
  limit: number | null;
  offset: number | null;
}

/**
 * The contract 19 envelope is declared once, in `@aidp/shared` (`listEnvelope`), and is what the
 * API answers with. This function only adds the tolerance an older API needs: a bare array, or a
 * generic `items`/`rows`/`data` key, or counters it did not send.
 */
function pageEnvelope(raw: unknown, key?: string): unknown {
  const empty = { total: null, limit: null, offset: null };
  if (Array.isArray(raw)) return { items: raw, ...empty };
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (key) {
      // Rows are checked by the caller's item schema afterwards; parsing them here too would run
      // a schema with transforms twice.
      const strict = listEnvelope(key, z.unknown()).safeParse(raw);
      if (strict.success) {
        const { total, limit, offset } = strict.data;
        return { items: obj[key], total, limit, offset };
      }
    }
    for (const k of [key, "items", "rows", "entries", "data"]) {
      const candidate = k ? obj[k] : undefined;
      if (Array.isArray(candidate)) {
        return {
          items: candidate,
          total: typeof obj.total === "number" ? obj.total : null,
          limit: typeof obj.limit === "number" ? obj.limit : null,
          offset: typeof obj.offset === "number" ? obj.offset : null,
        };
      }
    }
  }
  return { items: raw, ...empty };
}

/** Same tolerance as `listOf`, but keeps the pagination counters when the API sends them. */
export function pagedOf<T extends z.ZodType>(item: T, key?: string): z.ZodType<Paged<z.output<T>>> {
  return z.preprocess(
    (raw) => pageEnvelope(raw, key),
    z.object({
      items: z.array(item),
      total: z.number().nullable().default(null),
      limit: z.number().nullable().default(null),
      offset: z.number().nullable().default(null),
    }),
  );
}

export const OkSchema = z.looseObject({ ok: z.literal(true) });

// Participant flow

export const VerificationSchema = z.enum(["invitation", "email_code", "open"]);
export type Verification = z.infer<typeof VerificationSchema>;

export const PublicCampaignSchema = z.looseObject({
  name: z.string(),
  productName: z.string().default(""),
  purpose: z.string().default(""),
  expectedMinutes: z.number().default(15),
  participationMode: PrivacyModeSchema.default("identified"),
  verification: VerificationSchema.default("email_code"),
  consentText: z.string().default(""),
  participantFields: z.array(ParticipantFieldSchema).default([]),
  pathSelection: PathSelectionSchema.default("none"),
});
export type PublicCampaign = z.infer<typeof PublicCampaignSchema>;

export const LinkStatusSchema = z.enum(["open", "closed", "expired"]);
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

export const LinkInfoSchema = z.looseObject({ campaign: PublicCampaignSchema, status: LinkStatusSchema });
export type LinkInfo = z.infer<typeof LinkInfoSchema>;

export const TokenGrantSchema = z.looseObject({
  participantToken: z.string(),
  sessionId: z.string(),
  resume: z.boolean().default(false),
});
export type TokenGrant = z.infer<typeof TokenGrantSchema>;

/** What the browser receives after the proxy has moved the token into the httpOnly cookie. */
export const SessionGrantSchema = z.looseObject({
  sessionId: z.string(),
  resume: z.boolean().default(false),
});
export type SessionGrant = z.infer<typeof SessionGrantSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export const MessageSchema = z.looseObject({
  id: z.string(),
  seq: z.number().int().default(0),
  role: MessageRoleSchema,
  modality: ModalitySchema.default("text"),
  content: z.string().default(""),
  widget: WidgetSchema.nullish(),
  widgetResponse: WidgetResponseSchema.nullish(),
  areaKey: z.string().nullish(),
  createdAt: iso.default(""),
});
export type Message = z.infer<typeof MessageSchema>;

export const ProgressAreaSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  status: CoverageStatusSchema.catch("untouched"),
});
export type ProgressArea = z.infer<typeof ProgressAreaSchema>;
export const ProgressSchema = z.looseObject({ areas: z.array(ProgressAreaSchema).default([]) });
export type Progress = z.infer<typeof ProgressSchema>;

export const SESSION_STATUSES = ["created", "consented", "active", "paused", "completed", "deleted"] as const;
export const ModePreferenceSchema = z.enum(["chat", "options", "voice"]);
export type ModePreference = z.infer<typeof ModePreferenceSchema>;

/** An uploaded file or a recording (FR-30, FR-31, FR-32). `status` is the ingestion state. */
export const AttachmentKindSchema = z.enum(["audio", "document", "image"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;
export const AttachmentStatusSchema = z.enum(["pending", "ready", "failed"]);
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;
export const AttachmentSchema = z.looseObject({
  id: z.string(),
  kind: AttachmentKindSchema.catch("document"),
  filename: z.string().default(""),
  mime: z.string().default(""),
  sizeBytes: z.number().default(0),
  status: AttachmentStatusSchema.catch("pending"),
  summary: z.string().nullish(),
  error: z.string().nullish(),
  durationMs: z.number().nullish(),
  createdAt: iso.default(""),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const AttachmentEnvelopeSchema = z.looseObject({ attachment: AttachmentSchema });
export const AttachmentListSchema = listOf(AttachmentSchema, "attachments");

/**
 * What this session may do with voice and files, resolved from the tenant's and template's
 * settings. Every field defaults to what the app did before the API offered them — voice and
 * files on, the shipped size and type limits — so an older API is not read as "everything off".
 */
export const SessionCapabilitiesSchema = z.looseObject({
  recordedVoice: z.boolean().default(true),
  /**
   * FR-30a. Defaults to off, unlike the others: an API that predates live voice has no socket to
   * connect to, and a call that fails to open is worse than a microphone button that works.
   */
  liveVoice: z.boolean().default(false),
  /** Whether the live cascade sends `caption` frames. Without them nothing the participant says reaches this client. */
  captions: z.boolean().default(true),
  fileUpload: z.boolean().default(true),
  /**
   * Off hides the "options" answer mode (`features.optionsView`, D-187). Optional rather than
   * defaulted so existing fixtures and an older API read as "on" without every caller listing it.
   */
  optionsView: z.boolean().optional(),
  maxSizeMb: z.number().positive().default(DEFAULT_MAX_SIZE_MB),
  allowedTypes: z.array(z.string()).default([...DEFAULT_ALLOWED_TYPES]),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

export const ParticipantSessionSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  path: PathSchema.nullish(),
  modePreference: ModePreferenceSchema.nullish(),
  consented: z.boolean().default(false),
  progress: ProgressSchema.default({ areas: [] }),
  messages: z.array(MessageSchema).default([]),
  capabilities: SessionCapabilitiesSchema.prefault({}),
  /** The session's attachments, so the first render needs no second request. */
  attachments: z.array(AttachmentSchema).default([]),
  summary: z.string().nullish(),
  /**
   * Two sentences on where the participant left off, written by the API when they have been away
   * (spec 06). Not a message: it is shown in a banner and never enters the transcript.
   */
  recap: z
    .looseObject({ text: z.string().min(1), source: z.enum(["model", "fallback"]).catch("fallback") })
    .nullish(),
});
export type ParticipantSession = z.infer<typeof ParticipantSessionSchema>;
export const ParticipantSessionEnvelopeSchema = z.looseObject({ session: ParticipantSessionSchema });

/** `DELETE /p/session`: whether a confirmation email was queued (only identified participants have one). */
export const DeleteResultSchema = z.looseObject({
  ok: z.literal(true),
  emailSent: z.boolean().default(false),
});
export type DeleteResult = z.infer<typeof DeleteResultSchema>;

export const SummarySchema = z.looseObject({
  summary: z.string().default(""),
  facts: z.array(FactSchema).default([]),
  /** Whether the summary is written (D-325). An older server that does not say is "ready". */
  status: z.enum(["ready", "pending", "unavailable"]).catch("ready").default("ready"),
});
export type Summary = z.infer<typeof SummarySchema>;

// Staff

export const RoleSchema = z.enum(["platform_operator", "admin", "member"]);
export type Role = z.infer<typeof RoleSchema>;

export const MeSchema = z.looseObject({
  user: z.looseObject({
    id: z.string(),
    email: z.string(),
    name: z.string().nullish(),
    role: RoleSchema,
    companyId: z.string().nullish(),
  }),
  company: z
    .looseObject({
      id: z.string(),
      name: z.string(),
      /** `branding.currency`: what the cost figures are in (D-323). */
      currency: z.string().optional(),
    })
    .nullish(),
});
export type Me = z.infer<typeof MeSchema>;

export const UserSchema = z.looseObject({
  id: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  role: RoleSchema.catch("member"),
  status: z.string().nullish(),
  createdAt: iso.nullish(),
  /** Set when access has been withdrawn (D-161). */
  disabledAt: iso.nullish(),
});
export type User = z.infer<typeof UserSchema>;
export const UserPageSchema = pagedOf(UserSchema, "users");

export const TemplateStatusSchema = z.enum(["draft", "published", "archived"]);
export const TemplateRecordSchema = InterviewTemplateSchema.extend({
  id: z.string(),
  companyId: z.string().nullish(),
  status: TemplateStatusSchema.catch("draft"),
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
});
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;
/** List rows may be lighter than the full record; only identity fields are required. */
export const TemplateListItemSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  version: z.number().int().default(1),
  companyId: z.string().nullish(),
  status: TemplateStatusSchema.catch("draft"),
  updatedAt: iso.nullish(),
});
export type TemplateListItem = z.infer<typeof TemplateListItemSchema>;
export const TemplateListSchema = listOf(TemplateListItemSchema, "templates");
export const TemplatePageSchema = pagedOf(TemplateListItemSchema, "templates");
export const TemplateEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "template" in raw ? raw.template : raw),
  TemplateRecordSchema,
);

/** One version of a template key (FR-62, D-183). */
export const TemplateVersionSchema = z.looseObject({
  id: z.string(),
  version: z.number().int(),
  status: TemplateStatusSchema.catch("draft"),
  createdAt: iso.nullish(),
  createdBy: z.looseObject({ id: z.string(), name: z.string().nullish(), email: z.string() }).nullish(),
  changedFields: z.array(z.string()).default([]),
  campaigns: z.number().int().default(0),
  latest: z.boolean().default(false),
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;
export const TemplateVersionsSchema = z.looseObject({
  versions: z.array(TemplateVersionSchema).default([]),
});

export const TemplateDiffSchema = z.looseObject({
  shipped: z.unknown().nullish(),
  current: z.unknown().nullish(),
  changedFields: z.array(z.string()).default([]),
});
export type TemplateDiff = z.infer<typeof TemplateDiffSchema>;

/*
 * Prompt administration (D-230 to D-235). The groups, states and sources are closed sets of the
 * API; an unknown one falls back so a newer API does not blank the page.
 */
export const PromptStatsSchema = z.looseObject({
  calls: z.number().default(0),
  errors: z.number().default(0),
  errorRate: z.number().default(0),
  meanLatencyMs: z.number().default(0),
  meanCostCents: z.number().default(0),
});
export type PromptStats = z.infer<typeof PromptStatsSchema>;
const PromptSourceSchema = z.enum(["shipped", "platform", "tenant"]).catch("shipped");
const PromptEffectiveSchema = z.looseObject({
  source: PromptSourceSchema,
  version: z.number().int(),
  tag: z.string(),
});
const PromptCanarySchema = z.looseObject({ version: z.number().int(), share: z.number() }).nullish();
export const PROMPT_GROUPS = ["interview", "analysis", "requirements", "files"] as const;
export type PromptGroup = (typeof PROMPT_GROUPS)[number];
export const PromptSummarySchema = z.looseObject({
  key: z.string(),
  group: z.enum(PROMPT_GROUPS).catch("interview"),
  shipped: z.looseObject({ version: z.number().int(), tag: z.string(), chars: z.number() }),
  effective: PromptEffectiveSchema,
  canary: PromptCanarySchema,
  versions: z.number().int().default(0),
  stats: PromptStatsSchema,
});
export type PromptSummary = z.infer<typeof PromptSummarySchema>;
export const PromptListSchema = z.looseObject({
  prompts: z.array(PromptSummarySchema).default([]),
  windowDays: z.number().default(30),
});
export type PromptList = z.infer<typeof PromptListSchema>;

export const PromptVersionSchema = z.looseObject({
  version: z.number().int(),
  tag: z.string(),
  note: z.string().nullish(),
  body: z.string(),
  state: z.enum(["stable", "canary", "inactive"]).catch("inactive"),
  canaryShare: z.number().default(0),
  parentVersion: z.number().int().nullish(),
  createdAt: iso,
  createdBy: z.looseObject({ id: z.string(), name: z.string().nullish(), email: z.string() }).nullish(),
  activatedAt: iso.nullish(),
  deactivatedAt: iso.nullish(),
  stats: PromptStatsSchema,
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;
export const PromptDetailSchema = z.looseObject({
  key: z.string(),
  group: z.enum(PROMPT_GROUPS).catch("interview"),
  shipped: z.looseObject({
    version: z.number().int(),
    tag: z.string(),
    body: z.string(),
    stats: PromptStatsSchema,
  }),
  contract: z.looseObject({
    requiredPlaceholders: z.array(z.string()).default([]),
    untrustedRules: z.boolean().default(false),
    contractTokens: z.array(z.string()).default([]),
    maxChars: z.number().default(30000),
  }),
  effective: PromptEffectiveSchema,
  canary: PromptCanarySchema,
  platform: z.looseObject({ version: z.number().int() }).nullish(),
  versions: z.array(PromptVersionSchema).default([]),
  windowDays: z.number().default(30),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;
export const PromptIssueSchema = z.looseObject({
  code: z.string(),
  detail: z.string().nullish(),
  message: z.string().default(""),
});
export type PromptIssue = z.infer<typeof PromptIssueSchema>;
export const PromptCheckSchema = z.looseObject({
  ok: z.boolean(),
  issues: z.array(PromptIssueSchema).default([]),
  renders: z
    .array(
      z.looseObject({
        template: z.string(),
        ok: z.boolean(),
        leftover: z.array(z.string()).default([]),
        chars: z.number().default(0),
      }),
    )
    .default([]),
});
export type PromptCheck = z.infer<typeof PromptCheckSchema>;
export const PromptDiffSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  lines: z.array(z.looseObject({ type: z.enum(["same", "add", "del"]), text: z.string() })).default([]),
  added: z.number().default(0),
  removed: z.number().default(0),
});
export type PromptDiff = z.infer<typeof PromptDiffSchema>;

export const PreviewSessionSchema = z.looseObject({ participantToken: z.string(), sessionId: z.string() });

export const CampaignStatsSchema = z.looseObject({
  invited: z.number().default(0),
  started: z.number().default(0),
  completed: z.number().default(0),
  dropOffByArea: z.record(z.string(), z.number()).default({}),
});
export const CampaignSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  templateId: z.string().nullish(),
  templateKey: z.string().nullish(),
  templateVersion: z.number().nullish(),
  status: z.string().default("draft"),
  participationMode: PrivacyModeSchema.nullish(),
  verification: VerificationSchema.nullish(),
  allowedEmailDomains: z.array(z.string()).nullish(),
  maxTurns: z.number().nullish(),
  completionThreshold: z.number().nullish(),
  expiresAt: iso.nullish(),
  createdAt: iso.nullish(),
  link: z.looseObject({ url: z.string() }).nullish(),
  stats: CampaignStatsSchema.nullish(),
});
export type Campaign = z.infer<typeof CampaignSchema>;
export const CampaignPageSchema = pagedOf(CampaignSchema, "campaigns");
export const CampaignEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "campaign" in raw ? raw.campaign : raw),
  CampaignSchema,
);

export const InvitationSchema = z.looseObject({
  id: z.string(),
  email: z.string().nullish(),
  status: z.string().default("pending"),
  sentAt: iso.nullish(),
  openedAt: iso.nullish(),
  expiresAt: iso.nullish(),
});
export type Invitation = z.infer<typeof InvitationSchema>;
export const InvitationPageSchema = pagedOf(InvitationSchema, "invitations");
export const InvitationResultSchema = z.looseObject({
  created: z.number().default(0),
  skipped: z.number().default(0),
});

export const SessionListItemSchema = z.looseObject({
  id: z.string(),
  status: z.string().default("created"),
  progress: ProgressSchema.nullish(),
  costCents: z.number().nullish(),
  turns: z.number().nullish(),
  path: PathSchema.nullish(),
  /** Only for an identified participant; null for anyone anonymous (D-79). */
  participantEmail: z.string().nullish(),
  participantName: z.string().nullish(),
  areasCovered: z.number().nullish(),
  mode: z.string().nullish(),
  startedAt: iso.nullish(),
  endedAt: iso.nullish(),
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
  /** The last write to the session; the `lastActivity` sort. */
  lastActivityAt: iso.nullish(),
  /** The engine flagged the interview for hostility or distress (D-173). The reason is only on the detail. */
  flagged: z.boolean().default(false),
  flagAckedAt: iso.nullish(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export const SessionPageSchema = pagedOf(SessionListItemSchema, "sessions");

export const StaffSessionSchema = z.looseObject({
  id: z.string(),
  status: z.string().default("created"),
  campaignId: z.string().nullish(),
  templateKey: z.string().nullish(),
  progress: ProgressSchema.nullish(),
  costCents: z.number().nullish(),
  messages: z.array(MessageSchema).nullish(),
  transcriptHidden: z.boolean().nullish(),
  state: z.unknown().nullish(),
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
  flagged: z.boolean().default(false),
  flaggedAt: iso.nullish(),
  flagAckedAt: iso.nullish(),
  /** Null unless the viewer may read the transcript the reason was written from. */
  flagReason: z.string().nullish(),
});
export type StaffSession = z.infer<typeof StaffSessionSchema>;
export const StaffSessionEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "session" in raw ? raw.session : raw),
  StaffSessionSchema,
);

export const SessionEventSchema = z.looseObject({
  id: z.string().nullish(),
  seq: z.number().nullish(),
  type: z.string(),
  payload: z.unknown().nullish(),
  createdAt: iso.nullish(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export const SessionEventListSchema = listOf(SessionEventSchema, "events");

export const SettingsCatalogEntrySchema = z.looseObject({
  key: z.string(),
  category: z.string().default("other"),
  description: z.string().default(""),
  default: z.unknown(),
  scopes: z.array(z.string()).default([]),
  /** Contract 19: a secret never leaves the API in plain text. */
  secret: z.boolean().nullish(),
  /** The release the key first shipped in (D-180); null for a key from before tracking. */
  since: z.string().nullish(),
  /** Written only by the platform operator; a tenant admin sees it read-only (D-188). */
  operatorOnly: z.boolean().nullish(),
});
export type SettingsCatalogEntry = z.infer<typeof SettingsCatalogEntrySchema>;
export const SettingsResponseSchema = z.looseObject({
  values: z.record(z.string(), z.unknown()).default({}),
  catalog: z.array(SettingsCatalogEntrySchema).default([]),
  /** The value in force at this scope, inherited values included. Falls back to `values`. */
  effective: z.record(z.string(), z.unknown()).nullish(),
  /** `{ [key]: true }` for every secret that holds a value at the resolved scope. */
  secrets: z.record(z.string(), z.boolean()).nullish(),
  /** Optional: which scope each effective value came from. Absent means "guess from `values`". */
  sources: z.record(z.string(), z.string()).nullish(),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

/** One saved batch of settings, from the audit log: keys only, never a value (D-182). */
export const SettingsHistoryItemSchema = z.looseObject({
  id: z.string(),
  at: iso,
  scope: z.string(),
  scopeId: z.string().default(""),
  scopeName: z.string().nullish(),
  actor: z.looseObject({ id: z.string(), name: z.string().nullish(), email: z.string() }).nullish(),
  keys: z.array(z.string()).default([]),
  cleared: z.array(z.string()).default([]),
});
export type SettingsHistoryItem = z.infer<typeof SettingsHistoryItemSchema>;
export const SettingsHistorySchema = z.looseObject({
  items: z.array(SettingsHistoryItemSchema).default([]),
  next: z.string().nullish(),
});
export type SettingsHistory = z.infer<typeof SettingsHistorySchema>;

/** The sentinel `PUT /settings` reads as "leave this secret as it is" (contract 19). */
export const SECRET_UNCHANGED = "__unchanged__";

export const ScopeTargetSchema = z.looseObject({
  id: z.string(),
  name: z.string().default(""),
  detail: z.string().nullish(),
});
export type ScopeTarget = z.infer<typeof ScopeTargetSchema>;
export const ScopeTargetListSchema = listOf(ScopeTargetSchema, "targets");

/** One voice purpose in the live voice readiness check (D-77). */
export const VoicePurposeReadinessSchema = z.looseObject({
  ready: z.boolean().default(false),
  providerName: z.string().nullish(),
  model: z.string().nullish(),
  scope: z.enum(["tenant", "platform"]).nullish(),
});
export type VoicePurposeReadiness = z.infer<typeof VoicePurposeReadinessSchema>;

export const VOICE_PURPOSES = ["transcription", "stt_stream", "tts"] as const;
export type VoicePurpose = (typeof VOICE_PURPOSES)[number];

/** `GET /admin/voice/readiness` and the answer of both live voice writes (contract 19, "Live voice"). */
export const VoiceReadinessSchema = z.looseObject({
  liveVoiceEnabled: z.boolean().default(false),
  recordedVoiceEnabled: z.boolean().default(false),
  purposes: z
    .looseObject({
      transcription: VoicePurposeReadinessSchema.default({ ready: false }),
      stt_stream: VoicePurposeReadinessSchema.default({ ready: false }),
      tts: VoicePurposeReadinessSchema.default({ ready: false }),
    })
    .default({
      transcription: { ready: false },
      stt_stream: { ready: false },
      tts: { ready: false },
    }),
  canEnableLive: z.boolean().default(false),
  missing: z.array(z.string()).default([]),
});
export type VoiceReadiness = z.infer<typeof VoiceReadinessSchema>;

export const EmailTestSchema = z.looseObject({
  ok: z.boolean().default(false),
  usedScope: z.string().nullish(),
  error: z.string().nullish(),
});
export type EmailTest = z.infer<typeof EmailTestSchema>;

export const ProviderSchema = z.looseObject({
  id: z.string(),
  companyId: z.string().nullish(),
  kind: ProviderKindSchema.catch("openai_compatible"),
  name: z.string(),
  baseUrl: z.string().nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  enabled: z.boolean().default(true),
  hasKey: z.boolean().default(false),
});
export type Provider = z.infer<typeof ProviderSchema>;
export const ProviderListSchema = listOf(ProviderSchema, "providers");
export const ProviderEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "provider" in raw ? raw.provider : raw),
  ProviderSchema,
);

export const ProviderTestSchema = z.looseObject({
  ok: z.boolean(),
  /** The model the API picked when the request carried none (contract 19). */
  model: z.string().nullish(),
  latencyMs: z.number().nullish(),
  tokens: z.number().nullish(),
  costCents: z.number().nullish(),
  error: z.string().nullish(),
});
export type ProviderTest = z.infer<typeof ProviderTestSchema>;

/** Where a stored price came from: the shipped seed, a provider import, or an admin override. */
export const PriceSourceSchema = z.enum(["seed", "provider", "admin"]);
export type PriceSource = z.infer<typeof PriceSourceSchema>;

/**
 * `ModelInfo` from the shared catalog, widened for contract 19: the provider catalogue may
 * carry `contextLength` instead of `contextWindow`, a `maxOutputTokens`, and a `source`
 * saying whether the price came from the provider or from an admin override.
 */
export const ModelPriceSchema = ModelInfoSchema.loose().extend({
  contextLength: z.number().nullish(),
  maxOutputTokens: z.number().nullish(),
  source: PriceSourceSchema.nullish(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export const ModelListSchema = listOf(ModelPriceSchema, "models");

/**
 * A stored price row of `GET /providers/:id/prices`. It is keyed by `model`, not by the
 * catalogue's `id`, and carries no display name; `source` says whether the number was
 * imported from the provider or typed by an admin (an admin override always wins).
 */
export const ModelPriceRowSchema = z.looseObject({
  providerId: z.string().nullish(),
  model: z.string(),
  inputPerMtok: z.number().nullish(),
  cachedInputPerMtok: z.number().nullish(),
  outputPerMtok: z.number().nullish(),
  source: PriceSourceSchema.nullish(),
});
export type ModelPriceRow = z.infer<typeof ModelPriceRowSchema>;
export const PricePageSchema = pagedOf(ModelPriceRowSchema, "prices");

/** The body of `PUT /providers/:id/prices`: one entry per model that carries an override. */
export interface ModelPriceInput {
  model: string;
  inputPerMtok?: number;
  cachedInputPerMtok?: number;
  outputPerMtok?: number;
}

/** `GET /providers/:id/models`: the live catalogue, degrading to the last import when stale. */
export const ModelCatalogueSchema = z.preprocess(
  (raw) => (Array.isArray(raw) ? { models: raw } : raw),
  z.looseObject({
    models: z.array(ModelPriceSchema).default([]),
    importedPrices: z.number().nullish(),
    fetchedAt: iso.nullish(),
    stale: z.boolean().default(false),
    error: z.string().nullish(),
  }),
);
export type ModelCatalogue = z.infer<typeof ModelCatalogueSchema>;

export const RouteRecordSchema = RouteSchema.loose().extend({ id: z.string().nullish() });
export type RouteRecord = z.infer<typeof RouteRecordSchema>;
export const RoutesResponseSchema = z.looseObject({ routes: z.array(RouteRecordSchema).default([]) });

export const BudgetRecordSchema = BudgetLimitSchema.loose().extend({
  id: z.string().nullish(),
  spentCents: z.number().nullish(),
});
export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;
export const BudgetPageSchema = pagedOf(BudgetRecordSchema, "budgets");

export const SpendSchema = z.looseObject({
  rows: z
    .array(
      z.looseObject({
        key: z.string(),
        costCents: z.number().default(0),
        calls: z.number().default(0),
        tokens: z.number().default(0),
      }),
    )
    .default([]),
  budget: z.looseObject({ limitCents: z.number().nullish(), spentCents: z.number().default(0) }).nullish(),
});
export type Spend = z.infer<typeof SpendSchema>;
export type SpendGroupBy = "day" | "purpose" | "model" | "campaign";

/** `/stats` is not spelled out in the contract; groups of numbers are rendered generically. */
export const StatsSchema = z.record(z.string(), z.unknown());
export type Stats = z.infer<typeof StatsSchema>;

export const AuditEntrySchema = z.looseObject({
  id: z.string().nullish(),
  createdAt: iso.nullish(),
  at: iso.nullish(),
  actor: z.unknown().nullish(),
  actorEmail: z.string().nullish(),
  userId: z.string().nullish(),
  action: z.string(),
  target: z.unknown().nullish(),
  targetType: z.string().nullish(),
  targetId: z.string().nullish(),
  diff: z.unknown().nullish(),
  details: z.unknown().nullish(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditPageSchema = pagedOf(AuditEntrySchema, "audit");

export const CEILING_METRICS = [
  "maxActiveCampaigns",
  "maxSessionsPerMonth",
  "storageBytes",
  "voiceMinutes",
] as const;
export type CeilingMetric = (typeof CEILING_METRICS)[number];

/** What one ceiling allows and how much of it is used (D-188). `max` 0 is no ceiling. */
export const CeilingUtilisationSchema = z.looseObject({
  metric: z.string(),
  used: z.number().default(0),
  max: z.number().default(0),
  percent: z.number().nullish(),
});
export type CeilingUtilisation = z.infer<typeof CeilingUtilisationSchema>;

/** The getting-started checklist, derived by the API from what the tenant has (D-189). */
export const ONBOARDING_STEP_KEYS = ["provider", "template", "campaign", "invite"] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export const OnboardingSchema = z.looseObject({
  steps: z
    .array(
      z.looseObject({
        key: z.string(),
        done: z.boolean().default(false),
        source: z.string().nullish(),
      }),
    )
    .default([]),
  done: z.number().default(0),
  total: z.number().default(0),
  complete: z.boolean().default(false),
  dismissed: z.boolean().default(false),
  next: z.string().nullish(),
});
export type Onboarding = z.infer<typeof OnboardingSchema>;

export const TenantSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string().nullish(),
  region: z.string().nullish(),
  /** The API's field; `defaultBudgetCents` is what an older client read and is kept as a fallback. */
  monthlyBudgetCents: z.number().nullish(),
  defaultBudgetCents: z.number().nullish(),
  createdAt: iso.nullish(),
  utilisation: z.array(CeilingUtilisationSchema).default([]),
  onboarding: OnboardingSchema.nullish(),
});
export type Tenant = z.infer<typeof TenantSchema>;
/** `POST /operator/tenants`: the tenant, and who was invited with it. */
export const TenantCreatedSchema = z.looseObject({
  tenant: TenantSchema,
  invitation: z.looseObject({ to: z.string(), language: z.string() }).nullish(),
});
export type TenantCreated = z.infer<typeof TenantCreatedSchema>;
export const TenantPageSchema = pagedOf(TenantSchema, "tenants");
export const TenantEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "tenant" in raw ? raw.tenant : raw),
  TenantSchema,
);

/** One background queue as `GET /operator/jobs` reports it (D-92). */
export const QueueSummarySchema = z.looseObject({
  name: z.string(),
  queued: z.number(),
  active: z.number(),
  deadLettered: z.number(),
  oldestQueuedAt: iso.nullish(),
  expireInSeconds: z.number(),
  retryLimit: z.number(),
  lastFailure: z.looseObject({ at: iso, jobId: z.string() }).nullish(),
  runNow: z.boolean(),
});
export type QueueSummary = z.infer<typeof QueueSummarySchema>;
export const QueueListSchema = z.looseObject({ queues: z.array(QueueSummarySchema) });

/** A dead-lettered job: identifiers and the last error, never the payload's text. */
export const DeadJobSchema = z.looseObject({
  id: z.string(),
  queue: z.string(),
  createdAt: iso,
  sourceId: z.string().nullish(),
  retryCount: z.number(),
  companyId: z.string().nullish(),
  data: z.record(z.string(), z.string()),
  error: z.string(),
});
export type DeadJob = z.infer<typeof DeadJobSchema>;
export const DeadJobListSchema = z.looseObject({ queue: z.string(), jobs: z.array(DeadJobSchema) });

export const HealthSchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional() });

/** `GET /operator/health` (D-222): every platform signal and each tenant's utilisation. */
export const HealthSignalSchema = z.looseObject({
  key: z.string(),
  status: z.enum(["ok", "warn", "critical", "unknown"]),
  detail: z.string(),
  value: z.union([z.number(), z.string()]).nullish(),
});
export const CeilingUseSchema = z.looseObject({
  metric: z.string(),
  used: z.number(),
  max: z.number(),
  percent: z.number().nullable(),
});
export const TenantHealthSchema = z.looseObject({
  companyId: z.string(),
  name: z.string(),
  status: z.string(),
  sessionsThisMonth: z.number(),
  activeSessions: z.number(),
  spendCents: z.number(),
  budgetLimitCents: z.number().nullable(),
  budgetFraction: z.number().nullable(),
  storageBytes: z.number(),
  voiceMinutes: z.number(),
  lastActivityAt: z.string().nullable(),
  openCampaigns: z.number(),
  deadLetters24h: z.number(),
  firstTokenP95Ms: z.number().nullable(),
  utilisation: z.array(CeilingUseSchema),
});
export const PlatformHealthSchema = z.looseObject({
  generatedAt: z.string(),
  version: z.string().nullable(),
  signals: z.array(HealthSignalSchema),
  providers: z.array(
    z.looseObject({
      providerId: z.string(),
      name: z.string(),
      calls: z.number(),
      failed: z.number(),
      errorRate: z.number(),
      circuit: z.enum(["closed", "half_open", "open"]),
    }),
  ),
  latency: z.looseObject({
    firstTokenP50Ms24h: z.number().nullable(),
    firstTokenP95Ms24h: z.number().nullable(),
    firstTokenTargetMs: z.number(),
    voiceFirstWordP95Ms24h: z.number().nullable(),
    voiceFirstWordTargetMs: z.number(),
  }),
  backup: z.looseObject({
    lastResult: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    ageHours: z.number().nullable(),
    offsite: z.string().nullable(),
    drill: z.looseObject({
      result: z.string().nullable(),
      at: z.string().nullable(),
      error: z.string().nullable(),
      durationS: z.number().nullable(),
    }),
  }),
  tenants: z.array(TenantHealthSchema),
});
export type PlatformHealth = z.infer<typeof PlatformHealthSchema>;

// Phase 2: analysis and report (docs/spec/17)

export const AnalysisStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;
export const EmbeddingModeSchema = z.enum(["provider", "lexical"]);
export type EmbeddingMode = z.infer<typeof EmbeddingModeSchema>;

export const AnalysisStatsSchema = z.looseObject({
  sessions: z.number().default(0),
  facts: z.number().default(0),
  clusters: z.number().default(0),
  participants: z.number().default(0),
  thresholdMet: z.boolean().default(false),
  error: z.string().nullish(),
  embedding: EmbeddingModeSchema.nullish(),
  /** Who started the run (D-324): the owner, the platform at the threshold, or an edit of a version. */
  trigger: z.enum(["manual", "auto", "edit"]).optional().catch(undefined),
  /** An automatic run waits for the interviews still finishing; this is when it starts. */
  autoStartAt: z.string().optional().catch(undefined),
});
export type AnalysisStats = z.infer<typeof AnalysisStatsSchema>;

export const AnalysisSchema = z.looseObject({
  id: z.string(),
  campaignId: z.string().default(""),
  version: z.number().int().default(1),
  status: AnalysisStatusSchema,
  preliminary: z.boolean().default(false),
  stats: AnalysisStatsSchema.default({
    sessions: 0,
    facts: 0,
    clusters: 0,
    participants: 0,
    thresholdMet: false,
  }),
  startedAt: iso.nullish(),
  finishedAt: iso.nullish(),
  createdAt: iso.default(""),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export const AnalysisPageSchema = pagedOf(AnalysisSchema, "analyses");
export const AnalysisEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "analysis" in raw ? raw.analysis : raw),
  AnalysisSchema,
);

/** The contract's factor shape; the rationale is tolerated empty so a thin API answer still renders. */
const OpportunityFactorSchema = z.looseObject({
  score: z.number().min(1).max(5),
  rationale: z.string().default(""),
});
export const OpportunityFactorsSchema = z.object(
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, OpportunityFactorSchema])) as Record<
    FactorKey,
    typeof OpportunityFactorSchema
  >,
);
export type OpportunityFactors = z.infer<typeof OpportunityFactorsSchema>;

export const EvidenceSchema = z.looseObject({
  factId: z.string().default(""),
  snippet: z.string(),
  anonymized: z.boolean().default(true),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const OpportunitySchema = z.looseObject({
  id: z.string(),
  analysisId: z.string().default(""),
  clusterKey: z.string().default(""),
  title: z.string(),
  summary: z.string().default(""),
  solutionClass: SolutionClassSchema,
  factors: OpportunityFactorsSchema,
  rationale: z.string().default(""),
  rankScore: z.number().default(0),
  status: OpportunityStatusSchema.catch("new"),
  adminOverride: OpportunityOverrideSchema.nullable().default(null),
  stats: ClusterStatsSchema.loose(),
  dataNeeded: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  whyNotAi: z.string().nullish(),
  evidence: z.array(EvidenceSchema).default([]),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
export const OpportunityEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "opportunity" in raw ? raw.opportunity : raw),
  OpportunitySchema,
);

/** The queued edit run a merge, split or undo answers with. */
export const ClusterEditResultSchema = z.looseObject({
  analysis: AnalysisSchema,
  editId: z.string().optional(),
});
export type ClusterEditResult = z.infer<typeof ClusterEditResultSchema>;

export const ClusterEditSchema = z.looseObject({
  id: z.string(),
  op: z.enum(["merge", "split"]),
  createdAt: iso,
  revokedAt: iso.nullish(),
  clusters: z.number().int().optional(),
  parts: z.number().int().optional(),
  title: z.string().optional(),
});
export type ClusterEdit = z.infer<typeof ClusterEditSchema>;
export const ClusterEditListSchema = z.object({ edits: z.array(ClusterEditSchema) });

export const ReportSchema = z.looseObject({
  id: z.string(),
  analysisId: z.string().default(""),
  version: z.number().int().default(1),
  markdown: z.string().default(""),
  sections: z.array(z.string()).default([]),
  createdAt: iso.nullish(),
});
export type Report = z.infer<typeof ReportSchema>;

export const AnalysisDetailSchema = z.looseObject({
  analysis: AnalysisSchema,
  opportunities: z.array(OpportunitySchema).default([]),
  report: ReportSchema.nullable().default(null),
});
export type AnalysisDetail = z.infer<typeof AnalysisDetailSchema>;

export const AnalysisDiffSchema = z.looseObject({
  added: z.array(OpportunitySchema).default([]),
  removed: z.array(OpportunitySchema).default([]),
  changed: z.array(z.looseObject({ before: OpportunitySchema, after: OpportunitySchema })).default([]),
});
export type AnalysisDiff = z.infer<typeof AnalysisDiffSchema>;

export const PromoteResultSchema = z.looseObject({
  session: z.looseObject({ id: z.string(), templateKey: z.string().default("requirements_discovery") }),
  handoff: HandoffSchema.loose(),
});
export type PromoteResult = z.infer<typeof PromoteResultSchema>;

// Phase 3: requirements interview (docs/spec/18)

export const RequirementsListItemSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(""),
  status: z.string().default("created"),
  path: PathSchema.nullish(),
  sourceKind: z.string().nullish(),
  ownerUserId: z.string().nullish(),
  ownerEmail: z.string().nullish(),
  versions: z.number().int().default(0),
  openFindings: z.number().int().default(0),
  createdAt: iso.nullish(),
  endedAt: iso.nullish(),
});
export type RequirementsListItem = z.infer<typeof RequirementsListItemSchema>;
export const RequirementsPageSchema = pagedOf(RequirementsListItemSchema, "sessions");

export const RequirementsSessionSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(""),
  status: z.string().default("created"),
  path: PathSchema.nullish(),
  sourceKind: z.string().nullish(),
  ownerUserId: z.string().nullish(),
  handoff: HandoffSchema.loose().nullish(),
  templateId: z.string().nullish(),
  language: z.string().default("en"),
  progress: ProgressSchema.default({ areas: [] }),
  phase: z.string().nullish(),
  createdAt: iso.nullish(),
  startedAt: iso.nullish(),
  endedAt: iso.nullish(),
});
export type RequirementsSession = z.infer<typeof RequirementsSessionSchema>;
export const RequirementsSessionEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "session" in raw ? raw.session : raw),
  RequirementsSessionSchema,
);

/** A finding as the API returns it (shared shape, tolerant of extra fields). */
export const FindingRecordSchema = FindingSchema.loose();
export type FindingRecord = z.infer<typeof FindingRecordSchema>;

export const LiveSectionSchema = SharedLiveSectionSchema.loose();
export type LiveSection = z.infer<typeof LiveSectionSchema>;

/** A diagram of the live spec: generated, edited by the owner, or added by them (FR-23). */
export const LiveDiagramSchema = SharedLiveDiagramSchema.loose();
export type LiveDiagram = z.infer<typeof LiveDiagramSchema>;

const MvpChallengeSchema = z.looseObject({
  started: z.boolean().default(false),
  done: z.boolean().default(false),
  asked: z.array(z.string()).default([]),
  /** What to say about it (D-322): off, still to come, running, finished, or passed over. */
  outcome: z.enum(["off", "pending", "in_progress", "done", "skipped"]).catch("pending").default("pending"),
  endedBy: z.enum(["finish", "turn_limit"]).optional().catch(undefined),
});
const LiveSpecStatsSchema = z.looseObject({
  fields: z.number().int().default(0),
  sectionsWithContent: z.number().int().default(0),
  openFindings: z.number().int().default(0),
});

/** The live spec rendered after each turn; the shared shape with defaults so a thin answer still renders. */
export const LiveSpecSchema = z.looseObject({
  title: z.string().default(""),
  path: PathSchema.nullish(),
  context: z.record(z.string(), z.string()).default({}),
  sections: z.array(LiveSectionSchema).default([]),
  diagrams: z.array(LiveDiagramSchema).default([]),
  findings: z.array(FindingRecordSchema).default([]),
  decisions: z.array(DecisionSchema.loose()).default([]),
  mvpChallenge: MvpChallengeSchema.prefault({}),
  stats: LiveSpecStatsSchema.prefault({}),
});
export type LiveSpec = z.infer<typeof LiveSpecSchema>;
export const LiveSpecEnvelopeSchema = z.looseObject({ spec: LiveSpecSchema });
/** Answer to saving a diagram: the refreshed spec, the key it was saved under, and whether the renderer checked it. */
export const DiagramSaveResultSchema = z.looseObject({
  spec: LiveSpecSchema,
  key: z.string(),
  verified: z.boolean(),
});
export type DiagramSaveResult = z.infer<typeof DiagramSaveResultSchema>;

export const SpecVersionStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type SpecVersionStatus = z.infer<typeof SpecVersionStatusSchema>;

export const SpecVersionSummarySchema = z.looseObject({
  id: z.string(),
  version: z.number().int().default(1),
  label: z.string().nullish(),
  status: SpecVersionStatusSchema,
  error: z.string().nullish(),
  createdBy: z.string().nullish(),
  createdAt: iso.default(""),
  finishedAt: iso.nullish(),
  stats: SpecVersionStatsSchema.loose().prefault({}),
});
export type SpecVersionSummary = z.infer<typeof SpecVersionSummarySchema>;
export const SpecVersionListSchema = listOf(SpecVersionSummarySchema, "versions");
export const SpecVersionEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "version" in raw ? raw.version : raw),
  SpecVersionSummarySchema,
);

export const SpecDocumentRecordSchema = SpecDocumentSchema.loose();
export type SpecDocumentRecord = z.infer<typeof SpecDocumentRecordSchema>;
export const AgentBundleRecordSchema = AgentBundleSchema.loose();
export type AgentBundleRecord = z.infer<typeof AgentBundleRecordSchema>;

/** Document and bundle are absent while the version is queued or running. */
export const SpecVersionDetailSchema = z.looseObject({
  version: SpecVersionSummarySchema,
  document: SpecDocumentRecordSchema.nullish(),
  markdown: z.string().default(""),
  bundle: AgentBundleRecordSchema.nullish(),
  issues: z.array(FindingRecordSchema).default([]),
});
export type SpecVersionDetail = z.infer<typeof SpecVersionDetailSchema>;

export const DiffLineSchema = z.looseObject({
  type: z.enum(["same", "add", "del"]),
  text: z.string().default(""),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;
export const SpecDiffSectionSchema = z.looseObject({
  key: z.string(),
  title: z.string().default(""),
  change: z.enum(["added", "removed", "changed"]),
  lines: z.array(DiffLineSchema).default([]),
});
export type SpecDiffSection = z.infer<typeof SpecDiffSectionSchema>;
const SpecRequirementRecordSchema = SpecRequirementSchema.loose();
export type SpecRequirementRecord = z.infer<typeof SpecRequirementRecordSchema>;
export const SpecDiffSchema = z.looseObject({
  sections: z.array(SpecDiffSectionSchema).default([]),
  requirements: z
    .looseObject({
      added: z.array(SpecRequirementRecordSchema).default([]),
      removed: z.array(SpecRequirementRecordSchema).default([]),
      changed: z
        .array(z.looseObject({ before: SpecRequirementRecordSchema, after: SpecRequirementRecordSchema }))
        .default([]),
    })
    .prefault({}),
});
export type SpecDiff = z.infer<typeof SpecDiffSchema>;

export const SessionInvitationSchema = z.looseObject({
  id: z.string(),
  email: z.string().default(""),
  status: z.string().default("sent"),
  sentAt: iso.nullish(),
  openedAt: iso.nullish(),
  expiresAt: iso.nullish(),
});
export type SessionInvitation = z.infer<typeof SessionInvitationSchema>;
export const SessionInvitationEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "invitation" in raw ? raw.invitation : raw),
  SessionInvitationSchema,
);

export const RequirementsDetailSchema = z.looseObject({
  session: RequirementsSessionSchema,
  messages: z.array(MessageSchema).default([]),
  spec: LiveSpecSchema.prefault({}),
  versions: z.array(SpecVersionSummarySchema).default([]),
  invitations: z.array(SessionInvitationSchema).default([]),
});
export type RequirementsDetail = z.infer<typeof RequirementsDetailSchema>;

export const GitHubPushResultSchema = z.looseObject({
  commitUrl: z.string(),
  files: z.number().int().default(0),
});
export type GitHubPushResult = z.infer<typeof GitHubPushResultSchema>;

export const InviteStatusSchema = z.enum(["open", "revoked", "expired", "completed"]);
export type InviteStatus = z.infer<typeof InviteStatusSchema>;
export const InviteArrivalSchema = z.looseObject({
  session: z.looseObject({
    title: z.string().default(""),
    productName: z.string().default(""),
    purpose: z.string().default(""),
    consentText: z.string().default(""),
    consentVersion: z.string().default(""),
    pathSelection: PathSelectionSchema.default("none"),
    language: z.string().default("en"),
  }),
  status: InviteStatusSchema,
});
export type InviteArrival = z.infer<typeof InviteArrivalSchema>;

// Statements, tenant exports and offboarding (D-224 to D-226; D-376)

export const StatementLineSchema = z.looseObject({
  providerId: z.string().default(""),
  providerName: z.string().default(""),
  model: z.string().default(""),
  purpose: z.string().default(""),
  calls: z.number().default(0),
  inputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  audioSeconds: z.number().default(0),
  ttsCharacters: z.number().default(0),
  costCents: z.number().default(0),
  estimatedCents: z.number().default(0),
});
export type StatementLine = z.infer<typeof StatementLineSchema>;

const StatementCountsSchema = z.looseObject({
  sessionsStarted: z.number().default(0),
  sessionsCompleted: z.number().default(0),
  participants: z.number().default(0),
  voiceMinutes: z.number().default(0),
  storageBytes: z.number().default(0),
  campaignsActive: z.number().default(0),
  analysesRun: z.number().default(0),
  specVersions: z.number().default(0),
});

export const StatementSchema = z.looseObject({
  companyId: z.string(),
  month: z.string(),
  generatedAt: iso.nullish(),
  currency: z.string().default("USD"),
  lines: z.array(StatementLineSchema).default([]),
  totals: z.looseObject({
    costCents: z.number().default(0),
    estimatedCents: z.number().default(0),
    calls: z.number().default(0),
    byPurpose: z.record(z.string(), z.number()).default({}),
    byProvider: z.record(z.string(), z.number()).default({}),
    budgets: z
      .array(
        z.looseObject({
          scope: z.string(),
          scopeId: z.string(),
          name: z.string().nullable().default(null),
          period: z.string(),
          limitCents: z.number(),
          spentCents: z.number(),
          hit: z.boolean().default(false),
        }),
      )
      .default([]),
  }),
  counts: StatementCountsSchema.default(StatementCountsSchema.parse({})),
});
export type Statement = z.infer<typeof StatementSchema>;
export const StatementListSchema = z.looseObject({ statements: z.array(StatementSchema).default([]) });
export const StatementEnvelopeSchema = z.looseObject({ statement: StatementSchema });
export const OperatorStatementsSchema = z.looseObject({
  month: z.string(),
  statements: z.array(StatementSchema).default([]),
});

export const TenantExportSchema = z.looseObject({
  stamp: z.string(),
  companyId: z.string(),
  createdAt: iso,
  requestedBy: z.string().nullish(),
  bytes: z.number().default(0),
  sha256: z.string().default(""),
  files: z.number().default(0),
  skippedFiles: z.number().default(0),
  rows: z.record(z.string(), z.number()).default({}),
});
export type TenantExport = z.infer<typeof TenantExportSchema>;
export const TenantExportListSchema = z.looseObject({ exports: z.array(TenantExportSchema).default([]) });
export const OffboardResultSchema = z.looseObject({
  queued: z.boolean().default(true),
  purgeAfter: z.string().nullish(),
});
export type OffboardResult = z.infer<typeof OffboardResultSchema>;
