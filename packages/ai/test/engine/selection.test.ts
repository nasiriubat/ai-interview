import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { chooseFocus } from "../../src/engine/selection.js";
import { template } from "./helpers.js";

const t = template();
const st = (over: object) => SessionStateSchema.parse(over);
const base = { template: t, maxTurns: 60, lastAnswerMinimal: false };

describe("chooseFocus", () => {
  it("asks context questions first, in order", () => {
    const tc = template({
      contextBlock: [
        { key: "hosting", question: "Where?" },
        { key: "team", question: "Who?" },
      ],
    });
    expect(chooseFocus({ ...base, template: tc, state: st({}) })).toEqual({
      mode: "context",
      questionKey: "hosting",
    });
    expect(
      chooseFocus({ ...base, template: tc, state: st({ contextAnswers: { hosting: "cloud" } }) }),
    ).toEqual({ mode: "context", questionKey: "team" });
  });

  it("opens the first area, then stays on it while partial with follow-ups left", () => {
    expect(chooseFocus({ ...base, state: st({}) })).toEqual({ mode: "area", areaKey: "role" });
    const partial = st({ lastAreaKey: "role", coverage: { role: { status: "partial", followUpsUsed: 0 } } });
    expect(chooseFocus({ ...base, state: partial })).toEqual({ mode: "continue", areaKey: "role" });
    const exhausted = st({
      lastAreaKey: "role",
      coverage: { role: { status: "partial", followUpsUsed: 1 } },
    });
    expect(chooseFocus({ ...base, state: exhausted }).mode).not.toBe("continue");
  });

  it("does not deepen after a minimal answer; moves to a thread or the next area", () => {
    const partial = st({ lastAreaKey: "role", coverage: { role: { status: "partial", followUpsUsed: 0 } } });
    const f = chooseFocus({ ...base, state: partial, lastAnswerMinimal: true });
    expect(f).toEqual({ mode: "continue", areaKey: "role" }); // role is the next open area anyway
    const covered = st({
      lastAreaKey: "role",
      coverage: { role: { status: "covered" } },
      openThreads: [
        { id: "t1", areaKey: "daily", topic: "weekly report", priority: 4 },
        { id: "t2", areaKey: "problems", topic: "errors", priority: 5 },
      ],
    });
    expect(chooseFocus({ ...base, state: covered })).toMatchObject({ mode: "thread", threadId: "t2" });
  });

  it("skips non-essential areas when shortened and ends with closing then summary", () => {
    const shortened = st({ shortened: true, coverage: { role: { status: "covered" } } });
    expect(chooseFocus({ ...base, state: shortened })).toEqual({ mode: "area", areaKey: "problems" });
    const all = st({
      coverage: {
        role: { status: "covered" },
        daily: { status: "covered" },
        problems: { status: "skipped" },
      },
    });
    expect(chooseFocus({ ...base, state: all })).toEqual({ mode: "closing" });
    expect(chooseFocus({ ...base, state: st({ closingAsked: true }) })).toEqual({ mode: "summary" });
    expect(
      chooseFocus({ ...base, template: template({ endSummary: false }), state: st({ closingAsked: true }) }),
    ).toEqual({ mode: "done" });
  });

  it("filters areas by path and closes at max turns", () => {
    const tp = template({
      coverageAreas: [
        { key: "tech", name: "T", description: "d", doneWhen: "w", paths: ["technical"] },
        { key: "plain", name: "P", description: "d", doneWhen: "w", paths: ["nontechnical"] },
      ],
    });
    expect(chooseFocus({ ...base, template: tp, state: st({}), path: "nontechnical" })).toEqual({
      mode: "area",
      areaKey: "plain",
    });
    expect(chooseFocus({ ...base, state: st({ turnCount: 60 }) })).toEqual({ mode: "closing" });
  });
});
