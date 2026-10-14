import { describe, expect, it } from "vitest";
import { labelContextAnswers } from "../../src/engine/state.js";

/* Simulation 2026-10-15: the workspace showed "Hosting: onprem" and "Who builds it: team". */
describe("labelContextAnswers", () => {
  const template = {
    contextBlock: [
      {
        key: "hosting",
        question: "Where?",
        options: [
          { key: "onprem", label: "Company servers" },
          { key: "cloud", label: "Cloud account" },
        ],
      },
      { key: "budget", question: "How much?" },
    ],
  } as never;

  it("stores an option key as its label and keeps free text as written", () => {
    expect(labelContextAnswers({ hosting: "onprem", budget: "About 40k" }, template)).toEqual({
      hosting: "Company servers",
      budget: "About 40k",
    });
    expect(labelContextAnswers({ hosting: "Our own rack in Tampere" }, template)).toEqual({
      hosting: "Our own rack in Tampere",
    });
  });
});
