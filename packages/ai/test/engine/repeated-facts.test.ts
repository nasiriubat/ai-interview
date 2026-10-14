import type { Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { dropRepeatedFacts } from "../../src/engine/extraction.js";

/*
 * Simulation 2026-10-15: a low-cost extractor re-emitted facts it had been shown as known, so one
 * interview held 37 fact rows for 22 items and the participant's summary listed tasks twice.
 */
const task = (name: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 5,
  tools: [],
  painScore: 3,
});
const pain = (description: string): Fact => ({ kind: "pain_point", description, severity: 5 });

describe("dropRepeatedFacts", () => {
  it("drops a fact already known and a repeat within the batch, by kind and normalized name", () => {
    const known = [task("Calling no-shows")];
    const out = dropRepeatedFacts(known, [
      task("calling  no-shows."),
      task("Re-keying appointments"),
      task("Re-keying appointments"),
      pain("Calling no-shows"),
    ]);
    expect(
      out.map((f) => f.kind + ":" + ("name" in f ? f.name : f.kind === "pain_point" ? f.description : "")),
    ).toEqual(["task:Re-keying appointments", "pain_point:Calling no-shows"]);
  });

  it("never drops specification fields, which are replaced by section and path elsewhere", () => {
    const spec: Fact = { kind: "spec_field", section: "rules", path: "r1", value: "x", source: "user" };
    expect(dropRepeatedFacts([spec], [spec, spec])).toHaveLength(2);
  });
});
