import { tenantTransaction, withSystemTenant } from "@aidp/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { QueueSummary } from "../jobs/admin.js";
import type { TenantCeilings, CeilingUtilisation } from "../tenancy/ceilings.js";
import type { BackupStatus, HealthInputs, HealthThresholds } from "./health-sweep.js";

/**
 * The operator's one page (D-222, operations 7.6): every platform signal and every tenant's
 * utilisation, computed on request from the same inputs the five-minute sweep reads.
 *
 * Each signal carries a status, so the page is a set of traffic lights and the operator opens it
 * to find the one that is not green. Nothing here raises an alert: the sweep does that, and this
 * only reports what it would see right now.
 */

export type SignalStatus = "ok" | "warn" | "critical" | "unknown";

export interface HealthSignal {
  /** Stable key, also the anchor in docs/OPERATIONS.md the page links to. */
  key: string;
  status: SignalStatus;
  /** One line of what the number is, for the page. */
  detail: string;
  /** The number itself, when there is one. */
  value?: number | string | null;
}

export interface TenantHealth {
  companyId: string;
  name: string;
  status: string;
  sessionsThisMonth: number;
  activeSessions: number;
  spendCents: number;
  budgetLimitCents: number | null;
  /** Spend over limit, or null without a monthly budget. */
  budgetFraction: number | null;
  storageBytes: number;
  voiceMinutes: number;
  lastActivityAt: string | null;
  openCampaigns: number;
  deadLetters24h: number;
  firstTokenP95Ms: number | null;
  utilisation: CeilingUtilisation[];
}

export interface PlatformHealth {
  generatedAt: string;
  version: string | null;
  signals: HealthSignal[];
  queues: QueueSummary[];
  providers: {
    providerId: string;
    name: string;
    calls: number;
    failed: number;
    errorRate: number;
    circuit: "closed" | "half_open" | "open";
  }[];
  latency: {
    firstTokenP50Ms24h: number | null;
    firstTokenP95Ms24h: number | null;
    firstTokenTargetMs: number;
    voiceFirstWordP95Ms24h: number | null;
    voiceFirstWordTargetMs: number;
  };
  backup: {
    lastResult: string | null;
    lastSuccessAt: string | null;
    ageHours: number | null;
    sizeBytes: number | null;
    offsite: string | null;
    drill: { result: string | null; at: string | null; error: string | null; durationS: number | null };
  };
  tenants: TenantHealth[];
}

export interface PlatformHealthDeps {
  db: PrismaClient;
  inputs: HealthInputs;
  ceilings: TenantCeilings;
  thresholds: () => Promise<HealthThresholds & { voiceTargetFirstWordMs: number }>;
  /** Per provider: where this process's circuit breaker stands. */
  circuit?: (providerId: string) => "closed" | "half_open" | "open";
  speech?: () => { state: string; model: string | null };
  version?: string | undefined;
  now?: () => Date;
}

const FIRST_TOKEN_TARGET_MS = 2000;
const ERROR_WARN = 0.1;
const ERROR_CRITICAL = 0.3;

