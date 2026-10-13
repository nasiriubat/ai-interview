import { SessionStateSchema, type Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { reconcileBackgroundProgress } from "../../src/engine/state.js";

const task = (name: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 5,
  tools: [],
  painScore: 1,
});
const state = (over: Parameters<typeof SessionStateSchema.parse>[0]) => SessionStateSchema.parse(over);

describe("reconcileBackgroundProgress", () => {
  it("keeps the larger cursor and the facts the background job added", () => {
    const stored = state({ lastExtractedSeq: 24, summaryUpToSeq: 10, facts: [task("a")] });
    const staleTurn = state({ lastExtractedSeq: 0, summaryUpToSeq: 0, facts: [], turnCount: 5 });

    const merged = reconcileBackgroundProgress(stored, staleTurn);

    expect(merged.lastExtractedSeq).toBe(24);
    expect(merged.summaryUpToSeq).toBe(10);
    expect(merged.facts).toEqual([task("a")]);
    expect(merged.turnCount).toBe(5);
  });

  it("keeps facts the turn added itself alongside the job's, without duplicating", () => {
    const stored = state({ lastExtractedSeq: 24, facts: [task("a")] });
    const turn = state({ lastExtractedSeq: 0, facts: [task("a"), task("spec")] });

    expect(reconcileBackgroundProgress(stored, turn).facts).toEqual([task("a"), task("spec")]);
  });

  it("leaves a document that is already current alone", () => {
    const stored = state({ lastExtractedSeq: 24, facts: [task("a")] });
    const incoming = state({ lastExtractedSeq: 24, facts: [task("a"), task("b")], turnCount: 2 });

    expect(reconcileBackgroundProgress(stored, incoming)).toEqual(incoming);
  });
});
