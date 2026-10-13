import { SessionStateSchema, SpecDocumentSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { diffSpecs, normalizeProse } from "../../src/spec/diff.js";
import { generateSpec, type SpecGenerationInput } from "../../src/spec/generate.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-10-14T10:00:00Z");

const base = SessionStateSchema.parse({
  facts: [
    { kind: "spec_field", section: "overview", path: "problem", value: "Nurses chart twice", source: "user" },
    { kind: "spec_field", section: "users", path: "nurse", value: "Ward nurses", source: "user" },
    {
      kind: "spec_field",
      section: "functional",
      path: "FR-1",
      value: { title: "Single entry", scope: "mvp", acceptance: ["one form"] },
      source: "user",
    },
  ],
});

const input = (state = base): SpecGenerationInput => ({
  companyId: "c",
  sessionId: "s",
  title: "Charting",
  language: "en",
  state,
  summary: "",
  edits: {},
  sections: ["overview", "users", "functional"],
  diagramTypes: [],
  bundleFormat: "generic",
});

const modelAnswer = (overview: string, users: string, frTitle: string) =>
  JSON.stringify({
    title: "Charting",
    sections: [
      { key: "overview", markdown: overview },
      { key: "users", markdown: users },
    ],
    requirements: [{ id: "FR-1", title: frTitle, scope: "mvp", acceptance: ["one form"] }],
  });

async function generate(state: typeof base, answer: string) {
  const caller = new ScriptedCaller([answer]);
  return generateSpec(
    { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
    input(state),
  );
}

describe("version diff after a regeneration (live run bug 6)", () => {
  it("does not mark sections changed when only the model's wording changed", async () => {
    const v1 = await generate(
      base,
      modelAnswer("Nurses chart the same data twice.", "- Ward nurse", "Single entry"),
    );
    const v2 = await generate(
      base,
      modelAnswer("Nurses have to chart the same data twice!", "* **Ward nurse**", "Single entry."),
    );
    // The prose is different...
    expect(v1.document.sections[0]?.markdown).not.toBe(v2.document.sections[0]?.markdown);
    // ...the diff says nothing changed.
    const d = diffSpecs(v1.document, v2.document);
    expect(d.sections).toEqual([]);
    expect(d.requirements).toEqual({ added: [], removed: [], changed: [] });
  });

  it("marks only the section whose facts changed", async () => {
    const v1 = await generate(base, modelAnswer("Nurses chart twice.", "- Ward nurse", "Single entry"));
    const changed = SessionStateSchema.parse({
      ...base,
      facts: base.facts.map((f) =>
        f.kind === "spec_field" && f.section === "users" ? { ...f, value: "Ward nurses and clerks" } : f,
      ),
    });
    const v2 = await generate(
      changed,
      modelAnswer("Nurses chart the same data twice.", "- Ward nurse\n- Clerk", "Single entry"),
    );
    const d = diffSpecs(v1.document, v2.document);
    expect(d.sections.map((s) => `${s.key}:${s.change}`)).toEqual(["users:changed"]);
  });

  it("falls back to normalized prose for versions written before sections carried a basis", () => {
    const section = (markdown: string) => ({
      key: "overview",
      title: "Overview",
      markdown,
      source: "generated",
    });
    const mk = (markdown: string) =>
      SpecDocumentSchema.parse({ title: "T", generatedAt: "1", sections: [section(markdown)] });
    expect(diffSpecs(mk("Chart **twice**."), mk("chart twice")).sections).toEqual([]);
    expect(diffSpecs(mk("Chart twice."), mk("Chart once.")).sections.map((s) => s.change)).toEqual([
      "changed",
    ]);
  });

  it("normalizes case, markup, punctuation and spacing", () => {
    expect(normalizeProse("  **Single**  Entry.\n")).toBe(normalizeProse("single entry"));
  });
});
