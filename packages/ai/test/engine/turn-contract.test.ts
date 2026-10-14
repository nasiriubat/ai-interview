import type { ChatEvent, Purpose, SessionState } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CallContext, CallRequest, ModelCallerPort } from "../../src/callModel.js";
import { InterviewEngine, type TurnResult } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { requirementFacts } from "../../src/spec/live.js";
import { MemoryStore, settings, snapshot, template } from "./helpers.js";

const logger = { warn: () => undefined, info: () => undefined };

/** What goes wrong with the reply of one turn (D-190). */
type Injection =
  | "ok"
  | "marker_missing"
  | "malformed_json"
  | "truncated"
  | "wrong_section"
  | "descriptive_id"
  | "rules_flood"
  | "no_capture";

// Eight areas with seven follow-ups each: room for 60 turns without the interview closing.
const reqTemplate = template({
  coverageAreas: Array.from({ length: 8 }, (_, i) => ({
    key: `area_${i + 1}`,
    name: `Area ${i + 1}`,
    description: "What it does.",
    doneWhen: "Listed.",
    maxFollowUps: 9,
    essential: true,
  })),
  outputs: ["spec_field"],
  completeness: { minRequirements: 0, requiredSections: [], requireAcceptance: false },
  issueDetection: { enabled: false },
});

const requirement = (n: number) => ({
  title: `Capability ${n}`,
  scope: n % 2 ? "mvp" : "future",
  acceptance: [`capability ${n} works`],
});
const truthFact = (n: number) => ({
  kind: "spec_field",
  section: "functional",
  path: `FR-${n}`,
  value: requirement(n),
  source: "user",
});

/**
 * A model that behaves as asked per turn: the reply is broken in the way the injection says, and
 * the structured repair call answers with the ground truth of that turn unless it is "down".
 */
class InjectingModel implements ModelCallerPort {
  turn = 0;
  chatCalls = 0;
  repairCalls = 0;
  constructor(private readonly plan: Injection[]) {}
  private get injection(): Injection {
    return this.plan[this.turn - 1] ?? "ok";
  }
  async *chat(_p: Purpose, _c: CallContext, _r: CallRequest): AsyncIterable<ChatEvent> {
    this.chatCalls += 1;
    this.turn += 1;
    const n = this.turn;
    const message = `Tell me about capability ${n}?`;
    const meta = (facts: unknown[]) =>
      JSON.stringify({
        areaKey: "functional",
        reason: "scripted",
        stateDelta: { coverage: { functional: { status: "partial" } }, facts },
      });
    let text: string;
    switch (this.injection) {
      case "marker_missing":
        text = message;
        break;
      case "malformed_json":
        text = `${message}\n<<<TURN_META>>>\n{"areaKey": "functional", "stateDelta": {"facts": [ {`;
        break;
      case "truncated": {
        const full = meta([truthFact(n)]);
        text = `${message}\n<<<TURN_META>>>\n${full.slice(0, Math.floor(full.length * 0.6))}`;
        break;
      }
      case "wrong_section":
        text = `${message}\n<<<TURN_META>>>\n${meta([{ ...truthFact(n), section: "rules", path: `rule-${n}` }])}`;
        break;
      case "descriptive_id":
        text = `${message}\n<<<TURN_META>>>\n${meta([{ ...truthFact(n), path: `FR-capability-${n}` }])}`;
        break;
      case "rules_flood":
        text = `${message}\n<<<TURN_META>>>\n${meta(
          Array.from({ length: 7 }, (_, i) => ({
            kind: "spec_field",
            section: "rules",
            path: `r${n}-${i}`,
            value: `The system lets a nurse do thing ${i}`,
            source: "user",
          })),
        )}`;
        break;
      case "no_capture":
        text = `${message}\n<<<TURN_META>>>\n${meta([])}`;
        break;
      default:
        text = `${message}\n<<<TURN_META>>>\n${meta([truthFact(n)])}`;
    }
    yield { type: "text", text };
    yield {
      type: "done",
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      stopReason: "end_turn",
      model: "fake",
    };
  }
  async complete<T>(_p: Purpose, _c: CallContext, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
    this.repairCalls += 1;
    expect(String(req.system)).toContain("bookkeeping of one interview turn");
    return schema.parse({
      areaKey: "functional",
      reason: "repaired",
      stateDelta: {
        coverage: { functional: { status: "partial", known: "", missing: "" } },
        facts: [truthFact(this.turn)],
      },
    });
  }
  async embed(): Promise<undefined> {
    return undefined;
  }
}

async function interview(plan: Injection[]) {
  const model = new InjectingModel(plan);
  const store = new MemoryStore();
  const engine = new InterviewEngine({
    caller: model,
    store,
    prompts: new ShippedPromptSource(),
    recall: new LexicalRecall(store, 10),
    logger,
  });
  const results: TurnResult[] = [];
  for (let i = 0; i < plan.length; i++) {
    const gen = engine.nextTurn(
      snapshot(reqTemplate, store.state),
      i === 0
        ? undefined
        : { content: `Answer ${i} with enough words to count as an answer.`, modality: "text" },
      settings,
    );
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    results.push(r.value);
  }
  return { model, store, results };
}

