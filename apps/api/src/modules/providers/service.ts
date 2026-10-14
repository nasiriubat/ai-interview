import {
  costCents,
  estimateTokens,
  PriceTable,
  ProbeLimitError,
  ProviderError,
  type ModelPrice,
  type SpeechRunner,
} from "@aidp/ai";
import {
  classifyConnectFailure,
  decryptApiKey,
  EgressBlockedError,
  HEADER_KEEP,
  openHeaders,
  sealHeaders,
  validateTenantHeaders,
  type CallerFactory,
  type Crypto,
  type EgressGuard,
} from "@aidp/core";
import { tenantBatch } from "@aidp/db";
import {
  ROUTABLE_PURPOSES,
  ProviderConfigSchema,
  toListResponse,
  type ListEnvelope,
  type ModelInfo,
  type Purpose,
} from "@aidp/shared";
import type { Prisma, PrismaClient, Provider } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/** `/providers/:id/prices` and its operator twin (D-79): `q` matches the model id. */
export const PriceList = listSpec({
  sort: { model: "asc", inputPerMtok: "asc", outputPerMtok: "asc", updatedAt: "desc" },
  defaultSort: "model",
  filters: { source: z.enum(["seed", "provider", "admin"]).optional() },
});

export const PriceListQuery = listQuery(PriceList);
export type PriceListQuery = z.output<typeof PriceListQuery>;

