import { withSystemTenant, withTenant } from "@aidp/db";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The monthly tenant statement (D-224): the data an invoice reads.
 *
 * It is frozen, not computed on request, because the ledger it summarises is subject to
 * retention: a statement for a month two years ago must still say what that month cost after the
 * rows under it have been purged. The `billing.statement` job writes one row per tenant on the
 * 1st; the routes only read.
 */

/** One provider x model x purpose of one month. */
export interface StatementLine {
  providerId: string;
  providerName: string;
  model: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  audioSeconds: number;
  ttsCharacters: number;
  costCents: number;
  /** The part of `costCents` that is our estimate, not the provider's report (D-221). */
  estimatedCents: number;
}

export interface StatementBudgetLine {
  scope: string;
  scopeId: string;
  /** The campaign's name for a campaign budget; null when it cannot be resolved. */
  name: string | null;
  period: string;
  limitCents: number;
  spentCents: number;
  /** Spend reached the limit within the month. */
  hit: boolean;
}

export interface StatementTotals {
  costCents: number;
  estimatedCents: number;
  calls: number;
  byPurpose: Record<string, number>;
  byProvider: Record<string, number>;
  budgets: StatementBudgetLine[];
}

export interface StatementCounts {
  sessionsStarted: number;
  sessionsCompleted: number;
  participants: number;
  /** Minutes of audio sent to transcription: recorded answers and live calls (D-220). */
  voiceMinutes: number;
  storageBytes: number;
  campaignsActive: number;
  analysesRun: number;
  specVersions: number;
}

