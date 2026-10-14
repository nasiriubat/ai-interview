import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { generateSpec, mergeRequirements, type SpecGenerationInput } from "../../src/spec/generate.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-10-14T10:00:00Z");

const fr = (n: number, extra: object = {}) => ({
  kind: "spec_field" as const,
  section: "functional",
  path: `FR-${n}`,
  value: { title: `Capability ${n}`, scope: "mvp", acceptance: [`works ${n}`], ...extra },
  source: "user" as const,
});

const inputFor = (n: number, minRequirements?: number): SpecGenerationInput => ({
  companyId: "c",
  sessionId: "s",
  title: "Charting",
  language: "en",
  path: "nontechnical",
  state: SessionStateSchema.parse({ facts: Array.from({ length: n }, (_, i) => fr(i + 1)) }),
  summary: "",
  edits: {},
  sections: ["overview", "functional"],
  diagramTypes: [],
  bundleFormat: "claude_code",
  ...(minRequirements !== undefined ? { minRequirements } : {}),
});

const model = (requirements: object[]) =>
  JSON.stringify({ title: "T", sections: [{ key: "overview", markdown: "o" }], requirements });

describe("a version never has fewer requirements than the interview recorded (D-191)", () => {
  it("keeps every recorded requirement when the model lists only one", async () => {
    const caller = new ScriptedCaller([
      model([{ id: "FR-2", title: "Better wording", scope: "mvp", acceptance: ["works 2"] }]),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      inputFor(5),
    );
    expect(r.document.requirements.map((q) => q.id)).toEqual(["FR-1", "FR-2", "FR-3", "FR-4", "FR-5"]);
    expect(r.document.requirements[1]?.title).toBe("Better wording");
    expect(r.stats.requirements).toBe(5);
  });

  it("keeps the owner's scope against a model that moves a requirement", () => {
    const merged = mergeRequirements(
      [{ id: "FR-1", title: "x", scope: "future", acceptance: [] }],
      [{ id: "FR-1", title: "x", scope: "mvp", acceptance: ["a"], reason: "core" }],
    );
    expect(merged).toEqual([{ id: "FR-1", title: "x", scope: "mvp", acceptance: ["a"], reason: "core" }]);
  });

  it("adds requirements only the model wrote, after the recorded ones", () => {
    const merged = mergeRequirements(
      [{ id: "FR-7", title: "new", scope: "mvp", acceptance: [] }],
      [{ id: "FR-1", title: "a", scope: "mvp", acceptance: [] }],
    );
    expect(merged.map((m) => m.id)).toEqual(["FR-1", "FR-7"]);
  });

  it("fails loudly with a reason when the specification would have fewer requirements than the minimum", async () => {
    const caller = new ScriptedCaller([model([{ id: "FR-1", title: "Only", scope: "mvp", acceptance: [] }])]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      inputFor(1, 3),
    );
    expect(r.failure).toMatch(/1 functional requirement; at least 3/);
    expect(r.document.requirements).toHaveLength(1);
  });

  it("fails loudly on the fallback path too, and not when the minimum is met", async () => {
    const down = new ScriptedCaller(["{ not json"]);
    const failed = await generateSpec(
      { caller: down.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      inputFor(1, 3),
    );
    expect(failed.generated).toBe("fallback");
    expect(failed.failure).toBeTruthy();
    const ok = new ScriptedCaller([model([])]);
    const fine = await generateSpec(
      { caller: ok.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      inputFor(3, 3),
    );
    expect(fine.failure).toBeUndefined();
    expect(fine.document.requirements).toHaveLength(3);
  });
});
