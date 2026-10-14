import type { Alert, AlertPort } from "./port.js";

/**
 * The notices a tenant's admins receive about their own work (D-181): a campaign reached its
 * threshold, an analysis is ready, a specification version was generated, a ceiling is near.
 *
 * Each is an ordinary `Alert` of a tenant-audience kind, so recipients (`notifications.recipients`,
 * else the admins), the per-event switch, the hourly limit and the dedupe all come from
 * `AlertRouter`. What lives here is the words, in both languages the product speaks, and the key
 * that makes an event one mail: the id of the thing that happened.
 *
 * Nothing here carries an answer, a quote or a participant. A campaign or template name is the
 * tenant's own label, and the router scrubs addresses from every line regardless.
 */

export type CeilingMetric = "maxActiveCampaigns" | "maxSessionsPerMonth" | "storageBytes" | "voiceMinutes";

const METRIC_LABEL: Record<CeilingMetric, { en: string; fi: string }> = {
  maxActiveCampaigns: { en: "active campaigns", fi: "aktiivista kampanjaa" },
  maxSessionsPerMonth: { en: "interviews this month", fi: "haastattelua tässä kuussa" },
  storageBytes: { en: "stored files and recordings", fi: "tallennettuja tiedostoja ja äänitteitä" },
  voiceMinutes: { en: "voice minutes this month", fi: "puheminuuttia tässä kuussa" },
};

const MIB = 1024 * 1024;

