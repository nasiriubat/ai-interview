import type { BudgetLimit, InterviewTemplateInput, Route } from "@aidp/shared";
import { type z } from "zod";
import { request, type Transport } from "./http";
import {
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
  PreviewSessionSchema,
  PriceListSchema,
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
