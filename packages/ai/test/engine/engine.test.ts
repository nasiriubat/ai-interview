import { describe, expect, it } from "vitest";
import { InterviewEngine, type EngineEvent } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template, turn } from "./helpers.js";

const logger = { warn: () => undefined, info: () => undefined };

async function run(engine: InterviewEngine, ...args: Parameters<InterviewEngine["nextTurn"]>) {
  const events: EngineEvent[] = [];
  const gen = engine.nextTurn(...args);
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return {
    events,
    result: r.value,
    text: events
      .filter((e) => e.type === "text")
      .map((e) => (e as { text: string }).text)
      .join(""),
  };
}

describe("InterviewEngine", () => {
  it("runs a first turn: stable system prompt, focus in the last user message, message persisted with widget and state", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([
      turn("Hi! To start, what is your role?", {
        areaKey: "role",
        widget: {
          type: "single_choice",
          options: [
            { key: "n", label: "Nurse" },
            { key: "a", label: "Admin" },
          ],
        },
        reason: "open role",
      }),
    ]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const { events, result, text } = await run(engine, snapshot(template()), undefined, settings);

    expect(text).toBe("Hi! To start, what is your role?\n");
    const req = caller.requests[0]!.req;
    expect(req.cachePrefix).toBe(true);
    expect(req.system).toContain("Coverage areas");
    expect(req.messages[req.messages.length - 1]!.role).toBe("user");
    expect(String(req.messages[req.messages.length - 1]!.content)).toContain('open area "role"');

    const turnEv = events.find((e) => e.type === "turn");
    expect(turnEv?.type === "turn" ? turnEv.turn.widget?.type : undefined).toBe("single_choice");
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ role: "assistant", areaKey: "role" });
    expect(result.state.turnCount).toBe(1);
    expect(result.state.coverage.role?.status).toBe("partial");
    expect(result.state.lastWidgetTurn).toBe(1);
    expect(store.events.map((e) => e.type)).toEqual(["state_delta"]);
    expect(result.ended).toBe(false);
  });

  it("carries the turn's signal into the model request", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([turn("Hello?", { areaKey: "role" })]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const ac = new AbortController();

    const gen = engine.nextTurn(snapshot(template()), undefined, settings, { signal: ac.signal });
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    expect(caller.requests[0]?.req.signal).toBe(ac.signal);
  });

  it("persists the answer before calling the model, applies deltas, and ends via closing and summary", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([
      turn("What is your role?", { areaKey: "role" }),
      turn("What does a typical day look like?", {
        areaKey: "daily",
        stateDelta: { coverage: { role: { status: "covered", known: "nurse" } }, profile: { role: "nurse" } },
      }),
      turn("What problems come up?", {
        areaKey: "problems",
        stateDelta: { coverage: { daily: { status: "covered" } } },
      }),
      turn("Which of these hurts most?", {
        areaKey: "problems",
        stateDelta: { coverage: { problems: { status: "covered" } } },
      }),
      turn("Anything I missed?", { areaKey: "closing" }),
      turn("Thank you. Here is what I captured...", { areaKey: "summary", endInterview: true }),
    ]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const t = template();
    let s = snapshot(t);
    let r = await run(engine, s, undefined, settings);
    expect(r.result.state.lastAreaKey).toBe("role");

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "I am a nurse on the ward", modality: "text" }, settings);
    expect(store.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(r.result.state.profile.role).toBe("nurse");
    expect(r.result.state.coverage.role?.status).toBe("covered");
    // the model was asked to continue on role (follow-ups left); it covered it, so the code moves on next turn
    expect(String(caller.requests[1]!.req.messages.at(-1)!.content)).toContain('stay on area "role"');

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "Rounds, charting, calls to the lab", modality: "text" }, settings);
    expect(String(caller.requests[2]!.req.messages.at(-1)!.content)).toContain('open area "daily"');

    s = { ...s, state: r.result.state };
    r = await run(
      engine,
      s,
      { content: "Late lab results and double entry into two systems", modality: "text" },
      settings,
    );
    expect(String(caller.requests[3]!.req.messages.at(-1)!.content)).toContain('open area "problems"');
    expect(r.result.state.closingAsked).toBe(false);

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "That is the main one", modality: "text" }, settings);
    expect(String(caller.requests[4]!.req.messages.at(-1)!.content)).toContain("closing question");
    expect(r.result.state.closingAsked).toBe(true);
    expect(r.result.ended).toBe(false);

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "No", modality: "text" }, settings);
    expect(r.result.ended).toBe(true);
    expect(r.events.some((e) => e.type === "ended")).toBe(true);
    expect(r.result.followUps.extract).toBe(true);
    for (const { req } of caller.requests) {
      expect(req.messages.every((m, i) => i === 0 || m.role !== req.messages[i - 1]!.role)).toBe(true);
    }
  });

  it("keeps going when the model omits the metadata", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller(["Tell me about a typical morning."]);
    const warnings: string[] = [];
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger: { warn: (m) => warnings.push(m), info: () => undefined },
    });
    const { result, text } = await run(engine, snapshot(template()), undefined, settings);
    expect(text).toBe("Tell me about a typical morning.");
    expect(store.messages[0]?.content).toBe("Tell me about a typical morning.");
    expect(warnings).toHaveLength(1);
    expect(result.state.coverage.role?.status).toBe("partial");
  });

  it("requires a path when the template asks for one", async () => {
    const store = new MemoryStore();
    const engine = new InterviewEngine({
      caller: new ScriptedCaller([]).asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    await expect(
      run(engine, snapshot(template({ pathSelection: "technical_or_not" })), undefined, settings),
    ).rejects.toThrow(/Path/);
  });
});
