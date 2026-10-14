import type { Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { weeklyMinutes } from "../../src/analysis/minutes.js";

const task = (name: string, minutes: number, frequency: "daily" | "weekly" = "daily"): Fact => ({
  kind: "task",
  name,
  frequency,
  minutesPerOccurrence: minutes,
  tools: [],
  painScore: 3,
});

/* Simulation 2026-10-15: repeated task facts summed to 167 hours a week for five people. */
describe("weeklyMinutes", () => {
  it("counts a person's task once, keeping the largest stated time", () => {
    const minutes = weeklyMinutes([
      { participantKey: "p1", fact: task("Calling no-shows", 60) },
      { participantKey: "p1", fact: task("calling no-shows.", 60) },
      { participantKey: "p1", fact: task("Calling no-shows", 75) },
      { participantKey: "p2", fact: task("Calling no-shows", 30) },
      { participantKey: "p2", fact: task("Month-end reconciliation", 120, "weekly") },
      { participantKey: "p2", fact: { kind: "pain_point", description: "Slow", severity: 4 } },
    ]);
    expect(minutes).toBe(75 * 5 + 30 * 5 + 120);
  });
});
