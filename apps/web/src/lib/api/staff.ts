import type {
  BudgetLimit,
  FindingOutcome,
  InterviewTemplateInput,
  OpportunityOverride,
  Path,
  Route,
} from "@aidp/shared";
import { type z } from "zod";
import { request, requestStream, type Transport } from "./http";
import type { TurnInput } from "./participant";
import {
  type GitHubPushResult,
  GitHubPushResultSchema,
  type LiveSpec,
  LiveSpecEnvelopeSchema,
  type RequirementsDetail,
  RequirementsDetailSchema,
  type RequirementsListItem,
  RequirementsListSchema,
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
  AnalysisListSchema,
  AuditListSchema,
  type AuditEntry,
  BudgetListSchema,
  type BudgetRecord,
  CampaignEnvelopeSchema,
  CampaignListSchema,
  type Campaign,
  HealthSchema,
  InvitationListSchema,
  InvitationResultSchema,
  type Invitation,
  MeSchema,
  type Me,
  ModelListSchema,
  type ModelPrice,
  OkSchema,
  type Opportunity,
  OpportunityEnvelopeSchema,
  PreviewSessionSchema,
  PriceListSchema,
  type PromoteResult,
  PromoteResultSchema,
  ProviderEnvelopeSchema,
  ProviderListSchema,
  ProviderTestSchema,
  type Provider,
  type ProviderTest,
  type RouteRecord,
  RoutesResponseSchema,
  SessionEventListSchema,
  type SessionEvent,
  SessionListSchema,
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
  type TemplateDiff,
  type TemplateListItem,
  type TemplateRecord,
  TenantEnvelopeSchema,
  TenantListSchema,
  type Tenant,
  UserListSchema,
  type User,
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
      list: () => request(transport, { path: "/users", schema: UserListSchema }),
      create: (input) => request(transport, { method: "POST", path: "/users", body: input }),
      update: (id, input) => request(transport, { method: "PATCH", path: `/users/${id}`, body: input }),
    },

    templates: {
      list: () => request(transport, { path: "/templates", schema: TemplateListSchema }),
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
      list: () => request(transport, { path: "/campaigns", schema: CampaignListSchema }),
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
      sessions: (id) => request(transport, { path: `/campaigns/${id}/sessions`, schema: SessionListSchema }),
    },

    sessions: {
      get: (id) =>
        request(transport, { path: `/sessions/${id}`, schema: envelope(StaffSessionEnvelopeSchema) }),
      events: (id) => request(transport, { path: `/sessions/${id}/events`, schema: SessionEventListSchema }),
    },

    analyses: {
      start: (campaignId) =>
        request(transport, {
          method: "POST",
          path: `/campaigns/${campaignId}/analyses`,
          body: {},
          schema: envelope(AnalysisEnvelopeSchema),
        }),
      list: (campaignId) =>
        request(transport, { path: `/campaigns/${campaignId}/analyses`, schema: AnalysisListSchema }),
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
      models: (id) => request(transport, { path: `/providers/${id}/models`, schema: ModelListSchema }),
      prices: (id) => request(transport, { path: `/providers/${id}/prices`, schema: PriceListSchema }),
      putPrices: (id, prices) =>
        ok(request(transport, { method: "PUT", path: `/providers/${id}/prices`, body: { prices } })),
    },

    routes: {
      get: () => request(transport, { path: "/routes", schema: RoutesResponseSchema }).then((r) => r.routes),
      put: (routes) => ok(request(transport, { method: "PUT", path: "/routes", body: { routes } })),
    },

    budgets: {
      list: () => request(transport, { path: "/budgets", schema: BudgetListSchema }),
      create: (input) => request(transport, { method: "POST", path: "/budgets", body: input }),
      remove: (id) => ok(request(transport, { method: "DELETE", path: `/budgets/${id}` })),
    },

    spend: (q) => request(transport, { path: "/spend", query: { ...q }, schema: SpendSchema }),
    stats: () => request(transport, { path: "/stats", schema: StatsSchema }),
    audit: (q) => request(transport, { path: "/audit", query: { ...q }, schema: AuditListSchema }),

    requirements: {
      list: () => request(transport, { path: "/requirements", schema: RequirementsListSchema }),
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
        list: () => request(transport, { path: "/operator/tenants", schema: TenantListSchema }),
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
          request(transport, { path: `/operator/providers/${id}/models`, schema: ModelListSchema }),
        prices: (id) =>
          request(transport, { path: `/operator/providers/${id}/prices`, schema: PriceListSchema }),
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
    },
  };
}

