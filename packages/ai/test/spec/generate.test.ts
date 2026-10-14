import { SessionStateSchema, SpecDocumentSchema, type SpecDocument } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { renderBundle } from "../../src/spec/bundle.js";
import { diffSpecs, lineDiff } from "../../src/spec/diff.js";
import { generateSpec, type SpecGenerationInput } from "../../src/spec/generate.js";
import { renderSpecMarkdown } from "../../src/spec/markdown.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-09-11T10:00:00Z");

const state = SessionStateSchema.parse({
  contextAnswers: { hosting: "cloud", builder: "agent" },
  decisions: [
    { key: "auth", question: "How do users sign in?", choice: "magic link", source: "default_accepted" },
  ],
  facts: [
    { kind: "spec_field", section: "overview", path: "problem", value: "Nurses chart twice", source: "user" },
    {
      kind: "spec_field",
      section: "functional",
      path: "FR-1",
      value: { title: "Single entry", scope: "mvp", acceptance: ["one form"] },
      source: "user",
    },
    {
      kind: "spec_field",
      section: "functional",
      path: "FR-2",
      value: { title: "Excel export", scope: "future", reason: "later" },
      source: "user",
    },
  ],
  findings: [
    {
      id: "f1",
      type: "ambiguity",
      section: "nfr",
      description: "fast is undefined",
      resolution: "set p95",
      default: "1 s",
      status: "deferred",
    },
    {
      id: "f2",
      type: "contradiction",
      section: "data",
      description: "d",
      resolution: "r",
      default: "x",
      status: "resolved",
    },
  ],
});

const input: SpecGenerationInput = {
  companyId: "c",
  sessionId: "s",
  title: "Charting",
  language: "en",
  path: "nontechnical",
  state,
  summary: "They chart twice.",
  edits: { rules: { markdown: "R1. Owner rule.", editedAt: "2026-09-11T09:00:00Z", editedBy: "u" } },
  sections: [
    "overview",
    "users",
    "functional",
    "rules",
    "data",
    "phases",
    "open_questions",
    "mvp",
    "diagrams",
  ],
  diagramTypes: ["entity", "sequence"],
  bundleFormat: "claude_code",
};

const modelOutput = {
  title: "Single-entry charting",
  sections: [
    { key: "overview", markdown: "Nurses chart the same data twice." },
    { key: "users", markdown: "- Nurse\n- Ward clerk" },
    { key: "rules", markdown: "MODEL RULES (must be replaced by the owner's edit)" },
    { key: "data", markdown: "Entities: Patient, Chart." },
  ],
  requirements: [
    { id: "FR-1", title: "Single entry", scope: "mvp", acceptance: ["one form", "no re-typing"] },
    { id: "FR-2", title: "Excel export", scope: "future", acceptance: ["csv"], reason: "later" },
  ],
  phases: [
    {
      key: "p1",
      name: "Core charting",
      goals: ["FR-1 end to end"],
      tasks: [{ title: "Build the chart form (FR-1)", acceptance: ["saves once"] }],
      dependencies: [],
      acceptance: ["a nurse charts once"],
    },
    {
      key: "p2",
      name: "Exports",
      goals: ["FR-2"],
      tasks: [{ title: "Export", acceptance: ["csv downloads"] }],
      dependencies: ["p1"],
      acceptance: ["export works"],
    },
  ],
  openQuestions: [{ question: "Retention period?", defaultTaken: "5 years" }],
  mvp: { in: ["FR-1"], movedOut: [{ id: "FR-2", reason: "later" }], next: ["FR-2"] },
  diagrams: [
    { key: "er", title: "Entities", type: "entity", mermaid: "erDiagram\n  PATIENT ||--o{ CHART : has" },
    { key: "ctx", title: "Context", type: "context", mermaid: "flowchart LR\n  A-->B" },
  ],
};