const worst = (a: SignalStatus, b: SignalStatus): SignalStatus => {
  const order: SignalStatus[] = ["ok", "unknown", "warn", "critical"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

export class PlatformHealthService {
  private readonly now: () => Date;
  constructor(private readonly deps: PlatformHealthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async snapshot(): Promise<PlatformHealth> {
    const { inputs } = this.deps;
    const now = this.now();
    const t = await this.deps.thresholds();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
    const [queues, stuck, backupRead, disk, providerCalls, heartbeat, latency, voice] = await Promise.all([
      settle(inputs.queues(), [] as QueueSummary[]),
      settle(inputs.stuck(), []),
      settle(inputs.backup(), { state: "unreadable" as const }),
      settle(inputs.disk(), null),
      settle(inputs.providerCalls(hourAgo), []),
      settle(inputs.heartbeatAgeSeconds?.() ?? Promise.resolve(null), null),
      settle(this.firstToken(dayAgo), { p50: null, p95: null, errors: { calls: 0, failed: 0 } }),
      settle(this.voiceFirstWord(dayAgo), null),
    ]);

    const signals: HealthSignal[] = [];
    const add = (s: HealthSignal): void => {
      signals.push(s);
    };

    // Queue.
    const queued = queues.reduce((n, q) => n + q.queued, 0);
    const dead = queues.reduce((n, q) => n + q.deadLettered, 0);
    const oldest = queues
      .map((q) => (q.oldestQueuedAt ? now.getTime() - Date.parse(q.oldestQueuedAt) : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    add({
      key: "queue.depth",
      status: oldest > 600_000 ? "warn" : "ok",
      value: queued,
      detail: `${queued} queued, oldest waiting ${Math.round(oldest / 1000)} s`,
    });
    add({
      key: "job.dead_lettered",
      status: dead > 0 ? "critical" : "ok",
      value: dead,
      detail: dead > 0 ? `${dead} dead-lettered job(s) wait for a retry or discard` : "No dead letters",
    });
    const stuckTotal = stuck.reduce((n, s) => n + s.count, 0);
    add({
      key: "job.stuck",
      status: stuckTotal > 0 ? "warn" : "ok",
      value: stuckTotal,
      detail: stuckTotal > 0 ? `${stuckTotal} job(s) active past expiry` : "No stuck jobs",
    });

    // Worker.
    add({
      key: "worker.heartbeat_stale",
      status: heartbeat === null ? "unknown" : heartbeat > 300 ? "critical" : heartbeat > 90 ? "warn" : "ok",
      value: heartbeat,
      detail: heartbeat === null ? "No heartbeat file configured" : `Worker heartbeat ${heartbeat} s old`,
    });

    // Backups.
    const backup = backupRead.state === "present" ? backupRead.status : undefined;
    const ageMs = backup?.lastSuccessAt ? now.getTime() - Date.parse(backup.lastSuccessAt) : null;
    const ageHours = ageMs === null || Number.isNaN(ageMs) ? null : Math.floor(ageMs / 3_600_000);
    add({
      key: "backup.age",
      status:
        backupRead.state === "unconfigured"
          ? "unknown"
          : backup?.lastResult === "failed"
            ? "critical"
            : ageHours === null
              ? "critical"
              : ageHours > t.backupMaxAgeHours
                ? "critical"
                : "ok",
      value: ageHours,
      detail:
        backupRead.state === "unconfigured"
          ? "No ops state directory: backups are not monitored here"
          : ageHours === null
            ? "No successful backup recorded"
            : `Last successful backup ${ageHours} h ago`,
    });
    const offsite = backup?.offsite ?? null;
    add({
      key: "backup.offsite",
      status: offsite === "ok" ? "ok" : offsite === "failed" ? "critical" : "warn",
      value: offsite,
      detail:
        offsite === "ok"
          ? "Offsite copy is current"
          : offsite === "failed"
            ? "The last offsite copy failed"
            : "No offsite destination configured (set RCLONE_REMOTE)",
    });
    const drill = backup?.drill;
    const drillAgeDays = drill?.at ? Math.floor((now.getTime() - Date.parse(drill.at)) / 86_400_000) : null;
    add({
      key: "backup.drill",
      status:
        backupRead.state === "unconfigured"
          ? "unknown"
          : drill?.result === "failed"
            ? "critical"
            : drill?.result === "ok"
              ? drillAgeDays !== null && drillAgeDays > 9
                ? "warn"
                : "ok"
              : "warn",
      value: drill?.result ?? null,
      detail: drill?.result
        ? `Restore drill ${drill.result}${drillAgeDays !== null ? `, ${drillAgeDays} d ago` : ""}${drill.error ? `: ${drill.error}` : ""}`
        : "No restore drill has run yet",
    });

    // Disk.
    const diskPercent =
      disk && disk.totalBytes > 0 ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;
    add({
      key: "disk.high",
      status:
        diskPercent === null
          ? "unknown"
          : diskPercent >= t.diskCriticalPercent
            ? "critical"
            : diskPercent >= t.diskWarnPercent
              ? "warn"
              : "ok",
      value: diskPercent,
      detail: diskPercent === null ? "Disk not measured" : `${diskPercent}% used`,
    });

    // Providers and the error rate.
    const providers = providerCalls.map((p) => ({
      providerId: p.providerId,
      name: p.name,
      calls: p.total,
      failed: p.failed,
      errorRate: p.total === 0 ? 0 : p.failed / p.total,
      circuit: this.deps.circuit?.(p.providerId) ?? ("closed" as const),
    }));
    let providerStatus: SignalStatus = "ok";
    for (const p of providers) {
      if (p.circuit !== "closed") providerStatus = worst(providerStatus, "critical");
      else if (p.calls >= 10 && p.errorRate >= t.providerErrorRate)
        providerStatus = worst(providerStatus, "warn");
    }
    add({
      key: "provider.error_rate",
      status: providerStatus,
      value: providers.length,
      detail: providers.length
        ? providers
            .map((p) => `${p.name}: ${p.failed}/${p.calls}${p.circuit !== "closed" ? ` (${p.circuit})` : ""}`)
            .join("; ")
        : "No provider calls in the last hour",
    });
    const calls = latency.errors.calls;
    const errorRate = calls === 0 ? 0 : latency.errors.failed / calls;
    add({
      key: "error_rate",
      status: errorRate >= ERROR_CRITICAL ? "critical" : errorRate >= ERROR_WARN ? "warn" : "ok",
      value: Math.round(errorRate * 1000) / 10,
      detail: `${latency.errors.failed} of ${calls} model calls failed in the last 24 h`,
    });

    // SLOs.
    add({
      key: "slo.first_token",
      status: latency.p95 === null ? "unknown" : latency.p95 > FIRST_TOKEN_TARGET_MS ? "critical" : "ok",
      value: latency.p95,
      detail:
        latency.p95 === null
          ? "No interview turns measured in the last 24 h"
          : `First token p95 ${latency.p95} ms (target ${FIRST_TOKEN_TARGET_MS} ms)`,
    });
    add({
      key: "slo.voice_first_word",
      status: voice === null ? "unknown" : voice > t.voiceTargetFirstWordMs ? "critical" : "ok",
      value: voice,
      detail:
        voice === null
          ? "No live voice calls measured in the last 24 h"
          : `Voice first word p95 ${voice} ms (target ${t.voiceTargetFirstWordMs} ms)`,
    });

    // Speech model and memory.
    const speech = this.deps.speech?.();
    if (speech)
      add({
        key: "speech.model",
        status: speech.state === "error" ? "warn" : "ok",
        value: speech.state,
        detail: `On-server speech model: ${speech.state}${speech.model ? ` (${speech.model})` : ""}`,
      });
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    add({ key: "memory.api", status: "ok", value: rssMb, detail: `API process resident set ${rssMb} MB` });

    const [openAlerts, exceeded] = await Promise.all([
      settle(this.openAlerts(), 0),
      settle(this.tenantsOverBudget(monthStart), 0),
    ]);
    add({
      key: "alerts.open",
      status: openAlerts > 0 ? "warn" : "ok",
      value: openAlerts,
      detail: `${openAlerts} unresolved alert(s)`,
    });
    add({
      key: "budget.exceeded",
      status: exceeded > 0 ? "warn" : "ok",
      value: exceeded,
      detail: `${exceeded} tenant(s) at or over a monthly budget`,
    });

    const tenants = await settle(this.tenants(monthStart, dayAgo), []);

    return {
      generatedAt: now.toISOString(),
      version: this.deps.version ?? null,
      signals,
      queues,
      providers,
      latency: {
        firstTokenP50Ms24h: latency.p50,
        firstTokenP95Ms24h: latency.p95,
        firstTokenTargetMs: FIRST_TOKEN_TARGET_MS,
        voiceFirstWordP95Ms24h: voice,
        voiceFirstWordTargetMs: t.voiceTargetFirstWordMs,
      },
      backup: {
        lastResult: backup?.lastResult ?? null,
        lastSuccessAt: backup?.lastSuccessAt ?? null,
        ageHours,
        sizeBytes: backup?.sizeBytes ?? null,
        offsite,
        drill: {
          result: drill?.result ?? null,
          at: drill?.at ?? null,
          error: drill?.error ?? null,
          durationS: drill?.durationS ?? null,
        },
      },
      tenants,
    };
  }

  private async firstToken(
    since: Date,
  ): Promise<{ p50: number | null; p95: number | null; errors: { calls: number; failed: number } }> {
    return withSystemTenant(async () => {
      const rows = await tenantTransaction(
        this.deps.db,
        (tx) =>
          tx.$queryRaw<{ p50: number | null; p95: number | null }[]>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "firstTokenMs")::float8 AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY "firstTokenMs")::float8 AS p95
          FROM "LlmCall"
         WHERE "createdAt" >= ${since} AND "firstTokenMs" IS NOT NULL
           AND purpose IN (${Prisma.join(["interview_turn", "spec_turn"])})`,
      );
      const errs = await this.deps.db.llmCall.groupBy({
        by: ["status"],
        where: { createdAt: { gte: since }, status: { in: ["ok", "error"] } },
        _count: { _all: true },
      });
      const r = rows[0];
      const round = (v: number | null | undefined): number | null =>
        v === null || v === undefined ? null : Math.round(v);
      const ok = errs.find((e) => e.status === "ok")?._count._all ?? 0;
      const failed = errs.find((e) => e.status === "error")?._count._all ?? 0;
      return { p50: round(r?.p50), p95: round(r?.p95), errors: { calls: ok + failed, failed } };
    });
  }

  private async voiceFirstWord(since: Date): Promise<number | null> {
    return withSystemTenant(async () => {
      const rows = await tenantTransaction(
        this.deps.db,
        (tx) =>
          tx.$queryRaw<{ p95: number | null }[]>`
        SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'avgFirstWordMs')::float8)::float8 AS p95
          FROM "SessionEvent"
         WHERE type = 'voice.live' AND "createdAt" >= ${since} AND payload->>'avgFirstWordMs' IS NOT NULL`,
      );
      const p = rows[0]?.p95;
      return p === null || p === undefined ? null : Math.round(p);
    });
  }

  private async openAlerts(): Promise<number> {
    return withSystemTenant(async () =>
      this.deps.db.opsAlert.count({
        where: { resolvedAt: null, lastAt: { gte: new Date(this.now().getTime() - 86_400_000) } },
      }),
    );
  }

  private async tenantsOverBudget(monthStart: Date): Promise<number> {
    return withSystemTenant(async () => {
      const budgets = await this.deps.db.budget.findMany({
        where: { scope: "tenant", period: "month", limitCents: { gt: 0 } },
      });
      if (budgets.length === 0) return 0;
      const spend = await this.deps.db.llmCall.groupBy({
        by: ["companyId"],
        where: { createdAt: { gte: monthStart }, companyId: { in: budgets.map((b) => b.companyId) } },
        _sum: { costCents: true },
      });
      const by = new Map(spend.map((s) => [s.companyId, s._sum.costCents ?? 0]));
      return budgets.filter((b) => (by.get(b.companyId) ?? 0) >= b.limitCents).length;
    });
  }

  private async tenants(monthStart: Date, dayAgo: Date): Promise<TenantHealth[]> {
    const { db, ceilings } = this.deps;
    const companies = await withSystemTenant(async () =>
      db.company.findMany({
        where: { status: { not: "deleted" } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, status: true },
      }),
    );
    if (companies.length === 0) return [];
    const ids = companies.map((c) => c.id);
    const [sessions, active, spend, storage, lastSeen, campaigns, deadByTenant, budgets, p95s] =
      await withSystemTenant(async () =>
        Promise.all([
          db.session.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids }, createdAt: { gte: monthStart } },
            _count: { _all: true },
          }),
          db.session.groupBy({
            by: ["companyId"],
            where: {
              companyId: { in: ids },
              status: { in: ["active", "consented"] },
              updatedAt: { gte: new Date(this.now().getTime() - 300_000) },
            },
            _count: { _all: true },
          }),
          db.llmCall.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids }, createdAt: { gte: monthStart } },
            _sum: { costCents: true },
          }),
          db.attachment.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids } },
            _sum: { sizeBytes: true },
          }),
          db.session.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids } },
            _max: { updatedAt: true },
          }),
          db.campaign.groupBy({
            by: ["companyId"],
            where: { companyId: { in: ids }, status: { in: ["draft", "open", "analyzing"] } },
            _count: { _all: true },
          }),
          this.deadByTenant(dayAgo),
          db.budget.findMany({ where: { companyId: { in: ids }, scope: "tenant", period: "month" } }),
          tenantTransaction(
            db,
            (tx) =>
              tx.$queryRaw<{ companyId: string; p95: number | null }[]>`
            SELECT "companyId", percentile_cont(0.95) WITHIN GROUP (ORDER BY "firstTokenMs")::float8 AS p95
              FROM "LlmCall"
             WHERE "createdAt" >= ${dayAgo} AND "firstTokenMs" IS NOT NULL
               AND purpose IN (${Prisma.join(["interview_turn", "spec_turn"])})
             GROUP BY "companyId"`,
          ),
        ]),
      );
    const by = <T extends { companyId: string }>(rows: T[]): Map<string, T> =>
      new Map(rows.map((r) => [r.companyId, r]));
    const sessionsBy = by(sessions);
    const activeBy = by(active);
    const spendBy = by(spend);
    const storageBy = by(storage);
    const lastBy = by(lastSeen);
    const campaignsBy = by(campaigns);
    const budgetBy = by(budgets);
    const p95By = by(p95s);
    const out: TenantHealth[] = [];
    for (const c of companies) {
      const util = await ceilings.utilisation(c.id).catch(() => [] as CeilingUtilisation[]);
      const spent = spendBy.get(c.id)?._sum.costCents ?? 0;
      const limit = budgetBy.get(c.id)?.limitCents ?? null;
      const p95 = p95By.get(c.id)?.p95;
      out.push({
        companyId: c.id,
        name: c.name,
        status: c.status,
        sessionsThisMonth: sessionsBy.get(c.id)?._count._all ?? 0,
        activeSessions: activeBy.get(c.id)?._count._all ?? 0,
        spendCents: spent,
        budgetLimitCents: limit,
        budgetFraction: limit && limit > 0 ? spent / limit : null,
        storageBytes: storageBy.get(c.id)?._sum.sizeBytes ?? 0,
        voiceMinutes: util.find((u) => u.metric === "voiceMinutes")?.used ?? 0,
        lastActivityAt: lastBy.get(c.id)?._max.updatedAt?.toISOString() ?? null,
        openCampaigns: campaignsBy.get(c.id)?._count._all ?? 0,
        deadLetters24h: deadByTenant.get(c.id) ?? 0,
        firstTokenP95Ms: p95 === null || p95 === undefined ? null : Math.round(p95),
        utilisation: util,
      });
    }
    return out;
  }

  /** Dead letters of the last day by the tenant their payload names. */
  private async deadByTenant(since: Date): Promise<Map<string, number>> {
    try {
      const rows = await withSystemTenant(() =>
        tenantTransaction(this.deps.db, (tx) =>
          tx.$queryRaw<{ company: string | null; n: bigint }[]>(
            Prisma.sql`select data->>'companyId' as company, count(*) as n from pgboss.job
                    where name like '%.dead' and created_on >= ${since}
                    group by 1`,
          ),
        ),
      );
      return new Map(rows.filter((r) => r.company).map((r) => [r.company ?? "", Number(r.n)]));
    } catch {
      return new Map();
    }
  }
}

export type { BackupStatus };
