import {
  extractFacts,
  InterviewEngine,
  LexicalRecall,
  ShippedPromptSource,
  updateRollingSummary,
  type ContractReport,
  type EngineEvent,
  type SessionSnapshot,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import type { Fact, SessionState } from "@aidp/shared";
import { MemorySessionStore } from "@aidp/testing";
import type { Fixture } from "./fixture.js";
import {
  contractTally,
  coverageProgression,
  factRecall,
  frIdIntegrity,
  issueDetection,
  requirementCapture,
  specCompleteness,
  type RecordedRequirement,
} from "./metrics.js";
import { ReplayModel } from "./replay-model.js";

const SETTINGS = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};

export interface ReplayOutcome {
  fixtureId: string;
  turnsUsed: number;
  ended: boolean;
  state: SessionState;
  /** Flat, committed numbers: what the gate compares. */
  metrics: Record<string, number | boolean>;
  /** Detail for a failure message; never compared. */
  detail: Record<string, unknown>;
}

const asReq = (f: Fact): RecordedRequirement | undefined => {
  if (f.kind !== "spec_field" || f.section !== "functional") return undefined;
  const v = f.value as { title?: unknown; scope?: unknown } | null;
  if (!v || typeof v !== "object") return undefined;
  return {
    path: f.path,
    title: typeof v.title === "string" ? v.title : "",
    scope: v.scope === "future" ? "future" : "mvp",
  };
};

/** Runs one fixture through the real engine, extraction and rolling summary with the recorded model. */
export async function replayFixture(fixture: Fixture): Promise<ReplayOutcome> {
  const template = shippedTemplate(fixture.templateKey);
  if (!template) throw new Error(`unknown template ${fixture.templateKey}`);
  const store = new MemorySessionStore();
  const model = new ReplayModel(fixture, template);
  const prompts = new ShippedPromptSource();
  const logger = { warn: () => undefined, info: () => undefined };
  const engine = new InterviewEngine({
    caller: model,
    store,
    prompts,
    recall: new LexicalRecall(store, 10),
    logger,
  });
  const snapshot = (): SessionSnapshot => ({
    id: "eval",
    companyId: "c",
    template,
    state: store.state,
    summary: store.summary,
    ...(fixture.path ? { path: fixture.path } : {}),
  });

  const coverageCurve: number[] = [];
  const contracts: ContractReport[] = [];
  const turn = async (answer?: string): Promise<boolean> => {
    const gen = engine.nextTurn(
      snapshot(),
      answer ? { content: answer, modality: "text" } : undefined,
      SETTINGS,
    );
    let r = await gen.next();
    while (!r.done) {
      const ev: EngineEvent = r.value;
      ev;
      r = await gen.next();
    }
    const result = r.value;
    if (result.contract) contracts.push(result.contract);
    coverageCurve.push(Object.values(store.state.coverage).filter((c) => c.status === "covered").length);
    // The worker's follow-ups, run inline.
    if (result.followUps.extract) await extractFacts({ caller: model, store, prompts }, snapshot());
    if (result.followUps.summarize)
      await updateRollingSummary({ caller: model, store, prompts }, snapshot(), SETTINGS.recentWindowTurns);
    return result.ended;
  };

  let ended = await turn();
  let used = 1;
  for (const t of fixture.turns) {
    if (ended) break;
    ended = await turn(t.text);
    used += 1;
  }

  const state = store.state;
  const requirements = state.facts.map(asReq).filter((r): r is RecordedRequirement => r !== undefined);
  const rules = state.facts.flatMap((f) =>
    f.kind === "spec_field" && f.section === "rules" ? [JSON.stringify(f.value)] : [],
  );
  const capture = requirementCapture(fixture.goldRequirements, requirements, rules);
  const integrity = frIdIntegrity(requirements.map((r) => r.path));
  const coverage = coverageProgression(coverageCurve, fixture.expect.coverage);
  const specFacts = state.facts.flatMap((f) => (f.kind === "spec_field" ? [f] : []));
  const filledSections = [...new Set(specFacts.map((f) => f.section))];
  const reqValues = specFacts.flatMap((f) => {
    if (
      f.section !== "functional" ||
      typeof f.value !== "object" ||
      f.value === null ||
      Array.isArray(f.value)
    )
      return [];
    const v = f.value as { acceptance?: unknown; scope?: unknown };
    return [
      {
        acceptance: Array.isArray(v.acceptance) ? v.acceptance.map(String) : [],
        scope: String(v.scope ?? ""),
      },
    ];
  });
  const completeness = specCompleteness({
    filledSections,
    requiredSections: template.completeness.requiredSections,
    requirements: reqValues,
    minRequirements: template.completeness.minRequirements,
  });
  const recentWindow = store.messages
    .slice(-SETTINGS.recentWindowTurns * 2)
    .map((m) => m.content)
    .join("\n");
  const recall = factRecall(fixture.goldFacts, {
    facts: state.facts,
    summary: store.summary,
    window: recentWindow,
  });
  const issues = issueDetection(state.findings, fixture.goldFindings);
  const tally = contractTally(
    contracts.map((c) => ({ markerMissed: c.markerMissed, outcome: c.outcome, repairCalls: c.repairCalls })),
  );

  const isReq = fixture.templateKey === "requirements_discovery";
  const metrics: Record<string, number | boolean> = {
    ended,
    turnsUsed: used,
    coveragePass: coverage.pass,
    coveredAreas: coverageCurve.at(-1) ?? 0,
    contractTurns: tally.turns,
    markerMissRate: tally.markerMissRate,
    contractFailureRate: tally.failureRate,
    repairCalls: tally.repairCalls,
    ...(fixture.goldFacts.length ? { factRecall: recall.rate } : {}),
    ...(isReq
      ? {
          requirementCapture: capture.rate,
          requirementsRecorded: capture.recorded,
          requirementsMisfiled: capture.misfiled,
          scopeWrong: capture.scopeWrong.length,
          frIdIntegrity: integrity.ok,
          specCompleteness: completeness.score,
          issuePrecision: issues.precision,
          issueRecall: issues.recall,
        }
      : {}),
  };
  return {
    fixtureId: fixture.id,
    turnsUsed: used,
    ended,
    state,
    metrics,
    detail: { coverage, capture, integrity, completeness, recall, issues, tally },
  };
}
