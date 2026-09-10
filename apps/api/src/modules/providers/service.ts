import { createProvider, costCents, estimateTokens, PriceTable, type ModelPrice } from "@aidp/ai";
import { loadPrices, type CallerFactory, type Crypto } from "@aidp/core";
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
    if (!input.apiKey) throw new AppError("validation", "apiKey is required");
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
    return createProvider(
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

  /** Live model list; imports published prices without overwriting admin prices (FR-41). */
  async models(
    companyId: string | null,
    id: string,
  ): Promise<{ models: ModelInfo[]; importedPrices: number }> {
    const p = await this.get(companyId, id);
    const models = await this.adapter(p).listModels();
    const table = new PriceTable();
    const imported = table.importFromModels(p.id, models);
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
    imported;
    return { models, importedPrices };
  }

  /** Sends one tiny request through the adapter and prices it (FR-43). */
  async test(
    companyId: string | null,
    id: string,
    model: string,
  ): Promise<{ ok: boolean; latencyMs: number; tokens: number; costCents: number; error?: string }> {
    const p = await this.get(companyId, id);
    const started = Date.now();
    try {
      const events = this.adapter(p).chat(model, {
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        maxOutputTokens: 16,
        cachePrefix: false,
      });
      let usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      for await (const ev of events) if (ev.type === "done") usage = ev.usage;
      const table = new PriceTable();
      await loadPrices(this.db, companyId ?? "", table);
      const price = table.get(p.id, model);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        tokens: usage.inputTokens + usage.outputTokens,
        costCents: price ? costCents(price, usage) : 0,
      };
    } catch (err) {
      return {
        ok: false,
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

  async setPrice(
    companyId: string | null,
    providerId: string,
    price: Omit<ModelPrice, "providerId" | "source">,
  ): Promise<void> {
    await this.get(companyId, providerId);
    await this.db.modelPrice.upsert({
      where: { providerId_model: { providerId, model: price.model } },
      create: { providerId, ...price, source: "admin" },
      update: { ...price, source: "admin" },
    });
  }

  async routes(companyId: string | null): Promise<
    {
      purpose: Purpose;
      route: {
        providerId: string;
        model: string;
        effort: string | null;
        maxOutputTokens: number;
        batchAllowed: boolean;
        inherited: boolean;
      } | null;
    }[]
  > {
    const rows = await this.db.route.findMany({
      where: companyId ? { OR: [{ companyId }, { companyId: null }] } : { companyId: null },
    });
    return PURPOSES.map((purpose) => {
      const own = rows.find((r) => r.purpose === purpose && r.companyId === companyId);
      const platform = rows.find((r) => r.purpose === purpose && r.companyId === null);
      const r = own ?? platform;
      return {
        purpose,
        route: r
          ? {
              providerId: r.providerId,
              model: r.model,
              effort: r.effort,
              maxOutputTokens: r.maxOutputTokens,
              batchAllowed: r.batchAllowed,
              inherited: !own,
            }
          : null,
      };
    });
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