const idsOf = (state: SessionState): string[] =>
  requirementFacts(state)
    .map((f) => f.path)
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

describe("the turn contract (D-190): a delta is obtained and validated, or rebuilt", () => {
  it("costs nothing when the reply is whole: no extra call, every requirement filed", async () => {
    const { model, store, results } = await interview(Array<Injection>(6).fill("ok"));
    expect(model.repairCalls).toBe(0);
    expect(idsOf(store.state)).toEqual(["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6"]);
    expect(results.every((r) => r.contract?.outcome === "clean")).toBe(true);
  });

  it.each([
    ["marker_missing" as const, "no_metadata"],
    ["malformed_json" as const, "no_metadata"],
    ["truncated" as const, "no_metadata"],
  ])("rebuilds the facts of a reply that carried no usable metadata (%s)", async (injection, reason) => {
    const plan: Injection[] = ["ok", injection, "ok"];
    const { model, store, results } = await interview(plan);
    expect(model.repairCalls).toBe(1);
    // The requirement the broken turn would have filed is still there, in order, with its shape.
    expect(idsOf(store.state)).toEqual(["FR-1", "FR-2", "FR-3"]);
    expect(results[1]?.contract).toMatchObject({ outcome: "repaired", markerMissed: true });
    expect(results[1]?.contract?.reasons).toContain(reason);
    const fr2 = requirementFacts(store.state).find((f) => f.path === "FR-2");
    expect(fr2?.value).toMatchObject({ title: "Capability 2", acceptance: ["capability 2 works"] });
  });

  it("moves a requirement filed under rules into functional without a model call", async () => {
    const { model, store, results } = await interview(["ok", "wrong_section", "ok"]);
    expect(model.repairCalls).toBe(0);
    expect(idsOf(store.state)).toEqual(["FR-1", "FR-2", "FR-3"]);
    expect(store.state.facts.some((f) => f.kind === "spec_field" && f.section === "rules")).toBe(false);
    expect(results[1]?.contract?.fixed.map((f) => f.kind)).toContain("moved_to_functional");
  });

  it("renumbers a descriptive id to the next sequential one", async () => {
    const { store } = await interview(["ok", "descriptive_id", "ok"]);
    expect(idsOf(store.state)).toEqual(["FR-1", "FR-2", "FR-3"]);
  });

  it("asks for the facts again when only rules arrive and there is no requirement (the 140-rules run)", async () => {
    const { model, store, results } = await interview(["rules_flood"]);
    expect(model.repairCalls).toBe(1);
    expect(results[0]?.contract?.reasons).toContain("rules_without_requirements");
    expect(idsOf(store.state)).toEqual(["FR-1"]);
    // The pile is replaced by what the repair filed, not kept beside it.
    expect(store.state.facts.some((f) => f.kind === "spec_field" && f.section === "rules")).toBe(false);
  });

  it("asks once when an answered turn recorded no spec field at all", async () => {
    const { model, store } = await interview(["ok", "no_capture", "ok"]);
    expect(model.repairCalls).toBe(1);
    expect(idsOf(store.state)).toEqual(["FR-1", "FR-2", "FR-3"]);
  });

  it("keeps the interview going and reports a failure when the repair call is down", async () => {
    const model = new InjectingModel(["marker_missing"]);
    model.complete = () => Promise.reject(new Error("provider error"));
    const store = new MemoryStore();
    const engine = new InterviewEngine({
      caller: model,
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const gen = engine.nextTurn(snapshot(reqTemplate), undefined, settings);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(r.value.contract).toMatchObject({ outcome: "failed", markerMissed: true });
    expect(r.value.state.turnCount).toBe(1);
    expect(store.messages).toHaveLength(1);
  });

  it("measures: under 60 turns with every injection, no requirement is lost and nothing is misfiled", async () => {
    const kinds: Injection[] = [
      "ok",
      "ok",
      "marker_missing",
      "ok",
      "malformed_json",
      "ok",
      "truncated",
      "wrong_section",
      "ok",
      "descriptive_id",
      "no_capture",
      "ok",
    ];
    const plan = Array.from({ length: 60 }, (_, i) => kinds[i % kinds.length]!);
    const { model, store, results } = await interview(plan);
    const ids = idsOf(store.state);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => `FR-${i + 1}`));
    expect(store.state.facts.some((f) => f.kind === "spec_field" && f.section === "rules")).toBe(false);
    const failed = results.filter((r) => r.contract?.outcome === "failed").length;
    const missed = results.filter((r) => r.contract?.markerMissed).length;
    expect(failed).toBe(0);
    // 3 of 12 injections break the marker, 1 more is `no_capture`; the rest need no model call.
    expect(missed).toBe(15);
    expect(model.repairCalls).toBe(20);
  });
});
