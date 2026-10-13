import type { Api } from "./api.js";
import { pickModel, type ListedModel, type ModelNeed } from "./pure.js";
import { listModels, log, TENANT_BUDGET_CENTS } from "./runtime.js";

export type Tier = "fast" | "structured" | "strong";

interface PurposePlan {
  purpose: string;
  tier: Tier;
  maxOutputTokens: number;
}

/** The purposes this run exercises, with the output ceiling the platform default uses. */
const PLAN: PurposePlan[] = [
  { purpose: "interview_turn", tier: "fast", maxOutputTokens: 4096 },
  { purpose: "resume_summary", tier: "structured", maxOutputTokens: 2048 },
  { purpose: "extraction", tier: "structured", maxOutputTokens: 8192 },
  { purpose: "issue_detection", tier: "structured", maxOutputTokens: 4096 },
  { purpose: "file_ingest", tier: "structured", maxOutputTokens: 4096 },
  { purpose: "vision_ingest", tier: "structured", maxOutputTokens: 4096 },
  { purpose: "clustering", tier: "strong", maxOutputTokens: 16000 },
  { purpose: "analysis_report", tier: "strong", maxOutputTokens: 8000 },
  { purpose: "spec_turn", tier: "strong", maxOutputTokens: 2048 },
  { purpose: "spec_generation", tier: "strong", maxOutputTokens: 64000 },
];

/**
 * Selection rules, in one place. Fast tier: cheapest models that are reliable at following a
 * format instruction and emitting JSON; the interviewer must also hold a warm register. Strong
 * tier: still cheap, at least 128k context, judged capable of long structured output.
 * `LIVE_MODEL_FAST`, `LIVE_MODEL_STRONG` and `LIVE_MODEL_<PURPOSE>` override.
 */
/**
 * Structured-output purposes (extraction, summaries, issue detection) use a non-reasoning model:
 * a first run with a reasoning-capable model spent its output budget on hidden reasoning and was
 * cut off at max_tokens in 74 percent of extraction calls. The product does not send a reasoning
 * control to OpenRouter, so the route's model has to be one that does not think unprompted.
 */
const STRUCTURED_NEED: ModelNeed = {
  prefer: [
    "mistralai/mistral-small-3.2-24b-instruct",
    "openai/gpt-4.1-nano",
    "qwen/qwen3-30b-a3b-instruct-2507",
  ],
  minContext: 128_000,
  maxInputPerMtok: 0.5,
  maxOutputPerMtok: 1.0,
};
const FAST_NEED: ModelNeed = {
  prefer: [
    "anthropic/claude-haiku-5.5",
    "mistralai/mistral-small-3.2-24b-instruct",
    "openai/gpt-4.1-nano",
    "google/gemini-2.5-flash-lite",
  ],
  minContext: 128_000,
  maxInputPerMtok: 0.5,
  maxOutputPerMtok: 1.0,
};
const STRONG_NEED: ModelNeed = {
  prefer: ["openai/gpt-4.1-mini", "qwen/qwen3-235b-a22b-2507", "mistralai/mistral-medium-3.1"],
  minContext: 128_000,
  maxInputPerMtok: 1.0,
  maxOutputPerMtok: 2.5,
};

export interface ChosenRoute {
  purpose: string;
  tier: Tier;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  contextLength: number;
  maxOutputTokens: number;
}

export interface Routing {
  routes: ChosenRoute[];
  simulatorModel: ListedModel;
  judgeModel: ListedModel;
  embeddingRouteConfigured: boolean;
}

function overrideFor(purpose: string, tier: Tier): string | undefined {
  return (
    process.env[`LIVE_MODEL_${purpose.toUpperCase()}`] ?? process.env[`LIVE_MODEL_${tier.toUpperCase()}`]
  );
}

export async function configureRouting(operator: Api, admin: Api): Promise<Routing> {
  const models = await listModels();
  const byId = new Map(models.map((m) => [m.id, m]));

  const providers = await operator.ok<{
    providers: { id: string; kind: string; companyId: string | null }[];
  }>("GET", "/operator/providers");
  const openrouter = providers.providers.find((p) => p.kind === "openrouter" && p.companyId === null);
  if (!openrouter) throw new Error("bootstrap did not create the platform OpenRouter provider");

  const chosen: ChosenRoute[] = [];
  for (const plan of PLAN) {
    const forced = overrideFor(plan.purpose, plan.tier);
    const need =
      plan.tier === "fast" ? FAST_NEED : plan.tier === "structured" ? STRUCTURED_NEED : STRONG_NEED;
    const model = forced ? byId.get(forced) : pickModel(models, need);
    if (!model)
      throw new Error(`no model available for ${plan.purpose}${forced ? ` (forced ${forced})` : ""}`);
    chosen.push({
      purpose: plan.purpose,
      tier: plan.tier,
      model: model.id,
      inputPerMtok: model.inputPerMtok,
      outputPerMtok: model.outputPerMtok,
      contextLength: model.contextLength,
      maxOutputTokens: Math.min(plan.maxOutputTokens, model.maxCompletionTokens ?? plan.maxOutputTokens),
    });
  }

  // Prices first: a route to a model with no price row would book every call at zero.
  const unique = new Map(chosen.map((c) => [c.model, c]));
  await operator.ok("PUT", `/operator/providers/${openrouter.id}/prices`, {
    prices: [...unique.values()].map((c) => ({
      model: c.model,
      inputPerMtok: c.inputPerMtok,
      outputPerMtok: c.outputPerMtok,
    })),
  });
  await operator.ok("PUT", "/operator/routes", {
    routes: chosen.map((c) => ({
      purpose: c.purpose,
      providerId: openrouter.id,
      model: c.model,
      maxOutputTokens: c.maxOutputTokens,
      batchAllowed: false,
    })),
  });
  log(
    `routes set: ${[...unique.values()].map((c) => `${c.model} ($${c.inputPerMtok.toFixed(3)}/$${c.outputPerMtok.toFixed(3)} per Mtok)`).join(", ")}`,
  );

  // The tenant cap goes through the product's own budget feature, as a tenant admin would set it.
  await admin.ok("POST", "/budgets", { scope: "tenant", limitCents: TENANT_BUDGET_CENTS, period: "month" });

  const effective = await admin.ok<{ routes: { purpose: string; model?: string | null }[] }>(
    "GET",
    "/routes",
  );
  const embeddingRouteConfigured = effective.routes.some(
    (r) => r.purpose === "embedding" && Boolean(r.model),
  );

  const simulatorModel = models.find(
    (m) => m.id === (process.env.LIVE_MODEL_SIMULATOR ?? "qwen/qwen3-30b-a3b-instruct-2507"),
  );
  const judgeModel = models.find((m) => m.id === (process.env.LIVE_MODEL_JUDGE ?? "openai/gpt-4.1-mini"));
  if (!simulatorModel || !judgeModel) throw new Error("simulator or judge model is not listed by OpenRouter");
  return { routes: chosen, simulatorModel, judgeModel, embeddingRouteConfigured };
}