describe("generateSpec", () => {
  it("assembles the document from the model, keeps owner edits authoritative, renders spec.md and the bundle", async () => {
    const caller = new ScriptedCaller([JSON.stringify(modelOutput)]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(caller.requests[0]?.purpose).toBe("spec_generation");
    expect(String(caller.requests[0]?.req.system)).toContain("entity, sequence");
    expect(String(caller.requests[0]?.req.messages[0]?.content)).toContain("R1. Owner rule.");
    expect(r.generated).toBe("model");
    expect(r.error).toBeUndefined();
    expect(r.document.title).toBe("Single-entry charting");
    expect(r.document.sections.map((s) => s.key)).toEqual(input.sections);
    const rules = r.document.sections.find((s) => s.key === "rules");
    expect(rules).toMatchObject({ source: "edited", markdown: "R1. Owner rule." });
    expect(r.document.sections.find((s) => s.key === "users")?.source).toBe("generated");
    // diagrams outside the requested types are dropped
    expect(r.document.diagrams.map((d) => d.type)).toEqual(["entity"]);
    expect(r.issues.map((f) => f.id)).toEqual(["f1"]);
    expect(r.stats).toMatchObject({
      requirements: 2,
      mvp: 1,
      future: 1,
      phases: 2,
      openFindings: 1,
      promptVersions: ["spec@2"],
      generated: "model",
    });

    expect(r.markdown).toContain("# Single-entry charting");
    expect(r.markdown).toContain("| hosting | cloud |");
    expect(r.markdown).toContain("## Business rules\n\nR1. Owner rule.");
    expect(r.markdown).not.toContain("MODEL RULES");
    expect(r.markdown).toContain("- **FR-1** Single entry");
    expect(r.markdown).toContain("  - Acceptance: no re-typing");
    expect(r.markdown).toContain("### Phase 2: Exports");
    expect(r.markdown).toContain("Retention period? _Default taken: 5 years_");
    expect(r.markdown).toContain("```mermaid\nerDiagram");
    expect(r.markdown).toContain("Moved to future scope:\n- FR-2: later");

    const paths = r.bundle.files.map((f) => f.path);
    expect(paths).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "PLAN.md",
      "tasks/phase-1.md",
      "tasks/phase-2.md",
      "diagrams/er.mmd",
      "spec.md",
      "spec.json",
    ]);
    const agents = r.bundle.files.find((f) => f.path === "AGENTS.md")?.content ?? "";
    expect(agents).toContain("context for Claude Code");
    expect(agents).toContain("R1. Owner rule.");
    expect(agents).toContain("Retention period? Default: 5 years");
    const phase1 = r.bundle.files.find((f) => f.path === "tasks/phase-1.md")?.content ?? "";
    expect(phase1).toContain("### 1.1 Build the chart form (FR-1)");
    expect(phase1).toContain("- [ ] saves once");
    expect(phase1).toContain("- **FR-1** Single entry");
    expect(JSON.parse(r.bundle.files.find((f) => f.path === "spec.json")?.content ?? "{}")).toMatchObject({
      title: "Single-entry charting",
    });
    expect(SpecDocumentSchema.parse(r.document)).toBeTruthy();
  });

  it("falls back to the live spec when the model fails, still honoring edits, and reports the error", async () => {
    const warnings: string[] = [];
    const caller = new ScriptedCaller(["{ not json"]);
    const r = await generateSpec(
      {
        caller: caller.asCaller(),
        prompts: new ShippedPromptSource(),
        logger: { warn: (m) => warnings.push(m), info: () => undefined },
        now,
      },
      input,
    );
    expect(r.generated).toBe("fallback");
    expect(r.error).toBeTruthy();
    expect(warnings).toHaveLength(1);
    expect(r.document.sections.find((s) => s.key === "rules")).toMatchObject({
      source: "edited",
      markdown: "R1. Owner rule.",
    });
    expect(r.document.sections.find((s) => s.key === "overview")).toMatchObject({ source: "fallback" });
    expect(r.document.requirements.map((q) => q.id)).toEqual(["FR-1", "FR-2"]);
    expect(r.document.mvp).toEqual({
      in: ["FR-1"],
      movedOut: [{ id: "FR-2", reason: "later" }],
      next: ["FR-2"],
    });
    expect(r.markdown).toContain("Nurses chart twice");
    expect(r.bundle.files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "PLAN.md",
      "spec.md",
      "spec.json",
    ]);
    expect(r.bundle.files.find((f) => f.path === "PLAN.md")?.content).toContain("No phases were generated");
  });

  it("bundle flavors: codex has no extra file, generic adds a README", () => {
    const doc: SpecDocument = SpecDocumentSchema.parse({ title: "T", generatedAt: "x", sections: [] });
    const md = renderSpecMarkdown(doc);
    expect(renderBundle(doc, "codex", md).files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "PLAN.md",
      "spec.md",
      "spec.json",
    ]);
    expect(renderBundle(doc, "generic", md).files[0]?.path).toBe("README.md");
    expect(renderBundle(doc, "codex", md).files[0]?.content).toContain("context for Codex");
  });
});

describe("diff", () => {
  it("produces a minimal line diff", () => {
    const d = lineDiff("a\nb\nc", "a\nc\nd");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
    expect(lineDiff("x", "x")).toEqual([{ type: "same", text: "x" }]);
  });

  it("diffs sections and requirements between two versions", () => {
    const v1 = SpecDocumentSchema.parse({
      title: "T",
      generatedAt: "1",
      sections: [
        { key: "overview", title: "Overview", markdown: "one", source: "generated" },
        { key: "rules", title: "Rules", markdown: "r", source: "generated" },
      ],
      requirements: [
        { id: "FR-1", title: "A", scope: "mvp", acceptance: [] },
        { id: "FR-2", title: "B", scope: "mvp", acceptance: [] },
      ],
    });
    const v2 = SpecDocumentSchema.parse({
      title: "T",
      generatedAt: "2",
      sections: [
        { key: "overview", title: "Overview", markdown: "one\ntwo", source: "generated" },
        { key: "users", title: "Users", markdown: "u", source: "generated" },
      ],
      requirements: [
        { id: "FR-1", title: "A", scope: "future", acceptance: [], reason: "moved" },
        { id: "FR-3", title: "C", scope: "mvp", acceptance: [] },
      ],
    });
    const d = diffSpecs(v1, v2);
    expect(d.sections.map((s) => `${s.key}:${s.change}`)).toEqual([
      "overview:changed",
      "users:added",
      "rules:removed",
    ]);
    expect(d.sections[0]?.lines).toEqual([
      { type: "same", text: "one" },
      { type: "add", text: "two" },
    ]);
    expect(d.requirements.added.map((r) => r.id)).toEqual(["FR-3"]);
    expect(d.requirements.removed.map((r) => r.id)).toEqual(["FR-2"]);
    expect(d.requirements.changed.map((c) => `${c.before.scope}>${c.after.scope}`)).toEqual(["mvp>future"]);
  });
});
