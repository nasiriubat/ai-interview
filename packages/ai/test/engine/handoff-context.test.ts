import { SessionStateSchema, type Handoff, type InterviewTemplate } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { renderState } from "../../src/engine/context.js";

/**
 * A requirements interview started from an opportunity carries the discovery brief. Read as
 * "already known" it made the interviewer skip capture (simulation 2026-10-15), so the brief says
 * that none of it is a recorded requirement yet, and only where the template produces a spec.
 */

const template = (outputs: string[]): InterviewTemplate =>
  ({
    key: "t",
    version: 1,
    name: "T",
    language: "en",
    objective: "o",
    privacyMode: "identified",
    participantFields: [],
    coverageAreas: [{ key: "functional", name: "Functions", goal: "g", required: true }],
    aiInstructions: "",
    adaptivity: {},
    widgetPolicy: {},
    outputs,
    endSummary: true,
  }) as unknown as InterviewTemplate;

const handoff: Handoff = {
  sourceOpportunityId: "o1",
  problem: "Ward notes are typed twice",
  affectedUsers: ["nurses"],
  existingProcess: ["paper", "spreadsheet"],
  tools: ["Excel"],
  constraints: "",
  expectedBenefit: "",
  evidenceQuotes: [],
};

const state = SessionStateSchema.parse({});

describe("hand-off brief in the session context", () => {
  it("tells a specification interview that the brief is not the requirements list", () => {
    const text = renderState(state, template(["spec_field"]), undefined, handoff);
    expect(text).toContain("- problem: Ward notes are typed twice");
    expect(text).toContain("not the requirements list");
  });

  it("adds nothing for an interview that produces no specification", () => {
    const text = renderState(state, template(["task"]), undefined, handoff);
    expect(text).toContain("- problem: Ward notes are typed twice");
    expect(text).not.toContain("requirements list");
  });
});
