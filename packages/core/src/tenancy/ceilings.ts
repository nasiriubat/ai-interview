import type { SettingKey } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { formatCeilingAmount, type CeilingMetric, type TenantNotices } from "../alerts/tenant-notices.js";
import type { SettingsService } from "../settings/service.js";

/**
 * Tenant ceilings (D-188): what the platform operator promised a tenant it may use.
 *
 * The four numbers are `ceiling.*` settings, written only by the operator. A value of 0 is "no
 * ceiling". Two are enforced where the thing is created (a campaign, an interview); all four are
 * measured, shown to the operator, and announced at 80 and at 100 percent through the tenant
 * notices, so the tenant hears before a refusal rather than from one.
 */

const METRIC_KEY: Record<CeilingMetric, SettingKey> = {
  maxActiveCampaigns: "ceiling.maxActiveCampaigns",
  maxSessionsPerMonth: "ceiling.maxSessionsPerMonth",
  storageBytes: "ceiling.storageBytes",
  voiceMinutes: "ceiling.voiceMinutes",
};

export const CEILING_METRICS = Object.keys(METRIC_KEY) as CeilingMetric[];

/**
 * The ceilings that refuse. All four are enforced where the thing is created: a campaign, an
 * interview, an upload (`storageBytes`, which also caps the upload's own size to what is left) and
 * a voice answer or live call (`voiceMinutes`, D-229).
 */
export type EnforcedCeiling = CeilingMetric;

/** Campaigns that count against `maxActiveCampaigns`: anything not closed. */
export const ACTIVE_CAMPAIGN_STATUSES = ["draft", "open", "analyzing"] as const;

export interface CeilingUtilisation {
  metric: CeilingMetric;
  used: number;
  /** 0 means no ceiling. */
  max: number;
  /** Whole percent of the ceiling used, or null when there is none. */
  percent: number | null;
  /** `yyyy-mm` for a monthly metric. */
  month: string | null;
}

/** Thrown by an enforcement point; the API answers 403 `limit_reached` with `{ limit, current, max }`. */
export class CeilingReachedError extends Error {
  constructor(
    readonly metric: CeilingMetric,
    readonly current: number,
    readonly max: number,
  ) {
    super(
      `This organization has reached its limit (${formatCeilingAmount(metric, current)} of ${formatCeilingAmount(metric, max)}).`,
    );
    this.name = "CeilingReachedError";
  }
}

const MONTHLY: ReadonlySet<CeilingMetric> = new Set(["maxSessionsPerMonth", "voiceMinutes"]);

export interface TenantCeilingsDeps {
  db: PrismaClient;
  settings: SettingsService;
  /** Absent in tools that never mail: usage is still measured and enforced. */
  notices?: TenantNotices | undefined;
  now?: () => Date;
}

export class TenantCeilings {
  constructor(private readonly deps: TenantCeilingsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private monthStart(): Date {
    const n = this.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
  }

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  /** The four ceilings in force for a tenant. */
  async limits(companyId: string): Promise<Record<CeilingMetric, number>> {
    const keys = CEILING_METRICS.map((m) => METRIC_KEY[m]);
    const values = await this.deps.settings.resolveMany(keys, [{ scope: "tenant", scopeId: companyId }]);
    const out = {} as Record<CeilingMetric, number>;
    for (const m of CEILING_METRICS) out[m] = Number(values[METRIC_KEY[m]] ?? 0);
    return out;
  }

  /** What the tenant has used, per metric. */
  async usage(
    companyId: string,
    only: readonly CeilingMetric[] = CEILING_METRICS,
  ): Promise<Record<CeilingMetric, number>> {
    const { db } = this.deps;
    const since = this.monthStart();
    const want = new Set(only);
    const [campaigns, sessions, storage, voice, ledgerAudio] = await Promise.all([
      want.has("maxActiveCampaigns")
        ? db.campaign.count({ where: { companyId, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } } })
        : 0,
      want.has("maxSessionsPerMonth")
        ? db.session.count({ where: { companyId, createdAt: { gte: since } } })
        : 0,
      want.has("storageBytes")
        ? Promise.all([
            db.attachment.aggregate({ where: { companyId }, _sum: { sizeBytes: true } }),
            // Campaign background documents are stored bytes too (D-491).
            db.campaignDocument.aggregate({ where: { companyId }, _sum: { sizeBytes: true } }),
          ])
        : null,
      want.has("voiceMinutes")
        ? db.attachment.aggregate({
            where: { companyId, kind: "audio", createdAt: { gte: since } },
            _sum: { durationMs: true },
          })
        : null,
      // What the speech models were actually sent (D-220): recorded answers and live calls both
      // land in the ledger as audio seconds, so a live call that stored no attachment still counts.
      want.has("voiceMinutes")
        ? db.llmCall.aggregate({
            where: {
              companyId,
              createdAt: { gte: since },
              purpose: { in: ["transcription", "stt_stream", "realtime_voice"] },
            },
            _sum: { audioSeconds: true },
          })
        : null,
    ]);
    return {
      maxActiveCampaigns: campaigns,
      maxSessionsPerMonth: sessions,
      storageBytes: (storage?.[0]._sum.sizeBytes ?? 0) + (storage?.[1]._sum.sizeBytes ?? 0),
      // The larger of the two readings, never their sum: a recorded answer is both an attachment
      // with a duration and a transcription in the ledger, and counting it twice would refuse early.
      voiceMinutes: Math.ceil(
        Math.max((voice?._sum.durationMs ?? 0) / 1000, ledgerAudio?._sum.audioSeconds ?? 0) / 60,
      ),
    };
  }

