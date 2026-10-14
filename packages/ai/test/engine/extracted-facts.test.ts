import { SessionStateSchema, type Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { addExtractedFacts, layerTurnFacts } from "../../src/engine/extracted-facts.js";
import { reconcileBackgroundProgress } from "../../src/engine/state.js";

const fr = (path: string, title: string, over: Record<string, unknown> = {}): Fact => ({
  kind: "spec_field",
  section: "functional",
  path,
  value: { title, scope: "mvp", acceptance: ["a"], ...over },
  source: "user",
});
const rules = (path: string, value: string): Fact => ({
  kind: "spec_field",
  section: "rules",
  path,
  value,
  source: "user",
});
const ids = (facts: Fact[]): string[] =>
  facts.filter((f) => f.kind === "spec_field").map((f) => (f.kind === "spec_field" ? f.path : ""));

describe("adding an extraction batch to what the session holds (D-302)", () => {
  it("does not file a requirement a second time under an id already held", () => {
    const held = [fr("FR-3", "Department manager can dispute an invoice with a reason")];
    const r = addExtractedFacts(held, [
      fr("FR-3", "Department manager can dispute an invoice with a reason", { acceptance: ["b"] }),
    ]);
    expect(ids(r.facts)).toEqual(["FR-3"]);
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it("keeps a different capability that arrived under a taken id, with the next free number", () => {
    const held = [
      fr("FR-1", "Route invoice to the department manager"),
      fr("FR-11", "Manager disputes an invoice"),
    ];
    const r = addExtractedFacts(held, [fr("FR-11", "Director approves invoices above ten thousand")]);
    expect(ids(r.facts)).toEqual(["FR-1", "FR-11", "FR-12"]);
    expect(r.renumbered).toEqual([{ from: "FR-11", to: "FR-12" }]);
    expect(r.accepted).toHaveLength(1);
  });

  it("drops a restatement of a held requirement under another id", () => {
    const held = [fr("FR-2", "Send automated alerts by email")];
    const r = addExtractedFacts(held, [fr("FR-7", "Send automated alerts by email")]);
    expect(ids(r.facts)).toEqual(["FR-2"]);
    expect(r.dropped).toBe(1);
  });

  it("appends what is new, other kinds included, and holds a non-requirement field as it is", () => {
    const task: Fact = {
      kind: "task",
      name: "Check invoices",
      frequency: "daily",
      minutesPerOccurrence: 5,
      tools: [],
      painScore: 1,
    };
    const r = addExtractedFacts(
      [rules("retention", "seven years")],
      [fr("FR-1", "Nurse enters a note once"), rules("retention", "ten years"), task],
    );
    expect(r.facts).toHaveLength(3);
    expect(r.facts.find((f) => f.kind === "spec_field" && f.section === "rules")).toMatchObject({
      value: "seven years",
    });
    expect(r.accepted).toHaveLength(2);
  });

  it("treats section spellings as one section", () => {
    const base = fr("FR-4", "Escalate overdue approvals");
    const held: Fact[] = [{ ...(base as Fact & { kind: "spec_field" }), section: "Functional Requirements" }];
    const r = addExtractedFacts(held, [fr("FR-4", "Escalate overdue approvals")]);
    expect(r.facts).toHaveLength(1);
  });
});

describe("layering a turn's facts over the stored list", () => {
  it("replaces the job's record of the same capability by the turn's", () => {
    const out = layerTurnFacts(
      [fr("FR-3", "Manager can dispute an invoice", { acceptance: ["old"] })],
      [fr("FR-3", "Manager can dispute an invoice", { acceptance: ["new"] })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ value: { acceptance: ["new"] } });
  });

  it("keeps the job's capability under a new number when the turn used its id for another", () => {
    const out = layerTurnFacts(
      [fr("FR-1", "Route invoice approval"), fr("FR-2", "Send automated alerts by email")],
      [fr("FR-2", "Controller returns an invoice with a note")],
    );
    expect(out).toHaveLength(3);
    expect(out.find((f) => f.kind === "spec_field" && f.path === "FR-2")).toMatchObject({
      value: { title: "Controller returns an invoice with a note" },
    });
    expect(out.find((f) => f.kind === "spec_field" && f.path === "FR-3")).toMatchObject({
      value: { title: "Send automated alerts by email" },
    });
  });

  it("is what a stale whole-state write-back goes through", () => {
    const stored = SessionStateSchema.parse({
      lastExtractedSeq: 24,
      facts: [fr("FR-3", "Dispute an invoice")],
    });
    const turn = SessionStateSchema.parse({
      lastExtractedSeq: 0,
      facts: [fr("FR-3", "Dispute an invoice", { acceptance: ["from the turn"] })],
    });
    const merged = reconcileBackgroundProgress(stored, turn);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0]).toMatchObject({ value: { acceptance: ["from the turn"] } });
  });
});
