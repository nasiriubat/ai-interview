import type {
  ClusterStats,
  Fact,
  Factors,
  OpportunityOverride,
  ReportSection,
  SolutionClass,
  Weights,
} from "@aidp/shared";
import { ClusteringResultSchema, OpportunityDraftSchema, rankScore } from "@aidp/shared";
import { z } from "zod";
import type { ModelCaller } from "../callModel.js";
import type { Logger } from "../engine/ports.js";
import { promptVersionTag, type PromptSource } from "../engine/prompts/index.js";
import { agglomerate } from "./cluster.js";
import { LEXICAL_THRESHOLD, LexicalEmbeddings, type EmbeddingSource } from "./embeddings.js";
import { renderReport, type ReportOpportunity } from "./report.js";

export interface AnalysisFact {
  id: string;
  sessionId: string;
  /** Stable per-participant key for counting; never an identity. */
  participantKey: string;
  role?: string | undefined;
  department?: string | undefined;
  fact: Fact;
}

export interface AnalysisInput {
  companyId: string;
  campaignId: string;
  campaignName: string;
  facts: AnalysisFact[];
  participation: { invited: number; completed: number; sessionsAnalyzed: number };
  thresholdMet: boolean;
  k: number;
  weights: Weights;
  similarityThreshold: number;
  language: string;
  sections: ReportSection[];
  overrides: Record<string, OpportunityOverride>;
}

export interface AnalysisOpportunity {
  clusterKey: string;
  title: string;
  summary: string;
  solutionClass: SolutionClass;
  rationale: string;
  factors: Factors;
  rankScore: number;
  stats: ClusterStats;
  dataNeeded: string[];
  risks: string[];
  whyNotAi?: string | undefined;
  evidence: { factId: string; snippet: string; anonymized: boolean }[];
  override: OpportunityOverride | null;
}

export interface AnalysisResult {
  clusters: { key: string; name: string; summary: string; factIds: string[] }[];
  opportunities: AnalysisOpportunity[];
  report: { markdown: string; sections: ReportSection[] };
  stats: {
    sessions: number;
    facts: number;
    clusters: number;
    participants: number;
    embedding: "provider" | "lexical";
    promptVersions: string[];
  };
}

export interface AnalysisDeps {
  caller: ModelCaller;
  prompts: PromptSource;
  embeddings?: EmbeddingSource;
  logger: Logger;
  now?: () => Date;
}

const NarrativeSchema = z.object({
  executiveSummary: z.string().min(1),
  nextSteps: z.array(z.string()).min(1).max(5),
  caveats: z.string().min(1),
});
const PER_WEEK: Record<string, number> = { hourly: 40, daily: 5, weekly: 1, monthly: 0.25, rarely: 0.05 };

/**
 * The collective analysis (spec 04): embed, cluster, let the model merge and name,
 * aggregate per cluster with k-anonymity, generate one opportunity per cluster, rank,
 * write the report. Pure with respect to persistence: the caller stores the result.
 */
