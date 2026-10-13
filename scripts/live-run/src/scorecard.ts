import type { SpecCheck } from "./checks.js";
import type { JudgeVerdict } from "./judge.js";
import type { FlagTotals } from "./pure.js";
import { summarize } from "./pure.js";
import type { ChosenRoute } from "./routing.js";
import type { DbIntegrity } from "./stack.js";

type Dist = ReturnType<typeof summarize>;
interface Spend {
  key: string;
  costCents: number;
  calls: number;
  tokens: number;
}

export interface InterviewCard {
  persona: string;
  participation: string;
  sessionId: string;
  turns: number;
  ended: boolean;
  endReason: string;
  areas: { key: string; name: string; status: string }[];
  areasCovered: number;
  areasTotal: number;
  heuristics: FlagTotals;
  widgetsOffered: number;
  widgetsAnswered: number;
  factsByKind: Record<string, number>;
  factCount: number;
  summaryChars: number;
  summaryEdited: boolean;
  costCents: number | null;
  firstTokenMs: number[];
  totalMs: number[];
  retries: number;
  turnErrors: string[];
  staffCanReadTranscript: boolean | null;
  judge: JudgeVerdict | null;
  notes: string[];
}

export interface RequirementsCard {
  name: string;
  sessionId: string;
  turns: number;
  ended: boolean;
  endReason: string;
  areas: { key: string; name: string; status: string }[];
  heuristics: FlagTotals;
  findings: { type: string; status: string; description: string }[];
  specStats: Record<string, unknown>;
  version: { version: number; status: string; error: string | null; stats: Record<string, unknown> };
  specCheck: SpecCheck;
  bundlePaths: string[];
  bundleHasRequired: boolean;
  bundleFormat: string;
  zipEntries: string[];
  exports: Record<string, { status: number; bytes: number; contentType: string }>;
  issuesCount: number;
  secondVersion: { version: number; status: string } | null;
  diff: {
    status: number;
    sectionsChanged: string[];
    requirementsAdded: number;
    requirementsRemoved: number;
    requirementsChanged: number;
  } | null;
  firstTokenMs: number[];
  totalMs: number[];
  retries: number;
  turnErrors: string[];
  judge: JudgeVerdict | null;
  notes: string[];
}

export interface Scorecard {
  startedAt: string;
  durationMs: number;
  phasesCompleted: string[];
  routing: {
    routes: ChosenRoute[];
    simulatorModel: string;
    judgeModel: string;
    embeddingRouteConfigured: boolean;
    tenantBudgetCents: number;
  } | null;
  interviews: InterviewCard[];
  analysis: {
    analysisId: string;
    status: string;
    preliminary: boolean;
    autoTriggered: boolean;
    runs: { id: string; facts: number | null; status: string }[];
    stats: unknown;
    embedding: string | null;
    clusters: {
      title: string;
      key: string;
      participants: number;
      facts: number;
      solutionClass: string;
      rankScore: number;
    }[];
    k: number;
    kAnonymityFindings: { opportunity: string; participants: number; problem: string }[];
    reportSections: Record<string, boolean>;
    reportChars: number;
    namesInReport: string[];
    namesInOpportunities: string[];
    diff: unknown;
    opportunitiesWithoutWhyNotAi: string[];
  } | null;
  requirements: RequirementsCard[];
  cost: {
    ledgerCentsTotal: number;
    byPurpose: Spend[];
    byModel: Spend[];
    byCampaign: Spend[];
    budget: unknown;
    aiMonth: Record<string, unknown>;
    harnessUsd: number;
    harnessByLabel: Record<string, number>;
    harnessTokens: { prompt: number; completion: number };
    openRouterUsageDeltaUsd: number | null;
    perInterviewCents: { persona: string; costCents: number | null }[];
  } | null;
  latency: {
    discoveryFirstToken: Dist;
    discoveryFullTurn: Dist;
    requirementsFirstToken: Dist;
    requirementsFullTurn: Dist;
    byRoute: { route: string; n: number; p50: number; p90: number; max: number }[];
  } | null;
  errors: {
    http4xx5xx: { route: string; count: number }[];
    sseErrors: string[];
    apiLog: { level: string; msg: string; count: number }[];
    workerLog: { level: string; msg: string; count: number }[];
    logFiles: { api: string; worker: string; bootstrap: string };
  } | null;
  appBugCandidates: string[];
  integrity: DbIntegrity | null;
  probe: unknown;
  requirementsProbe: unknown;
  notes: string[];
}

const ms = (v: number): string => (Number.isFinite(v) ? `${Math.round(v)}` : "-");
const dist = (d: Dist): string =>
  `n=${d.n} p50=${ms(d.p50)} p90=${ms(d.p90)} p99=${ms(d.p99)} max=${ms(d.max)} ms`;
const cents = (v: number | null): string => (v === null ? "-" : v.toFixed(2));

