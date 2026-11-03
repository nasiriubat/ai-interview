import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { widgetNote } from "../../src/engine/context.js";
import { applyControl, controlNote } from "../../src/engine/controls.js";
import { InterviewEngine } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { chooseFocus, progressAreas } from "../../src/engine/selection.js";
import { admitWidget, droppedWidgetText, widgetAllowed } from "../../src/engine/state.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template, turn } from "./helpers.js";

const t = template();
const st = (over: object) => SessionStateSchema.parse(over);
const base = { template: t, maxTurns: 60, lastAnswerMinimal: false };
const logger = { warn: () => undefined, info: () => undefined };

describe("wrap up sooner (D-484)", () => {
  it("applies once, keeps going shorter, and is refused once the interview is closing", () => {
    const r = applyControl(st({}), t, { type: "wrap_up" });
    expect(r.applied).toBe(true);
    expect(r.state).toMatchObject({ wrapUp: true, shortened: true });
    expect(applyControl(r.state, t, { type: "wrap_up" }).applied).toBe(false);
    expect(applyControl(st({ closingAsked: true }), t, { type: "wrap_up" }).applied).toBe(false);
    expect(controlNote({ kind: "wrap_up" })).toContain("do not ask follow-ups");
  });

  it("asks only essential topics still untouched, with no follow-ups, then closes", () => {
    // "role" is essential and started, "daily" is not essential, "problems" is essential.
    const started = st({
      wrapUp: true,
      shortened: true,
      lastAreaKey: "role",
      coverage: { role: { status: "partial", followUpsUsed: 0 } },
    });
    expect(chooseFocus({ ...base, state: started })).toEqual({ mode: "area", areaKey: "problems" });
    const rest = st({
      wrapUp: true,
      shortened: true,
      lastAreaKey: "problems",
      coverage: { role: { status: "partial" }, problems: { status: "partial", followUpsUsed: 0 } },
    });
    expect(chooseFocus({ ...base, state: rest })).toEqual({ mode: "closing" });
  });

  it("still answers a request to come back to a topic the shortening dropped, once", () => {
    const state = st({ wrapUp: true, shortened: true, requestedAreaKey: "daily" });
    expect(chooseFocus({ ...base, state })).toEqual({ mode: "continue", areaKey: "daily" });
  });

  it("shows the dropped topics as skipped, so the count is what is left", () => {
    const state = st({ shortened: true, coverage: { role: { status: "covered" } } });
    expect(progressAreas(t, state).map((a) => [a.key, a.status])).toEqual([
      ["role", "covered"],
      ["daily", "skipped"],
      ["problems", "untouched"],
    ]);
    expect(progressAreas(t, st({})).every((a) => a.status === "untouched")).toBe(true);
  });
});

describe("widget availability (D-482)", () => {
  const choice = {
    type: "single_choice" as const,
    options: [
      { key: "d", label: "Daily" },
      { key: "w", label: "Weekly" },
    ],
  };

  it("allows a widget on every turn by default", () => {
    expect(t.widgetPolicy.everyTurns).toBe(1);
    expect(widgetAllowed(st({ lastWidgetTurn: 3 }), t, 4)).toBe(true);
  });

  it("tells the interviewer before it writes whether this turn may carry one", () => {
    const spaced = template({ widgetPolicy: { everyTurns: 3 } });
    expect(widgetNote(st({ turnCount: 3, lastWidgetTurn: 3 }), spaced)).toContain("No widget this turn");
    expect(widgetNote(st({ turnCount: 5, lastWidgetTurn: 3 }), spaced)).toContain("A widget is available");
    expect(widgetNote(st({}), t)).toContain("Use multi_choice whenever more than one answer can be true");
    expect(widgetNote(st({}), template({ widgetPolicy: { maxPerTurns: 0 } }))).toContain("Widgets are off");
  });

  it("keeps the choices of a refused widget as a list", () => {
    const spaced = template({ widgetPolicy: { everyTurns: 3 } });
    expect(admitWidget(choice, st({ turnCount: 4, lastWidgetTurn: 3 }), spaced)).toBeUndefined();
    expect(droppedWidgetText(choice)).toBe("• Daily\n• Weekly");
    expect(droppedWidgetText({ type: "yes_no" })).toBe("");
  });

  it("puts the choices of a refused widget in the stored message", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([
      turn("How often does that happen?", { areaKey: "role", widget: choice }),
    ]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const spaced = template({ widgetPolicy: { everyTurns: 3 } });
    const snap = snapshot(spaced);
    snap.state = st({ turnCount: 2, lastWidgetTurn: 2 });
    const gen = engine.nextTurn(snap, undefined, settings);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(store.messages.at(-1)).toMatchObject({
      content: "How often does that happen?\n\n• Daily\n• Weekly",
    });
    expect(store.messages.at(-1)?.widget).toBeUndefined();
  });
});
