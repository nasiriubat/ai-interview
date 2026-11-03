import {
  DepartmentComparisonSchema,
  SplitProposalSchema,
  StatsAiSchema,
  StatsDiscoverySchema,
  StatsHealthSchema,
  StatsParticipationSchema,
  StatsRequirementsSchema,
  type DepartmentComparison,
  type SplitProposal,
  type StatsAi,
  type StatsDiscovery,
  type StatsHealth,
  type StatsParticipation,
  type StatsRange,
  type StatsRequirements,
  type BudgetLimit,
  type FindingOutcome,
  type InterviewTemplateInput,
  type OpportunityOverride,
  type PageInput,
  type Path,
  type Route,
  type TurnControl,
} from "@aidp/shared";
import { type z } from "zod";
import { request, requestStream, type Transport } from "./http";
import type { LISTS, ListQueryOf } from "./lists";
import { recordingName, TranscriptSchema, uploadForm, type TurnInput } from "./participant";
import {
  type DiagramSaveResult,
  DiagramSaveResultSchema,
  type GitHubPushResult,
  GitHubPushResultSchema,
  type LiveSpec,
  LiveSpecEnvelopeSchema,
  type RequirementsDetail,
  RequirementsDetailSchema,
  type RequirementsListItem,
  RequirementsPageSchema,
  type RequirementsSession,
  RequirementsSessionEnvelopeSchema,
  type SessionInvitation,
  SessionInvitationEnvelopeSchema,
  type SpecDiff,
  SpecDiffSchema,
  type SpecVersionDetail,
  SpecVersionDetailSchema,
  SpecVersionEnvelopeSchema,
  SpecVersionListSchema,
  type SpecVersionSummary,
  type Analysis,
  type AnalysisDetail,
  type ClusterEdit,
  ClusterEditListSchema,
  type ClusterEditResult,
  ClusterEditResultSchema,
  ReportReviewResultSchema,
  type ReportReviewView,
  AnalysisDetailSchema,
  type AnalysisDiff,
  AnalysisDiffSchema,
  AnalysisEnvelopeSchema,
  AnalysisPageSchema,
  AuditPageSchema,
  type AuditEntry,
  BudgetPageSchema,
  type BudgetRecord,
  CampaignEnvelopeSchema,
  CampaignPageSchema,
  type Campaign,
  DeadJobListSchema,
  type DeadJob,
  ErrorGroupDetailSchema,
  ErrorGroupPageSchema,
  ErrorGroupEnvelopeSchema,
  ErrorSummarySchema,
  type ErrorGroup,
  type ErrorGroupDetail,
  type ErrorSummary,
  PlatformHealthSchema,
  type PlatformHealth,
  QueueListSchema,
  type QueueSummary,
  type EmailTest,
  EmailTestSchema,
  HealthSchema,
  InvitationPageSchema,
  InvitationResultSchema,
  type Invitation,
  MeSchema,
  type Me,
  type ModelCatalogue,
  ModelCatalogueSchema,
  type ModelPriceInput,
  type ModelPriceRow,
  OkSchema,
  type Opportunity,
  OpportunityEnvelopeSchema,
  type Paged,
  PreviewSessionSchema,
  PricePageSchema,
  PromptCheckSchema,
  PromptDetailSchema,
  PromptDiffSchema,
  PromptListSchema,
  PromptVersionSchema,
  type PromptCheck,
  type PromptDetail,
  type PromptDiff,
  type PromptList,
  type PromptVersion,
  type PromoteResult,
  PromoteResultSchema,
  ProviderEnvelopeSchema,
  ProviderListSchema,
  ProviderTestSchema,
  type Provider,
  type ProviderTest,
  type RouteRecord,
  RoutesResponseSchema,
  type ScopeTarget,
  ScopeTargetListSchema,
  SessionEventListSchema,
  type SessionEvent,
  SessionPageSchema,
  type SessionListItem,
  SettingsResponseSchema,
  type SettingsResponse,
  SpendSchema,
  type Spend,
  type SpendGroupBy,
  StaffSessionEnvelopeSchema,
  type StaffSession,
  StatsSchema,
  type Stats,
  TemplateDiffSchema,
  TemplateEnvelopeSchema,
  TemplateListSchema,
  TemplatePageSchema,
  type TemplateDiff,
  type TemplateListItem,
  type TemplateRecord,
  TenantCreatedSchema,
  TenantEnvelopeSchema,
  TenantPageSchema,
  StatementEnvelopeSchema,
  StatementListSchema,
  OperatorStatementsSchema,
  TenantExportListSchema,
  OffboardResultSchema,
  OnboardingSchema,
  SettingsHistorySchema,
  TemplateVersionsSchema,
  type CeilingMetric,
  type Onboarding,
  type SettingsHistory,
  type TemplateVersion,
  type TenantCreated,
  type Statement,
  type TenantExport,
  type OffboardResult,
  type Tenant,
  type PublicBranding,
  PublicBrandingSchema,
  UserPageSchema,
  type User,
  type VoiceReadiness,
  VoiceReadinessSchema,
} from "./schemas";

/** `from` and `to` travel as ISO strings; unset fields are not sent. */
function rangeQuery(q: StatsRange | undefined): Record<string, string> {
  return {
    ...(q?.from ? { from: q.from.toISOString() } : {}),
    ...(q?.to ? { to: q.to.toISOString() } : {}),
    ...(q?.campaignId ? { campaignId: q.campaignId } : {}),
  };
}

export interface CampaignCreateInput {
  templateId: string;
  name: string;
  participationMode?: string;
  verification?: string;
  allowedEmailDomains?: string[];
  maxTurns?: number;
  completionThreshold?: number;
  expiresAt?: string;
}

