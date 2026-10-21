import { tenantTransaction } from "@aidp/db";
import {
  COMPLETION_REQUESTED_TURN_COUNT,
  CoverageAreaSchema,
  IDLE_CAP_SECONDS,
  isNotAi,
  rankScore,
  SOLUTION_CLASSES,
  type SolutionClass,
  type StatsAi,
  type StatsDiscovery,
  type StatsHealth,
  type StatsParticipation,
  type StatsRange,
  type StatsRequirements,
  type TopOpportunity,
  type Weights,
} from "@aidp/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

/** What the segment queries need from the rest of the application. */
export interface SegmentDeps {
  db: PrismaClient;
  /** The newest weights of a campaign; opportunities are ranked under them, as the results page does. */
  weightsFor: (campaignId: string, companyId: string) => Promise<Weights>;
  /** `privacy.kAnonymity` in force for the tenant. */
  k: (companyId: string) => Promise<number>;
  /** Whether a member may see preliminary results (`analysis.preliminaryVisibleToMembers`). */
  preliminaryVisibleToMembers: (companyId: string) => Promise<boolean>;
  queues?:
    (() => Promise<{ name: string; queued: number; active: number; deadLettered: number }[]>) | undefined;
  deadLetters?: ((companyId: string) => Promise<number>) | undefined;
  /** `files.tenantQuotaMb` in force for the tenant, in bytes. */
  storageQuotaBytes?: ((companyId: string) => Promise<number | null>) | undefined;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** SQL fragments for the optional window and campaign, on the session alias `s`. */
function sessionRange(range: StatsRange): { when: Prisma.Sql; campaign: Prisma.Sql } {
  return {
    when: Prisma.sql`${range.from ? Prisma.sql`AND s."createdAt" >= ${range.from}` : Prisma.empty}
      ${range.to ? Prisma.sql`AND s."createdAt" <= ${range.to}` : Prisma.empty}`,
    campaign: range.campaignId ? Prisma.sql`AND s."campaignId" = ${range.campaignId}` : Prisma.empty,
  };
}

/**
 * Participation (spec 07). Every figure derived from fewer than k interviews is withheld; the
 * funnel's counts are totals of the organization's own campaigns, not breakdowns, and stay.
 */
export async function participation(
  d: SegmentDeps,
  companyId: string,
  range: StatsRange,
): Promise<StatsParticipation> {
  const k = await d.k(companyId);
  const { when, campaign } = sessionRange(range);
  const rows = await tenantTransaction(d.db, async (tx) => {
    const campaigns = await tx.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT status, count(*) AS n FROM "Campaign"
      WHERE "companyId" = ${companyId} ${range.campaignId ? Prisma.sql`AND id = ${range.campaignId}` : Prisma.empty}
      GROUP BY status`;
    const sessions = await tx.$queryRaw<{ status: string; identified: boolean; n: bigint }[]>`
      SELECT s.status, s.identified, count(*) AS n FROM "Session" s
      WHERE s."companyId" = ${companyId} AND s."sourceKind" = 'campaign' ${campaign} ${when}
      GROUP BY s.status, s.identified`;
    const invitations = await tx.$queryRaw<
      { invited: bigint; opened: bigint; reminded: bigint; reminders: bigint }[]
    >`
      SELECT count(*) FILTER (WHERE i.status <> 'revoked') AS invited,
             count(*) FILTER (WHERE i."openedAt" IS NOT NULL AND i.status <> 'revoked') AS opened,
             count(*) FILTER (WHERE i."reminderCount" > 0) AS reminded,
             COALESCE(sum(i."reminderCount"), 0) AS reminders
      FROM "Invitation" i
      WHERE i."companyId" = ${companyId} ${range.campaignId ? Prisma.sql`AND i."campaignId" = ${range.campaignId}` : Prisma.empty}`;
    // The gap between two messages is capped, because a pause overnight is not time spent.
    const median = await tx.$queryRaw<{ median: number | null; n: bigint }[]>`
      WITH gaps AS (
        SELECT m."sessionId",
               -- LEAST ignores NULL, so the first message (no predecessor) is left as NULL on purpose.
               CASE WHEN lag(m."createdAt") OVER w IS NULL THEN NULL
                    ELSE LEAST(EXTRACT(EPOCH FROM (m."createdAt" - lag(m."createdAt") OVER w)), ${IDLE_CAP_SECONDS})
               END AS g
        FROM "Message" m
        JOIN "Session" s ON s.id = m."sessionId" AND s."companyId" = m."companyId"
        WHERE m."companyId" = ${companyId} AND s.status = 'completed' AND s."sourceKind" = 'campaign' ${campaign} ${when}
        WINDOW w AS (PARTITION BY m."sessionId" ORDER BY m.seq)
      )
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t) AS median, count(*) AS n
      FROM (SELECT sum(g) AS t FROM gaps WHERE g IS NOT NULL GROUP BY "sessionId") x`;
    // The area of the last question an unfinished interview was asked.
    const dropOff = await tx.$queryRaw<{ areaKey: string; n: bigint }[]>`
      SELECT x."areaKey", count(*) AS n FROM (
        SELECT DISTINCT ON (s.id) s.id, m."areaKey"
        FROM "Session" s
        JOIN "Message" m ON m."sessionId" = s.id AND m."companyId" = s."companyId"
        WHERE s."companyId" = ${companyId} AND s."sourceKind" = 'campaign'
          AND s.status IN ('consented', 'active', 'paused') ${campaign} ${when}
          AND m."areaKey" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "Message" u WHERE u."sessionId" = s.id AND u.role = 'user')
        ORDER BY s.id, m.seq DESC
      ) x GROUP BY x."areaKey"`;
    const templates = await tx.interviewTemplate.findMany({
      where: { campaigns: { some: { companyId, ...(range.campaignId ? { id: range.campaignId } : {}) } } },
      select: { coverageAreas: true },
    });
    return { campaigns, sessions, invitations: invitations[0], median: median[0], dropOff, templates };
  });

  const byStatus = (status: string): number =>
    rows.sessions.filter((s) => s.status === status).reduce((a, s) => a + num(s.n), 0);
  const started = ["consented", "active", "paused", "completed"].reduce((a, s) => a + byStatus(s), 0);
  const identifiedN = rows.sessions
    .filter((s) => s.identified && s.status !== "created" && s.status !== "deleted")
    .reduce((a, s) => a + num(s.n), 0);
  const anonymousN = rows.sessions
    .filter((s) => !s.identified && s.status !== "created" && s.status !== "deleted")
    .reduce((a, s) => a + num(s.n), 0);
  const consented = identifiedN + anonymousN;
  const medianN = num(rows.median?.n);
  const names = new Map<string, string>();
  for (const t of rows.templates) {
    const parsed = Array.isArray(t.coverageAreas) ? t.coverageAreas : [];
    for (const a of parsed) {
      const area = CoverageAreaSchema.safeParse(a);
      if (area.success && !names.has(area.data.key)) names.set(area.data.key, area.data.name);
    }
  }
  const shownAreas = rows.dropOff
    .filter((r) => num(r.n) >= k)
    .map((r) => ({ areaKey: r.areaKey, name: names.get(r.areaKey) ?? r.areaKey, sessions: num(r.n) }))
    .sort((a, b) => b.sessions - a.sessions || a.areaKey.localeCompare(b.areaKey));
  const unfinished = rows.dropOff.reduce((a, r) => a + num(r.n), 0);
  const other = rows.dropOff.filter((r) => num(r.n) < k).reduce((a, r) => a + num(r.n), 0);
  const campaignsTotal = rows.campaigns.reduce((a, c) => a + num(c.n), 0);
  const inv = rows.invitations;

  return {
    k,
    campaigns: {
      open: rows.campaigns.filter((c) => c.status === "open").reduce((a, c) => a + num(c.n), 0),
      total: campaignsTotal,
    },
    funnel: {
      invited: num(inv?.invited),
      opened: num(inv?.opened),
      started,
      completed: byStatus("completed"),
    },
    medianActiveSeconds: medianN >= k ? numOrNull(rows.median?.median) : null,
    medianSessions: medianN,
    identified:
      consented >= k
        ? {
            identified: identifiedN,
            anonymous: anonymousN,
            share: Math.round((identifiedN / consented) * 1000) / 1000,
          }
        : { identified: null, anonymous: null, share: null, withheld: "below_k" },
    reminders: { sent: num(inv?.reminders), invitationsReminded: num(inv?.reminded) },
    dropOff: { areas: shownAreas, other, unfinished },
    ...(medianN > 0 && medianN < k ? { withheld: "below_k" as const } : {}),
  };
}

/**
 * Discovery results: the newest finished analysis of each campaign, its non-dismissed
 * opportunities by class, and the ten highest ranked under each campaign's own weights.
 */
export async function discovery(
  d: SegmentDeps,
  companyId: string,
  role: string,
  range: StatsRange,
): Promise<StatsDiscovery> {
  const hidePreliminary = role === "member" && !(await d.preliminaryVisibleToMembers(companyId));
  const analyses = await tenantTransaction(d.db, async (tx) => {
    const latest = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (a."campaignId") a.id
      FROM "Analysis" a
      WHERE a."companyId" = ${companyId} AND a.status = 'done'
        ${hidePreliminary ? Prisma.sql`AND a.preliminary = false` : Prisma.empty}
        ${range.campaignId ? Prisma.sql`AND a."campaignId" = ${range.campaignId}` : Prisma.empty}
      ORDER BY a."campaignId", a.version DESC`;
    return tx.analysis.findMany({
      where: { id: { in: latest.map((r) => r.id) }, companyId },
      include: {
        campaign: { select: { name: true } },
        opportunities: {
          where: { status: { not: "dismissed" } },
          select: { id: true, title: true, solutionClass: true, factors: true, stats: true, basis: true },
        },
      },
    });
  });

  const byClass = Object.fromEntries(SOLUTION_CLASSES.map((c) => [c, 0])) as Record<SolutionClass, number>;
  const candidates: TopOpportunity[] = [];
  let facts = 0;
  let participants = 0;
  let opportunities = 0;
  for (const a of analyses) {
    const weights = await d.weightsFor(a.campaignId, companyId);
    const s = a.stats as { facts?: number; participants?: number };
    facts += s.facts ?? 0;
    participants += s.participants ?? 0;
    for (const o of a.opportunities) {
      const cls = (SOLUTION_CLASSES as readonly string[]).includes(o.solutionClass)
        ? (o.solutionClass as SolutionClass)
        : "none";
      byClass[cls]++;
      opportunities++;
      // "No change recommended" items count in their class but are not top opportunities (D-479).
      if (o.basis === "works_well") continue;
      candidates.push({
        id: o.id,
        title: o.title,
        rankScore: rankScore(o.factors as Parameters<typeof rankScore>[0], weights),
        solutionClass: cls,
        campaignId: a.campaignId,
        campaignName: a.campaign.name,
        participants: (o.stats as { participants?: number }).participants ?? 0,
      });
    }
  }
  const notAi = SOLUTION_CLASSES.filter((c) => isNotAi(c)).reduce((n, c) => n + byClass[c], 0);
  return {
    byClass,
    notAi,
    top: candidates.sort((x, y) => y.rankScore - x.rankScore || x.id.localeCompare(y.id)).slice(0, 10),
    evidence: { analyses: analyses.length, opportunities, facts, participants },
  };
}

