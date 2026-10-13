import { costCents, estimateTokens, PriceTable, ProviderError, type ModelPrice } from "@aidp/ai";
import {
  classifyConnectFailure,
  EgressBlockedError,
  loadPrices,
  validateTenantHeaders,
  type CallerFactory,
  type Crypto,
  type EgressGuard,
} from "@aidp/core";
import { tenantBatch } from "@aidp/db";
import { PURPOSES, ProviderConfigSchema, type ModelInfo, type Purpose } from "@aidp/shared";
import type { PrismaClient, Provider } from "@prisma/client";
import { AppError, notFound } from "../../lib/errors.js";

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
      if (companyId !== null && input.headers) validateTenantHeaders(input.headers);
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

  async get(companyId: string | null, id: string): Promise<Provider> {
    const p = await this.db.provider.findFirst({ where: { id, OR: [{ companyId }, { companyId: null }] } });
    if (!p) throw notFound("Provider");
    return p;
  }

  async create(companyId: string | null, input: ProviderInput): Promise<Provider> {
    if (!input.apiKey) throw new AppError("validation", "apiKey is required");
    await this.assertEgress(companyId, input);
    ProviderConfigSchema.parse({
      id: "new",
      companyId,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      headers: input.headers ?? {},
      enabled: input.enabled ?? true,
    });
    return this.db.provider.create({
      data: {
        companyId,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        apiKeyEnc: this.crypto.encrypt(input.apiKey),
        headers: input.headers ?? {},
        enabled: input.enabled ?? true,
      },
    });
  }

  async update(companyId: string | null, id: string, input: ProviderPatch): Promise<Provider> {
    const p = await this.get(companyId, id);
    if (p.companyId !== companyId)
      throw new AppError("forbidden", "Platform providers are managed by the platform operator");
    await this.assertEgress(companyId, input);
    const updated = await this.db.provider.update({
      where: { id: p.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.apiKey ? { apiKeyEnc: this.crypto.encrypt(input.apiKey) } : {}),
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
        apiKey: this.crypto.decrypt(p.apiKeyEnc),
        headers: p.headers,
        enabled: p.enabled,
      }),
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
   * Sends one tiny request through the adapter and prices it (FR-43). Without an explicit model
   * it uses the newest route that points at this provider, else the first model the provider lists.
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
    try {
      const events = this.adapter(p).chat(chosen, {
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        maxOutputTokens: 16,
        cachePrefix: false,
      });
      let usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      for await (const ev of events) if (ev.type === "done") usage = ev.usage;
      const table = new PriceTable();
      await loadPrices(this.db, companyId ?? "", table);
      const price = table.get(p.id, chosen);
      return {
        ok: true,
        model: chosen,
        latencyMs: Date.now() - started,
        tokens: usage.inputTokens + usage.outputTokens,
        costCents: price ? costCents(price, usage) : 0,
        status: "ok",
      };
    } catch (err) {
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

  /** One page of prices with the row count beside it (contract 19). */
  async pricesPage(
    providerId: string,
    page: { limit: number; offset: number },
  ): Promise<{ prices: ModelPrice[]; total: number }> {
    const [rows, total] = await tenantBatch(this.db, [
      this.db.modelPrice.findMany({
        where: { providerId },
        orderBy: { model: "asc" },
        take: page.limit,
        skip: page.offset,
      }),
      this.db.modelPrice.count({ where: { providerId } }),
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
    const out: RouteRowOut[] = [];
    for (const purpose of PURPOSES) {
      const own = rows.find((r) => r.purpose === purpose && r.companyId === companyId);
      const platform = rows.find((r) => r.purpose === purpose && r.companyId === null);
      const r = own ?? platform;
      if (!r) continue;
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
