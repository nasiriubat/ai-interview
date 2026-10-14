/**
 * Live variance check of the requirements interview (D-193). Costs real money; never run by CI
 * (it is outside `src/**\/*.eval.ts`).
 *
 *   pnpm --filter @aidp/evals exec tsx live/variance.live.ts
 *
 * Runs the requirements interview N times (LIVE_RUNS, default 5) with the shipped nontechnical
 * owner persona of `scripts/live-run` as the simulated participant, the real engine, extraction,
 * rolling summary and spec generation, and the real ModelCaller and OpenRouter adapter, with an
 * in-memory store instead of the database and the API. Reports what a single live run cannot:
 * the distribution of requirement capture (recorded in the interview and written into the
 * generated specification), the parse-failure rate of the turn contract and what each run cost.
 * The two live runs of 2026-10-14 produced 6 and 8 requirements, then 1 and 1, on the same code.
 *
 * Environment (all optional):
 *   LIVE_RUNS=5               interviews
 *   LIVE_CAP_USD=1.5          hard cap on everything this script spends; runs stop starting at it
 *   LIVE_PERSONA=nontechnical | technical
 *   LIVE_MAX_TURNS=48         assistant turns per interview before the owner presses "done"
 *   LIVE_CONCURRENCY=3
 *   LIVE_MODEL_TURN           interview_turn route (default anthropic/claude-haiku-5.5)
 *   LIVE_MODEL_STRUCTURED     summary, extraction, issue detection (default mistral-small-3.2)
 *   LIVE_MODEL_STRONG         spec_generation (default openai/gpt-4.1-mini)
 *   LIVE_MODEL_SIMULATOR      the simulated owner (default qwen/qwen3-30b-a3b-instruct-2507)
 *
 * The key is read at runtime from OPENROUTER_API_KEY or the first .env above the repository, and is
 * never printed or written. Output: a markdown table on stdout and a JSON file under the OS temp dir.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetGuard,
  extractFacts,
  generateSpec,
  InMemoryLedger,
  InterviewEngine,
  LexicalRecall,
  ModelCaller,
  PriceTable,
  ProviderRegistry,
  reconcileBackgroundProgress,
  requirementFacts,
  ShippedPromptSource,
  StaticBudgetLimits,
  updateRollingSummary,
  type EngineEvent,
  type ExtractionCommit,
  type NewMessage,
  type SessionSnapshot,
  type SessionStore,
  type StoredMessage,
  type TurnResult,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import {
  SessionStateSchema,
  SPEC_SECTION_KEYS,
  type Fact,
  type ProviderConfig,
  type Route,
  type SessionState,
} from "@aidp/shared";
import { ownerSystemPrompt } from "../../scripts/live-run/src/requirements.js";
import {
  chat,
  harnessSpend,
  listModels,
  loadOpenRouterKey,
  mapLimit,
  redact,
} from "../../scripts/live-run/src/runtime.js";
import { simulateReply, simulateWidget, widgetInput } from "../../scripts/live-run/src/simulator.js";

const RUNS = Number(process.env.LIVE_RUNS ?? 5);
const CAP_USD = Number(process.env.LIVE_CAP_USD ?? 1.5);
const PERSONA = (process.env.LIVE_PERSONA ?? "nontechnical") as "nontechnical" | "technical";
const MAX_TURNS = Number(process.env.LIVE_MAX_TURNS ?? 48);
const CONCURRENCY = Number(process.env.LIVE_CONCURRENCY ?? 3);
const MODEL_TURN = process.env.LIVE_MODEL_TURN ?? "anthropic/claude-haiku-5.5";
const MODEL_STRUCTURED = process.env.LIVE_MODEL_STRUCTURED ?? "mistralai/mistral-small-3.2-24b-instruct";
const MODEL_STRONG = process.env.LIVE_MODEL_STRONG ?? "openai/gpt-4.1-mini";
const MODEL_SIM = process.env.LIVE_MODEL_SIMULATOR ?? "qwen/qwen3-30b-a3b-instruct-2507";

const IDEA =
  "Nurses on our ward type every note twice, once into the patient system and once into a spreadsheet, and we want to type it once.";
const TOPIC = "a tool that lets ward nurses enter a ward note once instead of in two systems";

const SETTINGS = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 120,
};

/** The session store of one interview, in memory (the product's is the database). */
class LiveStore implements SessionStore {
  messages: StoredMessage[] = [];
  state: SessionState = SessionStateSchema.parse({});
  summary = "";
  events: { type: string; payload: unknown }[] = [];
  async appendMessage(_id: string, m: NewMessage): Promise<StoredMessage> {
    const stored: StoredMessage = {
      ...m,
      id: `m${this.messages.length + 1}`,
      seq: this.messages.length + 1,
      createdAt: new Date(),
    };
    this.messages.push(stored);
    return stored;
  }
  async recentMessages(_id: string, limit: number): Promise<StoredMessage[]> {
    return this.messages.slice(-limit);
  }
  async messagesAfter(_id: string, seq: number): Promise<StoredMessage[]> {
    return this.messages.filter((m) => m.seq > seq);
  }
  async saveState(_id: string, state: SessionState): Promise<void> {
    this.state = reconcileBackgroundProgress(this.state, state);
  }
  async commitSummary(_id: string, summary: string, upToSeq: number): Promise<void> {
    this.summary = summary;
    this.state = { ...this.state, summaryUpToSeq: Math.max(this.state.summaryUpToSeq, upToSeq) };
  }
  async appendEvent(_id: string, type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
  }
  async commitExtraction(_id: string, c: ExtractionCommit): Promise<"committed" | "stale"> {
    if (this.state.lastExtractedSeq !== c.fromSeq) return "stale";
    this.state = {
      ...this.state,
      facts: [...this.state.facts, ...c.facts],
      lastExtractedSeq: c.toSeq,
    };
    return "committed";
  }
}