export async function runAnalysis(deps: AnalysisDeps, input: AnalysisInput): Promise<AnalysisResult> {
  const ctx = {
    companyId: input.companyId,
    campaignId: input.campaignId,
    ref: { type: "campaign", id: input.campaignId },
  };
  const facts = input.facts;
  const participants = new Set(facts.map((f) => f.participantKey)).size;
  const versions: string[] = [];
  if (facts.length === 0) {
    const empty = await narrative(deps, ctx, input, [], versions);
    const markdown = renderReport({
      campaignName: input.campaignName,
      generatedAt: (deps.now ?? (() => new Date()))(),
      participation: { ...input.participation, facts: 0, thresholdMet: input.thresholdMet },
      opportunities: [],
      narrative: empty,
      sections: input.sections,
      k: input.k,
      language: input.language,
    });
    return {
      clusters: [],
      opportunities: [],
      report: { markdown, sections: input.sections },
      stats: {
        sessions: input.participation.sessionsAnalyzed,
        facts: 0,
        clusters: 0,
        participants,
        embedding: "lexical",
        promptVersions: versions,
      },
    };
  }

  // 1. Vectors: provider embeddings when routed, lexical otherwise.
  const texts = facts.map((f) => factText(f.fact));
  let vectors: number[][] | undefined;
  let embedding: "provider" | "lexical" = "lexical";
  try {
    const res = await deps.caller.embed(ctx, texts);
    if (res) {
      vectors = res.vectors;
      embedding = "provider";
    }
  } catch (e) {
    deps.logger.warn("embedding route failed; falling back to lexical vectors", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  vectors ??= await (deps.embeddings ?? new LexicalEmbeddings()).embed(texts);
  const threshold =
    embedding === "lexical"
      ? Math.min(input.similarityThreshold, LEXICAL_THRESHOLD)
      : input.similarityThreshold;

  // 2. Draft clusters by similarity, then the model merges, splits and names them.
  const drafts = agglomerate(vectors, threshold).map((idx, i) => ({
    key: `draft_${i + 1}`,
    factIds: idx.map((j) => facts[j]?.id).filter((x): x is string => Boolean(x)),
  }));
  const clusters = await nameClusters(deps, ctx, input, facts, drafts, versions);

  // 3. Per-cluster aggregates with k-anonymity, then one opportunity each.
  const byId = new Map(facts.map((f) => [f.id, f]));
  const opportunities: AnalysisOpportunity[] = [];
  for (const c of clusters) {
    const members = c.factIds.map((id) => byId.get(id)).filter((f): f is AnalysisFact => Boolean(f));
    const stats = clusterStats(members, input.k);
    const draft = await opportunityFor(deps, ctx, input, c, members, stats, versions);
    const override = input.overrides[c.key] ?? null;
    const factors = applyFactorOverride(draft.factors, override);
    opportunities.push({
      clusterKey: c.key,
      title: override?.title ?? draft.title,
      summary: draft.summary,
      solutionClass: override?.solutionClass ?? draft.solutionClass,
      rationale: draft.rationale,
      factors,
      rankScore: rankScore(factors, input.weights),
      stats,
      dataNeeded: draft.dataNeeded,
      risks: draft.risks,
      whyNotAi: draft.whyNotAi,
      evidence: members
        .slice(0, 12)
        .map((m) => ({ factId: m.id, snippet: snippet(m.fact), anonymized: true })),
      override,
    });
  }
  opportunities.sort((a, b) => b.rankScore - a.rankScore);

  // 4. Narrative and report.
  const reportOpps: ReportOpportunity[] = opportunities.map((o) => ({
    clusterKey: o.clusterKey,
    title: o.title,
    summary: o.summary,
    solutionClass: o.solutionClass,
    rankScore: o.rankScore,
    factors: o.factors,
    stats: o.stats,
    whyNotAi: o.whyNotAi,
    processes: c(o.clusterKey, clusters, byId),
  }));
  const story = await narrative(deps, ctx, input, opportunities, versions);
  const markdown = renderReport({
    campaignName: input.campaignName,
    generatedAt: (deps.now ?? (() => new Date()))(),
    participation: { ...input.participation, facts: facts.length, thresholdMet: input.thresholdMet },
    opportunities: reportOpps,
    narrative: story,
    sections: input.sections,
    k: input.k,
    language: input.language,
  });

  return {
    clusters,
    opportunities,
    report: { markdown, sections: input.sections },
    stats: {
      sessions: input.participation.sessionsAnalyzed,
      facts: facts.length,
      clusters: clusters.length,
      participants,
      embedding,
      promptVersions: [...new Set(versions)],
    },
  };
}

function c(
  key: string,
  clusters: { key: string; factIds: string[] }[],
  byId: Map<string, AnalysisFact>,
): { name: string; steps: string[] }[] {
  const cl = clusters.find((x) => x.key === key);
  if (!cl) return [];
  const out: { name: string; steps: string[] }[] = [];
  for (const id of cl.factIds) {
    const f = byId.get(id)?.fact;
    if (f?.kind === "process" && f.steps.length > 1) out.push({ name: f.name, steps: f.steps });
  }
  return out;
}

async function nameClusters(
  deps: AnalysisDeps,
  ctx: Parameters<ModelCaller["complete"]>[1],
  input: AnalysisInput,
  facts: AnalysisFact[],
  drafts: { key: string; factIds: string[] }[],
  versions: string[],
) {
  const prompt = await deps.prompts.get(input.companyId, "clustering");
  versions.push(promptVersionTag(prompt));
  const listing = drafts
    .map(
      (d) =>
        `Draft ${d.key}:\n${d.factIds
          .map((id) => {
            const f = facts.find((x) => x.id === id);
            return f
              ? `  - [${f.id}] (${f.fact.kind}${f.role ? `, ${f.role}` : ""}) ${factText(f.fact)}`
              : "";
          })
          .join("\n")}`,
    )
    .join("\n\n");
  try {
    const res = await deps.caller.complete(
      "clustering",
      { ...ctx, promptVersion: promptVersionTag(prompt) },
      {
        system: prompt.body.replace("{{language}}", languageName(input.language)),
        messages: [{ role: "user", content: listing }],
        maxOutputTokens: 8000,
      },
      ClusteringResultSchema,
      "clusters",
    );
    return reconcile(res.clusters, facts);
  } catch (e) {
    deps.logger.warn("cluster naming failed; using similarity drafts", {
      error: e instanceof Error ? e.message : String(e),
    });
    return drafts.map((d) => ({
      key: d.key,
      name: factText(facts.find((f) => f.id === d.factIds[0])?.fact ?? facts[0]!.fact).slice(0, 80),
      summary: "",
      factIds: d.factIds,
    }));
  }
}

/** Every fact in exactly one cluster: unknown ids dropped, duplicates removed, missing facts get singleton clusters. */
export function reconcile(
  clusters: { key: string; name: string; summary: string; factIds: string[] }[],
  facts: AnalysisFact[],
) {
  const known = new Set(facts.map((f) => f.id));
  const seen = new Set<string>();
  const usedKeys = new Set<string>();
  const out: { key: string; name: string; summary: string; factIds: string[] }[] = [];
  for (const c of clusters) {
    const ids: string[] = [];
    for (const id of c.factIds) {
      if (!known.has(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (!ids.length) continue;
    let key = c.key;
    for (let n = 2; usedKeys.has(key); n++) key = `${c.key}_${n}`;
    usedKeys.add(key);
    out.push({ key, name: c.name, summary: c.summary, factIds: ids });
  }
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    let key = `single_${f.id
      .slice(-6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")}`;
    for (let n = 2; usedKeys.has(key); n++) key = `${key}_${n}`;
    usedKeys.add(key);
    out.push({ key, name: factText(f.fact).slice(0, 80), summary: "", factIds: [f.id] });
  }
  return out;
}

async function opportunityFor(
  deps: AnalysisDeps,
  ctx: Parameters<ModelCaller["complete"]>[1],
  input: AnalysisInput,
  cluster: { key: string; name: string; summary: string; factIds: string[] },
  members: AnalysisFact[],
  stats: ClusterStats,
  versions: string[],
) {
  const prompt = await deps.prompts.get(input.companyId, "opportunity");
  versions.push(promptVersionTag(prompt));
  const body = [
    `Cluster: ${cluster.name}`,
    cluster.summary ? `Summary: ${cluster.summary}` : "",
    `Participants describing it: ${stats.participants} of ${input.participation.sessionsAnalyzed} interviewed${stats.roles.length ? ` (roles: ${stats.roles.join(", ")})` : ""}`,
    stats.minutesPerWeekTotal
      ? `Self-reported time: about ${Math.round(stats.minutesPerWeekTotal)} minutes per week in total`
      : "",
    stats.tools.length ? `Tools: ${stats.tools.join(", ")}` : "",
    "Facts:",
    ...members.map((m) => `- (${m.fact.kind}) ${factText(m.fact)}`),
  ]
    .filter(Boolean)
    .join("\n");
  return deps.caller.complete(
    "analysis_report",
    { ...ctx, promptVersion: promptVersionTag(prompt) },
    {
      system: prompt.body.replace("{{language}}", languageName(input.language)),
      messages: [{ role: "user", content: body }],
      maxOutputTokens: 3000,
    },
    OpportunityDraftSchema,
    "opportunity",
  );
}

async function narrative(
  deps: AnalysisDeps,
  ctx: Parameters<ModelCaller["complete"]>[1],
  input: AnalysisInput,
  opportunities: AnalysisOpportunity[],
  versions: string[],
) {
  const prompt = await deps.prompts.get(input.companyId, "report");
  versions.push(promptVersionTag(prompt));
  const body = [
    `Campaign: ${input.campaignName}. Invited ${input.participation.invited}, completed ${input.participation.completed}, analyzed ${input.participation.sessionsAnalyzed}. Threshold met: ${input.thresholdMet}.`,
    opportunities.length ? "Opportunities (rank, class, title, summary):" : "No facts were extracted yet.",
    ...opportunities.map(
      (o) =>
        `- ${o.rankScore} | ${o.solutionClass} | ${o.title} | ${o.summary}${o.whyNotAi ? ` | not AI because: ${o.whyNotAi}` : ""}`,
    ),
  ].join("\n");
  try {
    return await deps.caller.complete(
      "analysis_report",
      { ...ctx, promptVersion: promptVersionTag(prompt) },
      {
        system: prompt.body.replace("{{language}}", languageName(input.language)),
        messages: [{ role: "user", content: body }],
        maxOutputTokens: 2500,
      },
      NarrativeSchema,
      "narrative",
    );
  } catch (e) {
    deps.logger.warn("report narrative failed; using a plain fallback", {
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      executiveSummary: `${input.participation.sessionsAnalyzed} interviews were analyzed and ${opportunities.length} opportunities identified.`,
      nextSteps: opportunities.slice(0, 3).map((o) => o.title),
      caveats: "The narrative could not be generated; the tables below are complete.",
    };
  }
}

export function clusterStats(members: AnalysisFact[], k: number): ClusterStats {
  const participants = new Set(members.map((m) => m.participantKey)).size;
  const roles = uniq(members.map((m) => m.role));
  const departments = uniq(members.map((m) => m.department));
  const tools = uniq(members.flatMap((m) => ("tools" in m.fact ? m.fact.tools : [])));
  let minutes = 0;
  for (const m of members) {
    if (m.fact.kind === "task") minutes += m.fact.minutesPerOccurrence * (PER_WEEK[m.fact.frequency] ?? 1);
  }
  const quotes =
    participants >= k
      ? uniq(members.map((m) => ("quote" in m.fact ? m.fact.quote : undefined))).slice(0, 5)
      : [];
  return {
    participants,
    facts: members.length,
    roles: participants >= k ? roles : [],
    departments: participants >= k ? departments : [],
    tools,
    minutesPerWeekTotal: Math.round(minutes),
    quotes,
  };
}

function applyFactorOverride(factors: Factors, override: OpportunityOverride | null): Factors {
  if (!override?.factors) return factors;
  const out = { ...factors };
  for (const [k, v] of Object.entries(override.factors)) if (v) out[k as keyof Factors] = v;
  return out;
}

export function factText(f: Fact): string {
  switch (f.kind) {
    case "task":
      return `${f.name} (${f.frequency}, ${f.minutesPerOccurrence} min${f.tools.length ? `, ${f.tools.join(", ")}` : ""}, pain ${f.painScore}/10)${f.quote ? ` "${f.quote}"` : ""}`;
    case "process":
      return `${f.name}: ${f.steps.join(" > ")}${f.manualSteps.length ? ` (manual: ${f.manualSteps.join(", ")})` : ""}`;
    case "information_flow":
      return `${f.what} from ${f.from} to ${f.to}${f.channel ? ` via ${f.channel}` : ""}${f.waitTime ? `, waiting ${f.waitTime}` : ""}`;
    case "pain_point":
      return `${f.description}${f.cause ? ` (cause: ${f.cause})` : ""} severity ${f.severity}/10${f.quote ? ` "${f.quote}"` : ""}`;
    case "opportunity_candidate":
      return `${f.title}: ${f.description}`;
    case "spec_field":
      return `${f.section}.${f.path}: ${JSON.stringify(f.value)}`;
  }
}

function snippet(f: Fact): string {
  if ("quote" in f && f.quote) return f.quote;
  return factText(f).slice(0, 200);
}

function uniq(xs: (string | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => Boolean(x?.trim())))];
}

export function languageName(code: string): string {
  return { en: "English", fi: "Finnish", sv: "Swedish", de: "German" }[code] ?? code;
}
