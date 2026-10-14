import {
  InterviewEngine,
  LexicalRecall,
  ShippedPromptSource,
  type EngineEvent,
  type SessionSnapshot,
  type TurnAnswer,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import { MemorySessionStore } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/controls-skip-return-finish.json" with { type: "json" };
import { IdealScriptedModel } from "./model-script.js";

const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};

/**
 * Participant controls through the whole engine (D-170, FR-12): skipping, coming back and
 * finishing change the interview's state and its next question without ever becoming a message.
 * The interviewer is scripted, so what is under test is the engine's selection and bookkeeping.
 */
describe(`engine replay: ${fixture.name}`, () => {
  it("skips, returns and finishes as state operations, with no control text in the transcript", async () => {
    const template = shippedTemplate(fixture.templateKey);
    expect(template).toBeDefined();
    if (!template) return;
    const store = new MemorySessionStore();
    const model = new IdealScriptedModel(template);
    const engine = new InterviewEngine({
      caller: model,
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger: { warn: () => undefined, info: () => undefined },
    });
    const session: SessionSnapshot = {
      id: "eval",
      companyId: "c",
      template,
      state: store.state,
      summary: "",
    };

    const focuses: { mode: string; areaKey?: string }[] = [];
    const controls: string[] = [];
    const run = async (answer?: TurnAnswer) => {
      const gen = engine.nextTurn({ ...session, state: store.state }, answer, settings);
      let r = await gen.next();
      while (!r.done) {
        const ev: EngineEvent = r.value;
        if (ev.type === "control") controls.push(ev.control.kind);
        if (ev.type === "turn")
          focuses.push({
            mode: ev.focus.mode,
            ...("areaKey" in ev.focus ? { areaKey: ev.focus.areaKey } : {}),
          });
        r = await gen.next();
      }
      return r.value;
    };

    await run();
    const skippedAt: number[] = [];
    for (const step of fixture.steps) {
      if ("control" in step) {
        await run({ control: step.control as Extract<TurnAnswer, { control: unknown }>["control"] });
        if (step.control.type === "skip_area") skippedAt.push(focuses.length);
      } else await run({ content: step.answer, modality: "text" });
    }

    expect(controls).toEqual(["skip_area", "return_area", "finish"]);
    // Only what the participant said is stored as theirs.
    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(fixture.expect.userMessages);
    expect(store.messages.map((m) => m.content).join("\n")).not.toMatch(/skip|come back|I'm done/i);
    // The skipped area is not asked while it is skipped...
    const skippedIdx = skippedAt[0] ?? 0;
    expect(focuses[skippedIdx - 1]?.areaKey).not.toBe(fixture.expect.skippedArea);
    expect(focuses[skippedIdx]?.areaKey).not.toBe(fixture.expect.skippedArea);
    // ...it is asked straight after the participant asks to come back to it...
    const returnIdx = skippedIdx + 1;
    expect(focuses[returnIdx]).toEqual({ mode: "continue", areaKey: fixture.expect.returnedArea });
    // ...and finishing makes the very next question the closing one, with the turn count intact.
    expect(focuses.at(-1)?.mode).toBe(fixture.expect.lastFocus);
    expect(store.state.finishRequested).toBe(true);
    expect(store.state.turnCount).toBe(focuses.length);
    expect(store.events.filter((e) => e.type === "control")).toHaveLength(3);
  });
});
