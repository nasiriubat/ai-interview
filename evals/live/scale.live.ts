/**
 * Live clustering at scale. Costs real money; never run by CI (it is outside `src/**\/*.eval.ts`).
 *
 *   pnpm exec tsx evals/live/scale.live.ts
 *
 * Reads the facts a `pnpm live:run` left in its database (`ai_discovery_live`, through the Postgres
 * container), replicates them to LIVE_SCALE_TARGET facts (default 500) with each copy attributed to
 * a different participant, and runs the real analysis pipeline against an OpenRouter model, with
 * the real ModelCaller and its ledger. This is the only place the merge pass is exercised against a
 * live model at a size where the old fact-id echo failed (441 facts). The copies are not new
 * interviews: what it shows is that the pass completes, covers every fact and stays bounded.
 *
 * The key is read at runtime from OPENROUTER_API_KEY or the first .env above the repository and is
 * never printed. Models: LIVE_MODEL_STRONG (default openai/gpt-4.1-mini).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BudgetGuard,
  InMemoryLedger,
  ModelCaller,
  PriceTable,
  ProviderRegistry,
  runAnalysis,
  ShippedPromptSource,
  StaticBudgetLimits,
  type AnalysisFact,
} from "@aidp/ai";
import { FactSchema, WEIGHT_PRESETS, type ProviderConfig, type Route } from "@aidp/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = Number(process.env.LIVE_SCALE_TARGET ?? 500);
const DB = process.env.LIVE_DB_NAME ?? "ai_discovery_live";
const CONTAINER = process.env.LIVE_PG_CONTAINER ?? "ai-interview-postgres-1";
const MODEL = process.env.LIVE_MODEL_STRONG ?? "openai/gpt-4.1-mini";
const CAP_CENTS = Number(process.env.LIVE_SCALE_CAP_CENTS ?? 100);

function apiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  let dir = resolve(HERE, "../..");
  for (let i = 0; i < 8; i++) {
    for (const f of [join(dir, ".env"), join(dir, "apps/api/.env")]) {
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = /^OPENROUTER_API_KEY\s*=\s*(.*)$/.exec(line.trim());
        if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("OPENROUTER_API_KEY not found");
}

function factsFromDb(): { id: string; sessionId: string; payload: unknown }[] {
  const out = execFileSync(
    "docker",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "app",
      "-d",
      DB,
      "-t",
      "-A",
      "-F",
      "\t",
      "-c",
      `select f.id, f."sessionId", f.payload::text from "Fact" f order by f.id`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, sessionId, payload] = l.split("\t");
      return { id: id ?? "", sessionId: sessionId ?? "", payload: JSON.parse(payload ?? "null") as unknown };
    });
}

async function price(model: string): Promise<{ input: number; output: number }> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const body = (await res.json()) as {
    data: { id: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const m = body.data.find((x) => x.id === model);
  if (!m) throw new Error(`model ${model} is not listed`);
  return {
    input: Number(m.pricing?.prompt ?? 0) * 1_000_000,
    output: Number(m.pricing?.completion ?? 0) * 1_000_000,
  };
}

const rows = factsFromDb();
if (rows.length === 0) throw new Error(`no facts in ${DB}; run pnpm live:run first`);
const base: AnalysisFact[] = [];
for (const r of rows) {
  const parsed = FactSchema.safeParse(r.payload);
  if (parsed.success)
    base.push({ id: r.id, sessionId: r.sessionId, participantKey: r.sessionId, fact: parsed.data });
}
const facts: AnalysisFact[] = [];
for (let copy = 0; facts.length < TARGET; copy++) {
  for (const f of base) {
    if (facts.length >= TARGET) break;
    facts.push({
      ...f,
      // Ids sort after the originals so keys stay stable; each copy is a different "person".
      id: `${f.id}~${String(copy).padStart(3, "0")}`,
      sessionId: `${f.sessionId}~${copy}`,
      participantKey: `${f.participantKey}~${copy}`,
    });
  }
}

const providerId = "openrouter-live";
const config: ProviderConfig = {
  id: providerId,
  companyId: null,
  kind: "openrouter",
  name: "OpenRouter",
  apiKey: apiKey(),
  headers: {},
  enabled: true,
};
const p = await price(MODEL);
const ledger = new InMemoryLedger();
const route = (purpose: Route["purpose"], maxOutputTokens: number): Route => ({
  companyId: null,
  purpose,
  providerId,
  model: MODEL,
  maxOutputTokens,
  batchAllowed: false,
});
const routes: Record<string, Route> = {
  clustering: route("clustering", 16000),
  analysis_report: route("analysis_report", 8000),
};
const caller = new ModelCaller({
  routes: { resolve: async (_c, purpose) => routes[purpose] },
  providerConfigs: { get: async () => config },
  registry: new ProviderRegistry(),
  prices: new PriceTable([
    {
      providerId,
      model: MODEL,
      inputPerMtok: p.input,
      cachedInputPerMtok: p.input,
      outputPerMtok: p.output,
      source: "provider",
    },
  ]),
  ledger,
  budget: new BudgetGuard(
    new StaticBudgetLimits([{ scope: "tenant", scopeId: "live", limitCents: CAP_CENTS, period: "month" }]),
    ledger,
  ),
});

const started = Date.now();
const result = await runAnalysis(
  {
    caller,
    prompts: new ShippedPromptSource(),
    logger: {
      warn: (m, c) => {
        console.warn("warn:", m, JSON.stringify(c ?? {}).slice(0, 200));
      },
      info: () => undefined,
    },
  },
  {
    companyId: "live",
    campaignId: "scale",
    campaignName: "Scale check",
    facts,
    participation: { invited: 100, completed: 80, sessionsAnalyzed: 80 },
    thresholdMet: true,
    k: 3,
    weights: WEIGHT_PRESETS.balanced,
    similarityThreshold: 0.5,
    language: "en",
    sections: ["executive_summary", "participation", "opportunities"],
    overrides: {},
  },
);
const elapsed = (Date.now() - started) / 1000;
const covered = new Set(result.clusters.flatMap((c) => c.factIds));
const sizes = result.clusters.map((c) => c.factIds.length).sort((a, b) => b - a);
const byStatus: Record<string, number> = {};
let cents = 0;
for (const e of ledger.entries) {
  const k = `${e.purpose}/${e.status}`;
  byStatus[k] = (byStatus[k] ?? 0) + 1;
  cents += e.costCents;
}
console.log(
  JSON.stringify(
    {
      model: MODEL,
      baseFacts: base.length,
      facts: facts.length,
      covered: covered.size,
      everyFactOnce:
        covered.size === facts.length && result.clusters.flatMap((c) => c.factIds).length === facts.length,
      clusters: result.clusters.length,
      largestClusters: sizes.slice(0, 8),
      singletons: sizes.filter((s) => s === 1).length,
      opportunities: result.opportunities.length,
      longTailClusters: result.stats.longTailClusters,
      opportunitiesFailed: result.stats.opportunitiesFailed,
      embedding: result.stats.embedding,
      modelCalls: ledger.entries.length,
      callsByPurposeStatus: byStatus,
      costCents: Math.round(cents * 100) / 100,
      seconds: Math.round(elapsed),
    },
    null,
    2,
  ),
);
