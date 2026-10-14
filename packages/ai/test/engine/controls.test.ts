import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { applyControl, controlNote } from "../../src/engine/controls.js";
import { InterviewEngine, type EngineEvent } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { chooseFocus } from "../../src/engine/selection.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template, turn } from "./helpers.js";

const t = template();
const st = (over: object) => SessionStateSchema.parse(over);
const base = { template: t, maxTurns: 60, lastAnswerMinimal: false };

describe("chooseFocus with participant controls (D-170, FR-12)", () => {
  it("closes when finishRequested is set, whatever the turn count", () => {
    expect(chooseFocus({ ...base, state: st({ finishRequested: true, turnCount: 1 }) })).toEqual({
      mode: "closing",
    });
  });

  it("does not let the finish flag skip the summary after the closing question was asked", () => {
    expect(chooseFocus({ ...base, state: st({ finishRequested: true, closingAsked: true }) })).toEqual({
      mode: "summary",
    });
  });

  it("asks a requested area next, ahead of the template order", () => {
    const state = st({ requestedAreaKey: "problems", coverage: { role: { status: "partial" } } });
    expect(chooseFocus({ ...base, state })).toEqual({ mode: "continue", areaKey: "problems" });
  });

  it("ignores a requested area that does not apply to the path", () => {
    const tp = template({
      coverageAreas: [
        { key: "tech", name: "T", description: "d", doneWhen: "w", paths: ["technical"] },
        { key: "plain", name: "P", description: "d", doneWhen: "w", paths: ["nontechnical"] },
      ],
    });
    expect(
      chooseFocus({ ...base, template: tp, state: st({ requestedAreaKey: "tech" }), path: "nontechnical" }),
    ).toEqual({ mode: "area", areaKey: "plain" });
  });
});

describe("applyControl", () => {
  it("skips an open area and drops a pending request to return to it", () => {
    const r = applyControl(
      st({ requestedAreaKey: "daily", coverage: { daily: { status: "partial", followUpsUsed: 1 } } }),
      t,
      { type: "skip_area", areaKey: "daily" },
    );
    expect(r.applied).toBe(true);
    expect(r.state.coverage.daily?.status).toBe("skipped");
    expect(r.state.requestedAreaKey).toBeUndefined();
  });

  it("keeps a request for another area when a different one is skipped", () => {
    const r = applyControl(st({ requestedAreaKey: "problems" }), t, { type: "skip_area", areaKey: "daily" });
    expect(r.state.requestedAreaKey).toBe("problems");
  });

  it("does not throw away what an answered area already holds", () => {
    const r = applyControl(st({ coverage: { role: { status: "covered", known: "nurse" } } }), t, {
      type: "skip_area",
      areaKey: "role",
    });
    expect(r).toMatchObject({ applied: false, reason: "already_covered" });
    expect(r.state.coverage.role?.status).toBe("covered");
  });

  it("returns a skipped area as partial with its follow-ups reset, and requests it", () => {
    const r = applyControl(st({ coverage: { daily: { status: "skipped", followUpsUsed: 2 } } }), t, {
      type: "return_area",
      areaKey: "daily",
    });
    expect(r.applied).toBe(true);
    expect(r.state.coverage.daily).toMatchObject({ status: "partial", followUpsUsed: 0 });
    expect(r.state.requestedAreaKey).toBe("daily");
  });

  it("ignores an area the template does not have", () => {
    const r = applyControl(st({}), t, { type: "skip_area", areaKey: "nope" });
    expect(r).toMatchObject({ applied: false, reason: "unknown_area" });
  });

  it("sets finishRequested once and is a no-op after the closing question", () => {
    const r = applyControl(st({ turnCount: 3 }), t, { type: "finish" });
    expect(r.applied && r.state.finishRequested).toBe(true);
    expect(r.state.turnCount).toBe(3);
    expect(applyControl(st({ closingAsked: true }), t, { type: "finish" }).applied).toBe(false);
  });

  it("describes a control to the model without inventing a participant utterance", () => {
    const note = controlNote({ kind: "skip_area", areaKey: "daily", areaName: "Daily" });
    expect(note).toContain("chose to skip");
    expect(note).not.toMatch(/^Participant:/);
  });
});

const logger = { warn: () => undefined, info: () => undefined };

async function run(engine: InterviewEngine, ...args: Parameters<InterviewEngine["nextTurn"]>) {
  const events: EngineEvent[] = [];
  const gen = engine.nextTurn(...args);
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value };
}