/** Requirements projects. A member sees only their own, as everywhere else in the workspace. */
export async function requirements(
  d: SegmentDeps,
  companyId: string,
  who: { role: string; userId: string },
  range: StatsRange,
): Promise<StatsRequirements> {
  const own = who.role === "member" ? Prisma.sql`AND s."ownerUserId" = ${who.userId}` : Prisma.empty;
  const when = Prisma.sql`${range.from ? Prisma.sql`AND s."createdAt" >= ${range.from}` : Prisma.empty}
    ${range.to ? Prisma.sql`AND s."createdAt" <= ${range.to}` : Prisma.empty}`;
  const r = await tenantTransaction(d.db, async (tx) => {
    const status = await tx.$queryRaw<{ status: string; n: bigint }[]>`
      SELECT s.status, count(*) AS n FROM "Session" s
      WHERE s."companyId" = ${companyId} AND s."sourceKind" <> 'campaign' ${own} ${when}
      GROUP BY s.status`;
    // Turns on a finished session; the legacy "I'm done" sentinel is not a turn count (D-170).
    const turns = await tx.$queryRaw<{ median: number | null; mean: unknown; n: bigint }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t) AS median, avg(t) AS mean, count(*) AS n
      FROM (
        SELECT (s.state ->> 'turnCount')::int AS t FROM "Session" s
        WHERE s."companyId" = ${companyId} AND s."sourceKind" <> 'campaign' AND s.status = 'completed'
          AND (s.state ->> 'turnCount') ~ '^[0-9]+$'
          AND (s.state ->> 'turnCount')::bigint < ${COMPLETION_REQUESTED_TURN_COUNT} ${own} ${when}
      ) x`;
    const findings = await tx.$queryRaw<{ type: string; status: string; n: bigint }[]>`
      SELECT f ->> 'type' AS type, COALESCE(f ->> 'status', 'open') AS status, count(*) AS n
      FROM "Session" s, jsonb_array_elements(
        CASE WHEN jsonb_typeof(s.state -> 'findings') = 'array' THEN s.state -> 'findings' ELSE '[]'::jsonb END
      ) f
      WHERE s."companyId" = ${companyId} AND s."sourceKind" <> 'campaign' ${own} ${when}
      GROUP BY 1, 2`;
    const versions = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "SpecVersion" v
      JOIN "Session" s ON s.id = v."sessionId" AND s."companyId" = v."companyId"
      WHERE v."companyId" = ${companyId} ${own} ${when}`;
    return { status, turns: turns[0], findings, versions: versions[0] };
  });
  const raised = r.findings.reduce((a, f) => a + num(f.n), 0);
  const resolved = r.findings
    .filter((f) => f.status === "resolved" || f.status === "accepted")
    .reduce((a, f) => a + num(f.n), 0);
  const byType: Record<string, number> = {};
  for (const f of r.findings) byType[f.type] = (byType[f.type] ?? 0) + num(f.n);
  return {
    projectsByStatus: Object.fromEntries(r.status.map((s) => [s.status, num(s.n)])),
    turnsToSpec: {
      median: numOrNull(r.turns?.median),
      mean: r.turns?.mean == null ? null : Math.round(num(r.turns.mean) * 10) / 10,
      sessions: num(r.turns?.n),
    },
    findings: {
      raised,
      resolved,
      resolvedRatio: raised > 0 ? Math.round((resolved / raised) * 1000) / 1000 : null,
      byType,
    },
    specVersions: num(r.versions?.n),
  };
}