export interface ProviderInput {
  kind: string;
  name: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

export interface RouteRowOut {
  id: string;
  purpose: Purpose;
  companyId: string | null;
  providerId: string;
  model: string;
  effort?: string;
  maxOutputTokens: number;
  batchAllowed: boolean;
  inherited: boolean;
  /**
   * The route used when this purpose's provider is down (D-228); null when none is configured.
   * `fallbackInherited` says the platform's fallback applies because the tenant set none.
   */
  fallback: { providerId: string; model: string } | null;
  fallbackInherited: boolean;
}

/**
 * What a connection test or a model listing can say about the provider. Deliberately coarse: the
 * address a tenant admin typed is untrusted, so the answer must not be a probe of what is behind
 * it. "Connection refused" and "filtered" are both `unreachable`; an upstream's own words are
 * never returned (S4, D-83).
 */
export type ProbeStatus =
  | "ok"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "provider_error"
  | "unreachable"
  | "blocked_address"
  | "tls_error"
  | "timeout";

const PROBE_MESSAGES: Record<Exclude<ProbeStatus, "ok">, string> = {
  unauthorized: "The provider rejected the API key",
  not_found: "The provider does not have that endpoint or model",
  rate_limited: "The provider is rate limiting this key",
  provider_error: "The provider returned an error",
  unreachable: "Could not reach the provider",
  blocked_address: "That address is not allowed for this provider",
  tls_error: "The provider's TLS certificate could not be verified",
  timeout: "The provider did not answer in time",
};

/** Reduces any failure from an adapter to a ProbeStatus. */
export function probeStatus(err: unknown): Exclude<ProbeStatus, "ok"> {
  const connect = classifyConnectFailure(err);
  if (connect === "blocked_address" || connect === "tls_error" || connect === "timeout") return connect;
  if (err instanceof ProviderError) {
    switch (err.code) {
      case "auth":
        return "unauthorized";
      case "not_found":
        return "not_found";
      case "rate_limit":
        return "rate_limited";
      case "network":
        return "unreachable";
      default:
        return "provider_error";
    }
  }
  return "unreachable";
}

export interface ModelsResult {
  models: ModelInfo[];
  importedPrices: number;
  /** When the catalogue was read; the newest stored price when the answer is stale, null when nothing is stored. */
  fetchedAt: Date | null;
  stale: boolean;
  /** Why the live list could not be read, when it could not; one of a fixed set. */
  status: ProbeStatus;
  /** A fixed sentence for `status`, never text from the provider. */
  error?: string;
}

export interface ProviderPatch {
  kind?: string | undefined;
  name?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  enabled?: boolean | undefined;
}

/** Providers, model lists with price import, routes and budgets (FR-40 to FR-47). Keys never leave this service decrypted. */
export class ProviderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly callers: CallerFactory,
    private readonly egress: EgressGuard,
    private readonly speech?: SpeechRunner,
  ) {}

  /**
   * Refuses a base URL or header map that the egress policy would never let a connection use. It
   * runs on save so the admin gets an answer at the form rather than a failure at interview
   * time; the connect-time check in the transport is the authoritative one.
   */
  private async assertEgress(
    companyId: string | null,
    input: { baseUrl?: string | undefined; headers?: Record<string, string> | undefined },
  ): Promise<void> {
    try {
      // Names are checked for the platform too: a header map that rewrites `Host` or `Authorization`
      // is never what an operator needs either, and one rule is easier to hold than two (D-147).
      if (input.headers) validateTenantHeaders(input.headers);
      if (input.baseUrl)
        await this.egress.validateUrl(input.baseUrl, companyId === null ? "platform" : "tenant");
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new AppError("blocked_address", PROBE_MESSAGES.blocked_address, { reason: err.reason });
      }
      throw err;
    }
  }

  list(companyId: string | null): Promise<Provider[]> {
    return this.db.provider.findMany({
      where: companyId ? { OR: [{ companyId }, { companyId: null }] } : { companyId: null },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * The names of a provider's custom headers, never the values (D-147). The values are credentials:
   * they are opened where a connection is made and nowhere that answers a browser.
   */
  headerNames(p: Provider): string[] {
    try {
      return Object.keys(openHeaders(this.crypto, p.headersEnc, p.headers)).sort();
    } catch {
      // A value sealed under a key that has since changed. The screen should still load.
      return [];
    }
  }

  /**
   * The full header map a save results in. The client sends names with new values, or `__keep__` for
   * a header it leaves alone (the browser was never given the values); anything it does not send is
   * removed.
   */
  private resolveHeaders(existing: Provider | null, sent: Record<string, string>): Record<string, string> {
    const current = existing ? openHeaders(this.crypto, existing.headersEnc, existing.headers) : {};
    const byLowerName = new Map(Object.entries(current).map(([k, v]) => [k.toLowerCase(), v]));
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(sent)) {
      if (value !== HEADER_KEEP) {
        out[name] = value;
        continue;
      }
      const kept = byLowerName.get(name.toLowerCase());
      if (kept === undefined)
        throw new AppError("validation", `Header '${name}' has no stored value to keep`, {
          field: "headers",
        });
      out[name] = kept;
    }
    return out;
  }

  async get(companyId: string | null, id: string): Promise<Provider> {
    const p = await this.db.provider.findFirst({ where: { id, OR: [{ companyId }, { companyId: null }] } });
    if (!p) throw notFound("Provider");
    return p;
  }

  async create(companyId: string | null, input: ProviderInput): Promise<Provider> {
    const keyless = input.kind === "local";
    if (keyless && companyId !== null) {
      // The on-server Whisper spends the server's own CPU and memory, which are the operator's to
      // allocate. Tenants route to the platform's one; they do not get a second copy (D-75).
      throw new AppError("forbidden", "The on-server speech model is managed by the platform operator");
    }
    if (!keyless && !input.apiKey) throw new AppError("validation", "apiKey is required");
    const apiKey = keyless ? "" : (input.apiKey ?? "");
    const headers = this.resolveHeaders(null, input.headers ?? {});
    await this.assertEgress(companyId, { ...input, headers });
    ProviderConfigSchema.parse({
      id: "new",
      companyId,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey,
      headers,
      enabled: input.enabled ?? true,
    });
    return this.db.provider.create({
      data: {
        companyId,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        // No secret, so nothing to encrypt: an empty column is how "has no key" is stored.
        apiKeyEnc: keyless ? "" : this.crypto.encrypt(apiKey, "provider.apiKey"),
        headers: {},
        headersEnc: sealHeaders(this.crypto, headers),
        enabled: input.enabled ?? true,
      },
    });
  }

  async update(companyId: string | null, id: string, input: ProviderPatch): Promise<Provider> {
    const p = await this.get(companyId, id);
    if (p.companyId !== companyId)
      throw new AppError("forbidden", "Platform providers are managed by the platform operator");
    const headers = input.headers !== undefined ? this.resolveHeaders(p, input.headers) : undefined;
    await this.assertEgress(companyId, { ...input, ...(headers !== undefined ? { headers } : {}) });
    const updated = await this.db.provider.update({
      where: { id: p.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(headers !== undefined ? { headersEnc: sealHeaders(this.crypto, headers), headers: {} } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.apiKey && p.kind !== "local"
          ? { apiKeyEnc: this.crypto.encrypt(input.apiKey, "provider.apiKey") }
          : {}),
      },
    });
    this.callers.invalidateProvider(p.id);
    return updated;
  }

  async remove(companyId: string | null, id: string): Promise<void> {
    const p = await this.get(companyId, id);
    if (p.companyId !== companyId)
      throw new AppError("forbidden", "Platform providers are managed by the platform operator");
    const routes = await this.db.route.count({ where: { providerId: p.id } });
    if (routes) throw new AppError("conflict", "Provider is used by routes; reassign them first");
    // The ledger keeps every call a provider made (cost control, FR-40), so a provider that has
    // been used cannot be erased; it was a foreign-key violation answered as a 500.
    const calls = await this.db.llmCall.count({ where: { providerId: p.id } });
    if (calls)
      throw new AppError(
        "conflict",
        "This provider has recorded usage and cannot be deleted; disable it instead",
      );
    await this.db.provider.delete({ where: { id: p.id } });
    this.callers.invalidateProvider(p.id);
  }

  private adapter(p: Provider) {
    return this.callers.adapterFor(
      ProviderConfigSchema.parse({
        id: p.id,
        companyId: p.companyId,
        kind: p.kind,
        name: p.name,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        apiKey: decryptApiKey(this.crypto, p.apiKeyEnc),
        headers: openHeaders(this.crypto, p.headersEnc, p.headers),
        enabled: p.enabled,
      }),
      this.speech ? { speech: this.speech } : {},
    );
  }

  /**
   * Live model list; imports published prices without overwriting admin prices (FR-41). When the
   * provider cannot be reached the answer is the last imported prices with `stale: true`, so the
   * screen degrades instead of failing (contract 19).
   */
  async models(companyId: string | null, id: string): Promise<ModelsResult> {
    const p = await this.get(companyId, id);
    let models: ModelInfo[];
    try {
      models = await this.adapter(p).listModels();
    } catch (err) {
      return this.storedModels(p.id, probeStatus(err));
    }
    // A platform provider's prices are the operator's to set (see `setPrices`), and the database now
    // refuses a tenant's write to a platform row: a tenant admin listing a platform provider's
    // models sees them, and nothing is imported (D-141).
    if (p.companyId !== companyId)
      return { models, importedPrices: 0, fetchedAt: new Date(), stale: false, status: "ok" };
    const table = new PriceTable();
    table.importFromModels(p.id, models);
    let importedPrices = 0;
    for (const m of models) {
      const price = table.get(p.id, m.id);
      if (!price) continue;
      const existing = await this.db.modelPrice.findUnique({
        where: { providerId_model: { providerId: p.id, model: m.id } },
      });
      if (existing?.source === "admin") continue;
      await this.db.modelPrice.upsert({
        where: { providerId_model: { providerId: p.id, model: m.id } },
        create: {
          providerId: p.id,
          model: m.id,
          inputPerMtok: price.inputPerMtok,
          cachedInputPerMtok: price.cachedInputPerMtok,
          outputPerMtok: price.outputPerMtok,
          source: "provider",
        },
        update: {
          inputPerMtok: price.inputPerMtok,
          cachedInputPerMtok: price.cachedInputPerMtok,
          outputPerMtok: price.outputPerMtok,
          source: "provider",
        },
      });
      importedPrices++;
    }
    return { models, importedPrices, fetchedAt: new Date(), stale: false, status: "ok" };
  }

  /** The catalogue rebuilt from stored prices, for when the provider is unreachable. */
  private async storedModels(providerId: string, status: Exclude<ProbeStatus, "ok">): Promise<ModelsResult> {
    const rows = await this.db.modelPrice.findMany({
      where: { providerId },
      orderBy: { model: "asc" },
    });
    const newest = rows.reduce<Date | null>(
      (acc, r) => (acc === null || r.updatedAt > acc ? r.updatedAt : acc),
      null,
    );
    return {
      models: rows.map((r) => ({
        id: r.model,
        name: r.model,
        inputPerMtok: r.inputPerMtok,
        cachedInputPerMtok: r.cachedInputPerMtok,
        outputPerMtok: r.outputPerMtok,
      })),
      importedPrices: 0,
      fetchedAt: newest,
      stale: true,
      status,
      error: PROBE_MESSAGES[status],
    };
  }

  /**
   * The model a test uses when the caller names none: the newest route pointing at this provider
   * (ids are time-ordered cuids, and Route carries no timestamp), else the provider's first model.
   */
  private async defaultModel(companyId: string | null, p: Provider): Promise<string> {
    const route = await this.db.route.findFirst({
      where: { providerId: p.id, ...(companyId ? { OR: [{ companyId }, { companyId: null }] } : {}) },
      orderBy: { id: "desc" },
    });
    if (route) return route.model;
    try {
      const first = (await this.adapter(p).listModels())[0];
      if (first) return first.id;
    } catch {
      // The provider is unreachable; the caller has to name a model.
    }
    throw new AppError(
      "validation",
      "No model could be determined for this provider; choose one and send it as `model`",
    );
  }

  /**
   * Sends one tiny request through `ModelCaller.probe` (FR-43). Without an explicit model it uses
   * the newest route that points at this provider, else the first model the provider lists.
   *
   * It goes through the caller rather than the adapter so the call is priced from the tenant's
   * price table, ledgered, bounded by the daily probe cap, and subject to the same outbound
   * guards as every other model call. The provider id is checked against what this tenant may
   * use before anything is sent.
   */
  async test(
    companyId: string | null,
    id: string,
    model?: string,
  ): Promise<{
    ok: boolean;
    model: string;
    latencyMs: number;
    tokens: number;
    costCents: number;
    status: ProbeStatus;
    error?: string;
  }> {
    const p = await this.get(companyId, id);
    const chosen = model ?? (await this.defaultModel(companyId, p));
    const started = Date.now();
    if (p.kind === "local") return this.testTranscription(p, chosen, started);
    try {
      const caller = await this.callers.forCompany(companyId ?? "");
      const r = await caller.probe({ companyId }, { providerId: p.id, model: chosen });
      return {
        ok: true,
        model: chosen,
        latencyMs: r.latencyMs,
        tokens: r.usage.inputTokens + r.usage.outputTokens,
        costCents: r.costCents,
        status: "ok",
      };
    } catch (err) {
      // Over the daily cap is not "the provider failed": say so with the right status.
      if (err instanceof ProbeLimitError) throw new AppError("rate_limited", err.message);
      const status = probeStatus(err);
      return {
        ok: false,
        model: chosen,
        latencyMs: Date.now() - started,
        tokens: 0,
        costCents: 0,
        status,
        error: PROBE_MESSAGES[status],
      };
    }
  }

  /**
   * A provider that only transcribes cannot be asked for a word. It is sent a second of tone
   * instead, which proves the part that can actually fail: the model downloads, loads and runs on
   * this server. The first test after a deployment therefore waits for the download (D-75).
   */
  private async testTranscription(
    p: Provider,
    model: string,
    started: number,
  ): Promise<{
    ok: boolean;
    model: string;
    latencyMs: number;
    tokens: number;
    costCents: number;
    status: ProbeStatus;
    error?: string;
  }> {
    try {
      const adapter = this.adapter(p);
      if (!adapter.transcribe) throw new AppError("validation", "This provider cannot transcribe audio");
      await adapter.transcribe(model, {
        data: testTone(),
        mime: "audio/wav",
        filename: "test.wav",
        language: "en",
      });
      return { ok: true, model, latencyMs: Date.now() - started, tokens: 0, costCents: 0, status: "ok" };
    } catch (err) {
      // The on-server model's own failures (download, load, decode) are this server's and not
      // an upstream's, so they are not collapsed to a status; a message from this process is safe
      // to show, and the operator is the one who needs it.
      const status = probeStatus(err);
      return {
        ok: false,
        model,
        latencyMs: Date.now() - started,
        tokens: 0,
        costCents: 0,
        status,
        error: err instanceof Error ? err.message : PROBE_MESSAGES[status],
      };
    }
  }

  prices(providerId: string): Promise<ModelPrice[]> {
    return this.db.modelPrice.findMany({ where: { providerId } }).then((rows) =>
      rows.map((r) => ({
        providerId: r.providerId,
        model: r.model,
        inputPerMtok: r.inputPerMtok,
        cachedInputPerMtok: r.cachedInputPerMtok,
        outputPerMtok: r.outputPerMtok,
        source: r.source as ModelPrice["source"],
      })),
    );
  }

  /**
   * One page of prices with the row count beside it (contract 19). `where` narrows within the
   * provider and can never widen past it; the caller has already checked the provider's scope.
   */
  async pricesPage(
    providerId: string,
    page: {
      limit: number;
      offset: number;
      where?: Omit<Prisma.ModelPriceWhereInput, "providerId" | "provider">;
      orderBy?: Prisma.ModelPriceOrderByWithRelationInput[];
    },
  ): Promise<{ prices: ModelPrice[]; total: number }> {
    const where: Prisma.ModelPriceWhereInput = { ...page.where, providerId };
    const [rows, total] = await tenantBatch(this.db, [
      this.db.modelPrice.findMany({
        where,
        orderBy: page.orderBy ?? [{ model: "asc" }],
        take: page.limit,
        skip: page.offset,
      }),
      this.db.modelPrice.count({ where }),
    ]);
    return {
      prices: rows.map((r) => ({
        providerId: r.providerId,
        model: r.model,
        inputPerMtok: r.inputPerMtok,
        cachedInputPerMtok: r.cachedInputPerMtok,
        outputPerMtok: r.outputPerMtok,
        source: r.source as ModelPrice["source"],
      })),
      total,
    };
  }

  /**
   * One page of a provider's prices, after checking the provider is visible to this scope. The
   * search and filters narrow within the provider and can never widen past it.
   */
  async pricesList(
    companyId: string | null,
    providerId: string,
    query: PriceListQuery,
  ): Promise<ListEnvelope<"prices", ModelPrice>> {
    await this.get(companyId, providerId);
    const q = searchTerm(query.q);
    const { prices, total } = await this.pricesPage(providerId, {
      limit: query.limit,
      offset: query.offset,
      where: {
        ...(q ? { model: contains(q) } : {}),
        ...(query.source ? { source: query.source } : {}),
      },
      orderBy: listOrder<Prisma.ModelPriceOrderByWithRelationInput, typeof query.sort>(PriceList, query),
    });
    return toListResponse("prices", prices, total, query);
  }

  async setPrice(
    companyId: string | null,
    providerId: string,
    price: Omit<ModelPrice, "providerId" | "source">,
  ): Promise<void> {
    await this.setPrices(companyId, providerId, [price]);
  }

  /**
   * Admin prices for a provider, written as one transaction so a half-applied table is impossible.
   * `source: "admin"` is what protects these rows from being overwritten by the next import.
   */
  async setPrices(
    companyId: string | null,
    providerId: string,
    prices: Omit<ModelPrice, "providerId" | "source">[],
  ): Promise<void> {
    const p = await this.get(companyId, providerId);
    // A platform provider resolves for every tenant, so prices on it are the operator's to set:
    // a tenant override here would feed the cost ledger of every other tenant using that provider.
    if (p.companyId !== companyId)
      throw new AppError("forbidden", "Platform provider prices are managed by the platform operator");
    await this.db.$transaction(
      prices.map((price) =>
        this.db.modelPrice.upsert({
          where: { providerId_model: { providerId, model: price.model } },
          create: { providerId, ...price, source: "admin" },
          update: { ...price, source: "admin" },
        }),
      ),
    );
  }

  /** Flat `Route` rows in contract shape for every purpose that has a route; unrouted purposes are absent. */
  async routes(companyId: string | null): Promise<RouteRowOut[]> {
    const rows = await this.db.route.findMany({
      where: companyId ? { OR: [{ companyId }, { companyId: null }] } : { companyId: null },
    });
    const fallbacks = await this.db.fallbackRoute.findMany({
      where: companyId ? { OR: [{ companyId }, { companyId: null }] } : { companyId: null },
    });
    const out: RouteRowOut[] = [];
    for (const purpose of ROUTABLE_PURPOSES) {
      const own = rows.find((r) => r.purpose === purpose && r.companyId === companyId);
      const platform = rows.find((r) => r.purpose === purpose && r.companyId === null);
      const r = own ?? platform;
      if (!r) continue;
      const ownFallback = fallbacks.find((f) => f.purpose === purpose && f.companyId === companyId);
      const platformFallback = fallbacks.find((f) => f.purpose === purpose && f.companyId === null);
      const f = ownFallback ?? platformFallback;
      out.push({
        id: r.id,
        purpose,
        companyId: r.companyId,
        providerId: r.providerId,
        model: r.model,
        ...(r.effort ? { effort: r.effort } : {}),
        maxOutputTokens: r.maxOutputTokens,
        batchAllowed: r.batchAllowed,
        inherited: !own,
        fallback: f ? { providerId: f.providerId, model: f.model } : null,
        fallbackInherited: f !== undefined && ownFallback === undefined,
      });
    }
    return out;
  }

  async setRoute(
    companyId: string | null,
    purpose: Purpose,
    route: {
      providerId: string;
      model: string;
      effort?: string | undefined;
      maxOutputTokens: number;
      batchAllowed?: boolean | undefined;
    } | null,
  ): Promise<void> {
    if (route === null) {
      await this.db.route.deleteMany({ where: { companyId, purpose } });
      return;
    }
    await this.get(companyId, route.providerId);
    const data = {
      providerId: route.providerId,
      model: route.model,
      effort: route.effort ?? null,
      maxOutputTokens: route.maxOutputTokens,
      batchAllowed: route.batchAllowed ?? false,
    };
    const existing = await this.db.route.findFirst({ where: { companyId, purpose } });
    if (existing) await this.db.route.update({ where: { id: existing.id }, data });
    else await this.db.route.create({ data: { companyId, purpose, ...data } });
  }

  /**
   * Sets or clears the fallback route of a purpose in this scope (D-228). The provider must be one
   * this scope may use, exactly as for the primary, and a fallback on the same provider as the
   * primary is refused: it would route a failing provider back to itself.
   */
  async setFallback(
    companyId: string | null,
    purpose: Purpose,
    fallback: { providerId: string; model: string } | null,
  ): Promise<void> {
    if (fallback === null) {
      await this.db.fallbackRoute.deleteMany({ where: { companyId, purpose } });
      return;
    }
    await this.get(companyId, fallback.providerId);
    const primary =
      (await this.db.route.findFirst({ where: { companyId, purpose } })) ??
      (await this.db.route.findFirst({ where: { companyId: null, purpose } }));
    if (primary && primary.providerId === fallback.providerId)
      throw new AppError("validation", "The fallback must use a different provider than the primary route");
    const data = {
      providerId: fallback.providerId,
      model: fallback.model,
      maxOutputTokens: primary?.maxOutputTokens ?? 4096,
    };
    const existing = await this.db.fallbackRoute.findFirst({ where: { companyId, purpose } });
    if (existing) await this.db.fallbackRoute.update({ where: { id: existing.id }, data });
    else await this.db.fallbackRoute.create({ data: { companyId, purpose, ...data } });
  }

  /** Estimates what one interview costs at the current routes, for the admin's sanity check. */
  estimateTurnCents(price: ModelPrice | undefined, systemChars: number, maxOutputTokens: number): number {
    if (!price) return 0;
    return costCents(price, {
      inputTokens: estimateTokens("x".repeat(systemChars)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: maxOutputTokens,
    });
  }
}

/** One second of a 440 Hz tone as 16 kHz mono PCM WAV: loud enough not to count as silence. */
function testTone(): Uint8Array {
  const rate = 16_000;
  const samples = rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return new Uint8Array(buf);
}
