import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Api, requestLog, staffToken } from "./api.js";
import {
  checkKAnonymity,
  checkSpec,
  leakedNames,
  REQUIRED_BUNDLE_FILES,
  reportSectionsPresent,
  type OpportunityView,
  type SpecDocumentView,
} from "./checks.js";
import {
  collectFacts,
  runDoneProbe,
  runInterview,
  transcriptMarkdown,
  type InterviewResult,
} from "./interview.js";
import { judgeTranscript, type JudgeVerdict } from "./judge.js";
import { PERSONAS } from "./personas.js";
import { totalFlags, summarize } from "./pure.js";
import {
  generateVersion,
  ownerSystemPrompt,
  runRequirementsDoneProbe,
  runRequirementsTurns,
  type Handoff,
  type RequirementsRun,
} from "./requirements.js";
import { configureRouting, type Routing } from "./routing.js";
import {
  abortState,
  harnessSpend,
  keyUsageUsd,
  loadOpenRouterKey,
  log,
  mapLimit,
  OUT_DIR,
  ensureDir,
  SCRATCH_DIR,
  sleep,
  TENANT_BUDGET_CENTS,
  TOTAL_CAP_CENTS,
  writeArtifact,
  writeJson,
} from "./runtime.js";
import { renderScorecard, type Scorecard } from "./scorecard.js";
import { ADMIN_EMAIL, dbIntegrity, OPERATOR_EMAIL, startStack, type Stack } from "./stack.js";

const sh = promisify(execFile);

const MAX_INTERVIEW_TURNS = Number(process.env.LIVE_MAX_INTERVIEW_TURNS ?? 60);
const MAX_REQUIREMENTS_TURNS = Number(process.env.LIVE_MAX_REQUIREMENTS_TURNS ?? 60);
const CONCURRENCY = Number(process.env.LIVE_CONCURRENCY ?? 3);
const SKIP_TECHNICAL = process.env.LIVE_SKIP_TECHNICAL === "1";
const ONLY = process.env.LIVE_PERSONAS?.split(",").filter(Boolean);

async function ledgerCents(admin: Api): Promise<number> {
  const r = await admin.call<{ rows: { costCents: number }[] }>("GET", "/spend?groupBy=purpose");
  return r.status === 200 ? r.body.rows.reduce((s, x) => s + x.costCents, 0) : 0;
}

function watchBudget(admin: Api): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        const product = await ledgerCents(admin);
        const total = product + harnessSpend.usd * 100;
        if (product > TENANT_BUDGET_CENTS || total > TOTAL_CAP_CENTS) {
          abortState.reason = `spend cap exceeded: ledger ${product.toFixed(1)} c, total ${total.toFixed(1)} c`;
          log(`ABORT: ${abortState.reason}`);
        }
      } catch {
        // a missed poll is not fatal; the next one catches up
      }
    })();
  }, 15_000);
}

function section(title: string): void {
  log(`==== ${title}`);
}

interface CampaignCreated {
  campaign: { id: string };
  link: { url: string };
}