export interface ProvidersApi {
  list(): Promise<Provider[]>;
  create(input: ProviderInput): Promise<Provider>;
  update(id: string, input: Partial<ProviderInput>): Promise<Provider>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<ProviderTest>;
  models(id: string): Promise<ModelPrice[]>;
  prices(id: string): Promise<ModelPrice[]>;
  putPrices(id: string, prices: ModelPrice[]): Promise<void>;
}

export interface RoutesApi {
  get(): Promise<RouteRecord[]>;
  put(routes: Route[]): Promise<void>;
}

export interface RequirementsApi {
  list(): Promise<RequirementsListItem[]>;
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
    list(): Promise<User[]>;
    create(input: UserInput): Promise<unknown>;
    update(id: string, input: Partial<UserInput>): Promise<unknown>;
  };
  templates: {
    list(): Promise<TemplateListItem[]>;
    get(id: string): Promise<TemplateRecord>;
    create(input: InterviewTemplateInput, copyFromId?: string): Promise<TemplateRecord>;
    update(id: string, input: InterviewTemplateInput): Promise<TemplateRecord>;
    publish(id: string): Promise<void>;
    archive(id: string): Promise<void>;
    diffShipped(id: string): Promise<TemplateDiff>;
    preview(id: string): Promise<{ participantToken: string; sessionId: string }>;
  };
  campaigns: {
    list(): Promise<Campaign[]>;
    get(id: string): Promise<Campaign>;
    create(input: CampaignCreateInput): Promise<Campaign>;
    update(id: string, input: Partial<CampaignCreateInput> & { status?: string }): Promise<Campaign>;
    open(id: string): Promise<void>;
    close(id: string): Promise<void>;
    invite(id: string, emails: string[]): Promise<{ created: number; skipped: number }>;
    invitations(id: string): Promise<Invitation[]>;
    remind(id: string, invId: string): Promise<void>;
    revoke(id: string, invId: string): Promise<void>;
    sessions(id: string): Promise<SessionListItem[]>;
  };
  sessions: {
    get(id: string): Promise<StaffSession>;
    events(id: string): Promise<SessionEvent[]>;
  };
  /** Contract 17: analysis runs are versioned per campaign. */
  analyses: {
    start(campaignId: string): Promise<Analysis>;
    list(campaignId: string): Promise<Analysis[]>;
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
  };
  providers: ProvidersApi;
  routes: RoutesApi;
  budgets: {
    list(): Promise<BudgetRecord[]>;
    create(input: BudgetLimit): Promise<unknown>;
    remove(id: string): Promise<void>;
  };
  spend(q: SpendQuery): Promise<Spend>;
  stats(): Promise<Stats>;
  audit(q: { from?: string; to?: string }): Promise<AuditEntry[]>;
  /** Contract 18: requirements sessions owned by staff, their live spec, versions and invitations. */
  requirements: RequirementsApi;
  operator: {
    tenants: {
      list(): Promise<Tenant[]>;
      create(input: TenantInput): Promise<Tenant>;
      update(id: string, input: Partial<TenantInput>): Promise<Tenant>;
    };
    providers: ProvidersApi;
    routes: RoutesApi;
    stats(): Promise<Stats>;
  };
}
