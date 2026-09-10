import {
  BudgetLimitSchema,
  CoverageStatusSchema,
  FactSchema,
  InterviewTemplateSchema,
  ModalitySchema,
  ModelInfoSchema,
  ParticipantFieldSchema,
  PathSchema,
  PathSelectionSchema,
  PrivacyModeSchema,
  ProviderKindSchema,
  RouteSchema,
  WidgetResponseSchema,
  WidgetSchema,
} from "@aidp/shared";
import { z } from "zod";

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

export const ParticipantSessionSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  path: PathSchema.nullish(),
  modePreference: ModePreferenceSchema.nullish(),
  consented: z.boolean().default(false),
  progress: ProgressSchema.default({ areas: [] }),
  messages: z.array(MessageSchema).default([]),
  summary: z.string().nullish(),
});
export type ParticipantSession = z.infer<typeof ParticipantSessionSchema>;
export const ParticipantSessionEnvelopeSchema = z.looseObject({ session: ParticipantSessionSchema });

export const SummarySchema = z.looseObject({
  summary: z.string().default(""),
  facts: z.array(FactSchema).default([]),
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
  company: z.looseObject({ id: z.string(), name: z.string() }).nullish(),
});
export type Me = z.infer<typeof MeSchema>;

export const UserSchema = z.looseObject({
  id: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  role: RoleSchema.catch("member"),
  status: z.string().nullish(),
  createdAt: iso.nullish(),
});
export type User = z.infer<typeof UserSchema>;
export const UserListSchema = listOf(UserSchema, "users");

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
export const TemplateEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "template" in raw ? raw.template : raw),
  TemplateRecordSchema,
);

export const TemplateDiffSchema = z.looseObject({
  shipped: z.unknown().nullish(),
  current: z.unknown().nullish(),
  changedFields: z.array(z.string()).default([]),
});
export type TemplateDiff = z.infer<typeof TemplateDiffSchema>;

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
export const CampaignListSchema = listOf(CampaignSchema, "campaigns");
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
export const InvitationListSchema = listOf(InvitationSchema, "invitations");
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
  participantEmail: z.string().nullish(),
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
});
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export const SessionListSchema = listOf(SessionListItemSchema, "sessions");

export const StaffSessionSchema = z.looseObject({
  id: z.string(),
  status: z.string().default("created"),
  campaignId: z.string().nullish(),
  progress: ProgressSchema.nullish(),
  costCents: z.number().nullish(),
  messages: z.array(MessageSchema).nullish(),
  transcriptHidden: z.boolean().nullish(),
  state: z.unknown().nullish(),
  createdAt: iso.nullish(),
  updatedAt: iso.nullish(),
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
});
export type SettingsCatalogEntry = z.infer<typeof SettingsCatalogEntrySchema>;
export const SettingsResponseSchema = z.looseObject({
  values: z.record(z.string(), z.unknown()).default({}),
  catalog: z.array(SettingsCatalogEntrySchema).default([]),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

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
  latencyMs: z.number().nullish(),
  tokens: z.number().nullish(),
  costCents: z.number().nullish(),
  error: z.string().nullish(),
});
export type ProviderTest = z.infer<typeof ProviderTestSchema>;

export const ModelPriceSchema = ModelInfoSchema.loose();
export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export const ModelListSchema = listOf(ModelPriceSchema, "models");
export const PriceListSchema = listOf(ModelPriceSchema, "prices");

export const RouteRecordSchema = RouteSchema.loose().extend({ id: z.string().nullish() });
export type RouteRecord = z.infer<typeof RouteRecordSchema>;
export const RoutesResponseSchema = z.looseObject({ routes: z.array(RouteRecordSchema).default([]) });

export const BudgetRecordSchema = BudgetLimitSchema.loose().extend({
  id: z.string().nullish(),
  spentCents: z.number().nullish(),
});
export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;
export const BudgetListSchema = listOf(BudgetRecordSchema, "budgets");

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
export const AuditListSchema = listOf(AuditEntrySchema, "audit");

export const TenantSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string().nullish(),
  region: z.string().nullish(),
  defaultBudgetCents: z.number().nullish(),
  createdAt: iso.nullish(),
});
export type Tenant = z.infer<typeof TenantSchema>;
export const TenantListSchema = listOf(TenantSchema, "tenants");
export const TenantEnvelopeSchema = z.preprocess(
  (raw) => (raw && typeof raw === "object" && "tenant" in raw ? raw.tenant : raw),
  TenantSchema,
);

export const HealthSchema = z.looseObject({ ok: z.boolean().optional(), status: z.string().optional() });
