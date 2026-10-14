import type {
  BudgetLimit,
  FindingOutcome,
  InterviewTemplateInput,
  OpportunityOverride,
  PageInput,
  Path,
  Route,
  TurnControl,
} from "@aidp/shared";
import { type z } from "zod";
import { request, requestStream, type Transport } from "./http";
import type { LISTS, ListQueryOf } from "./lists";
import type { TurnInput } from "./participant";
import {
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
  QueueListSchema,
  type QueueSummary,
  type EmailTest,
  EmailTestSchema,
  HealthSchema,
  InvitationListSchema,
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
  TenantEnvelopeSchema,
  TenantPageSchema,
  type Tenant,
  UserPageSchema,
  type User,
  type VoiceReadiness,
  VoiceReadinessSchema,
} from "./schemas";

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

export interface SettingsQuery {
  scope?: string;
  scopeId?: string;
}

/** Contract 19: every staff list that can grow takes `limit` (1..200) and `offset`. */
export type PageQuery = PageInput;

/** D-79: each list's search, sort and filters on top of the window (see `LISTS`). */
export type CampaignListQuery = ListQueryOf<(typeof LISTS)["campaigns"]>;
export type CampaignSessionListQuery = ListQueryOf<(typeof LISTS)["campaignSessions"]>;
export type AnalysisListQuery = ListQueryOf<(typeof LISTS)["analyses"]>;
export type RequirementsListQuery = ListQueryOf<(typeof LISTS)["requirements"]>;
export type TemplateListQuery = ListQueryOf<(typeof LISTS)["templates"]>;
export type UserListQuery = ListQueryOf<(typeof LISTS)["users"]>;
export type AuditListQuery = ListQueryOf<(typeof LISTS)["audit"]>;
export type BudgetListQuery = ListQueryOf<(typeof LISTS)["budgets"]>;
export type PriceListQuery = ListQueryOf<(typeof LISTS)["prices"]>;
export type TenantListQuery = ListQueryOf<(typeof LISTS)["tenants"]>;

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
  defaultBudgetCents?: number;
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

export type SpecExportFormat = "md" | "json" | "bundle";

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
    health: () => request(transport, { path: "/health/ready", schema: HealthSchema }),

    users: {
      list: (q) => request(transport, { path: "/users", query: { ...q }, schema: UserPageSchema }),
      create: (input) => request(transport, { method: "POST", path: "/users", body: input }),
      update: (id, input) => request(transport, { method: "PATCH", path: `/users/${id}`, body: input }),
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
      invitations: (id) =>
        request(transport, { path: `/campaigns/${id}/invitations`, schema: InvitationListSchema }),
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
    },

    settings: {
      get: (q) => request(transport, { path: "/settings", query: { ...q }, schema: SettingsResponseSchema }),
      scopes: (scope) =>
        request(transport, { path: "/settings/scopes", query: { scope }, schema: ScopeTargetListSchema }),
      emailTest: (q) =>
        request(transport, {
          method: "POST",
          path: "/settings/email/test",
          // The route reads the scope from the body; sending it as a query string tested the
          // tenant chain whichever scope was selected.
          body: { scope: q.scope === "platform" ? "platform" : "tenant" },
          schema: EmailTestSchema,
        }),
      put: (q, values) =>
        ok(
          request(transport, {
            method: "PUT",
            path: "/settings",
            query: { ...q },
            body: { values },
            schema: OkSchema,
          }),
        ),
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
    stats: () => request(transport, { path: "/stats", schema: StatsSchema }),
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
      settleFinding: (id, findingId, outcome, note) =>
        request(transport, {
          method: "POST",
          path: `/requirements/${id}/findings/${encodeURIComponent(findingId)}`,
          body: { outcome, ...(note ? { note } : {}) },
          schema: LiveSpecEnvelopeSchema,
        }).then((r) => r.spec),
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
            schema: envelope(TenantEnvelopeSchema),
          }),
        update: (id, input) =>
          request(transport, {
            method: "PATCH",
            path: `/operator/tenants/${id}`,
            body: input,
            schema: envelope(TenantEnvelopeSchema),
          }),
      },
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
  settleFinding(id: string, findingId: string, outcome: FindingOutcome, note?: string): Promise<LiveSpec>;
  /** Same SSE stream as the participant turn, plus `event: spec` after each turn. */
  sendTurn(id: string, input: TurnInput | undefined, signal?: AbortSignal): Promise<Response>;
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
  health(): Promise<unknown>;
  users: {
    list(q?: UserListQuery): Promise<Paged<User>>;
    create(input: UserInput): Promise<unknown>;
    update(id: string, input: Partial<UserInput>): Promise<unknown>;
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
  };
  campaigns: {
    list(q?: CampaignListQuery): Promise<Paged<Campaign>>;
    get(id: string): Promise<Campaign>;
    create(input: CampaignCreateInput): Promise<Campaign>;
    update(id: string, input: Partial<CampaignCreateInput> & { status?: string }): Promise<Campaign>;
    open(id: string): Promise<void>;
    close(id: string): Promise<void>;
    invite(id: string, emails: string[]): Promise<{ created: number; skipped: number }>;
    invitations(id: string): Promise<Invitation[]>;
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
  };
  opportunities: {
    override(id: string, override: OpportunityOverride): Promise<Opportunity>;
    setStatus(id: string, status: OpportunityStatusInput): Promise<Opportunity>;
    promote(id: string): Promise<PromoteResult>;
  };
  settings: {
    get(q: SettingsQuery): Promise<SettingsResponse>;
    put(q: SettingsQuery, values: Record<string, unknown>): Promise<void>;
    /** Named targets for a scope picker, newest first (contract 19). */
    scopes(scope: ScopeKind): Promise<ScopeTarget[]>;
    /** Sends a test message with the configuration in effect for the scope. */
    emailTest(q: SettingsQuery): Promise<EmailTest>;
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
  stats(): Promise<Stats>;
  audit(q?: AuditListQuery): Promise<Paged<AuditEntry>>;
  /** Contract 18: requirements sessions owned by staff, their live spec, versions and invitations. */
  requirements: RequirementsApi;
  operator: {
    tenants: {
      list(q?: TenantListQuery): Promise<Paged<Tenant>>;
      create(input: TenantInput): Promise<Tenant>;
      update(id: string, input: Partial<TenantInput>): Promise<Tenant>;
    };
    providers: ProvidersApi;
    routes: RoutesApi;
    stats(): Promise<Stats>;
    /** The background queue: counters, dead letters, and the verbs that act on them (D-92). */
    jobs: {
      list(): Promise<QueueSummary[]>;
      dead(queue: string, limit?: number): Promise<DeadJob[]>;
      retry(queue: string, id: string): Promise<void>;
      discard(queue: string, id: string): Promise<void>;
      runNow(name: string): Promise<void>;
    };
  };
}
