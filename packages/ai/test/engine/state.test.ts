import { SessionStateSchema, StateDeltaSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { admitWidget, applyDelta, isMinimalAnswer, noteUserAnswer } from "../../src/engine/state.js";
import { template } from "./helpers.js";

const t = template();
const st = (over: object) => SessionStateSchema.parse(over);
const delta = (over: object) => StateDeltaSchema.parse(over);

describe("state", () => {
  it("detects minimal answers and shortens after the threshold", () => {
    expect(isMinimalAnswer("yes")).toBe(true);
    expect(isMinimalAnswer("ok", { type: "scale", value: 3 })).toBe(false);
    expect(isMinimalAnswer("I mostly handle invoices and supplier calls")).toBe(false);
    let s = st({});
    for (let i = 0; i < 3; i++) s = noteUserAnswer(s, t, true);
    expect(s.shortened).toBe(true);
    expect(noteUserAnswer(s, t, false).profile.minimalAnswerStreak).toBe(0);
  });

  it("never regresses coverage, ignores unknown areas, counts follow-ups and moves on when exhausted", () => {
    let s = applyDelta(
      st({}),
      delta({ coverage: { role: { status: "covered", known: "nurse" }, bogus: { status: "covered" } } }),
      t,
      { mode: "area", areaKey: "role" },
    );
    expect(s.coverage.role?.status).toBe("covered");
    expect(s.coverage.bogus).toBeUndefined();
    s = applyDelta(s, delta({ coverage: { role: { status: "partial" } } }), t, {
      mode: "continue",
      areaKey: "role",
    });
    expect(s.coverage.role?.status).toBe("covered");
    // daily has maxFollowUps 2: two continues while partial force it to covered with a note
    s = applyDelta(s, delta({ coverage: { daily: { status: "partial" } } }), t, {
      mode: "area",
      areaKey: "daily",
    });
    s = applyDelta(s, delta({}), t, { mode: "continue", areaKey: "daily" });
    s = applyDelta(s, delta({}), t, { mode: "continue", areaKey: "daily" });
    expect(s.coverage.daily).toMatchObject({ status: "covered", followUpsUsed: 2 });
    expect(s.coverage.daily?.missing).toContain("moved on");
    expect(s.lastAreaKey).toBe("daily");
  });

  it("assigns thread ids, resolves the focused thread, merges decisions by key", () => {
    let s = applyDelta(
      st({}),
      delta({ newThreads: [{ areaKey: "problems", topic: "late data", priority: 4 }] }),
      t,
      { mode: "area", areaKey: "role" },
    );
    const id = s.openThreads[0]!.id;
    expect(id).toMatch(/^t/);
    s = applyDelta(s, delta({ decisions: [{ key: "k", question: "q", choice: "a", source: "user" }] }), t, {
      mode: "thread",
      areaKey: "problems",
      threadId: id,
      topic: "late data",
    });
    expect(s.openThreads[0]!.resolved).toBe(true);
    s = applyDelta(s, delta({ decisions: [{ key: "k", question: "q", choice: "b", source: "user" }] }), t, {
      mode: "area",
      areaKey: "daily",
    });
    expect(s.decisions).toEqual([{ key: "k", question: "q", choice: "b", source: "user" }]);
  });

  it("admits widgets only per policy", () => {
    const w = { type: "yes_no" as const };
    expect(admitWidget(w, st({ turnCount: 1 }), t)).toEqual(w);
    expect(admitWidget(w, st({ turnCount: 2, lastWidgetTurn: 1 }), t)).toBeUndefined(); // everyTurns 2
    expect(admitWidget(w, st({ turnCount: 3, lastWidgetTurn: 1 }), t)).toEqual(w);
    expect(
      admitWidget(
        {
          type: "ranking",
          options: [
            { key: "a", label: "A" },
            { key: "b", label: "B" },
          ],
        },
        st({ turnCount: 1 }),
        template({ widgetPolicy: { allowedTypes: ["yes_no"] } }),
      ),
    ).toBeUndefined();
  });
});
