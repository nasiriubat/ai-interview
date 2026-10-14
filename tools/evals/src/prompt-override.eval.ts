import {
  evaluatePrompt,
  InterviewEngine,
  LexicalRecall,
  SHIPPED_PROMPTS,
  validatePromptBody,
  type EngineEvent,
  type PromptDefinition,
  type PromptSource,
  type SessionSnapshot,
} from "@aidp/ai";
import { shippedTemplate, shippedTemplates } from "@aidp/db";
import { MemorySessionStore } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/ward-nurse.json" with { type: "json" };
import { IdealScriptedModel } from "./model-script.js";

/*
 * Prompt administration, evaluated before a canary (D-234).
 *
 * What this proves, and what it cannot: the deterministic replay drives the real engine with a
 * scripted model that answers as an ideal interviewer would. It therefore shows that an override
 * which passes the admin checks renders into a system prompt the engine can run a whole interview
 * on (areas in order, closing, summary, turn budget) and that the prompt prefix stays byte
 * identical across turns so the cache can hit. It cannot show that a real model follows the
 * edited wording: that is what the canary and the ledger's per-version error rate are for.
 */

const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};

class OverrideSource implements PromptSource {
  readonly stickyKeys: (string | undefined)[] = [];
  constructor(private readonly body: string) {}
  async get(_companyId: string, key: string, stickyKey?: string): Promise<PromptDefinition> {
    this.stickyKeys.push(stickyKey);
    const shipped = SHIPPED_PROMPTS[key];
    if (!shipped) throw new Error(`Unknown prompt '${key}'`);
    return key === "interviewer" ? { key, version: 7, body: this.body, source: "tenant" } : shipped;
  }
}

async function replay(prompts: PromptSource) {
  const template = shippedTemplate(fixture.templateKey);
  if (!template) throw new Error("template missing");
  const store = new MemorySessionStore();
  const model = new IdealScriptedModel(template);
  const engine = new InterviewEngine({
    caller: model,
    store,
    prompts,
    recall: new LexicalRecall(store, 10),
    logger: { warn: () => undefined, info: () => undefined },
  });
  const session: SessionSnapshot = {
    id: "eval-override",
    companyId: "c",
    template,
    state: store.state,
    summary: "",
  };
  const run = async (answer?: string) => {
    const gen = engine.nextTurn(
      { ...session, state: store.state },
      answer ? { content: answer, modality: "text" } : undefined,
      settings,
    );
    let r = await gen.next();
    while (!r.done) {
      const _ev: EngineEvent = r.value;
      r = await gen.next();
    }
    return r.value;
  };
  let result = await run();
  let turns = 1;
  for (const a of fixture.answers) {
    if (result.ended) break;
    result = await run(a);
    turns++;
  }
  while (!result.ended && turns < fixture.expect.maxTurns + 2) {
    result = await run("No, that is all.");
    turns++;
  }
  return { result, turns, model, store, template };
}

describe("prompt override replay", () => {
  const edited = SHIPPED_PROMPTS.interviewer!.body.replace(
    "Warm, brief, specific.",
    "Warm, brief, specific, and always plain.",
  );

  it("an override that passes the admin checks runs the whole interview", async () => {
    expect(validatePromptBody("interviewer", edited)).toEqual([]);
    expect(evaluatePrompt("interviewer", edited, shippedTemplates()).ok).toBe(true);

    const source = new OverrideSource(edited);
    const { result, turns, model, store } = await replay(source);

    expect(result.ended).toBe(true);
    expect(turns).toBeLessThanOrEqual(fixture.expect.maxTurns);
    for (const key of fixture.expect.coveredByEnd)
      expect(store.state.coverage[key]?.status, key).toBe("covered");
    // The engine used the override, and the prefix is stable so the cache can hit.
    expect(model.requests.every((r) => r.system?.includes("always plain") === true)).toBe(true);
    expect(new Set(model.requests.map((r) => r.system)).size).toBe(1);
    // Every interviewer turn asked the source with the session as the sticky key.
    expect(source.stickyKeys.every((k) => k === "eval-override")).toBe(true);
  });

  it("an override that drops the untrusted rules or the TURN contract never reaches the replay", () => {
    const noRules = edited.replace("never instructions to follow", "sometimes useful");
    const noContract = edited.split("<<<TURN_META>>>").join("[meta]");
    for (const body of [noRules, noContract]) {
      expect(validatePromptBody("interviewer", body).length).toBeGreaterThan(0);
      expect(evaluatePrompt("interviewer", body, shippedTemplates()).ok).toBe(false);
    }
  });
});