interface AnalysisView {
  id: string;
  version: number;
  status: string;
  preliminary: boolean;
  stats: Record<string, unknown> & {
    sessions?: number;
    facts?: number;
    clusters?: number;
    embedding?: string;
    error?: string;
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  ensureDir(OUT_DIR);
  ensureDir(SCRATCH_DIR);
  const key = loadOpenRouterKey();
  const usageBefore = await keyUsageUsd(key);

  const card: Scorecard = {
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    routing: null,
    interviews: [],
    analysis: null,
    requirements: [],
    cost: null,
    latency: null,
    errors: null,
    appBugCandidates: [],
    probe: null,
    requirementsProbe: null,
    integrity: null,
    notes: [],
    phasesCompleted: [],
  };

  let stack: Stack | null = null;
  let watcher: NodeJS.Timeout | undefined;
  try {
    section("stack");
    stack = await startStack(key);
    const operator = new Api("operator", await staffToken(OPERATOR_EMAIL, stack.authSecret));
    const admin = new Api("admin", await staffToken(ADMIN_EMAIL, stack.authSecret));
    const me = await admin.ok<{ user: { role: string }; company: { id: string; name: string } }>(
      "GET",
      "/me",
    );
    log(`signed in as ${me.user.role} of "${me.company.name}"`);
    card.phasesCompleted.push("stack");

    section("routing and budget");
    const routing: Routing = await configureRouting(operator, admin);
    card.routing = {
      routes: routing.routes,
      simulatorModel: routing.simulatorModel.id,
      judgeModel: routing.judgeModel.id,
      embeddingRouteConfigured: routing.embeddingRouteConfigured,
      tenantBudgetCents: TENANT_BUDGET_CENTS,
    };
    const budgets = await admin.ok<{ budgets: { scope: string; limitCents: number }[] }>("GET", "/budgets");
    card.notes.push(
      `tenant budgets after set: ${JSON.stringify(budgets.budgets.map((b) => `${b.scope}:${b.limitCents}`))}`,
    );
    watcher = watchBudget(admin);
    card.phasesCompleted.push("routing");
    const sim = { apiKey: key, model: routing.simulatorModel.id };

    // ------------------------------------------------------------------ campaign
    section("campaign");
    const templates = await admin.ok<{
      templates: { id: string; key: string; status: string; companyId: string | null; version: number }[];
    }>("GET", "/templates");
    const template = templates.templates
      .filter((t) => t.key === "opportunity_discovery")
      .sort((a, b) => b.version - a.version)[0];
    if (!template) throw new Error("opportunity_discovery template not found");
    const created = await admin.ok<CampaignCreated>("POST", "/campaigns", {
      templateId: template.id,
      name: "Live run: hospital group discovery",
      participationMode: "participant_choice",
      verification: "open",
      maxTurns: Number(process.env.LIVE_CAMPAIGN_MAX_TURNS ?? 18),
      completionThreshold: PERSONAS.length,
    });
    const campaignId = created.campaign.id;
    const linkToken = created.link.url.split("/p/")[1];
    if (!linkToken) throw new Error(`could not read a link token from ${created.link.url}`);
    await admin.ok("POST", `/campaigns/${campaignId}/open`);
    // The requirements template is capped through the product's own settings, so the interview
    // closes by itself even though the explicit "I'm done" path is broken (see the report).
    const reqTemplate = templates.templates
      .filter((t) => t.key === "requirements_discovery")
      .sort((a, b) => b.version - a.version)[0];
    if (reqTemplate) {
      await operator.ok("PUT", `/settings?scope=template&scopeId=${reqTemplate.id}`, {
        values: { "engine.maxTurns": 40 },
      });
    }
    card.phasesCompleted.push("campaign");

    // ------------------------------------------------------------------ interviews
    section("interviews");
    const personas = PERSONAS.filter((p) => !ONLY || ONLY.includes(p.id));
    const results = await mapLimit(personas, CONCURRENCY, async (persona, index) => {
      if (abortState.reason) throw new Error(abortState.reason);
      try {
        return await runInterview({ linkToken, persona, sim, maxTurns: MAX_INTERVIEW_TURNS, index });
      } catch (err) {
        log(`interview ${persona.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        card.notes.push(
          `interview ${persona.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    });
    const interviews = results.filter((r): r is InterviewResult => r !== null);
    ensureDir(join(OUT_DIR, "transcripts"));
    for (const r of interviews) writeArtifact(`transcripts/${r.persona.id}.md`, transcriptMarkdown(r));
    card.phasesCompleted.push("interviews");

    section("probe: I'm done and delete my data");
    card.probe = await runDoneProbe(linkToken).catch((err: unknown) => {
      card.notes.push(`done probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    section("waiting for extraction");
    await mapLimit(interviews, 4, (r) => collectFacts(r, 150_000));

    // ------------------------------------------------------------------ privacy of staff views
    const sessions = await admin.ok<{
      sessions: { id: string; status: string; turns: number; costCents: number; progress?: unknown }[];
    }>("GET", `/campaigns/${campaignId}/sessions`);
    const costBySession = new Map(sessions.sessions.map((s) => [s.id, s.costCents]));
    const staffViews: Record<string, { status: number; hasMessages: boolean }> = {};
    for (const r of interviews) {
      const view = await admin.call<{ messages?: unknown[]; session?: { messages?: unknown[] } }>(
        "GET",
        `/sessions/${r.sessionId}`,
      );
      const msgs = view.body.messages ?? view.body.session?.messages ?? [];
      staffViews[r.persona.id] = { status: view.status, hasMessages: Array.isArray(msgs) && msgs.length > 0 };
    }

    // ------------------------------------------------------------------ judge
    section("judging interviews");
    const verdicts = new Map<string, JudgeVerdict | null>();
    await mapLimit(interviews, 4, async (r) => {
      const transcript: { role: "assistant" | "user"; content: string }[] = [];
      for (const t of r.turns) {
        transcript.push({ role: "assistant", content: t.assistantText });
        if (t.reply) transcript.push({ role: "user", content: t.reply.text });
      }
      verdicts.set(
        r.persona.id,
        await judgeTranscript({
          apiKey: key,
          model: routing.judgeModel.id,
          kind: "discovery",
          transcript,
          label: `judge:${r.persona.id}`,
        }),
      );
    });

    for (const r of interviews) {
      const texts = r.turns.map((t) => t.assistantText).filter(Boolean);
      const verdict = verdicts.get(r.persona.id) ?? null;
      const factsByKind: Record<string, number> = {};
      for (const f of r.facts) factsByKind[f.kind] = (factsByKind[f.kind] ?? 0) + 1;
      card.interviews.push({
        persona: r.persona.id,
        participation: r.persona.participation,
        sessionId: r.sessionId,
        turns: r.turns.length,
        ended: r.ended,
        endReason: r.endReason,
        areas: r.areas,
        areasCovered: r.areas.filter((a) => a.status === "covered").length,
        areasTotal: r.areas.length,
        heuristics: totalFlags(texts, 500),
        widgetsOffered: r.turns.filter((t) => t.widget).length,
        widgetsAnswered: r.turns.filter((t) => t.reply?.modality === "widget").length,
        factsByKind,
        factCount: r.facts.length,
        summaryChars: r.summary.length,
        summaryEdited: r.summaryEdited,
        costCents: costBySession.get(r.sessionId) ?? null,
        firstTokenMs: r.turns.map((t) => t.firstTokenMs).filter((x): x is number => x !== null),
        totalMs: r.turns.map((t) => t.totalMs),
        retries: r.turns.reduce((s, t) => s + t.retried, 0),
        turnErrors: r.turns.filter((t) => t.error).map((t) => `${t.error?.code}: ${t.error?.message}`),
        staffCanReadTranscript: staffViews[r.persona.id]?.hasMessages ?? null,
        judge: verdict,
        notes: r.notes,
      });
    }
    writeJson("interviews.json", card.interviews);
    card.phasesCompleted.push("facts_and_judge");

    // ------------------------------------------------------------------ analysis
    section("analysis");
    const totalFacts = interviews.reduce((s, r) => s + r.facts.length, 0);
    card.notes.push(`facts across interviews when analysis was awaited: ${totalFacts}`);
    const analyses: AnalysisView[] = [];
    const listAnalyses = async (): Promise<AnalysisView[]> =>
      (await admin.ok<{ analyses: AnalysisView[] }>("GET", `/campaigns/${campaignId}/analyses`)).analyses;
    let autoTriggered = false;
    {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const l = await listAnalyses();
        if (l.length > 0) {
          autoTriggered = true;
          break;
        }
        await sleep(5000);
      }
    }
    const completedCount = interviews.filter((r) => r.ended).length;
    card.notes.push(`${completedCount} of ${interviews.length} interviews ended through the engine`);
    if (!autoTriggered) {
      if (completedCount >= PERSONAS.length)
        card.appBugCandidates.push(
          `Analysis was not queued automatically after ${completedCount} sessions completed with completionThreshold=${PERSONAS.length} (contract 17 "Trigger").`,
        );
      await admin.ok("POST", `/campaigns/${campaignId}/analyses`, {});
    }
    const waitAnalysis = async (): Promise<AnalysisView> => {
      const deadline = Date.now() + 40 * 60_000;
      for (;;) {
        const list = await listAnalyses();
        const latest = list[0];
        if (latest && (latest.status === "done" || latest.status === "failed")) return latest;
        if (abortState.reason) throw new Error(abortState.reason);
        if (Date.now() > deadline) throw new Error("analysis did not finish in 40 minutes");
        await sleep(5000);
      }
    };
    let latest = await waitAnalysis();
    analyses.push(latest);
    // An automatic run can start before the last extraction finished: re-run once on settled facts.
    if (autoTriggered && latest.status === "done" && (latest.stats.facts ?? 0) < totalFacts) {
      card.notes.push(
        `auto-triggered analysis saw ${latest.stats.facts ?? 0} facts but ${totalFacts} existed after settling; re-ran manually`,
      );
      await admin.ok("POST", `/campaigns/${campaignId}/analyses`, {});
      latest = await waitAnalysis();
      analyses.push(latest);
    }
    const detail = await admin.ok<{
      analysis: AnalysisView;
      opportunities: OpportunityView[];
      report: { markdown: string; sections: { key?: string }[] } | null;
    }>("GET", `/analyses/${latest.id}`);
    writeJson("analysis.json", detail);
    writeArtifact("report.md", detail.report?.markdown ?? "(no report)");

    let diffSummary: unknown = null;
    if (analyses.length > 1 && analyses[0]) {
      const d = await admin.call("GET", `/analyses/${latest.id}/diff/${analyses[0].id}`);
      diffSummary = { status: d.status };
    }

    const kRes = await admin.ok<{ values: Record<string, unknown> }>("GET", "/settings?scope=tenant");
    const k = typeof kRes.values["privacy.kAnonymity"] === "number" ? kRes.values["privacy.kAnonymity"] : 3;
    const quotesByFact = new Map<string, string>();
    for (const r of interviews)
      for (const f of r.facts) {
        const q = typeof f.quote === "string" ? f.quote : undefined;
        if (q && typeof f.id === "string") quotesByFact.set(f.id, q);
      }
    const markdown = detail.report?.markdown ?? "";
    const names = PERSONAS.flatMap((p) => p.name.split(" ")).filter((n) => n.length > 3);
    card.analysis = {
      analysisId: latest.id,
      status: latest.status,
      preliminary: latest.preliminary,
      autoTriggered,
      runs: analyses.map((a) => ({ id: a.id, facts: a.stats.facts ?? null, status: a.status })),
      stats: detail.analysis.stats,
      embedding: detail.analysis.stats.embedding ?? null,
      clusters: detail.opportunities.map((o) => ({
        title: o.title,
        key: o.clusterKey,
        participants: o.stats.participants,
        facts: o.stats.facts,
        solutionClass: o.solutionClass,
        rankScore: o.rankScore,
      })),
      k,
      kAnonymityFindings: checkKAnonymity(detail.opportunities, k, quotesByFact, markdown),
      reportSections: reportSectionsPresent(markdown),
      reportChars: markdown.length,
      namesInReport: leakedNames(markdown, names),
      namesInOpportunities: leakedNames(JSON.stringify(detail.opportunities), names),
      diff: diffSummary,
      opportunitiesWithoutWhyNotAi: detail.opportunities
        .filter((o) => (o.solutionClass === "process" || o.solutionClass === "none") && !o.whyNotAi)
        .map((o) => o.title),
    };
    card.phasesCompleted.push("analysis");

    // ------------------------------------------------------------------ requirements
    const top = [...detail.opportunities].sort((a, b) => b.rankScore - a.rankScore)[0];
    if (!top) throw new Error("analysis produced no opportunities; cannot promote");
    section(`promote "${top.title}"`);
    const promoted = await admin.ok<{ session: { id: string }; handoff: Handoff }>(
      "POST",
      `/opportunities/${top.id}/promote`,
      {},
    );
    writeJson("handoff.json", promoted.handoff);

    const requirementsRuns: { run: RequirementsRun; verdict: JudgeVerdict | null; label: string }[] = [];

    const sessionA = promoted.session.id;
    await admin.ok("POST", `/requirements/${sessionA}/path`, { path: "nontechnical" });
    section("requirements interview (nontechnical owner)");
    const systemA = ownerSystemPrompt("nontechnical", top.title, promoted.handoff);
    const runA = await runRequirementsTurns({
      api: admin,
      sessionId: sessionA,
      kind: "nontechnical",
      system: systemA,
      sim,
      maxTurns: MAX_REQUIREMENTS_TURNS,
      label: "sim:owner_nontechnical",
    });
    const reqCard = await finishRequirements({
      admin,
      run: runA,
      sim,
      system: systemA,
      reopen: true,
      judgeKey: key,
      judgeModel: routing.judgeModel.id,
      name: "nontechnical",
    });
    card.requirements.push(reqCard);
    requirementsRuns.push({ run: runA, verdict: null, label: "nontechnical" });
    card.phasesCompleted.push("requirements_nontechnical");

    if (!SKIP_TECHNICAL && !abortState.reason) {
      try {
        section("requirements interview (technical owner, fresh session from the same opportunity)");
        const created2 = await admin.ok<{ session: { id: string } }>("POST", "/requirements", {
          title: `${top.title} (technical variant)`,
          prompt: `${promoted.handoff.problem}\n\nExisting process: ${promoted.handoff.existingProcess.join("; ")}\nTools: ${promoted.handoff.tools.join(", ")}\nConstraints: ${promoted.handoff.constraints}`,
          path: "technical",
        });
        const systemB = ownerSystemPrompt("technical", top.title, promoted.handoff);
        const runB = await runRequirementsTurns({
          api: admin,
          sessionId: created2.session.id,
          kind: "technical",
          system: systemB,
          sim,
          maxTurns: MAX_REQUIREMENTS_TURNS,
          label: "sim:owner_technical",
        });
        const reqCardB = await finishRequirements({
          admin,
          run: runB,
          sim,
          system: systemB,
          reopen: false,
          judgeKey: key,
          judgeModel: routing.judgeModel.id,
          name: "technical",
        });
        card.requirements.push(reqCardB);
        card.phasesCompleted.push("requirements_technical");
      } catch (err) {
        card.notes.push(
          `technical requirements run failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    section("probe: owner presses done early");
    card.requirementsProbe = await runRequirementsDoneProbe(admin).catch((err: unknown) => {
      card.notes.push(`requirements probe failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    // ------------------------------------------------------------------ cost, latency, errors
    section("cost, latency, errors");
    const byPurpose = await admin.ok<{
      rows: { key: string; costCents: number; calls: number; tokens: number }[];
      budget: unknown;
    }>("GET", "/spend?groupBy=purpose");
    const byModel = await admin.ok<{
      rows: { key: string; costCents: number; calls: number; tokens: number }[];
    }>("GET", "/spend?groupBy=model");
    const byCampaign = await admin.ok<{
      rows: { key: string; costCents: number; calls: number; tokens: number }[];
    }>("GET", "/spend?groupBy=campaign");
    const stats = await admin.ok<{ ai: { month: Record<string, unknown>; budget: unknown } }>(
      "GET",
      "/stats",
    );
    const usageAfter = await keyUsageUsd(key);
    const ledgerTotal = byPurpose.rows.reduce((s, r) => s + r.costCents, 0);
    card.cost = {
      ledgerCentsTotal: ledgerTotal,
      byPurpose: byPurpose.rows,
      byModel: byModel.rows,
      byCampaign: byCampaign.rows,
      budget: byPurpose.budget,
      aiMonth: stats.ai.month,
      harnessUsd: harnessSpend.usd,
      harnessByLabel: harnessSpend.byLabel,
      harnessTokens: { prompt: harnessSpend.promptTokens, completion: harnessSpend.completionTokens },
      openRouterUsageDeltaUsd: usageBefore !== null && usageAfter !== null ? usageAfter - usageBefore : null,
      perInterviewCents: card.interviews.map((i) => ({ persona: i.persona, costCents: i.costCents })),
    };
    const turnFirst = card.interviews.flatMap((i) => i.firstTokenMs);
    const turnFull = card.interviews.flatMap((i) => i.totalMs);
    const reqFirst = card.requirements.flatMap((r) => r.firstTokenMs);
    const reqFull = card.requirements.flatMap((r) => r.totalMs);
    card.latency = {
      discoveryFirstToken: summarize(turnFirst),
      discoveryFullTurn: summarize(turnFull),
      requirementsFirstToken: summarize(reqFirst),
      requirementsFullTurn: summarize(reqFull),
      byRoute: routeLatency(),
    };
    card.errors = collectErrors(stack);
    card.integrity = await dbIntegrity().catch(() => null);

    writeJson("requests.json", requestLog);
    card.durationMs = Date.now() - started;
    writeJson("scorecard.json", card);
    writeArtifact("scorecard.md", renderScorecard(card));
    log(
      `done in ${(card.durationMs / 60000).toFixed(1)} min; ledger ${ledgerTotal.toFixed(1)} c, harness $${harnessSpend.usd.toFixed(3)}`,
    );
    console.warn(`\n${renderScorecard(card)}`);
  } catch (err) {
    card.notes.push(`RUN ABORTED: ${err instanceof Error ? err.message : String(err)}`);
    card.durationMs = Date.now() - started;
    card.errors = stack ? collectErrors(stack) : null;
    writeJson("scorecard.json", card);
    writeArtifact("scorecard.md", renderScorecard(card));
    throw err;
  } finally {
    if (watcher) clearInterval(watcher);
    if (stack) await stack.stop();
  }
}

function routeLatency(): { route: string; n: number; p50: number; p90: number; max: number }[] {
  const groups = new Map<string, number[]>();
  for (const r of requestLog) {
    const route = `${r.method} ${r.path.replace(/\/[0-9a-z]{20,}(?=\/|$)/g, "/:id").replace(/\/pt\.[^/]+/g, "")}`;
    const arr = groups.get(route) ?? [];
    arr.push(r.ms);
    groups.set(route, arr);
  }
  return [...groups.entries()]
    .map(([route, ms]) => ({ route, ...summarize(ms) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 25);
}

function collectErrors(stack: Stack): Scorecard["errors"] {
  const byStatus = new Map<string, number>();
  for (const r of requestLog) {
    if (r.status >= 400) {
      const route = `${r.method} ${r.path.replace(/\/[0-9a-z]{20,}(?=\/|$)/g, "/:id")} -> ${r.status}`;
      byStatus.set(route, (byStatus.get(route) ?? 0) + 1);
    }
  }
  const sse = requestLog.filter((r) => r.note?.startsWith("sse error")).map((r) => `${r.path}: ${r.note}`);
  const logSummary = (file: string): { level: string; msg: string; count: number }[] => {
    const counts = new Map<string, number>();
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const o = JSON.parse(line) as { level?: number; msg?: string };
          if ((o.level ?? 0) >= 40) {
            const key = `${o.level === 40 ? "warn" : "error"}|${(o.msg ?? "").slice(0, 160)}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        } catch {
          // not a JSON log line
        }
      }
    } catch {
      return [];
    }
    return [...counts.entries()].map(([k, count]) => {
      const [level = "", msg = ""] = k.split("|");
      return { level, msg, count };
    });
  };
  return {
    http4xx5xx: [...byStatus.entries()].map(([route, count]) => ({ route, count })),
    sseErrors: sse,
    apiLog: logSummary(stack.logs.api),
    workerLog: logSummary(stack.logs.worker),
    logFiles: stack.logs,
  };
}

interface FinishArgs {
  admin: Api;
  run: RequirementsRun;
  sim: { apiKey: string; model: string };
  system: string;
  reopen: boolean;
  judgeKey: string;
  judgeModel: string;
  name: string;
}

async function finishRequirements(a: FinishArgs): Promise<Scorecard["requirements"][number]> {
  const { admin, run } = a;
  const sid = run.sessionId;
  const detail = await admin.ok<{
    messages: { role: string; content: string }[];
    spec: {
      stats: Record<string, unknown>;
      findings: { status: string; type: string; description: string }[];
      sections: { key: string; status: string }[];
      mvpChallenge: unknown;
    };
    session: { status: string };
  }>("GET", `/requirements/${sid}`);
  writeJson(`requirements-${a.name}-live-spec.json`, detail.spec);
  writeArtifact(
    `transcripts/requirements-${a.name}.md`,
    run.turns
      .map(
        (t) =>
          `**Interviewer:** ${t.assistantText}\n\n**Owner (${t.reply?.modality ?? "-"}):** ${t.reply?.text ?? ""}\n`,
      )
      .join("\n"),
  );

  section(`generating spec version 1 (${a.name})`);
  const v1 = await generateVersion(admin, sid, `live ${a.name} v1`, 20 * 60_000);
  const got1 = await admin.ok<{
    document: SpecDocumentView;
    markdown: string;
    bundle: { format: string; files: { path: string; content: string }[] };
    issues: unknown[];
    version: { stats: Record<string, unknown> };
  }>("GET", `/requirements/${sid}/versions/${v1.version}`);
  writeArtifact(`spec-${a.name}-v${v1.version}.md`, got1.markdown);
  writeJson(`spec-${a.name}-v${v1.version}.json`, got1.document);
  const taskFiles = got1.bundle.files.filter((f) => f.path.startsWith("tasks/")).map((f) => f.content);
  const specCheck = checkSpec(got1.document, taskFiles);
  const bundlePaths = got1.bundle.files.map((f) => f.path);

  const exports: Record<string, { status: number; bytes: number; contentType: string }> = {};
  let zipEntries: string[] = [];
  for (const fmt of ["md", "json", "bundle"]) {
    const r = await admin.bytes(`/requirements/${sid}/versions/${v1.version}/export?format=${fmt}`);
    exports[fmt] = { status: r.status, bytes: r.data.length, contentType: r.contentType };
    if (fmt === "bundle" && r.status === 200) {
      const zipPath = join(SCRATCH_DIR, `bundle-${a.name}.zip`);
      writeFileSync(zipPath, r.data);
      try {
        const out = await sh("unzip", ["-Z1", zipPath]);
        zipEntries = out.stdout.split("\n").filter(Boolean);
      } catch {
        zipEntries = [];
      }
    }
  }
  for (const f of got1.bundle.files) writeArtifact(`bundle-${a.name}/${f.path}`, f.content);

  let diff: Scorecard["requirements"][number]["diff"] = null;
  let v2Info: { version: number; status: string } | null = null;
  if (a.reopen) {
    section("reopening and revising");
    const reopen = await admin.call("POST", `/requirements/${sid}/reopen`);
    if (reopen.status === 200) {
      const more = await runRequirementsTurns({
        api: admin,
        sessionId: sid,
        kind: run.kind,
        system: a.system,
        sim: a.sim,
        maxTurns: 6,
        startIndex: run.turns.length,
        label: `sim:owner_${a.name}_revision`,
        nudge:
          "You have had second thoughts since the last conversation. In this answer, change one earlier decision to something different and say why, and add one requirement you forgot (for example an audit trail, an export, or a role you had left out).",
      });
      run.turns.push(...more.turns);
      const v2 = await generateVersion(admin, sid, `live ${a.name} v2`, 20 * 60_000);
      v2Info = { version: v2.version, status: v2.status };
      const d = await admin.call<{
        sections: { key: string; change: string; lines: unknown[] }[];
        requirements?: { added: unknown[]; removed: unknown[]; changed: unknown[] };
      }>("GET", `/requirements/${sid}/versions/${v2.version}/diff/${v1.version}`);
      diff = {
        status: d.status,
        sectionsChanged: Array.isArray(d.body.sections)
          ? d.body.sections.map((s) => `${s.key}:${s.change}`)
          : [],
        requirementsAdded: d.body.requirements?.added.length ?? 0,
        requirementsRemoved: d.body.requirements?.removed.length ?? 0,
        requirementsChanged: d.body.requirements?.changed.length ?? 0,
      };
      writeJson(`spec-${a.name}-diff-v${v2.version}-v${v1.version}.json`, d.body);
      const got2 = await admin.call<{ markdown: string }>(
        "GET",
        `/requirements/${sid}/versions/${v2.version}`,
      );
      if (got2.status === 200) writeArtifact(`spec-${a.name}-v${v2.version}.md`, got2.body.markdown);
    } else {
      diff = {
        status: reopen.status,
        sectionsChanged: [],
        requirementsAdded: 0,
        requirementsRemoved: 0,
        requirementsChanged: 0,
      };
    }
  }

  const transcript: { role: "assistant" | "user"; content: string }[] = [];
  for (const t of run.turns) {
    transcript.push({ role: "assistant", content: t.assistantText });
    if (t.reply) transcript.push({ role: "user", content: t.reply.text });
  }
  const verdict = await judgeTranscript({
    apiKey: a.judgeKey,
    model: a.judgeModel,
    kind: "requirements",
    transcript,
    label: `judge:requirements_${a.name}`,
  });
  const texts = run.turns.map((t) => t.assistantText).filter(Boolean);
  return {
    name: a.name,
    sessionId: sid,
    turns: run.turns.length,
    ended: run.ended,
    endReason: run.endReason,
    areas: run.progress,
    heuristics: totalFlags(texts, 700),
    findings: detail.spec.findings.map((f) => ({
      type: f.type,
      status: f.status,
      description: f.description.slice(0, 200),
    })),
    specStats: detail.spec.stats,
    version: { version: v1.version, status: v1.status, error: v1.error ?? null, stats: got1.version.stats },
    specCheck,
    bundlePaths,
    bundleHasRequired: REQUIRED_BUNDLE_FILES.every((f) => bundlePaths.includes(f)),
    bundleFormat: got1.bundle.format,
    zipEntries,
    exports,
    issuesCount: got1.issues.length,
    secondVersion: v2Info,
    diff,
    firstTokenMs: run.turns.map((t) => t.firstTokenMs).filter((x): x is number => x !== null),
    totalMs: run.turns.map((t) => t.totalMs),
    retries: run.turns.reduce((s, t) => s + t.retried, 0),
    turnErrors: run.turns.filter((t) => t.error).map((t) => `${t.error?.code}: ${t.error?.message}`),
    judge: verdict,
    notes: run.notes,
  };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
