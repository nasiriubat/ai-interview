import {
  createProvider,
  costCents,
  estimateTokens,
  PriceTable,
  ProbeLimitError,
  type ModelPrice,
  type SpeechRunner,
} from "@aidp/ai";
import { decryptApiKey, type CallerFactory, type Crypto } from "@aidp/core";
import { tenantBatch } from "@aidp/db";
import { ROUTABLE_PURPOSES, ProviderConfigSchema, type ModelInfo, type Purpose } from "@aidp/shared";
import type { Prisma, PrismaClient, Provider } from "@prisma/client";
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

export interface ModelsResult {
  models: ModelInfo[];
  importedPrices: number;
  /** When the catalogue was read; the newest stored price when the answer is stale, null when nothing is stored. */
  fetchedAt: Date | null;
  stale: boolean;
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
    private readonly speech?: SpeechRunner,
  ) {}

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
    const keyless = input.kind === "local";
    if (keyless && companyId !== null) {
      // The on-server Whisper spends the server's own CPU and memory, which are the operator's to
      // allocate. Tenants route to the platform's one; they do not get a second copy (D-75).
      throw new AppError("forbidden", "The on-server speech model is managed by the platform operator");
    }
    if (!keyless && !input.apiKey) throw new AppError("validation", "apiKey is required");
    const apiKey = keyless ? "" : (input.apiKey ?? "");
    ProviderConfigSchema.parse({
      id: "new",
      companyId,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey,
      headers: input.headers ?? {},
      enabled: input.enabled ?? true,
    });
    return this.db.provider.create({
      data: {
        companyId,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        // No secret, so nothing to encrypt: an empty column is how "has no key" is stored.
        apiKeyEnc: keyless ? "" : this.crypto.encrypt(apiKey),
        headers: input.headers ?? {},
        enabled: input.enabled ?? true,
      },
    });
  }

  async update(companyId: string | null, id: string, input: ProviderPatch): Promise<Provider> {
    const p = await this.get(companyId, id);
    if (p.companyId !== companyId)
      throw new AppError("forbidden", "Platform providers are managed by the platform operator");
    const updated = await this.db.provider.update({
      where: { id: p.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.apiKey && p.kind !== "local" ? { apiKeyEnc: this.crypto.encrypt(input.apiKey) } : {}),
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
    return createProvider(
      ProviderConfigSchema.parse({
        id: p.id,
        companyId: p.companyId,
        kind: p.kind,
        name: p.name,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        apiKey: decryptApiKey(this.crypto, p.apiKeyEnc),
        headers: p.headers,
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
      return this.storedModels(p.id, err instanceof Error ? err.message : String(err));
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
    return { models, importedPrices, fetchedAt: new Date(), stale: false };
  }

  /** The catalogue rebuilt from stored prices, for when the provider is unreachable. */
  private async storedModels(providerId: string, error: string): Promise<ModelsResult> {
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
      error,
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
      };
    } catch (err) {
      // Over the daily cap is not "the provider failed": say so with the right status.
      if (err instanceof ProbeLimitError) throw new AppError("rate_limited", err.message);
      return {
        ok: false,
        model: chosen,
        latencyMs: Date.now() - started,
        tokens: 0,
        costCents: 0,
        error: err instanceof Error ? err.message : String(err),
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
      return { ok: true, model, latencyMs: Date.now() - started, tokens: 0, costCents: 0 };
    } catch (err) {
      return {
        ok: false,
        model,
        latencyMs: Date.now() - started,
        tokens: 0,
        costCents: 0,
        error: err instanceof Error ? err.message : String(err),
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
    for (const purpose of ROUTABLE_PURPOSES) {
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