/** `1.5 GB` for bytes, a plain integer for counts; the same figure in both languages. */
export function formatCeilingAmount(metric: CeilingMetric, value: number): string {
  if (metric !== "storageBytes") return String(Math.round(value));
  if (value >= 1024 * MIB) return `${(value / (1024 * MIB)).toFixed(1)} GB`;
  return `${(value / MIB).toFixed(0)} MB`;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

export function campaignThresholdAlert(i: {
  companyId: string;
  campaignId: string;
  campaignName: string;
  completed: number;
  needed: number;
  publicWebUrl: string;
}): Alert {
  const url = `${trimSlash(i.publicWebUrl)}/admin/campaigns/${i.campaignId}`;
  return {
    kind: "campaign.threshold",
    key: `campaign.threshold:${i.campaignId}`,
    companyId: i.companyId,
    title: `Enough interviews are in: ${i.campaignName}`,
    message: `${i.completed} interviews are complete, and ${i.needed} were needed. The analysis for "${i.campaignName}" is being prepared; you will get another message when it is ready.`,
    context: { campaignId: i.campaignId, completed: i.completed, needed: i.needed },
    localized: {
      fi: {
        title: `Haastatteluja on tarpeeksi: ${i.campaignName}`,
        message: `${i.completed} haastattelua on valmis, ja tarvittiin ${i.needed}. Kampanjan "${i.campaignName}" analyysia valmistellaan; saat uuden viestin, kun se on valmis.`,
        linkLabels: ["Kampanja"],
      },
    },
    links: [{ label: "Campaign", url }],
  };
}

export function analysisReadyAlert(i: {
  companyId: string;
  campaignId: string;
  campaignName: string;
  analysisId: string;
  version: number;
  preliminary: boolean;
  publicWebUrl: string;
}): Alert {
  const url = `${trimSlash(i.publicWebUrl)}/admin/campaigns/${i.campaignId}/results`;
  return {
    kind: "analysis.ready",
    key: `analysis.ready:${i.analysisId}`,
    companyId: i.companyId,
    title: `Analysis ready: ${i.campaignName}`,
    message: `Analysis ${i.version} of "${i.campaignName}" is ready${i.preliminary ? ". It is preliminary: the completion threshold had not been reached" : ""}.`,
    context: { campaignId: i.campaignId, analysisId: i.analysisId, version: i.version },
    localized: {
      fi: {
        title: `Analyysi valmis: ${i.campaignName}`,
        message: `Kampanjan "${i.campaignName}" analyysi ${i.version} on valmis${i.preliminary ? ". Se on alustava: valmistumisrajaa ei ollut vielä saavutettu" : ""}.`,
        linkLabels: ["Tulokset"],
      },
    },
    links: [{ label: "Results", url }],
  };
}

export function specReadyAlert(i: {
  companyId: string;
  sessionId: string;
  title: string;
  versionId: string;
  version: number;
  publicWebUrl: string;
}): Alert {
  const url = `${trimSlash(i.publicWebUrl)}/admin/requirements/${i.sessionId}/versions/${i.version}`;
  return {
    kind: "spec.ready",
    key: `spec.ready:${i.versionId}`,
    companyId: i.companyId,
    title: `Specification version ${i.version} is ready: ${i.title}`,
    message: `Version ${i.version} of the specification "${i.title}" has been generated.`,
    context: { sessionId: i.sessionId, versionId: i.versionId, version: i.version },
    localized: {
      fi: {
        title: `Määrittelyn versio ${i.version} on valmis: ${i.title}`,
        message: `Määrittelyn "${i.title}" versio ${i.version} on luotu.`,
        linkLabels: ["Versio"],
      },
    },
    links: [{ label: "Version", url }],
  };
}

export function ceilingAlert(i: {
  companyId: string;
  metric: CeilingMetric;
  used: number;
  max: number;
  /** `yyyy-mm` for a monthly metric, so each month is its own condition. */
  month?: string;
  reached: boolean;
  publicWebUrl: string;
}): Alert {
  const label = METRIC_LABEL[i.metric];
  const used = formatCeilingAmount(i.metric, i.used);
  const max = formatCeilingAmount(i.metric, i.max);
  const percent = i.max > 0 ? Math.round((i.used / i.max) * 100) : 0;
  const level = i.reached ? "reached" : "warning";
  const url = `${trimSlash(i.publicWebUrl)}/admin/settings?category=ceiling`;
  return {
    kind: i.reached ? "ceiling.reached" : "ceiling.warning",
    key: `ceiling.${level}:${i.companyId}:${i.metric}${i.month ? `:${i.month}` : ""}`,
    companyId: i.companyId,
    title: i.reached ? `Limit reached: ${label.en}` : `Limit at ${percent}%: ${label.en}`,
    message: i.reached
      ? `This workspace has used ${used} of ${max} ${label.en}. New ones are refused until the limit is raised${i.month ? " or the month ends" : ""}. Ask the platform operator to raise it.`
      : `This workspace has used ${used} of ${max} ${label.en} (${percent}%). Nothing is refused yet.`,
    context: { metric: i.metric, used: Math.round(i.used), max: i.max, percent },
    localized: {
      fi: {
        title: i.reached ? `Raja saavutettu: ${label.fi}` : `Raja ${percent} % täynnä: ${label.fi}`,
        message: i.reached
          ? `Tämä työtila on käyttänyt ${used} / ${max} (${label.fi}). Uusia ei hyväksytä, ennen kuin rajaa nostetaan${i.month ? " tai kuukausi vaihtuu" : ""}. Pyydä alustan ylläpitäjää nostamaan rajaa.`
          : `Tämä työtila on käyttänyt ${used} / ${max} (${label.fi}), eli ${percent} %. Mitään ei ole vielä estetty.`,
        linkLabels: ["Asetukset"],
      },
    },
    links: [{ label: "Settings", url }],
  };
}

/** The sending side: builds the alert and hands it over, and never lets a notice fail the work it reports. */
export class TenantNotices {
  constructor(
    private readonly deps: {
      alerts: AlertPort;
      publicWebUrl: string;
      log?: { warn: (message: string, meta?: Record<string, unknown>) => void };
    },
  ) {}

  private async send(alert: Alert): Promise<void> {
    try {
      await this.deps.alerts.raise(alert);
    } catch (err) {
      this.deps.log?.warn("tenant notice failed", { kind: alert.kind, err: String(err) });
    }
  }

  campaignThreshold(i: Omit<Parameters<typeof campaignThresholdAlert>[0], "publicWebUrl">): Promise<void> {
    return this.send(campaignThresholdAlert({ ...i, publicWebUrl: this.deps.publicWebUrl }));
  }

  analysisReady(i: Omit<Parameters<typeof analysisReadyAlert>[0], "publicWebUrl">): Promise<void> {
    return this.send(analysisReadyAlert({ ...i, publicWebUrl: this.deps.publicWebUrl }));
  }

  specReady(i: Omit<Parameters<typeof specReadyAlert>[0], "publicWebUrl">): Promise<void> {
    return this.send(specReadyAlert({ ...i, publicWebUrl: this.deps.publicWebUrl }));
  }

  ceiling(i: Omit<Parameters<typeof ceilingAlert>[0], "publicWebUrl">): Promise<void> {
    return this.send(ceilingAlert({ ...i, publicWebUrl: this.deps.publicWebUrl }));
  }

  /** The condition cleared (usage fell back under the line): the next crossing is a new notice. */
  async ceilingCleared(companyId: string, metric: CeilingMetric, month?: string): Promise<void> {
    const suffix = month ? `:${month}` : "";
    for (const level of ["warning", "reached"]) {
      await this.deps.alerts.resolve(`ceiling.${level}:${companyId}:${metric}${suffix}`);
    }
  }
}
