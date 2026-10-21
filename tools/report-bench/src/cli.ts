/**
 * report-bench: measures the analysis report against a scenario with planted ground truth.
 *
 *   bench estimate                      cost estimate for the scenario, nothing is called
 *   bench run --name <run> --local      simulate, analyse and grade on a local instance
 *   bench run --name <run> --base-url <api> --staff-token <jwt> [--link <url>] [--campaign-id <id>]
 *   bench grade --name <run>            re-grade a cached run (judge answers are cached too)
 *   bench compare <a> <b>               diff two scorecards (run names, result names or paths)
 *
 * See README.md for every flag.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client, mintStaffToken } from "./client.js";
import { estimateCost, renderEstimate, type Price } from "./estimate.js";
import { grade } from "./grade/index.js";
import type { JudgeConfig } from "./grade/judge.js";
import { compareScorecards, renderScorecard, type Scorecard } from "./grade/scorecard.js";
import { startLocalStack, type LocalStack } from "./localstack.js";
import {
  abortState,
  harnessSpend,
  keyUsageUsd,
  listPrices,
  loadOpenRouterKey,
  log,
  mapLimit,
  REPO_ROOT,
} from "./openrouter.js";
import { fromAnalysisDetail, readReport, type BenchReport } from "./report.js";
import { loadScenario, type Scenario } from "./scenario.js";
import { simulateInterview, type Transcript } from "./simulate.js";
import {
  campaignSpendUsd,
  createCampaign,
  fetchAnalysis,
  linkTokenFrom,
  readK,
  runAnalysis,
  waitForExtraction,
} from "./staff.js";

const BENCH_DIR = resolve(REPO_ROOT, "tools/report-bench");
const DEFAULT_SCENARIO = join(BENCH_DIR, "scenarios/kaarna-logistics.json");
/** The production default routes (packages/ai/src/routes/defaults.ts, OpenRouter tiers). */
const PRODUCT_MODELS = {
  interview: "anthropic/claude-sonnet-5",
  extraction: "anthropic/claude-sonnet-5",
  analysis: "anthropic/claude-opus-5",
};

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    scenario: { type: "string", default: DEFAULT_SCENARIO },
    name: { type: "string" },
    local: { type: "boolean", default: false },
    fresh: { type: "boolean", default: false },
    "base-url": { type: "string" },
    "staff-token": { type: "string" },
    "auth-secret": { type: "string" },
    "staff-email": { type: "string" },
    link: { type: "string" },
    "campaign-id": { type: "string" },
    "max-cost": { type: "string", default: "8" },
    "sim-model": { type: "string", default: "anthropic/claude-haiku-5.5" },
    "judge-model": { type: "string", default: "anthropic/claude-sonnet-5" },
    "judge-samples": { type: "string", default: "3" },
    temperature: { type: "string", default: "0.7" },
    seed: { type: "string", default: "7" },
    concurrency: { type: "string", default: "3" },
    personas: { type: "string" },
    "force-analysis": { type: "boolean", default: false },
    resimulate: { type: "boolean", default: false },
    "no-judge": { type: "boolean", default: false },
    report: { type: "string" },
    "save-as": { type: "string" },
    port: { type: "string", default: "4290" },
    "pg-container": { type: "string", default: "ai-interview-postgres-1" },
    "embedding-model": { type: "string", default: "openai/text-embedding-3-small" },
  },
});

const runDir = (name: string): string => join(BENCH_DIR, "runs", name);
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed read of our own files
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, v: unknown): void => {
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
};

interface RunState {
  baseUrl?: string;
  campaignId?: string;
  linkToken?: string;
  analysisId?: string;
}

function requireName(): string {
  const name = opt.name;
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name))
    throw new Error("--name <run> is required (lowercase letters, digits, - and _)");
  return name;
}

function selectedPersonas(scenario: Scenario): Scenario["personas"] {
  const only = opt.personas?.split(",").filter(Boolean);
  return only ? scenario.personas.filter((p) => only.includes(p.id)) : scenario.personas;
}

