import {
  ProbeLimitError,
  type BudgetLimitSource,
  type LedgerSink,
  type ModelPrice,
  type PriceTable,
  type ProbeGuard,
  type ProviderConfigSource,
  type RouteResolver,
  type SpendSource,
} from "@aidp/ai";
import type { BudgetLimit, BudgetScope, LedgerEntry, ProviderConfig, Purpose, Route } from "@aidp/shared";
import { ProviderConfigSchema, RouteSchema } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { Crypto } from "../crypto.js";

/** Routes: tenant override first, then platform default (FR-42). */
export class PrismaRouteResolver implements RouteResolver {
  constructor(private readonly db: PrismaClient) {}
  async resolve(companyId: string, purpose: Purpose): Promise<Route | undefined> {
    const rows = await this.db.route.findMany({
      where: { purpose, OR: [{ companyId }, { companyId: null }] },
    });
    const row = rows.find((r) => r.companyId === companyId) ?? rows.find((r) => r.companyId === null);
    if (!row) return undefined;
    return RouteSchema.parse({
      companyId: row.companyId,
      purpose: row.purpose,
      providerId: row.providerId,
      model: row.model,
      ...(row.effort ? { effort: row.effort } : {}),
      maxOutputTokens: row.maxOutputTokens,
      batchAllowed: row.batchAllowed,
    });
  }
}

/** Providers a tenant may use: its own, plus platform-level. Keys are decrypted here and nowhere else. */
export class PrismaProviderConfigSource implements ProviderConfigSource {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
  ) {}
  async get(companyId: string, providerId: string): Promise<ProviderConfig | undefined> {
    const row = await this.db.provider.findFirst({
      where: { id: providerId, OR: [{ companyId }, { companyId: null }] },
    });
    if (!row) return undefined;
    return ProviderConfigSchema.parse({
      id: row.id,
      companyId: row.companyId,
      kind: row.kind,
      name: row.name,
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      apiKey: this.crypto.decrypt(row.apiKeyEnc),
      headers: row.headers,
      enabled: row.enabled,
    });
  }
}

/** Ledger rows and spend queries (FR-45, FR-47). */
export class PrismaLedger implements LedgerSink, SpendSource {
  constructor(private readonly db: PrismaClient) {}

  async record(e: LedgerEntry): Promise<void> {
    await this.db.llmCall.create({
      data: {
        companyId: e.companyId,
        purpose: e.purpose,
        providerId: e.providerId,
        model: e.model,
        promptVersion: e.promptVersion ?? null,
        inputTokens: e.usage.inputTokens,
        cacheReadTokens: e.usage.cacheReadTokens,
        cacheWriteTokens: e.usage.cacheWriteTokens,
        outputTokens: e.usage.outputTokens,
        latencyMs: e.latencyMs,
        status: e.status,
        costCents: e.costCents,
        sessionId: e.sessionId ?? null,
        campaignId: e.campaignId ?? null,
        createdAt: e.createdAt,
      },
    });
  }

  async spentCents(
    scope: BudgetScope,
    scopeId: string,
    period: "month" | "total",
    at: Date,
  ): Promise<number> {
    const where =
      scope === "tenant"
        ? { companyId: scopeId }
        : scope === "campaign"
          ? { campaignId: scopeId }
          : { sessionId: scopeId };
    const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const agg = await this.db.llmCall.aggregate({
      _sum: { costCents: true },
      where: { ...where, ...(period === "month" ? { createdAt: { gte: from } } : {}) },
    });
    return agg._sum.costCents ?? 0;
  }
}

/**
 * Caps provider tests per tenant over a rolling day, counted from the ledger itself so it needs no
 * state of its own and survives restarts. Counts calls rather than cents: a probe costs a fraction
 * of a cent and may have no price at all, so a cents cap would never fire on exactly the provider
 * it is most needed for.
 */
export class PrismaProbeGuard implements ProbeGuard {
  constructor(
    private readonly db: PrismaClient,
    private readonly limitPerDay: number,
  ) {}

  async check(companyId: string, at: Date): Promise<void> {
    const since = new Date(at.getTime() - 24 * 60 * 60 * 1000);
    const used = await this.db.llmCall.count({
      where: { companyId, purpose: "probe", createdAt: { gte: since } },
    });
    if (used >= this.limitPerDay) throw new ProbeLimitError(this.limitPerDay);
  }
}

export class PrismaBudgetLimits implements BudgetLimitSource {
  constructor(private readonly db: PrismaClient) {}
  async limitsFor(scopes: { scope: BudgetScope; scopeId: string }[]): Promise<BudgetLimit[]> {
    if (scopes.length === 0) return [];
    const rows = await this.db.budget.findMany({
      where: { OR: scopes.map((s) => ({ scope: s.scope, scopeId: s.scopeId })) },
    });
    return rows.map((r) => ({
      scope: r.scope as BudgetScope,
      scopeId: r.scopeId,
      limitCents: r.limitCents,
      period: r.period as "month" | "total",
    }));
  }
}

/** Loads prices for the providers a tenant can use into an in-memory PriceTable. */
export async function loadPrices(db: PrismaClient, companyId: string, into: PriceTable): Promise<void> {
  const rows = await db.modelPrice.findMany({
    where: { provider: { OR: [{ companyId }, { companyId: null }] } },
  });
  for (const r of rows) {
    const p: ModelPrice = {
      providerId: r.providerId,
      model: r.model,
      inputPerMtok: r.inputPerMtok,
      cachedInputPerMtok: r.cachedInputPerMtok,
      outputPerMtok: r.outputPerMtok,
      source: r.source as ModelPrice["source"],
    };
    into.set(p);
  }
}