interface RunResult {
  run: number;
  turns: number;
  ended: boolean;
  endReason: string;
  recordedRequirements: number;
  recordedMvp: number;
  frIdsOk: boolean;
  rulesFacts: number;
  specFields: number;
  sectionsFilled: number;
  contractTurns: number;
  parseFailures: number;
  unrecovered: number;
  /** How the unparsed replies failed: the parser's error, counted. */
  parseErrorKinds: Record<string, number>;
  repairCalls: number;
  repaired: number;
  completenessAsks: number;
  generatedRequirements: number;
  generationFailure: string | null;
  generationFallback: boolean;
  costUsd: number;
  error?: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  const at = (i: number): number => s[i] ?? 0;
  return s.length % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
};

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
  const used = [MODEL_TURN, MODEL_STRUCTURED, MODEL_STRONG];
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
    interview_turn: route("interview_turn", MODEL_TURN, 4096),
    resume_summary: route("resume_summary", MODEL_STRUCTURED, 2048),
    extraction: route("extraction", MODEL_STRUCTURED, 8192),
    issue_detection: route("issue_detection", MODEL_STRUCTURED, 4096),
    spec_generation: route("spec_generation", MODEL_STRONG, 16000),
  };
  const ledger = new InMemoryLedger();
  const caller = new ModelCaller({
    routes: { resolve: async (_c, purpose) => routes[purpose] },
    providerConfigs: { get: async () => config },
    registry: new ProviderRegistry(),
    prices: new PriceTable(
      [...new Set(used)].map((model) => ({
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
  const shipped = shippedTemplate("requirements_discovery");
  if (!shipped) throw new Error("requirements_discovery template not found");
  const template: NonNullable<typeof shipped> = shipped;
  const prompts = new ShippedPromptSource();
  const system = ownerSystemPrompt(PERSONA, TOPIC, null);
  const sim = { apiKey, model: MODEL_SIM };

  const spent = (): number => ledger.entries.reduce((n, e) => n + e.costCents, 0) / 100 + harnessSpend.usd;
  console.warn(
    `variance: ${RUNS} runs, cap ${CAP_USD} USD, persona ${PERSONA}, turns ${MODEL_TURN}, structured ${MODEL_STRUCTURED}, strong ${MODEL_STRONG}, simulator ${MODEL_SIM}`,
  );

  async function oneRun(run: number): Promise<RunResult> {
    const sessionId = `variance-${run}`;
    const store = new LiveStore();
    /** Errors of the turns whose reply did not parse (the engine logs them before any repair). */
    const parseErrors: string[] = [];
    const logger = {
      warn: (m: string, meta?: Record<string, unknown>) => {
        if (m.startsWith("turn metadata not parsed")) parseErrors.push(String(meta?.error ?? ""));
      },
      info: () => undefined,
    };
    // As the product's create: the idea becomes an overview field and the problem area is opened.
    store.state = SessionStateSchema.parse({
      facts: [{ kind: "spec_field", section: "overview", path: "idea", value: IDEA, source: "user" }],
      coverage: {
        problem: { status: "partial", known: IDEA.slice(0, 200), missing: "confirm the problem" },
      },
    });
    const engine = new InterviewEngine({
      caller,
      store,
      prompts,
      recall: new LexicalRecall(store, SETTINGS.recentWindowTurns),
      logger,
    });
    const snapshot = (): SessionSnapshot => ({
      id: sessionId,
      companyId: "live",
      template,
      state: store.state,
      summary: store.summary,
      path: PERSONA,
    });
    const history: { role: "assistant" | "user"; content: string }[] = [];
    const contracts: NonNullable<TurnResult["contract"]>[] = [];
    let answer: Parameters<InterviewEngine["nextTurn"]>[1];
    let turns = 0;
    let ended = false;
    let endReason = "turn cap";
    let widgetOffers = 0;
    try {
      for (; turns < MAX_TURNS;) {
        if (spent() >= CAP_USD) {
          endReason = "cost cap";
          break;
        }
        const gen = engine.nextTurn(snapshot(), answer, SETTINGS);
        let message = "";
        let widget: Extract<EngineEvent, { type: "turn" }>["turn"]["widget"];
        let r = await gen.next();
        while (!r.done) {
          const ev = r.value;
          if (ev.type === "turn") {
            message = ev.turn.message;
            widget = ev.turn.widget;
          }
          r = await gen.next();
        }
        const result = r.value;
        turns += 1;
        if (result.contract) contracts.push(result.contract);
        if (result.followUps.extract) await extractFacts({ caller, store, prompts }, snapshot());
        if (result.followUps.summarize)
          await updateRollingSummary({ caller, store, prompts }, snapshot(), SETTINGS.recentWindowTurns);
        if (result.ended) {
          ended = true;
          endReason = "engine ended the session";
          break;
        }
        history.push({ role: "assistant", content: message });
        let next: Parameters<InterviewEngine["nextTurn"]>[1];
        if (widget) {
          widgetOffers += 1;
          if (widgetOffers % 2 === 1) {
            const wr = await simulateWidget(
              sim,
              system,
              history,
              // The harness declares its own widget type; the JSON is the same.
              JSON.parse(JSON.stringify(widget)) as Parameters<typeof simulateWidget>[3],
              `sim:${run}`,
            );
            if (wr) {
              const input = widgetInput(wr);
              history.push({ role: "user", content: `(I picked: ${JSON.stringify(wr)})` });
              next = { content: input.content, modality: "widget", widgetResponse: wr };
            }
          }
        }
        if (!next) {
          const text = await simulateReply(sim, system, history, `sim:${run}`);
          history.push({ role: "user", content: text });
          next = { content: text, modality: "text" };
        }
        answer = next;
      }
    } catch (e) {
      endReason = `error: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
    }

    const state = store.state;
    const reqs = requirementFacts(state);
    const specFields = state.facts.filter(
      (f): f is Extract<Fact, { kind: "spec_field" }> => f.kind === "spec_field",
    );
    // The specification the owner would get from "generate".
    let generatedRequirements = 0;
    let generationFailure: string | null = null;
    let generationFallback = false;
    // Absent on the engine before D-191, so the same script measures it.
    const minRequirements = (template as { completeness?: { minRequirements?: number } }).completeness
      ?.minRequirements;
    try {
      const gen = await generateSpec(
        { caller, prompts, logger },
        {
          companyId: "live",
          sessionId,
          title: "Ward notes",
          language: template.language,
          path: PERSONA,
          state,
          summary: store.summary,
          edits: {},
          sections: SPEC_SECTION_KEYS.filter((k) => k !== "diagrams"),
          diagramTypes: [],
          bundleFormat: "claude_code",
          ...(minRequirements !== undefined ? { minRequirements } : {}),
        },
      );
      generatedRequirements = gen.document.requirements.length;
      generationFallback = gen.generated === "fallback";
      generationFailure = gen.failure ?? null;
    } catch (e) {
      generationFailure = redact(e instanceof Error ? e.message : String(e)).slice(0, 160);
    }

    // A reply with no recoverable metadata at all (a partial one keeps its good fields). The same
    // counting serves the engine before and after D-190: the warning is logged in both.
    const noMeta = parseErrors.filter((e) => !e.startsWith("invalid metadata field")).length;
    const mine = ledger.entries.filter((e) => e.sessionId === sessionId);
    const repairsOk = mine.filter(
      (e) => e.promptVersion?.startsWith("turn_meta_repair") === true && e.status === "ok",
    ).length;
    const repairCalls = mine.filter((e) => e.promptVersion?.startsWith("turn_meta_repair") === true).length;
    const parseFailures = noMeta;
    return {
      run,
      turns,
      ended,
      endReason,
      recordedRequirements: reqs.length,
      recordedMvp: reqs.filter((f) => (f.value as { scope?: unknown }).scope !== "future").length,
      frIdsOk: reqs.every((f, i) => f.path === `FR-${i + 1}`),
      rulesFacts: specFields.filter((f) => f.section === "rules").length,
      specFields: specFields.length,
      sectionsFilled: new Set(specFields.map((f) => f.section)).size,
      contractTurns: turns,
      parseFailures,
      unrecovered: Math.max(0, noMeta - repairsOk),
      parseErrorKinds: parseErrors.reduce<Record<string, number>>((acc, e) => {
        const k = e.slice(0, 48);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      repairCalls,
      repaired: contracts.filter((c) => c.outcome === "repaired").length,
      completenessAsks: (state as { completenessAsks?: number }).completenessAsks ?? 0,
      generatedRequirements,
      generationFailure,
      generationFallback,
      costUsd: Math.round((mine.reduce((n, e) => n + e.costCents, 0) / 100) * 1000) / 1000,
    };
  }

  // Pre-flight: one cheap call, so a bad key fails here and not forty turns in.
  await chat({
    apiKey,
    model: MODEL_SIM,
    label: "preflight",
    messages: [{ role: "user", content: "ok" }],
    maxTokens: 4,
  });

  const started = Date.now();
  const results = await mapLimit(
    Array.from({ length: RUNS }, (_, i) => i + 1),
    CONCURRENCY,
    async (run) => {
      if (spent() >= CAP_USD) {
        return { run, skipped: true } as const;
      }
      const r = await oneRun(run);
      console.warn(
        `run ${run}: ${r.turns} turns, ${r.recordedRequirements} requirements recorded, ${r.generatedRequirements} in the spec, ${r.parseFailures} parse failures, ${r.endReason}`,
      );
      return r;
    },
  );
  const done = results.filter((r): r is RunResult => !("skipped" in r));
  const col = (f: (r: RunResult) => number): { min: number; median: number; max: number } => {
    const xs = done.map(f);
    return { min: Math.min(...xs), median: median(xs), max: Math.max(...xs) };
  };
  const turnsTotal = done.reduce((n, r) => n + r.contractTurns, 0);
  const parseTotal = done.reduce((n, r) => n + r.parseFailures, 0);
  const unrecoveredTotal = done.reduce((n, r) => n + r.unrecovered, 0);
  const summary = {
    model: { turn: MODEL_TURN, structured: MODEL_STRUCTURED, strong: MODEL_STRONG, simulator: MODEL_SIM },
    persona: PERSONA,
    runs: done.length,
    skippedForCost: results.length - done.length,
    recordedRequirements: col((r) => r.recordedRequirements),
    generatedRequirements: col((r) => r.generatedRequirements),
    rulesFacts: col((r) => r.rulesFacts),
    turns: col((r) => r.turns),
    parseFailureRate: turnsTotal ? Math.round((parseTotal / turnsTotal) * 1000) / 1000 : 0,
    contractFailureRate: turnsTotal ? Math.round((unrecoveredTotal / turnsTotal) * 1000) / 1000 : 0,
    parseFailures: parseTotal,
    unrecovered: unrecoveredTotal,
    turnsTotal,
    repairCalls: done.reduce((n, r) => n + r.repairCalls, 0),
    generationFailures: done.filter((r) => r.generationFailure).length,
    productUsd: Math.round((ledger.entries.reduce((n, e) => n + e.costCents, 0) / 100) * 1000) / 1000,
    harnessUsd: Math.round(harnessSpend.usd * 1000) / 1000,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
  const out = join(tmpdir(), "ai-discovery-live");
  mkdirSync(out, { recursive: true });
  const file = join(out, `variance-${Date.now()}.json`);
  writeFileSync(file, redact(JSON.stringify({ summary, runs: done }, null, 2)));
  console.log(JSON.stringify(summary, null, 2));
  const kinds: Record<string, number> = {};
  for (const r of done)
    for (const [k, n] of Object.entries(r.parseErrorKinds)) kinds[k] = (kinds[k] ?? 0) + n;
  console.log("parse errors:", JSON.stringify(kinds));
  console.log(
    "\n| run | turns | recorded | in spec | rules | parse failures | unrecovered | repairs | cost USD | end |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of done)
    console.log(
      `| ${r.run} | ${r.turns} | ${r.recordedRequirements} | ${r.generatedRequirements} | ${r.rulesFacts} | ${r.parseFailures} | ${r.unrecovered} | ${r.repairCalls} | ${r.costUsd} | ${r.endReason} |`,
    );
  console.warn(`details: ${file}`);
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