async function estimate(scenario: Scenario, personas: number, withProduct: boolean): Promise<number> {
  const prices = await listPrices();
  const p = (id: string): Price | null => {
    const m = prices.get(id);
    if (!m) log(`warning: no OpenRouter price for ${id}; it is left out of the estimate`);
    return m ?? null;
  };
  const est = estimateCost({
    personas,
    turns: scenario.campaign.maxTurns,
    interview: withProduct ? p(PRODUCT_MODELS.interview) : null,
    extraction: withProduct ? p(PRODUCT_MODELS.extraction) : null,
    analysis: withProduct ? p(PRODUCT_MODELS.analysis) : null,
    simulator: withProduct ? p(opt["sim-model"]) : null,
    judge: opt["no-judge"] ? null : p(opt["judge-model"]),
  });
  console.warn(renderEstimate(est));
  return est.totalUsd;
}

function judgeConfig(apiKey: string, dir: string): JudgeConfig | null {
  return opt["no-judge"]
    ? null
    : {
        apiKey,
        model: opt["judge-model"],
        cacheDir: join(dir, "judge-cache"),
        samples: Number(opt["judge-samples"]),
      };
}

function writeScorecard(dir: string, card: Scorecard): void {
  writeJson(join(dir, "scorecard.json"), card);
  writeFileSync(join(dir, "scorecard.md"), renderScorecard(card));
  if (opt["save-as"]) {
    const target = join(BENCH_DIR, "results", opt["save-as"]);
    mkdirSync(target, { recursive: true });
    for (const f of [
      "scorecard.json",
      "scorecard.md",
      "report.json",
      "report.md",
      "transcripts.json",
      "run.json",
    ])
      if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(target, f));
    log(`saved to ${target}`);
  }
  console.warn(`\n${renderScorecard(card).split("## Ground truth")[0] ?? ""}`);
  log(`scorecard: ${join(dir, "scorecard.md")}`);
}