export function renderScorecard(c: Scorecard): string {
  const out: string[] = [];
  out.push(
    `# Live run scorecard`,
    "",
    `started ${c.startedAt}; ${(c.durationMs / 60000).toFixed(1)} min; phases: ${c.phasesCompleted.join(", ") || "none"}`,
    "",
  );
  for (const n of c.notes) out.push(`- NOTE: ${n}`);
  for (const n of c.appBugCandidates) out.push(`- APP BUG CANDIDATE: ${n}`);
  if (c.notes.length || c.appBugCandidates.length) out.push("");

  if (c.routing) {
    out.push("## Models and prices (USD per million tokens, input / output)", "");
    out.push("| purpose | tier | model | in | out | ctx |", "|---|---|---|---|---|---|");
    for (const r of c.routing.routes)
      out.push(
        `| ${r.purpose} | ${r.tier} | ${r.model} | ${r.inputPerMtok.toFixed(3)} | ${r.outputPerMtok.toFixed(3)} | ${r.contextLength} |`,
      );
    out.push(
      "",
      `Simulator: ${c.routing.simulatorModel}. Judge: ${c.routing.judgeModel}. Tenant budget: ${c.routing.tenantBudgetCents} c. Embedding route configured: ${c.routing.embeddingRouteConfigured}.`,
      "",
    );
  }

  if (c.requirementsProbe)
    out.push("## Probe: requirements owner presses done early", "", JSON.stringify(c.requirementsProbe), "");
  if (c.probe) out.push("## Probe: I'm done, then delete my data", "", JSON.stringify(c.probe), "");

  if (c.interviews.length) {
    out.push("## Interviews", "");
    out.push(
      "| persona | mode | turns | ended | areas | facts | multi-Q | solution | where-AI | leading | long | widgets | cost c | p50 first-token ms | judge (follow/rep/adapt/tone/rules) |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const i of c.interviews) {
      const s = i.judge?.scores ?? {};
      const scores = [
        "followUpQuality",
        "nonRepetition",
        "adaptsToParticipant",
        "toneAndBrevity",
        "followsRules",
      ]
        .map((k) => String(s[k] ?? "-"))
        .join("/");
      out.push(
        `| ${i.persona} | ${i.participation} | ${i.turns} | ${i.ended ? "yes" : `NO (${i.endReason})`} | ${i.areasCovered}/${i.areasTotal} | ${i.factCount} | ${i.heuristics.multiQuestion} | ${i.heuristics.suggestsSolution} | ${i.heuristics.asksWhereAiGoes} | ${i.heuristics.leading} | ${i.heuristics.overLength} | ${i.widgetsAnswered}/${i.widgetsOffered} | ${cents(i.costCents)} | ${ms(summarize(i.firstTokenMs).p50)} | ${scores} |`,
      );
    }
    out.push("", "Facts by kind per interview:", "");
    for (const i of c.interviews) out.push(`- ${i.persona}: ${JSON.stringify(i.factsByKind)}`);
    out.push("", "Judge worst message per interview:", "");
    for (const i of c.interviews) if (i.judge?.worst) out.push(`- ${i.persona}: ${i.judge.worst}`);
    out.push("");
    const judged = c.interviews.filter((i) => i.judge && i.judge.perMessage.length > 0);
    if (judged.length) {
      const sum = (f: (m: JudgeVerdict["perMessage"][number]) => boolean): number =>
        judged.reduce((s, i) => s + (i.judge?.perMessage.filter(f).length ?? 0), 0);
      const total = judged.reduce((s, i) => s + (i.judge?.perMessage.length ?? 0), 0);
      out.push(
        `Judge over ${total} interviewer messages: not single-question ${sum((m) => !m.singleQuestion)}, leading ${sum((m) => m.leading)}, suggests solution ${sum((m) => m.suggestsSolution)}, asks for concrete example ${sum((m) => m.concreteExample)}.`,
        "",
      );
    }
  }

  if (c.analysis) {
    const a = c.analysis;
    out.push("## Analysis", "");
    out.push(
      `status ${a.status}; preliminary ${a.preliminary}; auto-triggered ${a.autoTriggered}; embedding ${a.embedding ?? "n/a"}; runs ${JSON.stringify(a.runs)}`,
      `stats: ${JSON.stringify(a.stats)}`,
      "",
      `Clusters (k = ${a.k}):`,
      "",
      "| cluster | participants | facts | class | rank |",
      "|---|---|---|---|---|",
    );
    for (const cl of a.clusters)
      out.push(`| ${cl.title} | ${cl.participants} | ${cl.facts} | ${cl.solutionClass} | ${cl.rankScore} |`);
    out.push(
      "",
      `k-anonymity findings: ${a.kAnonymityFindings.length}${a.kAnonymityFindings.length ? ` ${JSON.stringify(a.kAnonymityFindings)}` : ""}`,
      `Report sections: ${JSON.stringify(a.reportSections)} (${a.reportChars} chars)`,
      `Participant names in report: ${JSON.stringify(a.namesInReport)}; in opportunities: ${JSON.stringify(a.namesInOpportunities)}`,
      `Process/none opportunities without whyNotAi: ${JSON.stringify(a.opportunitiesWithoutWhyNotAi)}`,
      "",
    );
  }

  for (const r of c.requirements) {
    out.push(`## Requirements interview: ${r.name}`, "");
    out.push(
      `${r.turns} turns; ended ${r.ended} (${r.endReason}); areas ${r.areas.filter((x) => x.status === "covered").length}/${r.areas.length} covered; findings ${r.findings.length} (${r.findings.filter((f) => f.status !== "open" && f.status !== "raised").length} settled)`,
      `heuristics: ${JSON.stringify(r.heuristics)}`,
      `spec stats: ${JSON.stringify(r.specStats)}`,
      `version ${r.version.version}: ${r.version.status}${r.version.error ? ` ERROR ${r.version.error}` : ""}; stats ${JSON.stringify(r.version.stats)}`,
      `spec check: ${JSON.stringify(r.specCheck)}`,
      `bundle (${r.bundleFormat}): ${r.bundlePaths.join(", ")}; required present: ${r.bundleHasRequired}`,
      `zip entries: ${r.zipEntries.join(", ") || "(none read)"}`,
      `exports: ${JSON.stringify(r.exports)}`,
      `second version: ${JSON.stringify(r.secondVersion)}; diff: ${JSON.stringify(r.diff)}`,
      `judge: ${JSON.stringify(r.judge?.scores ?? {})} worst: ${r.judge?.worst ?? ""}`,
      "",
    );
  }

  if (c.integrity) {
    out.push("## State integrity (database cross-check)", "");
    out.push(
      "| session | status | turnCount | assistant msgs | lastExtractedSeq | maxSeq | facts in state | Fact rows |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const s of c.integrity.sessions)
      out.push(
        `| ${s.sessionId.slice(-6)} | ${s.status} | ${s.turnCount} | ${s.assistantMessages} | ${s.lastExtractedSeq} | ${s.maxSeq} | ${s.factsInState} | ${s.factRows} |`,
      );
    out.push(
      "",
      "Model calls by purpose and status (ledger rows; failed calls book what the provider reported):",
      "",
    );
    for (const r of c.integrity.llmByPurpose)
      out.push(
        `- ${r.purpose} ${r.status}: ${r.calls} calls, ${r.inputTokens} in, ${r.outputTokens} out, ${r.costCents} c`,
      );
    out.push("");
  }

  if (c.cost) {
    const k = c.cost;
    out.push("## Cost", "");
    out.push(
      `Ledger total: ${k.ledgerCentsTotal.toFixed(2)} c. Harness (simulators and judge, outside the product): $${k.harnessUsd.toFixed(4)}. OpenRouter key usage delta: ${k.openRouterUsageDeltaUsd === null ? "n/a" : `$${k.openRouterUsageDeltaUsd.toFixed(4)}`}.`,
      "",
      "| purpose | cost c | calls | tokens |",
      "|---|---|---|---|",
    );
    for (const p of k.byPurpose)
      out.push(`| ${p.key} | ${p.costCents.toFixed(3)} | ${p.calls} | ${p.tokens} |`);
    out.push("", "By model:", "");
    for (const p of k.byModel)
      out.push(`- ${p.key}: ${p.costCents.toFixed(3)} c, ${p.calls} calls, ${p.tokens} tokens`);
    out.push("", "By campaign bucket:", "");
    for (const p of k.byCampaign) out.push(`- ${p.key}: ${p.costCents.toFixed(3)} c, ${p.calls} calls`);
    out.push("", `Harness by label: ${JSON.stringify(k.harnessByLabel)}`, "");
  }

  if (c.latency) {
    const l = c.latency;
    out.push(
      "## Latency",
      "",
      `- discovery first token: ${dist(l.discoveryFirstToken)}`,
      `- discovery full turn: ${dist(l.discoveryFullTurn)}`,
      `- requirements first token: ${dist(l.requirementsFirstToken)}`,
      `- requirements full turn: ${dist(l.requirementsFullTurn)}`,
      "",
    );
  }

  if (c.errors) {
    const e = c.errors;
    out.push("## Errors", "");
    out.push(`HTTP 4xx/5xx: ${e.http4xx5xx.length ? JSON.stringify(e.http4xx5xx) : "none"}`);
    out.push(`SSE error events: ${e.sseErrors.length ? JSON.stringify(e.sseErrors) : "none"}`);
    out.push(`API log warn/error: ${e.apiLog.length ? JSON.stringify(e.apiLog) : "none"}`);
    out.push(`Worker log warn/error: ${e.workerLog.length ? JSON.stringify(e.workerLog) : "none"}`, "");
  }
  return out.join("\n");
}