function make(responses: string[]) {
  const store = new MemoryStore();
  const caller = new ScriptedCaller(responses);
  const engine = new InterviewEngine({
    caller: caller.asCaller(),
    store,
    prompts: new ShippedPromptSource(),
    recall: new LexicalRecall(store, 10),
    logger,
  });
  return { store, caller, engine };
}

describe("InterviewEngine controls", () => {
  it("skips an area without storing a user message and moves on", async () => {
    const { store, caller, engine } = make([turn("Understood, let's move on.", { areaKey: "problems" })]);
    const snap = snapshot(t, { coverage: { daily: { status: "partial" } }, lastAreaKey: "daily" });
    const { events, result } = await run(
      engine,
      snap,
      { control: { type: "skip_area", areaKey: "daily" } },
      settings,
    );

    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(0);
    expect(store.messages).toHaveLength(1);
    expect(result.state.coverage.daily?.status).toBe("skipped");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["control", "turn"]));
    expect(events.findIndex((e) => e.type === "control")).toBeLessThan(
      events.findIndex((e) => e.type === "turn"),
    );
    const last = caller.requests[0]!.req.messages.at(-1)!;
    expect(String(last.content)).toContain('chose to skip "Daily"');
    expect(String(last.content)).not.toContain("Let's skip");
    expect(store.events.map((e) => e.type)).toEqual(expect.arrayContaining(["control", "state_delta"]));
    expect(store.events.find((e) => e.type === "control")?.payload).toMatchObject({
      kind: "skip_area",
      areaKey: "daily",
    });
  });

  it("comes back to a skipped area, asks it once, then clears the request", async () => {
    const { store, engine } = make([
      turn("Back to daily work: what fills a typical day?", { areaKey: "daily" }),
    ]);
    const snap = snapshot(t, {
      lastAreaKey: "role",
      coverage: { role: { status: "covered" }, daily: { status: "skipped", followUpsUsed: 2 } },
    });
    const { events, result } = await run(
      engine,
      snap,
      { control: { type: "return_area", areaKey: "daily" } },
      settings,
    );
    const turnEv = events.find((e) => e.type === "turn");
    expect(turnEv?.type === "turn" ? turnEv.focus : undefined).toEqual({
      mode: "continue",
      areaKey: "daily",
    });
    expect(result.state.requestedAreaKey).toBeUndefined();
    expect(result.state.coverage.daily?.status).toBe("partial");
    expect(store.messages.every((m) => m.role === "assistant")).toBe(true);
  });

  it("finishes after one turn: closing question asked, turn count not replaced by a sentinel", async () => {
    const { store, caller, engine } = make([turn("Before we stop: anything else?", { areaKey: "closing" })]);
    const snap = snapshot(t, { turnCount: 1, lastAreaKey: "role" });
    const { events, result } = await run(engine, snap, { control: { type: "finish" } }, settings);
    const turnEv = events.find((e) => e.type === "turn");
    expect(turnEv?.type === "turn" ? turnEv.focus.mode : undefined).toBe("closing");
    expect(result.state.closingAsked).toBe(true);
    expect(result.state.finishRequested).toBe(true);
    expect(result.state.turnCount).toBe(2);
    expect(store.messages.filter((m) => m.role === "user")).toHaveLength(0);
    expect(String(caller.requests[0]!.req.messages.at(-1)!.content)).toContain("asked to end");
  });

  it("closes a session stored with the legacy sentinel", async () => {
    const { engine } = make([turn("Anything else before we stop?", { areaKey: "closing" })]);
    const snap = snapshot(t, { turnCount: 1_000_000 });
    const { events, result } = await run(engine, snap, undefined, settings);
    const turnEv = events.find((e) => e.type === "turn");
    expect(turnEv?.type === "turn" ? turnEv.focus.mode : undefined).toBe("closing");
    expect(result.state.turnCount).toBeLessThan(1000);
  });

  it("carries on from the unchanged state when a control no longer applies", async () => {
    const { store, engine } = make([turn("Tell me about your role.", { areaKey: "role" })]);
    const { events } = await run(
      engine,
      snapshot(t),
      { control: { type: "skip_area", areaKey: "ghost" } },
      settings,
    );
    expect(events.some((e) => e.type === "control")).toBe(false);
    expect(store.events.some((e) => e.type === "control")).toBe(false);
  });
});
