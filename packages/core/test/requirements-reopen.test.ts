import { chooseFocus } from "@aidp/ai";
import {
  COMPLETION_REQUESTED_TURN_COUNT,
  InterviewTemplateSchema,
  SessionStateSchema,
  type InterviewTemplate,
} from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { reopenedState, reopenRoom } from "../src/requirements/helpers.js";

const template: InterviewTemplate = InterviewTemplateSchema.parse({
  key: "t",
  version: 1,
  name: "T",
  objective: "o",
  privacyMode: "anonymous",
  coverageAreas: [
    {
      key: "problem",
      name: "Problem",
      description: "d",
      doneWhen: "known",
      essential: true,
      maxFollowUps: 2,
    },
  ],
  outputs: ["task"],
});

const MAX = 60;

describe("reopening a completed requirements session (live run bug 6)", () => {
  it("leaves room below the cap when the session ended by hitting it", () => {
    const state = SessionStateSchema.parse({ turnCount: MAX, closingAsked: true, phase: "done" });
    const next = reopenedState(state, 61, MAX);
    expect(next.turnCount).toBe(MAX - reopenRoom(MAX));
    expect(next.turnCount).toBeLessThan(MAX);
    expect(next.closingAsked).toBe(false);
    expect(next.phase).toBe("areas");
  });

  it("clears an 'I'm done' request instead of carrying the sentinel into the next turn", () => {
    // Both shapes: the flag written now, and the legacy sentinel the schema migrates to it.
    for (const raw of [
      { turnCount: 22, finishRequested: true, closingAsked: true },
      { turnCount: COMPLETION_REQUESTED_TURN_COUNT, lastWidgetTurn: 22, closingAsked: true },
    ]) {
      const state = SessionStateSchema.parse(raw);
      expect(state.finishRequested).toBe(true);
      const next = reopenedState(state, 22, MAX);
      expect(next.finishRequested).toBe(false);
      expect(next.turnCount).toBe(22);
      expect(next.turnCount).toBeLessThan(MAX);
    }
  });

  it("is a session that does not close on its first turn: the engine picks real work, not closing", () => {
    const finished = SessionStateSchema.parse({
      turnCount: MAX,
      closingAsked: true,
      phase: "done",
      coverage: { problem: { status: "partial", known: "k", missing: "m", followUpsUsed: 0 } },
    });
    // Before the fix a reopened state was still at the cap.
    const before = chooseFocus({
      template,
      state: { ...finished, closingAsked: false, phase: "areas" },
      maxTurns: MAX,
      lastAnswerMinimal: false,
    });
    expect(before.mode).toBe("closing");
    const after = chooseFocus({
      template,
      state: reopenedState(finished, 61, MAX),
      maxTurns: MAX,
      lastAnswerMinimal: false,
    });
    expect(after.mode).not.toBe("closing");
    expect(after.mode).not.toBe("done");
  });

  it("lets the issue scan and the MVP challenge run again for new material", () => {
    const state = SessionStateSchema.parse({
      turnCount: 55,
      lastIssueScanTurn: 50,
      finalIssueScanDone: true,
      mvpChallenge: { started: true, done: true, asked: ["FR-1"] },
    });
    const next = reopenedState(state, 55, MAX);
    expect(next.finalIssueScanDone).toBe(false);
    expect(next.mvpChallenge).toEqual({ started: true, done: false, asked: ["FR-1"] });
    expect(next.lastIssueScanTurn).toBeLessThanOrEqual(next.turnCount);
  });

  it("never raises a turn count, and scales the room with the cap within 5 to 15", () => {
    expect(reopenedState(SessionStateSchema.parse({ turnCount: 7 }), 30, MAX).turnCount).toBe(7);
    expect(reopenRoom(10)).toBe(5);
    expect(reopenRoom(60)).toBe(12);
    expect(reopenRoom(500)).toBe(15);
    // A tiny cap still yields a non-negative count.
    expect(reopenedState(SessionStateSchema.parse({ turnCount: 9 }), 9, 5).turnCount).toBe(0);
  });
});