  async utilisation(companyId: string): Promise<CeilingUtilisation[]> {
    const [limits, usage] = await Promise.all([this.limits(companyId), this.usage(companyId)]);
    return CEILING_METRICS.map((metric) => {
      const max = limits[metric];
      const used = usage[metric];
      return {
        metric,
        used,
        max,
        percent: max > 0 ? Math.round((used / max) * 100) : null,
        month: MONTHLY.has(metric) ? this.month() : null,
      };
    });
  }

  /**
   * The check an enforcement point runs before it creates something: throws when the tenant is at
   * its ceiling, after telling the tenant and the operator once. A tenant with no ceiling (0) is
   * never refused.
   */
  async assertRoom(companyId: string, metric: EnforcedCeiling): Promise<void> {
    const max = (await this.limits(companyId))[metric];
    if (max <= 0) return;
    const used = (await this.usage(companyId, [metric]))[metric];
    if (used < max) return;
    await this.announce(companyId, metric, used, max);
    throw new CeilingReachedError(metric, used, max);
  }

  /**
   * After something was created: raise the 80 or 100 percent notice for any ceiling that crossed
   * it, and clear the ones that are back under so the next crossing is announced again. Never
   * throws; a notice must not undo the thing it reports.
   */
  async afterChange(companyId: string): Promise<void> {
    try {
      for (const u of await this.utilisation(companyId)) {
        if (u.max <= 0 || u.percent === null) {
          await this.deps.notices?.ceilingCleared(companyId, u.metric, u.month ?? undefined);
          continue;
        }
        if (u.used >= u.max || u.percent >= 80) await this.announce(companyId, u.metric, u.used, u.max);
        else await this.deps.notices?.ceilingCleared(companyId, u.metric, u.month ?? undefined);
      }
    } catch {
      // Measuring failed; the next change measures again.
    }
  }

  /**
   * Where a tenant stands on one metric: the ceiling and what is used. For an enforcement point
   * that needs the room itself (an upload is capped to what is left), not only a yes or no.
   */
  async standing(companyId: string, metric: CeilingMetric): Promise<{ max: number; used: number }> {
    const max = (await this.limits(companyId))[metric];
    if (max <= 0) return { max, used: 0 };
    return { max, used: (await this.usage(companyId, [metric]))[metric] };
  }

  /** Tells the tenant and the operator the ceiling was hit, and returns the error to throw. */
  async reached(
    companyId: string,
    metric: CeilingMetric,
    used: number,
    max: number,
  ): Promise<CeilingReachedError> {
    // `reached` is stated, not derived from the numbers: an upload that does not fit in what is
    // left refused the tenant at 62 percent used, and that is still a refusal to announce.
    await this.deps.notices?.ceiling({
      companyId,
      metric,
      used,
      max,
      reached: true,
      ...(MONTHLY.has(metric) ? { month: this.month() } : {}),
    });
    return new CeilingReachedError(metric, used, max);
  }

  private async announce(companyId: string, metric: CeilingMetric, used: number, max: number): Promise<void> {
    await this.deps.notices?.ceiling({
      companyId,
      metric,
      used,
      max,
      reached: used >= max,
      ...(MONTHLY.has(metric) ? { month: this.month() } : {}),
    });
  }
}