export interface Statement {
  companyId: string;
  month: string;
  generatedAt: string;
  currency: string;
  lines: StatementLine[];
  totals: StatementTotals;
  counts: StatementCounts;
}

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The `yyyy-mm` a date falls in, UTC. */
export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** The month before the one `date` is in. */
export function previousMonth(date: Date): string {
  return monthOf(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

function bounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export interface StatementServiceDeps {
  db: PrismaClient;
  now?: () => Date;
}

export class StatementService {
  private readonly now: () => Date;
  constructor(private readonly deps: StatementServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Computes a month's statement for one tenant from the ledger. Writes nothing. */
  async compute(companyId: string, month: string): Promise<Statement> {
    const { db } = this.deps;
    const { from, to } = bounds(month);
    const inMonth = { companyId, createdAt: { gte: from, lt: to } };
    const [groups, estimatedGroups] = await Promise.all([
      db.llmCall.groupBy({
        by: ["providerId", "model", "purpose"],
        where: inMonth,
        _count: { _all: true },
        _sum: {
          inputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          outputTokens: true,
          audioSeconds: true,
          ttsCharacters: true,
          costCents: true,
        },
      }),
      db.llmCall.groupBy({
        by: ["providerId", "model", "purpose"],
        where: { ...inMonth, estimated: true },
        _sum: { costCents: true },
      }),
    ]);
    const providerIds = [...new Set(groups.map((g) => g.providerId))];
    const providers = providerIds.length
      ? await db.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(providers.map((p) => [p.id, p.name]));
    const estimatedBy = new Map(
      estimatedGroups.map((g) => [`${g.providerId}|${g.model}|${g.purpose}`, g._sum.costCents ?? 0]),
    );
    const lines: StatementLine[] = groups
      .map((g) => ({
        providerId: g.providerId,
        providerName: names.get(g.providerId) ?? g.providerId,
        model: g.model,
        purpose: g.purpose,
        calls: g._count._all,
        inputTokens: g._sum.inputTokens ?? 0,
        cacheReadTokens: g._sum.cacheReadTokens ?? 0,
        cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        audioSeconds: g._sum.audioSeconds ?? 0,
        ttsCharacters: g._sum.ttsCharacters ?? 0,
        costCents: g._sum.costCents ?? 0,
        estimatedCents: estimatedBy.get(`${g.providerId}|${g.model}|${g.purpose}`) ?? 0,
      }))
      .sort(
        (a, b) =>
          a.providerName.localeCompare(b.providerName) ||
          a.model.localeCompare(b.model) ||
          a.purpose.localeCompare(b.purpose),
      );

    const totals: StatementTotals = {
      costCents: 0,
      estimatedCents: 0,
      calls: 0,
      byPurpose: {},
      byProvider: {},
      budgets: await this.budgetLines(companyId, from, to),
    };
    for (const l of lines) {
      totals.costCents += l.costCents;
      totals.estimatedCents += l.estimatedCents;
      totals.calls += l.calls;
      totals.byPurpose[l.purpose] = (totals.byPurpose[l.purpose] ?? 0) + l.costCents;
      totals.byProvider[l.providerName] = (totals.byProvider[l.providerName] ?? 0) + l.costCents;
    }

    return {
      companyId,
      month,
      generatedAt: this.now().toISOString(),
      currency: "USD",
      lines,
      totals,
      counts: await this.counts(companyId, from, to),
    };
  }

  private async budgetLines(companyId: string, from: Date, to: Date): Promise<StatementBudgetLine[]> {
    const { db } = this.deps;
    const budgets = await db.budget.findMany({ where: { companyId } });
    if (budgets.length === 0) return [];
    const campaignIds = budgets.filter((b) => b.scope === "campaign").map((b) => b.scopeId);
    const campaigns = campaignIds.length
      ? await db.campaign.findMany({
          where: { companyId, id: { in: campaignIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(campaigns.map((c) => [c.id, c.name]));
    const out: StatementBudgetLine[] = [];
    for (const b of budgets) {
      const scopeWhere: Prisma.LlmCallWhereInput =
        b.scope === "tenant"
          ? { companyId }
          : b.scope === "campaign"
            ? { companyId, campaignId: b.scopeId }
            : { companyId, sessionId: b.scopeId };
      const agg = await db.llmCall.aggregate({
        _sum: { costCents: true },
        where: { ...scopeWhere, ...(b.period === "month" ? { createdAt: { gte: from, lt: to } } : {}) },
      });
      const spent = agg._sum.costCents ?? 0;
      out.push({
        scope: b.scope,
        scopeId: b.scopeId,
        name: b.scope === "tenant" ? null : (names.get(b.scopeId) ?? null),
        period: b.period,
        limitCents: b.limitCents,
        spentCents: spent,
        hit: b.limitCents > 0 && spent >= b.limitCents,
      });
    }
    return out;
  }

  private async counts(companyId: string, from: Date, to: Date): Promise<StatementCounts> {
    const { db } = this.deps;
    const created = { gte: from, lt: to };
    const [started, completed, participants, audio, storage, campaigns, analyses, specs] = await Promise.all([
      db.session.count({ where: { companyId, createdAt: created } }),
      db.session.count({ where: { companyId, status: "completed", endedAt: created } }),
      db.participant.count({ where: { companyId, createdAt: created } }),
      db.llmCall.aggregate({
        where: {
          companyId,
          createdAt: created,
          purpose: { in: ["transcription", "stt_stream", "realtime_voice"] },
        },
        _sum: { audioSeconds: true },
      }),
      db.attachment.aggregate({ where: { companyId, createdAt: { lt: to } }, _sum: { sizeBytes: true } }),
      db.campaign.count({ where: { companyId, status: { in: ["draft", "open", "analyzing"] } } }),
      db.analysis.count({ where: { companyId, createdAt: created } }),
      db.specVersion.count({ where: { companyId, createdAt: created } }),
    ]);
    return {
      sessionsStarted: started,
      sessionsCompleted: completed,
      participants,
      voiceMinutes: Math.round(((audio._sum.audioSeconds ?? 0) / 60) * 100) / 100,
      storageBytes: storage._sum.sizeBytes ?? 0,
      campaignsActive: campaigns,
      analysesRun: analyses,
      specVersions: specs,
    };
  }

  /**
   * Computes and stores a month's statement for one tenant. A statement that exists is returned
   * as it is unless `force`: the first freeze is the one an invoice may already have used.
   */
  async freeze(
    companyId: string,
    month: string,
    options: { force?: boolean } = {},
  ): Promise<{ statement: Statement; created: boolean }> {
    return withTenant(companyId, async () => {
      const { db } = this.deps;
      const existing = await db.tenantStatement.findUnique({
        where: { companyId_month: { companyId, month } },
      });
      if (existing && !options.force) return { statement: toStatement(existing), created: false };
      const s = await this.compute(companyId, month);
      const data = {
        generatedAt: new Date(s.generatedAt),
        currency: s.currency,
        lines: s.lines as unknown as Prisma.InputJsonValue,
        totals: s.totals as unknown as Prisma.InputJsonValue,
        counts: s.counts as unknown as Prisma.InputJsonValue,
      };
      await db.tenantStatement.upsert({
        where: { companyId_month: { companyId, month } },
        create: { companyId, month, ...data },
        update: data,
      });
      return { statement: s, created: true };
    });
  }

  /** Freezes a month for every active tenant; one tenant's failure does not stop the rest. */
  async freezeAll(
    month: string,
    options: {
      force?: boolean;
      companyId?: string;
      onError?: (companyId: string, err: unknown) => void;
    } = {},
  ): Promise<{ created: string[]; existing: string[]; failed: string[] }> {
    const tenants = await withSystemTenant(async () =>
      this.deps.db.company.findMany({
        where: options.companyId ? { id: options.companyId } : { status: { in: ["active", "suspended"] } },
        select: { id: true },
      }),
    );
    const out = { created: [] as string[], existing: [] as string[], failed: [] as string[] };
    for (const t of tenants) {
      try {
        const r = await this.freeze(t.id, month, options.force ? { force: true } : {});
        (r.created ? out.created : out.existing).push(t.id);
      } catch (err) {
        out.failed.push(t.id);
        options.onError?.(t.id, err);
      }
    }
    return out;
  }

  async list(companyId: string): Promise<{ month: string; generatedAt: string; costCents: number }[]> {
    const rows = await this.deps.db.tenantStatement.findMany({
      where: { companyId },
      orderBy: { month: "desc" },
    });
    return rows.map((r) => ({
      month: r.month,
      generatedAt: r.generatedAt.toISOString(),
      costCents: (r.totals as unknown as StatementTotals).costCents,
    }));
  }

  async get(companyId: string, month: string): Promise<Statement | null> {
    const row = await this.deps.db.tenantStatement.findUnique({
      where: { companyId_month: { companyId, month } },
    });
    return row ? toStatement(row) : null;
  }

  /** Every tenant's frozen statement for a month: the operator's invoicing export. */
  async allForMonth(month: string): Promise<Statement[]> {
    const rows = await withSystemTenant(async () =>
      this.deps.db.tenantStatement.findMany({ where: { month }, orderBy: { companyId: "asc" } }),
    );
    return rows.map(toStatement);
  }
}

function toStatement(r: {
  companyId: string;
  month: string;
  generatedAt: Date;
  currency: string;
  lines: Prisma.JsonValue;
  totals: Prisma.JsonValue;
  counts: Prisma.JsonValue;
}): Statement {
  return {
    companyId: r.companyId,
    month: r.month,
    generatedAt: r.generatedAt.toISOString(),
    currency: r.currency,
    lines: r.lines as unknown as StatementLine[],
    totals: r.totals as unknown as StatementTotals,
    counts: r.counts as unknown as StatementCounts,
  };
}

const CSV_HEADER = [
  "companyId",
  "month",
  "currency",
  "provider",
  "providerId",
  "model",
  "purpose",
  "calls",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "audioSeconds",
  "ttsCharacters",
  "costCents",
  "estimatedCents",
] as const;

/** A cell, quoted when it must be; and made inert when a spreadsheet would read it as a formula. */
export function csvCell(value: string | number): string {
  let s = typeof value === "number" ? String(value) : value;
  // A provider or model name is data a tenant admin can type; a leading `=`, `+`, `-`, `@` would
  // be executed by a spreadsheet the operator opens the export in.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Statements as CSV, one row per provider x model x purpose, with the tenant and month on every
 * row so several tenants share one file (the operator's invoicing spreadsheet).
 */
export function statementsToCsv(statements: Statement[]): string {
  const rows: string[] = [CSV_HEADER.join(",")];
  for (const s of statements)
    for (const l of s.lines)
      rows.push(
        [
          s.companyId,
          s.month,
          s.currency,
          l.providerName,
          l.providerId,
          l.model,
          l.purpose,
          l.calls,
          l.inputTokens,
          l.cacheReadTokens,
          l.cacheWriteTokens,
          l.outputTokens,
          Math.round(l.audioSeconds * 1000) / 1000,
          l.ttsCharacters,
          Math.round(l.costCents * 10000) / 10000,
          Math.round(l.estimatedCents * 10000) / 10000,
        ]
          .map(csvCell)
          .join(","),
      );
  return `${rows.join("\n")}\n`;
}
