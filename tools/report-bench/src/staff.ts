import type { Client } from "./client.js";
import { abortState, log, sleep } from "./openrouter.js";
import type { Scenario } from "./scenario.js";

interface Template {
  id: string;
  key: string;
  version: number;
}

export interface CampaignHandle {
  campaignId: string;
  linkToken: string;
}

/** Reads the link token out of a shareable URL (`https://host/p/<token>`) or returns the token. */
export function linkTokenFrom(urlOrToken: string): string {
  const m = /\/p\/([^/?#]+)/.exec(urlOrToken);
  return m?.[1] ?? urlOrToken.trim();
}

/** Creates and opens a campaign on the discovery template, as an admin would in the dashboard. */
export async function createCampaign(
  staff: Client,
  scenario: Scenario,
  personas: number,
): Promise<CampaignHandle> {
  const { templates } = await staff.ok<{ templates: Template[] }>("GET", "/templates");
  const template = templates
    .filter((t) => t.key === "opportunity_discovery")
    .sort((a, b) => b.version - a.version)[0];
  if (!template) throw new Error("opportunity_discovery template not found");
  const created = await staff.ok<{ campaign: { id: string }; link: { url: string } }>("POST", "/campaigns", {
    templateId: template.id,
    name: scenario.campaign.name,
    participationMode: "participant_choice",
    verification: "open",
    maxTurns: scenario.campaign.maxTurns,
    completionThreshold: personas,
  });
  await staff.ok("POST", `/campaigns/${created.campaign.id}/open`);
  return { campaignId: created.campaign.id, linkToken: linkTokenFrom(created.link.url) };
}

/** The tenant's k-anonymity threshold, or null when the token cannot read settings. */
export async function readK(staff: Client): Promise<number | null> {
  const r = await staff.call<{ values?: Record<string, unknown> }>("GET", "/settings?scope=tenant");
  const v = r.status === 200 ? r.body.values?.["privacy.kAnonymity"] : undefined;
  return typeof v === "number" ? v : null;
}

/** What the product's ledger says this campaign has cost so far, in USD (null when not readable). */
export async function campaignSpendUsd(staff: Client, campaignId: string): Promise<number | null> {
  const r = await staff.call<{ rows?: { costCents: number }[] }>(
    "GET",
    `/spend?groupBy=purpose&campaignId=${encodeURIComponent(campaignId)}&from=2000-01-01`,
  );
  if (r.status !== 200 || !Array.isArray(r.body.rows)) return null;
  return r.body.rows.reduce((s, x) => s + (x.costCents || 0), 0) / 100;
}

interface AnalysisView {
  id: string;
  status: string;
  stats?: { facts?: number; sessions?: number; embedding?: string; error?: string };
}

/** Polls the campaign's session list until the fact counts stop moving (extraction has settled). */
export async function waitForExtraction(staff: Client, campaignId: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    // Whatever the list carries (status, fact counts, progress): any change means work is still landing.
    const r = await staff.call("GET", `/campaigns/${campaignId}/sessions`);
    const sig = JSON.stringify(r.body);
    if (sig !== last) {
      last = sig;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 30_000) return;
    await sleep(5000);
  }
}

/**
 * Gets a finished analysis of the campaign. The product queues one by itself when the completion
 * threshold is reached (after `analysis.autoRunDelayMinutes`, default 5, so extraction has settled);
 * that run is awaited and used. With no run at all, or with `force` (re-analysing the same
 * interviews after a code change), a manual run is started the way an admin starts one.
 */
export async function runAnalysis(
  staff: Client,
  campaignId: string,
  opts: { force: boolean },
): Promise<string> {
  const list = async (): Promise<AnalysisView[]> =>
    (await staff.ok<{ analyses: AnalysisView[] }>("GET", `/campaigns/${campaignId}/analyses`)).analyses;
  const waitDone = async (): Promise<AnalysisView> => {
    const deadline = Date.now() + 40 * 60_000;
    for (;;) {
      const latest = (await list())[0];
      if (latest && (latest.status === "done" || latest.status === "failed")) return latest;
      if (abortState.reason) throw new Error(abortState.reason);
      if (Date.now() > deadline) throw new Error("analysis did not finish in 40 minutes");
      await sleep(5000);
    }
  };
  const existing = await list();
  const active = existing.some((a) => a.status !== "done" && a.status !== "failed");
  if (active) {
    log("an analysis is queued or running (the automatic one); waiting for it");
    await waitDone();
  }
  if (opts.force || (!existing.some((a) => a.status === "done") && !active)) {
    log("starting the analysis");
    const r = await staff.call("POST", `/campaigns/${campaignId}/analyses`, {});
    if (r.status !== 202 && r.status !== 409)
      throw new Error(`POST analyses -> ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const done = await waitDone();
  if (done.status !== "done")
    throw new Error(`analysis ${done.id} ${done.status}: ${done.stats?.error ?? ""}`);
  log(`analysis ${done.id} done: ${JSON.stringify(done.stats ?? {})}`);
  return done.id;
}

export async function fetchAnalysis(staff: Client, analysisId: string): Promise<unknown> {
  return staff.ok("GET", `/analyses/${analysisId}`);
}