async function cmdRun(): Promise<void> {
  const name = requireName();
  const scenario = loadScenario(opt.scenario);
  const dir = runDir(name);
  mkdirSync(dir, { recursive: true });
  const personas = selectedPersonas(scenario);
  const transcriptsFile = join(dir, "transcripts.json");
  const cached: Transcript[] =
    existsSync(transcriptsFile) && !opt.resimulate ? readJson<Transcript[]>(transcriptsFile) : [];
  const todo = personas.filter((p) => !cached.some((t) => t.personaId === p.id));
  const maxCost = Number(opt["max-cost"]);

  const key = loadOpenRouterKey();
  const est = await estimate(scenario, todo.length, todo.length > 0);
  if (est > maxCost)
    throw new Error(
      `estimate $${est.toFixed(2)} is above --max-cost $${maxCost}; lower the persona count or raise the cap`,
    );
  const usageBefore = await keyUsageUsd(key);

  let stack: LocalStack | null = null;
  let watcher: NodeJS.Timeout | undefined;
  const statePath = join(dir, "state.json");
  const state: RunState = existsSync(statePath) ? readJson<RunState>(statePath) : {};
  try {
    let base: string;
    let staffToken: string;
    if (opt.local) {
      stack = await startLocalStack({
        runDir: dir,
        dbName: `ai_discovery_bench_${name.replace(/-/g, "_")}`,
        port: Number(opt.port),
        pgContainer: opt["pg-container"],
        openRouterKey: key,
        fresh: opt.fresh,
        embeddingModel: opt["embedding-model"] === "none" ? null : opt["embedding-model"],
      });
      if (opt.fresh) {
        delete state.campaignId;
        delete state.linkToken;
        delete state.analysisId;
      }
      base = stack.baseUrl;
      staffToken = await mintStaffToken(stack.adminEmail, stack.authSecret);
    } else {
      const b = opt["base-url"];
      if (!b) throw new Error("--local or --base-url <https://host/api/v1> is required");
      base = b.replace(/\/$/, "");
      const token =
        opt["staff-token"] ??
        process.env.BENCH_STAFF_TOKEN ??
        (opt["auth-secret"] && opt["staff-email"]
          ? await mintStaffToken(opt["staff-email"], opt["auth-secret"])
          : undefined);
      if (!token)
        throw new Error(
          "a staff token is required: --staff-token, BENCH_STAFF_TOKEN, or --auth-secret with --staff-email",
        );
      staffToken = token;
    }
    state.baseUrl = base;
    const staff = new Client(base, staffToken);
    await staff.ok("GET", "/me");

    if (opt.link) state.linkToken = linkTokenFrom(opt.link);
    if (opt["campaign-id"]) state.campaignId = opt["campaign-id"];
    if (!state.campaignId || !state.linkToken) {
      if (todo.length === 0)
        throw new Error(
          "transcripts are cached but the campaign is unknown; pass --campaign-id or --resimulate",
        );
      const c = await createCampaign(staff, scenario, personas.length);
      state.campaignId = c.campaignId;
      state.linkToken = c.linkToken;
      log(`campaign ${c.campaignId} created and opened`);
    }
    writeJson(statePath, state);
    const campaignId = state.campaignId;
    const linkToken = state.linkToken;
    const ledgerBefore = (await campaignSpendUsd(staff, campaignId)) ?? 0;

    // The --max-cost guard: harness calls plus the product's ledger for this campaign, and the
    // OpenRouter key's own usage when it is the same key, checked every 15 s.
    watcher = setInterval(() => {
      void (async () => {
        const ledger = ((await campaignSpendUsd(staff, campaignId)) ?? ledgerBefore) - ledgerBefore;
        const keyNow = usageBefore === null ? null : await keyUsageUsd(key);
        const spent = Math.max(
          harnessSpend.usd + ledger,
          keyNow !== null && usageBefore !== null ? keyNow - usageBefore : 0,
        );
        if (spent > maxCost && !abortState.reason) {
          abortState.reason = `spend $${spent.toFixed(2)} passed --max-cost $${maxCost}`;
          log(`ABORT: ${abortState.reason}`);
        }
      })().catch(() => undefined);
    }, 15_000);

    if (todo.length) {
      log(`simulating ${todo.length} interview(s) with ${opt["sim-model"]}`);
      const sim = {
        apiKey: key,
        model: opt["sim-model"],
        temperature: Number(opt.temperature),
        seed: Number(opt.seed),
        turnCap: scenario.campaign.maxTurns,
      };
      const done = [...cached];
      await mapLimit(todo, Number(opt.concurrency), async (persona) => {
        try {
          const t = await simulateInterview(base, linkToken, scenario, persona, sim);
          done.push(t);
          writeJson(transcriptsFile, done);
        } catch (err) {
          log(`interview ${persona.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      if (abortState.reason) throw new Error(abortState.reason);
      log("waiting for extraction to settle");
      await waitForExtraction(staff, campaignId, 4 * 60_000);
    }
    const transcripts = readJson<Transcript[]>(transcriptsFile);
    const order = new Map(scenario.personas.map((p, i) => [p.id, i]));
    transcripts.sort((a, b) => (order.get(a.personaId) ?? 0) - (order.get(b.personaId) ?? 0));
    writeJson(transcriptsFile, transcripts);

    const analysisId = await runAnalysis(staff, campaignId, { force: opt["force-analysis"] });
    state.analysisId = analysisId;
    writeJson(statePath, state);
    const detail = await fetchAnalysis(staff, analysisId);
    const k = (await readK(staff)) ?? scenario.k;
    const report = fromAnalysisDetail(detail, `analysis ${analysisId}`, k);
    writeJson(join(dir, "analysis.json"), detail);
    writeJson(join(dir, "report.json"), report);
    writeFileSync(join(dir, "report.md"), report.markdown);

    // What making the report cost, recorded before grading so a failed grade does not lose it.
    const ledger = ((await campaignSpendUsd(staff, campaignId)) ?? ledgerBefore) - ledgerBefore;
    const usageAfter = await keyUsageUsd(key);
    const meta: RunMeta = {
      notes: [
        `instance ${base.replace(/\/api\/v1$/, "")}${opt.local ? `, embedding route ${opt["embedding-model"]}` : ""}`,
        `simulator ${opt["sim-model"]} (temperature ${opt.temperature}, seed ${opt.seed})`,
      ],
      spend: {
        ...(usageBefore !== null && usageAfter !== null
          ? { openrouter_key_delta_before_grading: usageAfter - usageBefore }
          : {}),
        product_ledger_this_run: ledger,
        ...Object.fromEntries(Object.entries(harnessSpend.byLabel).map(([k2, v]) => [`harness_${k2}`, v])),
      },
    };
    writeJson(join(dir, "run.json"), meta);
    await gradeAndWrite(name, scenario, dir, dir, report, transcripts, key);
  } finally {
    if (watcher) clearInterval(watcher);
    if (stack) await stack.stop();
  }
}

interface RunMeta {
  notes: string[];
  spend: Record<string, number>;
}

/** Grades, adds the grading's own spend to what the run recorded, and writes the scorecard. */
async function gradeAndWrite(
  name: string,
  scenario: Scenario,
  dataDir: string,
  outDir: string,
  report: BenchReport,
  transcripts: Transcript[],
  key: string,
): Promise<void> {
  const metaPath = join(dataDir, "run.json");
  const meta: RunMeta = existsSync(metaPath) ? readJson<RunMeta>(metaPath) : { notes: [], spend: {} };
  const before = harnessSpend.usd;
  const card = await grade({
    scenario,
    run: name,
    report,
    transcripts,
    judge: judgeConfig(key, dataDir),
    notes: meta.notes,
  });
  card.spend = { ...meta.spend, harness_grading_this_time: harnessSpend.usd - before };
  writeScorecard(outDir, card);
  log(
    `spend: ${Object.entries(card.spend)
      .map(([k2, v]) => `${k2} $${v.toFixed(2)}`)
      .join(", ")}`,
  );
}

async function cmdGrade(): Promise<void> {
  const name = requireName();
  const scenario = loadScenario(opt.scenario);
  const dir = existsSync(runDir(name)) ? runDir(name) : join(BENCH_DIR, "results", name);
  const transcripts = readJson<Transcript[]>(join(dir, "transcripts.json"));
  const reportPath = opt.report ?? join(dir, "report.json");
  const report: BenchReport = readReport(readJson<unknown>(reportPath), reportPath, scenario.k);
  const outDir = opt.report ? join(BENCH_DIR, "runs", `${name}-regrade`) : dir;
  mkdirSync(outDir, { recursive: true });
  const key = opt["no-judge"] ? "" : loadOpenRouterKey();
  await gradeAndWrite(name, scenario, dir, outDir, report, transcripts, key);
}

function resolveScorecard(ref: string): Scorecard {
  const candidates = [
    ref,
    join(runDir(ref), "scorecard.json"),
    join(BENCH_DIR, "results", ref, "scorecard.json"),
  ];
  const path = candidates.find((c) => c.endsWith(".json") && existsSync(c));
  if (!path) throw new Error(`no scorecard for "${ref}" (tried ${candidates.join(", ")})`);
  return readJson<Scorecard>(path);
}

async function main(): Promise<void> {
  const [cmd, a, b] = positionals;
  switch (cmd) {
    case "estimate": {
      const scenario = loadScenario(opt.scenario);
      await estimate(scenario, selectedPersonas(scenario).length, true);
      return;
    }
    case "run":
      return cmdRun();
    case "grade":
      return cmdGrade();
    case "compare": {
      if (!a || !b) throw new Error("usage: bench compare <a> <b>");
      process.stdout.write(`${compareScorecards(resolveScorecard(a), resolveScorecard(b))}\n`);
      return;
    }
    default:
      console.error("usage: bench estimate | run | grade | compare  (see tools/report-bench/README.md)");
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