/** The model ledger: latency percentiles by purpose, outcome rates, tokens per interview. */
export async function ai(d: SegmentDeps, companyId: string, range: StatsRange): Promise<StatsAi> {
  const to = range.to ?? new Date();
  const from = range.from ?? new Date(to.getTime() - 30 * 86_400_000);
  const campaign = range.campaignId ? Prisma.sql`AND c."campaignId" = ${range.campaignId}` : Prisma.empty;
  const r = await tenantTransaction(d.db, async (tx) => {
    // Percentiles over calls that produced an answer: a refused or failed call's latency is the
    // provider's time to say no, which would pull the figure the interview feels away from the truth.
    const latency = await tx.$queryRaw<{ purpose: string; n: bigint; p50: number; p95: number }[]>`
      SELECT c.purpose, count(*) AS n,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY c."latencyMs") AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs") AS p95
      FROM "LlmCall" c
      WHERE c."companyId" = ${companyId} AND c.status = 'ok'
        AND c."createdAt" >= ${from} AND c."createdAt" <= ${to} ${campaign}
      GROUP BY c.purpose ORDER BY c.purpose`;
    const outcomes = await tx.$queryRaw<
      { status: string; n: bigint; input: bigint; cache: bigint; output: bigint }[]
    >`
      SELECT c.status, count(*) AS n, COALESCE(sum(c."inputTokens"), 0) AS input,
             COALESCE(sum(c."cacheReadTokens"), 0) AS cache, COALESCE(sum(c."outputTokens"), 0) AS output
      FROM "LlmCall" c
      WHERE c."companyId" = ${companyId} AND c."createdAt" >= ${from} AND c."createdAt" <= ${to} ${campaign}
      GROUP BY c.status`;
    const interviews = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT s.id) AS n FROM "Session" s
      WHERE s."companyId" = ${companyId} AND s."sourceKind" = 'campaign' AND s.status = 'completed'
        AND s."endedAt" >= ${from} AND s."endedAt" <= ${to}
        ${range.campaignId ? Prisma.sql`AND s."campaignId" = ${range.campaignId}` : Prisma.empty}`;
    return { latency, outcomes, interviews: num(interviews[0]?.n) };
  });
  const status = (s: string): number => num(r.outcomes.find((o) => o.status === s)?.n);
  const total = r.outcomes.reduce((a, o) => a + num(o.n), 0);
  const tokens = r.outcomes.reduce((a, o) => a + num(o.input) + num(o.cache) + num(o.output), 0);
  const inputAll = r.outcomes.reduce((a, o) => a + num(o.input) + num(o.cache), 0);
  const cache = r.outcomes.reduce((a, o) => a + num(o.cache), 0);
  const rate = (n: number): number | null => (total > 0 ? Math.round((n / total) * 10_000) / 10_000 : null);
  const ms = (x: number): number => Math.round(x);
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    calls: total,
    latency: r.latency.map((l) => ({
      purpose: l.purpose,
      calls: num(l.n),
      fullMs: { p50: ms(l.p50), p95: ms(l.p95) },
      firstTokenMs: null,
    })),
    outcomes: {
      ok: status("ok"),
      error: status("error"),
      refused: status("refused"),
      budgetExceeded: status("budget_exceeded"),
      aborted: status("aborted"),
    },
    errorRate: rate(status("error")),
    refusalRate: rate(status("refused")),
    failureRate: rate(status("error") + status("refused") + status("budget_exceeded")),
    cacheHitRate: inputAll > 0 ? Math.round((cache / inputAll) * 10_000) / 10_000 : null,
    tokensPerInterview: r.interviews > 0 ? Math.round(tokens / r.interviews) : null,
    interviews: r.interviews,
  };
}

/** Queue depth from the job admin port, this organization's failures, and storage. */
export async function health(d: SegmentDeps, companyId: string): Promise<StatsHealth> {
  const [queues, failed, quotaBytes, storage] = await Promise.all([
    d.queues?.() ?? Promise.resolve([]),
    d.deadLetters?.(companyId) ?? Promise.resolve(0),
    d.storageQuotaBytes?.(companyId) ?? Promise.resolve(null),
    tenantTransaction(
      d.db,
      (tx) =>
        tx.$queryRaw<{ kind: string; bytes: bigint; files: bigint }[]>`
        SELECT a.kind, COALESCE(sum(a."sizeBytes"), 0) AS bytes, count(*) AS files
        FROM "Attachment" a WHERE a."companyId" = ${companyId} GROUP BY a.kind`,
    ),
  ]);
  const byKind = Object.fromEntries(
    storage.map((s) => [s.kind, { bytes: num(s.bytes), files: num(s.files) }]),
  );
  return {
    queues,
    depth: {
      queued: queues.reduce((a, q) => a + q.queued, 0),
      active: queues.reduce((a, q) => a + q.active, 0),
    },
    failedJobs: failed,
    storage: {
      bytes: storage.reduce((a, s) => a + num(s.bytes), 0),
      files: storage.reduce((a, s) => a + num(s.files), 0),
      byKind,
      quotaBytes,
    },
  };
}