export interface ProviderInput {
  kind: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** The mail relay as the form submits it; `password` is `__unchanged__` to keep the stored one. */
export interface SmtpFormBody {
  host: string;
  port: number;
  security: "starttls" | "ssl" | "none";
  username: string;
  password: string | null;
}

/** What a test send may carry beyond the scope: the unsaved form, sender and reply-to. */
export interface EmailTestDraft {
  smtp?: SmtpFormBody;
  from?: string;
  replyTo?: string;
}

export interface SettingsQuery {
  scope?: string;
  scopeId?: string;
}

/** Contract 19: every staff list that can grow takes `limit` (1..200) and `offset`. */
export type PageQuery = PageInput;

/** D-79: each list's search, sort and filters on top of the window (see `LISTS`). */
export type CampaignListQuery = ListQueryOf<(typeof LISTS)["campaigns"]>;
export type CampaignInvitationListQuery = ListQueryOf<(typeof LISTS)["invitations"]>;
export type CampaignSessionListQuery = ListQueryOf<(typeof LISTS)["campaignSessions"]>;
export type AnalysisListQuery = ListQueryOf<(typeof LISTS)["analyses"]>;
export type RequirementsListQuery = ListQueryOf<(typeof LISTS)["requirements"]>;
export type TemplateListQuery = ListQueryOf<(typeof LISTS)["templates"]>;
export type UserListQuery = ListQueryOf<(typeof LISTS)["users"]>;
export type AuditListQuery = ListQueryOf<(typeof LISTS)["audit"]>;
export type BudgetListQuery = ListQueryOf<(typeof LISTS)["budgets"]>;
export type PriceListQuery = ListQueryOf<(typeof LISTS)["prices"]>;
export type TenantListQuery = ListQueryOf<(typeof LISTS)["tenants"]>;
export type ErrorListQuery = ListQueryOf<(typeof LISTS)["errors"]>;

/**
 * `templates.list()` feeds pickers (a campaign's template, a requirements template), which want
 * every usable template rather than a page of them; the catalogue is small, so one full window.
 */
const TEMPLATE_PICKER_LIMIT = 200;

/** The scopes that answer `GET /settings/scopes` with named targets. */
export type ScopeKind = "template" | "campaign" | "tenant";

export interface UserInput {
  email: string;
  name?: string;
  role: string;
}

export interface TenantInput {
  name: string;
  region?: string;
  /** The first admin, who is invited by email (D-189). Required to create, never sent to update. */
  adminEmail?: string;
  monthlyBudgetCents?: number;
  /** The language of the invitation and of the notices the tenant's admins receive. */
  language?: "en" | "fi";
  ceilings?: Partial<Record<CeilingMetric, number>>;
  status?: string;
}

export interface SpendQuery {
  from?: string;
  to?: string;
  groupBy?: SpendGroupBy;
}

/** Statuses an admin can set by hand; `promoted` only ever comes from `promote`. */
export type OpportunityStatusInput = "new" | "shortlisted" | "dismissed";

export interface RequirementsCreateInput {
  title: string;
  prompt?: string;
  path: Path;
  templateId?: string;
  language?: string;
}

export interface GitHubPushInput {
  repository: string;
  branch?: string;
  directory?: string;
  token: string;
  message?: string;
}

export type SpecExportFormat = "md" | "json" | "bundle" | "pdf";

/** What the diagram editor sends (FR-23). The description is the caption and the alt text. */
export interface DiagramInput {
  mermaid: string;
  description: string;
  title?: string;
  type?: "context" | "containers" | "sequence" | "state" | "entity";
}

/** Browser-side download URL of an analysis report as a PDF, through the `/api/staff` proxy. */
export function analysisReportPdfUrl(analysisId: string): string {
  return `/api/staff/analyses/${encodeURIComponent(analysisId)}/report.pdf`;
}

/** Version routes accept the version number (`/versions/:v`). */
export type SpecVersionRef = number | string;

/** Browser-side download URL of a version export, through the `/api/staff` proxy (contract 18). */
export function specExportUrl(sessionId: string, v: SpecVersionRef, format: SpecExportFormat): string {
  const id = encodeURIComponent(sessionId);
  return `/api/staff/requirements/${id}/versions/${encodeURIComponent(String(v))}/export?format=${format}`;
}

/**
 * Staff endpoints (docs/spec/16). Operator routes live under `/operator` and are exposed
 * through the same client with an `operator` namespace.
 */
export function staffApi(transport: Transport): StaffApi {
  const ok = (p: Promise<unknown>): Promise<void> => p.then(() => undefined);
  const envelope = <T extends z.ZodType>(s: T): T => s;
  return {
    me: () => request(transport, { path: "/me", schema: MeSchema }),
    updateProfile: (input) => ok(request(transport, { method: "PATCH", path: "/me", body: input })),
    revokeOwnSessions: () =>
      ok(request(transport, { method: "POST", path: "/me/sessions/revoke", body: { confirm: true } })),
    health: () => request(transport, { path: "/health/ready", schema: HealthSchema }),

    users: {
      list: (q) => request(transport, { path: "/users", query: { ...q }, schema: UserPageSchema }),
      create: (input) => request(transport, { method: "POST", path: "/users", body: input }),
      update: (id, input) => request(transport, { method: "PATCH", path: `/users/${id}`, body: input }),
      remove: (id) => ok(request(transport, { method: "DELETE", path: `/users/${id}` })),
    },

    templates: {
      list: (q) =>
        request(transport, {
          path: "/templates",
          query: { limit: TEMPLATE_PICKER_LIMIT, ...q },
          schema: TemplateListSchema,
        }),
      page: (q) => request(transport, { path: "/templates", query: { ...q }, schema: TemplatePageSchema }),
      get: (id) => request(transport, { path: `/templates/${id}`, schema: envelope(TemplateEnvelopeSchema) }),
      versions: (id) =>
        request(transport, { path: `/templates/${id}/versions`, schema: TemplateVersionsSchema }).then(
          (r) => r.versions,
        ),
      restore: (id) =>
        request(transport, {
          method: "POST",
          path: `/templates/${id}/restore`,
          body: {},
          schema: envelope(TemplateEnvelopeSchema),
        }),
      create: (input, copyFromId) =>
        request(transport, {
          method: "POST",
          path: "/templates",
          body: copyFromId ? { ...input, copyFromId } : input,
          schema: envelope(TemplateEnvelopeSchema),
        }),
      update: (id, input) =>
        request(transport, {
          method: "PUT",
          path: `/templates/${id}`,
          body: input,
          schema: envelope(TemplateEnvelopeSchema),
        }),
      publish: (id) => ok(request(transport, { method: "POST", path: `/templates/${id}/publish` })),
      archive: (id) => ok(request(transport, { method: "POST", path: `/templates/${id}/archive` })),
      diffShipped: (id) =>
        request(transport, { path: `/templates/${id}/diff-shipped`, schema: TemplateDiffSchema }),
      preview: (id) =>
        request(transport, {
          method: "POST",
          path: `/templates/${id}/preview`,
          schema: PreviewSessionSchema,
        }),
    },

    campaigns: {
      list: (q) => request(transport, { path: "/campaigns", query: { ...q }, schema: CampaignPageSchema }),
      get: (id) => request(transport, { path: `/campaigns/${id}`, schema: envelope(CampaignEnvelopeSchema) }),
      create: (input) =>
        request(transport, {
          method: "POST",
          path: "/campaigns",
          body: input,
          schema: envelope(CampaignEnvelopeSchema),
        }),
      update: (id, input) =>
        request(transport, {
          method: "PATCH",
          path: `/campaigns/${id}`,
          body: input,
          schema: envelope(CampaignEnvelopeSchema),
        }),
      open: (id) => ok(request(transport, { method: "POST", path: `/campaigns/${id}/open` })),
      close: (id) => ok(request(transport, { method: "POST", path: `/campaigns/${id}/close` })),
      invite: (id, emails) =>
        request(transport, {
          method: "POST",
          path: `/campaigns/${id}/invitations`,
          body: { emails },
          schema: InvitationResultSchema,
        }),
      invitations: (id, q) =>
        request(transport, {
          path: `/campaigns/${id}/invitations`,
          query: { ...q },
          schema: InvitationPageSchema,
        }),
      remind: (id, invId) =>
        ok(request(transport, { method: "POST", path: `/campaigns/${id}/invitations/${invId}/remind` })),
      revoke: (id, invId) =>
        ok(request(transport, { method: "POST", path: `/campaigns/${id}/invitations/${invId}/revoke` })),
      sessions: (id, q) =>
        request(transport, { path: `/campaigns/${id}/sessions`, query: { ...q }, schema: SessionPageSchema }),
    },

    sessions: {
      get: (id) =>
        request(transport, { path: `/sessions/${id}`, schema: envelope(StaffSessionEnvelopeSchema) }),
      events: (id) => request(transport, { path: `/sessions/${id}/events`, schema: SessionEventListSchema }),
      acknowledgeFlag: (id, note) =>
        ok(
          request(transport, {
            method: "POST",
            path: `/sessions/${id}/flag/ack`,
            body: note ? { note } : {},
          }),
        ),
    },

    analyses: {
      start: (campaignId) =>
        request(transport, {
          method: "POST",
          path: `/campaigns/${campaignId}/analyses`,
          body: {},
          schema: envelope(AnalysisEnvelopeSchema),
        }),
      list: (campaignId, q) =>
        request(transport, {
          path: `/campaigns/${campaignId}/analyses`,
          query: { ...q },
          schema: AnalysisPageSchema,
        }),
      get: (id) => request(transport, { path: `/analyses/${id}`, schema: AnalysisDetailSchema }),
      diff: (id, otherId) =>
        request(transport, { path: `/analyses/${id}/diff/${otherId}`, schema: AnalysisDiffSchema }),
      departments: (id) =>
        request(transport, { path: `/analyses/${id}/departments`, schema: DepartmentComparisonSchema }),
      merge: (id, body) =>
        request(transport, {
          method: "POST",
          path: `/analyses/${id}/opportunities/merge`,
          body,
          schema: ClusterEditResultSchema,
        }),
      clusterEdits: (campaignId) =>
        request(transport, {
          path: `/campaigns/${campaignId}/cluster-edits`,
          schema: ClusterEditListSchema,
        }).then((r) => r.edits),
      undoClusterEdit: (campaignId, editId) =>
        request(transport, {
          method: "DELETE",
          path: `/campaigns/${campaignId}/cluster-edits/${editId}`,
          schema: ClusterEditResultSchema,
        }),
      review: (id, status) =>
        request(transport, {
          method: "POST",
          path: `/analyses/${id}/review`,
          body: { status },
          schema: ReportReviewResultSchema,
        }).then((r) => r.review),
    },

    opportunities: {
      override: (id, override) =>
        request(transport, {
          method: "PATCH",
          path: `/opportunities/${id}`,
          body: override,
          schema: envelope(OpportunityEnvelopeSchema),
        }),
      setStatus: (id, status) =>
        request(transport, {
          method: "POST",
          path: `/opportunities/${id}/status`,
          body: { status },
          schema: envelope(OpportunityEnvelopeSchema),
        }),
      promote: (id) =>
        request(transport, {
          method: "POST",
          path: `/opportunities/${id}/promote`,
          body: {},
          schema: PromoteResultSchema,
        }),
      splitProposal: (id) =>
        request(transport, { path: `/opportunities/${id}/split-proposal`, schema: SplitProposalSchema }),
      split: (id, parts) =>
        request(transport, {
          method: "POST",
          path: `/opportunities/${id}/split`,
          body: { parts },
          schema: ClusterEditResultSchema,
        }),
    },

    settings: {
      get: (q) => request(transport, { path: "/settings", query: { ...q }, schema: SettingsResponseSchema }),
      scopes: (scope) =>
        request(transport, { path: "/settings/scopes", query: { scope }, schema: ScopeTargetListSchema }),
      emailTest: (q, draft) =>
        request(transport, {
          method: "POST",
          path: "/settings/email/test",
          // The route reads the scope from the body; sending it as a query string tested the
          // tenant chain whichever scope was selected. A draft tests the form without saving it.
          body: { scope: q.scope === "platform" ? "platform" : "tenant", ...(draft ?? {}) },
          schema: EmailTestSchema,
        }),
      history: (q = {}) =>
        request(transport, { path: "/settings/history", query: { ...q }, schema: SettingsHistorySchema }),
      put: (q, values, smtp) =>
        ok(
          request(transport, {
            method: "PUT",
            path: "/settings",
            query: { ...q },
            body: { values, ...(smtp ? { smtp } : {}) },
            schema: OkSchema,
          }),
        ),
    },

    branding: {
      uploadLogo: (file) => {
        const form = new FormData();
        form.append("file", file, file.name);
        return request(transport, {
          method: "PUT",
          path: "/operator/branding/logo",
          body: form,
          schema: PublicBrandingSchema,
        });
      },
      removeLogo: () =>
        request(transport, {
          method: "DELETE",
          path: "/operator/branding/logo",
          schema: PublicBrandingSchema,
        }),
    },

    prompts: {
      list: () => request(transport, { path: "/prompts", schema: PromptListSchema }),
      get: (key) =>
        request(transport, { path: `/prompts/${encodeURIComponent(key)}`, schema: PromptDetailSchema }),
      diff: (key, from, to) =>
        request(transport, {
          path: `/prompts/${encodeURIComponent(key)}/diff`,
          query: { from, to },
          schema: PromptDiffSchema,
        }),
      check: (key, body) =>
        request(transport, {
          method: "POST",
          path: `/prompts/${encodeURIComponent(key)}/check`,
          body: { body },
          schema: PromptCheckSchema,
        }),
      create: (key, input) =>
        request(transport, {
          method: "POST",
          path: `/prompts/${encodeURIComponent(key)}/versions`,
          body: input,
          schema: PromptVersionSchema,
        }),
      activate: (key, version, canaryShare) =>
        ok(
          request(transport, {
            method: "POST",
            path: `/prompts/${encodeURIComponent(key)}/versions/${String(version)}/activate`,
            body: { canaryShare },
          }),
        ),
      stopCanary: (key) =>
        ok(request(transport, { method: "DELETE", path: `/prompts/${encodeURIComponent(key)}/canary` })),
      rollback: (key) =>
        ok(
          request(transport, {
            method: "POST",
            path: `/prompts/${encodeURIComponent(key)}/rollback`,
            body: {},
          }),
        ),
      reset: (key) =>
        ok(
          request(transport, { method: "POST", path: `/prompts/${encodeURIComponent(key)}/reset`, body: {} }),
        ),
    },

    onboarding: {
      get: () => request(transport, { path: "/onboarding", schema: OnboardingSchema }),
      dismiss: () =>
        request(transport, {
          method: "POST",
          path: "/onboarding/dismiss",
          body: {},
          schema: OnboardingSchema,
        }),
    },

    voice: {
      readiness: () => request(transport, { path: "/admin/voice/readiness", schema: VoiceReadinessSchema }),
      connectOpenAI: (apiKey) =>
        request(transport, {
          method: "POST",
          path: "/admin/voice/openai",
          body: { apiKey },
          schema: VoiceReadinessSchema,
        }),
      setLive: (enabled) =>
        request(transport, {
          method: "PUT",
          path: "/admin/voice/live",
          body: { enabled },
          schema: VoiceReadinessSchema,
        }),
    },

    providers: {
      list: () => request(transport, { path: "/providers", schema: ProviderListSchema }),
      create: (input) =>
        request(transport, {
          method: "POST",
          path: "/providers",
          body: input,
          schema: envelope(ProviderEnvelopeSchema),
        }),
      update: (id, input) =>
        request(transport, {
          method: "PATCH",
          path: `/providers/${id}`,
          body: input,
          schema: envelope(ProviderEnvelopeSchema),
        }),
      remove: (id) => ok(request(transport, { method: "DELETE", path: `/providers/${id}` })),
      test: (id) =>
        request(transport, { method: "POST", path: `/providers/${id}/test`, schema: ProviderTestSchema }),
      models: (id) => request(transport, { path: `/providers/${id}/models`, schema: ModelCatalogueSchema }),
      prices: (id, q) =>
        request(transport, { path: `/providers/${id}/prices`, query: { ...q }, schema: PricePageSchema }),
      putPrices: (id, prices) =>
        ok(request(transport, { method: "PUT", path: `/providers/${id}/prices`, body: { prices } })),
    },

    routes: {
      get: () => request(transport, { path: "/routes", schema: RoutesResponseSchema }).then((r) => r.routes),
      put: (routes) => ok(request(transport, { method: "PUT", path: "/routes", body: { routes } })),
    },

    budgets: {
      list: (q) => request(transport, { path: "/budgets", query: { ...q }, schema: BudgetPageSchema }),
      create: (input) => request(transport, { method: "POST", path: "/budgets", body: input }),
      remove: (id) => ok(request(transport, { method: "DELETE", path: `/budgets/${id}` })),
    },

    spend: (q) => request(transport, { path: "/spend", query: { ...q }, schema: SpendSchema }),
    statements: {
      list: () =>
        request(transport, { path: "/spend/statements", schema: StatementListSchema }).then(
          (r) => r.statements,
        ),
      get: (month) =>
        request(transport, {
          path: `/spend/statements/${encodeURIComponent(month)}`,
          schema: StatementEnvelopeSchema,
        }).then((r) => r.statement),
    },
    stats: () => request(transport, { path: "/stats", schema: StatsSchema }),
    statsSegments: {
      participation: (q) =>
        request(transport, {
          path: "/stats/participation",
          query: rangeQuery(q),
          schema: StatsParticipationSchema,
        }),
      discovery: (q) =>
        request(transport, { path: "/stats/discovery", query: rangeQuery(q), schema: StatsDiscoverySchema }),
      requirements: (q) =>
        request(transport, {
          path: "/stats/requirements",
          query: rangeQuery(q),
          schema: StatsRequirementsSchema,
        }),
      ai: (q) => request(transport, { path: "/stats/ai", query: rangeQuery(q), schema: StatsAiSchema }),
      health: () => request(transport, { path: "/stats/health", schema: StatsHealthSchema }),
    },
    audit: (q) => request(transport, { path: "/audit", query: { ...q }, schema: AuditPageSchema }),

    requirements: {
      list: (q) =>
        request(transport, { path: "/requirements", query: { ...q }, schema: RequirementsPageSchema }),
      create: (input) =>
        request(transport, {
          method: "POST",
          path: "/requirements",
          body: input,
          schema: envelope(RequirementsSessionEnvelopeSchema),
        }),
      get: (id) => request(transport, { path: `/requirements/${id}`, schema: RequirementsDetailSchema }),
      setPath: (id, path) =>
        ok(request(transport, { method: "POST", path: `/requirements/${id}/path`, body: { path } })),
      complete: (id) => ok(request(transport, { method: "POST", path: `/requirements/${id}/complete` })),
      reopen: (id) => ok(request(transport, { method: "POST", path: `/requirements/${id}/reopen` })),
      editSection: (id, key, markdown) =>
        request(transport, {
          method: "PUT",
          path: `/requirements/${id}/sections/${encodeURIComponent(key)}`,
          body: { markdown },
          schema: LiveSpecEnvelopeSchema,
        }).then((r) => r.spec),
      diagrams: {
        save: (id, key, input) =>
          request(transport, {
            method: key === null ? "POST" : "PUT",
            path:
              key === null
                ? `/requirements/${id}/spec/diagrams`
                : `/requirements/${id}/spec/diagrams/${encodeURIComponent(key)}`,
            body: input,
            schema: DiagramSaveResultSchema,
          }),
        reset: (id, key) =>
          request(transport, {
            method: "DELETE",
            path: `/requirements/${id}/spec/diagrams/${encodeURIComponent(key)}`,
            schema: LiveSpecEnvelopeSchema,
          }).then((r) => r.spec),
      },
      settleFinding: (id, findingId, outcome, note) =>
        request(transport, {
          method: "POST",
          path: `/requirements/${id}/findings/${encodeURIComponent(findingId)}`,
          body: { outcome, ...(note ? { note } : {}) },
          schema: LiveSpecEnvelopeSchema,
        }).then((r) => r.spec),
      transcribe: (id, audio, durationMs) =>
        request(transport, {
          method: "POST",
          path: `/requirements/${id}/transcribe`,
          body: uploadForm(audio, recordingName(audio.type), durationMs),
          schema: TranscriptSchema,
        }).then((r) => r.text),
      sendTurn: (id, input, signal) =>
        requestStream(transport, {
          method: "POST",
          path: `/requirements/${id}/turns`,
          ...(input ? { body: input } : {}),
          signal,
        }),
      sendControl: (id, control, signal) =>
        requestStream(transport, {
          method: "POST",
          path: `/requirements/${id}/turns`,
          body: { control },
          signal,
        }),
      versions: {
        create: (id, label) =>
          request(transport, {
            method: "POST",
            path: `/requirements/${id}/versions`,
            body: label ? { label } : {},
            schema: envelope(SpecVersionEnvelopeSchema),
          }),
        list: (id) =>
          request(transport, { path: `/requirements/${id}/versions`, schema: SpecVersionListSchema }),
        get: (id, v) =>
          request(transport, { path: `/requirements/${id}/versions/${v}`, schema: SpecVersionDetailSchema }),
        diff: (id, v, other) =>
          request(transport, {
            path: `/requirements/${id}/versions/${v}/diff/${other}`,
            schema: SpecDiffSchema,
          }),
        exportUrl: specExportUrl,
        github: (id, v, input) =>
          request(transport, {
            method: "POST",
            path: `/requirements/${id}/versions/${v}/github`,
            body: input,
            schema: GitHubPushResultSchema,
          }),
      },
      invitations: {
        create: (id, email) =>
          request(transport, {
            method: "POST",
            path: `/requirements/${id}/invitations`,
            body: { email },
            schema: envelope(SessionInvitationEnvelopeSchema),
          }),
        revoke: (id, invId) =>
          ok(request(transport, { method: "POST", path: `/requirements/${id}/invitations/${invId}/revoke` })),
      },
    },

    operator: {
      tenants: {
        list: (q) =>
          request(transport, { path: "/operator/tenants", query: { ...q }, schema: TenantPageSchema }),
        create: (input) =>
          request(transport, {
            method: "POST",
            path: "/operator/tenants",
            body: input,
            schema: TenantCreatedSchema,
          }),
        update: (id, input) =>
          request(transport, {
            method: "PATCH",
            path: `/operator/tenants/${id}`,
            body: input,
            schema: envelope(TenantEnvelopeSchema),
          }),
        exports: (id) =>
          request(transport, {
            path: `/operator/tenants/${encodeURIComponent(id)}/exports`,
            schema: TenantExportListSchema,
          }).then((r) => r.exports),
        requestExport: (id) =>
          ok(
            request(transport, {
              method: "POST",
              path: `/operator/tenants/${encodeURIComponent(id)}/export`,
            }),
          ),
        offboard: (id, body) =>
          request(transport, {
            method: "POST",
            path: `/operator/tenants/${encodeURIComponent(id)}/offboard`,
            body,
            schema: OffboardResultSchema,
          }),
      },
      statements: (month) =>
        request(transport, {
          path: `/operator/statements/${encodeURIComponent(month)}`,
          schema: OperatorStatementsSchema,
        }),
      providers: {
        list: () => request(transport, { path: "/operator/providers", schema: ProviderListSchema }),
        create: (input) =>
          request(transport, {
            method: "POST",
            path: "/operator/providers",
            body: input,
            schema: envelope(ProviderEnvelopeSchema),
          }),
        update: (id, input) =>
          request(transport, {
            method: "PATCH",
            path: `/operator/providers/${id}`,
            body: input,
            schema: envelope(ProviderEnvelopeSchema),
          }),
        remove: (id) => ok(request(transport, { method: "DELETE", path: `/operator/providers/${id}` })),
        test: (id) =>
          request(transport, {
            method: "POST",
            path: `/operator/providers/${id}/test`,
            schema: ProviderTestSchema,
          }),
        models: (id) =>
          request(transport, { path: `/operator/providers/${id}/models`, schema: ModelCatalogueSchema }),
        prices: (id, q) =>
          request(transport, {
            path: `/operator/providers/${id}/prices`,
            query: { ...q },
            schema: PricePageSchema,
          }),
        putPrices: (id, prices) =>
          ok(
            request(transport, { method: "PUT", path: `/operator/providers/${id}/prices`, body: { prices } }),
          ),
      },
      routes: {
        get: () =>
          request(transport, { path: "/operator/routes", schema: RoutesResponseSchema }).then(
            (r) => r.routes,
          ),
        put: (routes) =>
          ok(request(transport, { method: "PUT", path: "/operator/routes", body: { routes } })),
      },
      stats: () => request(transport, { path: "/operator/stats", schema: StatsSchema }),
      health: () => request(transport, { path: "/operator/health", schema: PlatformHealthSchema }),
      jobs: {
        list: () =>
          request(transport, { path: "/operator/jobs", schema: QueueListSchema }).then((r) => r.queues),
        dead: (queue, limit) =>
          request(transport, {
            path: "/operator/jobs/dead",
            query: { queue, ...(limit ? { limit } : {}) },
            schema: DeadJobListSchema,
          }).then((r) => r.jobs),
        retry: (queue, id) =>
          ok(
            request(transport, {
              method: "POST",
              path: `/operator/jobs/dead/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/retry`,
            }),
          ),
        discard: (queue, id) =>
          ok(
            request(transport, {
              method: "POST",
              path: `/operator/jobs/dead/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/discard`,
            }),
          ),
        runNow: (name) =>
          ok(request(transport, { method: "POST", path: `/operator/jobs/run/${encodeURIComponent(name)}` })),
      },
      errors: {
        list: (q) =>
          request(transport, { path: "/operator/errors", query: { ...q }, schema: ErrorGroupPageSchema }),
        summary: () => request(transport, { path: "/operator/errors/summary", schema: ErrorSummarySchema }),
        get: (id) =>
          request(transport, {
            path: `/operator/errors/${encodeURIComponent(id)}`,
            schema: ErrorGroupDetailSchema,
          }),
        resolve: (id) =>
          request(transport, {
            method: "POST",
            path: `/operator/errors/${encodeURIComponent(id)}/resolve`,
            schema: ErrorGroupEnvelopeSchema,
          }).then((r) => r.group),
        remove: (id) =>
          ok(request(transport, { method: "DELETE", path: `/operator/errors/${encodeURIComponent(id)}` })),
      },
    },
  };
}

export interface ProvidersApi {
  list(): Promise<Provider[]>;
  create(input: ProviderInput): Promise<Provider>;
  update(id: string, input: Partial<ProviderInput>): Promise<Provider>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<ProviderTest>;
  /** The provider's own catalogue with the prices it publishes (contract 19). */
  models(id: string): Promise<ModelCatalogue>;
  prices(id: string, q?: PriceListQuery): Promise<Paged<ModelPriceRow>>;
  putPrices(id: string, prices: ModelPriceInput[]): Promise<void>;
}

export interface RoutesApi {
  get(): Promise<RouteRecord[]>;
  put(routes: Route[]): Promise<void>;
}

export interface RequirementsApi {
  list(q?: RequirementsListQuery): Promise<Paged<RequirementsListItem>>;
  create(input: RequirementsCreateInput): Promise<RequirementsSession>;
  get(id: string): Promise<RequirementsDetail>;
  setPath(id: string, path: Path): Promise<void>;
  complete(id: string): Promise<void>;
  reopen(id: string): Promise<void>;
  /** An empty string clears the owner's edit. Returns the refreshed live spec. */
  editSection(id: string, key: string, markdown: string): Promise<LiveSpec>;
  diagrams: {
    /** `null` adds a diagram; a key edits that one. A source the renderer refuses answers 400 with `details.issues`. */
    save(id: string, key: string | null, input: DiagramInput): Promise<DiagramSaveResult>;
    /** Puts a generated diagram back, or removes one the owner added. */
    reset(id: string, key: string): Promise<LiveSpec>;
  };
  settleFinding(id: string, findingId: string, outcome: FindingOutcome, note?: string): Promise<LiveSpec>;
  /** Same SSE stream as the participant turn, plus `event: spec` after each turn. */
  sendTurn(id: string, input: TurnInput | undefined, signal?: AbortSignal): Promise<Response>;
  /** A recording to an editable draft for the answer box; nothing is sent (D-483). */
  transcribe(id: string, audio: Blob, durationMs?: number): Promise<string>;
  /** "I'm done" and the other participant controls, as a state operation rather than a message (D-170). */
  sendControl(id: string, control: TurnControl, signal?: AbortSignal): Promise<Response>;
  versions: {
    create(id: string, label?: string): Promise<SpecVersionSummary>;
    list(id: string): Promise<SpecVersionSummary[]>;
    get(id: string, v: SpecVersionRef): Promise<SpecVersionDetail>;
    diff(id: string, v: SpecVersionRef, other: SpecVersionRef): Promise<SpecDiff>;
    exportUrl(id: string, v: SpecVersionRef, format: SpecExportFormat): string;
    github(id: string, v: SpecVersionRef, input: GitHubPushInput): Promise<GitHubPushResult>;
  };
  invitations: {
    create(id: string, email: string): Promise<SessionInvitation>;
    revoke(id: string, invId: string): Promise<void>;
  };
}

export interface StaffApi {
  me(): Promise<Me>;
  /** The signed-in person's own display name (D-344). `null` clears it. */
  updateProfile(input: { name: string | null }): Promise<void>;
  /** Ends every session of the signed-in person on every device, this one included (D-344). */
  revokeOwnSessions(): Promise<void>;
  health(): Promise<unknown>;
  users: {
    list(q?: UserListQuery): Promise<Paged<User>>;
    create(input: UserInput): Promise<unknown>;
    update(id: string, input: Partial<UserInput> & { disabled?: boolean }): Promise<unknown>;
    remove(id: string): Promise<void>;
  };
  templates: {
    /** Every usable template in one call, for pickers; archived versions only when asked for. */
    list(q?: TemplateListQuery): Promise<TemplateListItem[]>;
    /** One page of templates with the counters, for the templates table (D-79). */
    page(q?: TemplateListQuery): Promise<Paged<TemplateListItem>>;
    get(id: string): Promise<TemplateRecord>;
    create(input: InterviewTemplateInput, copyFromId?: string): Promise<TemplateRecord>;
    update(id: string, input: InterviewTemplateInput): Promise<TemplateRecord>;
    publish(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    diffShipped(id: string): Promise<TemplateDiff>;
    preview(id: string): Promise<{ participantToken: string; sessionId: string }>;
    /** Every version of the template's key, newest first (FR-62). */
    versions(id: string): Promise<TemplateVersion[]>;
    /** A new version with the content of version `id`; history is never rewritten (D-183). */
    restore(id: string): Promise<TemplateRecord>;
  };
  campaigns: {
    list(q?: CampaignListQuery): Promise<Paged<Campaign>>;
    get(id: string): Promise<Campaign>;
    create(input: CampaignCreateInput): Promise<Campaign>;
    update(id: string, input: Partial<CampaignCreateInput> & { status?: string }): Promise<Campaign>;
    open(id: string): Promise<void>;
    close(id: string): Promise<void>;
    invite(id: string, emails: string[]): Promise<{ created: number; skipped: number }>;
    invitations(id: string, q?: CampaignInvitationListQuery): Promise<Paged<Invitation>>;
    remind(id: string, invId: string): Promise<void>;
    revoke(id: string, invId: string): Promise<void>;
    sessions(id: string, q?: CampaignSessionListQuery): Promise<Paged<SessionListItem>>;
  };
  sessions: {
    get(id: string): Promise<StaffSession>;
    events(id: string): Promise<SessionEvent[]>;
    /** A person has looked at a flagged interview; audited, and idempotent. */
    acknowledgeFlag(id: string, note?: string): Promise<void>;
  };
  /** Contract 17: analysis runs are versioned per campaign. */
  analyses: {
    start(campaignId: string): Promise<Analysis>;
    list(campaignId: string, q?: AnalysisListQuery): Promise<Paged<Analysis>>;
    get(id: string): Promise<AnalysisDetail>;
    diff(id: string, otherId: string): Promise<AnalysisDiff>;
    /** Department comparison under the anonymity rule: groups below k are not in the answer (FR-17). */
    departments(id: string): Promise<DepartmentComparison>;
    /** Merges opportunities of the newest analysis; the answer is the queued edit run (FR-18). */
    merge(id: string, body: { opportunityIds: string[]; title?: string }): Promise<ClusterEditResult>;
    clusterEdits(campaignId: string): Promise<ClusterEdit[]>;
    undoClusterEdit(campaignId: string, editId: string): Promise<ClusterEditResult>;
    /** Marks the report of a version reviewed, or returns it to draft (D-478). */
    review(id: string, status: "draft" | "reviewed"): Promise<ReportReviewView>;
  };
  opportunities: {
    /** The cluster's facts as text, grouped by similarity, for the split dialog. */
    splitProposal(id: string): Promise<SplitProposal>;
    split(id: string, parts: string[][]): Promise<ClusterEditResult>;
    override(id: string, override: OpportunityOverride): Promise<Opportunity>;
    setStatus(id: string, status: OpportunityStatusInput): Promise<Opportunity>;
    promote(id: string): Promise<PromoteResult>;
  };
  settings: {
    get(q: SettingsQuery): Promise<SettingsResponse>;
    /** `smtp` is the structured mail relay; the API composes it into `email.smtpUrl`. */
    put(q: SettingsQuery, values: Record<string, unknown>, smtp?: SmtpFormBody): Promise<void>;
    /** Named targets for a scope picker, newest first (contract 19). */
    scopes(scope: ScopeKind): Promise<ScopeTarget[]>;
    /** Sends a test message with the configuration in effect for the scope. */
    emailTest(q: SettingsQuery, draft?: EmailTestDraft): Promise<EmailTest>;
    /** Who changed which keys and when, newest first (D-182). */
    history(q?: {
      scope?: string;
      scopeId?: string;
      key?: string;
      limit?: number;
      before?: string;
    }): Promise<SettingsHistory>;
  };
  /** The platform's logo, written by the platform operator only (D-434). */
  branding: {
    uploadLogo(file: File): Promise<PublicBranding>;
    removeLogo(): Promise<PublicBranding>;
  };
  /** Prompt administration: tenant versions, canaries and the built-in prompts they replace (D-230). */
  prompts: {
    list(): Promise<PromptList>;
    get(key: string): Promise<PromptDetail>;
    /** Line diff of two bodies; each side is `shipped` or a version number. */
    diff(key: string, from: string, to: string): Promise<PromptDiff>;
    /** Validates a draft against the contract without storing it. */
    check(key: string, body: string): Promise<PromptCheck>;
    create(
      key: string,
      input: { body: string; note?: string; parentVersion?: number },
    ): Promise<PromptVersion>;
    /** `canaryShare` 1 makes the version the stable one; between 0 and 1 starts a canary. */
    activate(key: string, version: number, canaryShare: number): Promise<void>;
    stopCanary(key: string): Promise<void>;
    rollback(key: string): Promise<void>;
    reset(key: string): Promise<void>;
  };
  /** The getting-started checklist (D-189). */
  onboarding: {
    get(): Promise<Onboarding>;
    dismiss(): Promise<Onboarding>;
  };
  providers: ProvidersApi;
  routes: RoutesApi;
  /** Live voice as one switch with a readiness check (D-77). */
  voice: {
    readiness(): Promise<VoiceReadiness>;
    /** Checks the key with OpenAI, stores it encrypted and routes the voice purposes. Never echoed. */
    connectOpenAI(apiKey: string): Promise<VoiceReadiness>;
    /** Fails with `voice_not_ready` (details.missing) when a required route is missing. */
    setLive(enabled: boolean): Promise<VoiceReadiness>;
  };
  budgets: {
    list(q?: BudgetListQuery): Promise<Paged<BudgetRecord>>;
    create(input: BudgetLimit): Promise<unknown>;
    remove(id: string): Promise<void>;
  };
  spend(q: SpendQuery): Promise<Spend>;
  /** Monthly statements, frozen on the 1st (D-224); administrators only. */
  statements: {
    list(): Promise<Statement[]>;
    get(month: string): Promise<Statement>;
  };
  stats(): Promise<Stats>;
  /** Dashboard segments (spec 07); each is parsed with the contract the API serves. */
  statsSegments: {
    participation(q?: StatsRange): Promise<StatsParticipation>;
    discovery(q?: StatsRange): Promise<StatsDiscovery>;
    requirements(q?: StatsRange): Promise<StatsRequirements>;
    ai(q?: StatsRange): Promise<StatsAi>;
    health(): Promise<StatsHealth>;
  };
  audit(q?: AuditListQuery): Promise<Paged<AuditEntry>>;
  /** Contract 18: requirements sessions owned by staff, their live spec, versions and invitations. */
  requirements: RequirementsApi;
  operator: {
    tenants: {
      list(q?: TenantListQuery): Promise<Paged<Tenant>>;
      create(input: TenantInput): Promise<TenantCreated>;
      update(id: string, input: Partial<TenantInput>): Promise<Tenant>;
      /** The sealed archives taken of a tenant, newest first (D-225). */
      exports(id: string): Promise<TenantExport[]>;
      requestExport(id: string): Promise<void>;
      offboard(id: string, body: { confirmName: string; immediate: boolean }): Promise<OffboardResult>;
    };
    /** Every tenant's frozen statement for one month, for invoicing (D-224). */
    statements(month: string): Promise<{ month: string; statements: Statement[] }>;
    providers: ProvidersApi;
    routes: RoutesApi;
    stats(): Promise<Stats>;
    /** Every platform signal and each tenant's utilisation on one page (D-222). */
    health(): Promise<PlatformHealth>;
    /** The background queue: counters, dead letters, and the verbs that act on them (D-92). */
    jobs: {
      list(): Promise<QueueSummary[]>;
      dead(queue: string, limit?: number): Promise<DeadJob[]>;
      retry(queue: string, id: string): Promise<void>;
      discard(queue: string, id: string): Promise<void>;
      runNow(name: string): Promise<void>;
    };
    /** The built-in error log (D-477): groups, one group's occurrences, the badge numbers. */
    errors: {
      list(q?: ErrorListQuery): Promise<Paged<ErrorGroup>>;
      summary(): Promise<ErrorSummary>;
      get(id: string): Promise<ErrorGroupDetail>;
      resolve(id: string): Promise<ErrorGroup>;
      remove(id: string): Promise<void>;
    };
  };
}
