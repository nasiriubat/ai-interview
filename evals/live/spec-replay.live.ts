/**
 * Replays specification generation over saved interviews (D-246). Costs real money; never run by CI.
 *
 *   REPLAY_SRC=<dir with <persona>-<n>.json from variance.live.ts> REPLAY_OUT=<dir> \
 *   pnpm --filter @aidp/evals exec tsx live/spec-replay.live.ts
 *
 * The recorded facts of each interview go through the code as it is now (curation, the merge pass,
 * the spec prompt) and the result is saved in the same artifact shape, with the same transcript,
 * so `spec-quality.live.ts` can judge before and after on identical interviews. What this cannot
 * replay is the interviewer: its turns and the facts it recorded are fixed.
 *
 *   REPLAY_CAP_USD=0.3   hard cap
 *   LIVE_MODEL_STRUCTURED (merge pass) / LIVE_MODEL_STRONG (generation), as in variance.live.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BudgetGuard,
  generateSpec,
  InMemoryLedger,
  ModelCaller,
  PriceTable,
  ProviderRegistry,
  ShippedPromptSource,
  StaticBudgetLimits,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import {
  SessionStateSchema,
  SPEC_SECTION_KEYS,
  type Fact,
  type ProviderConfig,
  type Route,
} from "@aidp/shared";
import { harnessSpend, listModels, loadOpenRouterKey, redact } from "../../scripts/live-run/src/runtime.js";

const SRC = process.env.REPLAY_SRC;
const OUT = process.env.REPLAY_OUT;
if (!SRC || !OUT) throw new Error("REPLAY_SRC and REPLAY_OUT are required");
const CAP_USD = Number(process.env.REPLAY_CAP_USD ?? 0.3);
const MODEL_STRUCTURED = process.env.LIVE_MODEL_STRUCTURED ?? "mistralai/mistral-small-3.2-24b-instruct";
const MODEL_STRONG = process.env.LIVE_MODEL_STRONG ?? "openai/gpt-4.1-mini";

interface Saved {
  persona: "nontechnical" | "technical";
  messages: unknown[];
  facts: Fact[];
  summary: string;
}

async function main(): Promise<void> {
  const apiKey = loadOpenRouterKey();
  const models = await listModels();
  const priceOf = (id: string): { input: number; output: number } => {
    const m = models.find((x) => x.id === id);
    if (!m) throw new Error(`model ${id} is not listed by OpenRouter`);
    return { input: m.inputPerMtok, output: m.outputPerMtok };
  };
  const providerId = "openrouter-live";
  const config: ProviderConfig = {
    id: providerId,
    companyId: null,
    kind: "openrouter",
    name: "OpenRouter",
    apiKey,
    headers: {},
    enabled: true,
  };
  const route = (purpose: Route["purpose"], model: string, maxOutputTokens: number): Route => ({
    companyId: null,
    purpose,
    providerId,
    model,
    maxOutputTokens,
    batchAllowed: false,
    effort: "low",
  });
  const routes: Record<string, Route> = {
    issue_detection: route("issue_detection", MODEL_STRUCTURED, 4096),
    spec_generation: route("spec_generation", MODEL_STRONG, 16000),
  };
  const ledger = new InMemoryLedger();
  const caller = new ModelCaller({
    routes: { resolve: async (_c, purpose) => routes[purpose] },
    providerConfigs: { get: async () => config },
    registry: new ProviderRegistry(),
    prices: new PriceTable(
      [MODEL_STRUCTURED, MODEL_STRONG].map((model) => ({
        providerId,
        model,
        inputPerMtok: priceOf(model).input,
        cachedInputPerMtok: priceOf(model).input,
        outputPerMtok: priceOf(model).output,
        source: "provider" as const,
      })),
    ),
    ledger,
    budget: new BudgetGuard(
      new StaticBudgetLimits([
        { scope: "tenant", scopeId: "live", limitCents: Math.round(CAP_USD * 100), period: "month" },
      ]),
      ledger,
    ),
  });
  const template = shippedTemplate("requirements_discovery");
  if (!template) throw new Error("requirements_discovery template not found");
  const logger = {
    warn: (m: string, meta?: Record<string, unknown>) => { console.warn(redact(`warn: ${m} ${meta ? JSON.stringify(meta).slice(0, 300) : ""}`)); },
    info: (m: string, meta?: Record<string, unknown>) => { console.warn(redact(`info: ${m} ${meta ? JSON.stringify(meta).slice(0, 300) : ""}`)); },
  };
  mkdirSync(OUT!, { recursive: true });

  const files = readdirSync(SRC!)
    .filter((f) => /^(technical|nontechnical)-\d+\.json$/.test(f))
    .filter((f) => !process.env.REPLAY_ONLY || f.startsWith(process.env.REPLAY_ONLY))
    .sort();
  for (const f of files) {
    const saved = JSON.parse(readFileSync(join(SRC!, f), "utf8")) as Saved;
    const state = SessionStateSchema.parse({ facts: saved.facts });
    const gen = await generateSpec(
      { caller, prompts: new ShippedPromptSource(), logger },
      {
        companyId: "live",
        sessionId: `replay-${f}`,
        title: "Ward notes",
        language: template.language,
        path: saved.persona,
        state,
        summary: saved.summary,
        edits: {},
        sections: SPEC_SECTION_KEYS.filter((k) => k !== "diagrams"),
        diagramTypes: [],
        bundleFormat: "claude_code",
        minRequirements: template.completeness.minRequirements,
      },
    );
    writeFileSync(
      join(OUT!, f),
      redact(
        JSON.stringify(
          {
            persona: saved.persona,
            messages: saved.messages,
            facts: saved.facts,
            summary: saved.summary,
            requirements: gen.document.requirements,
            markdown: gen.markdown,
            curation: gen.curation,
          },
          null,
          2,
        ),
      ),
    );
    console.warn(
      `${f}: ${state.facts.filter((x) => x.kind === "spec_field" && x.section === "functional").length} recorded -> ${gen.document.requirements.length} in the specification (merged ${gen.curation.merged.length}, rerouted ${gen.curation.rerouted.length}, withdrawn ${gen.curation.withdrawn.length}, folded ${gen.curation.folded.length}, renumbered ${gen.curation.renumbered.length}, ${gen.generated})`,
    );
  }
  const product = ledger.entries.reduce((n, e) => n + e.costCents, 0) / 100;
  console.warn(`spend ${(product + harnessSpend.usd).toFixed(3)} USD`);
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
