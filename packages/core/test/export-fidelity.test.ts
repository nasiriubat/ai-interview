import {
  mergeDiagrams,
  renderBundle,
  renderReport,
  renderSpecMarkdown,
  type ReportInput,
  type ReportOpportunity,
} from "@aidp/ai";
import {
  FACTOR_KEYS,
  REPORT_SECTIONS,
  SpecDocumentSchema,
  type Factors,
  type SpecDocument,
} from "@aidp/shared";
import { readPdf } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import { FakeKroki, renderPdf, type PdfBrand } from "../src/exports/index.js";

/*
 * Fidelity (FR-23, FR-24, D-219): a fixed specification and a fixed report go through every export,
 * and what comes out is checked by structure: every section, requirement, phase, question,
 * diagram and table row that went in is there, in every format that is meant to carry it. Not byte
 * equality, so wording and layout may change; but an export that silently drops a section fails
 * here, which is the point.
 */

const brand: PdfBrand = {
  productName: "Ward Co",
  color: "#1f4e79",
  footerText: "",
  pageSize: "A4",
  cover: true,
};

// ---------- the specification ----------

const SECTION_TITLES: Record<string, string> = {
  overview: "Product overview and problem",
  users: "Target users and roles",
  functional: "Functional requirements",
  rules: "Business rules",
  data: "Data requirements",
  phases: "Implementation phases",
  open_questions: "Open questions",
  mvp: "MVP scope",
  diagrams: "Diagrams",
};

const SPEC: SpecDocument = SpecDocumentSchema.parse({
  title: "Ward notes",
  language: "en",
  path: "technical",
  generatedAt: "2026-10-14T09:00:00.000Z",
  context: { hosting: "EU cloud", builder: "In-house team" },
  sections: Object.entries(SECTION_TITLES).map(([key, title]) => ({
    key,
    title,
    markdown:
      key === "overview"
        ? "Nurses enter ward notes once. OVERVIEW_TEXT."
        : key === "users"
          ? "- Ward nurse\n- Charge nurse who reviews notes"
          : key === "rules"
            ? "R1. A note is locked after review. RULES_TEXT."
            : key === "data"
              ? "Entities: Patient, Note, Review. DATA_TEXT."
              : "",
    source: key === "rules" ? "edited" : "generated",
  })),
  requirements: [
    {
      id: "FR-1",
      title: "Enter a note once",
      scope: "mvp",
      acceptance: ["Saved once", "Visible in both systems"],
    },
    { id: "FR-2", title: "Review a note", scope: "mvp", acceptance: ["A charge nurse can sign off"] },
    { id: "FR-3", title: "Excel export", scope: "future", acceptance: [], reason: "Not needed for pilot" },
  ],
  phases: [
    {
      key: "p1",
      name: "Core charting",
      goals: ["FR-1 end to end"],
      tasks: [{ title: "Build the note form (FR-1)", acceptance: ["Saves once"] }],
      dependencies: [],
      acceptance: ["A nurse charts once"],
    },
    {
      key: "p2",
      name: "Review workflow",
      goals: ["FR-2"],
      tasks: [{ title: "Sign-off screen (FR-2)", acceptance: ["Sign-off is recorded"] }],
      dependencies: ["p1"],
      acceptance: ["A reviewer signs off"],
    },
  ],
  openQuestions: [{ question: "Which system is the source of truth?", defaultTaken: "The EHR" }],
  mvp: {
    in: ["FR-1", "FR-2"],
    movedOut: [{ id: "FR-3", reason: "Not needed for pilot" }],
    next: ["FR-3"],
  },
  diagrams: mergeDiagrams(
    [
      {
        key: "ctx",
        title: "System context",
        type: "context",
        mermaid: "flowchart LR\n  Nurse --> Notes\n  Notes --> EHR",
      },
      { key: "er", title: "Entities", type: "entity", mermaid: "erDiagram\n  PATIENT ||--o{ NOTE : has" },
    ],
    {
      "diagram:deploy": {
        markdown: "",
        mermaid: "flowchart TD\n  Web --> Api --> Db",
        title: "Deployment",
        description: "Where the parts run",
        editedAt: "2026-10-14T08:00:00Z",
        editedBy: "u",
      },
    },
  ),
});

describe("specification fidelity", () => {
  const markdown = renderSpecMarkdown(SPEC);

  it("the Markdown carries every section in order, every requirement, phase, question and diagram", () => {
    const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    // the document's sections, in the order they are listed, after the context block
    expect(headings).toEqual(["Context", ...Object.values(SECTION_TITLES)]);
    for (const needle of [
      "OVERVIEW_TEXT",
      "Charge nurse who reviews notes",
      "RULES_TEXT",
      "DATA_TEXT",
      "**FR-1** Enter a note once",
      "Acceptance: Visible in both systems",
      "**FR-3** Excel export",
      "Reason: Not needed for pilot",
      "### Phase 1: Core charting",
      "### Phase 2: Review workflow",
      "Depends on: p1",
      "Which system is the source of truth?",
      "Default taken: The EHR",
      "In version one:",
      "Moved to future scope:",
      "| Hosting | EU cloud |",
    ])
      expect(markdown, needle).toContain(needle);
    expect((markdown.match(/^```mermaid$/gm) ?? []).length).toBe(3);
    expect(markdown).toContain("Where the parts run");
    expect(markdown).toContain("Web --> Api --> Db");
  });

  it("the JSON and the bundle carry the same structure", () => {
    const bundle = renderBundle(SPEC, "claude_code", markdown);
    const files = Object.fromEntries(bundle.files.map((f) => [f.path, f.content]));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        "PLAN.md",
        "spec.md",
        "spec.json",
        "tasks/phase-1.md",
        "tasks/phase-2.md",
        "diagrams/ctx.mmd",
        "diagrams/er.mmd",
        "diagrams/deploy.mmd",
      ]),
    );
    const json = SpecDocumentSchema.parse(JSON.parse(files["spec.json"] ?? "{}"));
    expect(json.sections.map((s) => s.key)).toEqual(SPEC.sections.map((s) => s.key));
    expect(json.requirements.map((r) => r.id)).toEqual(["FR-1", "FR-2", "FR-3"]);
    expect(json.phases.map((p) => p.name)).toEqual(["Core charting", "Review workflow"]);
    expect(json.diagrams.map((d) => d.key)).toEqual(["ctx", "er", "deploy"]);
    expect(files["spec.md"]).toBe(markdown);
    expect(files["PLAN.md"]).toContain("Core charting");
    expect(files["PLAN.md"]).toContain("Review workflow");
    expect(files["tasks/phase-2.md"]).toContain("Sign-off screen (FR-2)");
    expect(files["AGENTS.md"]).toContain("RULES_TEXT");
    expect(files["diagrams/deploy.mmd"]).toContain("Where the parts run");
  });

  it("the PDF has every heading in its contents, every requirement and phase, and every diagram drawn", async () => {
    const kroki = new FakeKroki();
    const r = await renderPdf({
      title: SPEC.title,
      markdown,
      language: "en",
      versionLabel: "Version 3",
      date: new Date("2026-10-14T10:00:00Z"),
      brand,
      kroki,
    });
    expect(r.warnings).toEqual([]);
    const pdf = await readPdf(r.bytes);
    const body = pdf.pages.slice(1).join("\n");

    // contents: one entry per section, with a page number each
    const contents = body.slice(body.indexOf("Contents"));
    for (const title of Object.values(SECTION_TITLES))
      expect(contents, `contents: ${title}`).toContain(title);

    for (const needle of [
      "OVERVIEW_TEXT",
      "Charge nurse who reviews notes",
      "RULES_TEXT",
      "DATA_TEXT",
      "FR-1",
      "Enter a note once",
      "Visible in both systems",
      "FR-3",
      "Not needed for pilot",
      "Phase 1: Core charting",
      "Phase 2: Review workflow",
      "Which system is the source of truth?",
      "The EHR",
      "Moved to future scope:",
      "EU cloud",
      "Where the parts run",
    ])
      expect(body, needle).toContain(needle);

    // the three diagrams are pictures, and the renderer was asked for each source
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(3); // the entity diagram is shown once, under Data
    const asked = kroki.calls.map((c) => c.source).join("\n");
    for (const marker of ["Nurse --> Notes", "PATIENT ||--o{ NOTE", "Web --> Api --> Db"])
      expect(asked, marker).toContain(marker);
    // and none of it is printed twice as source
    expect(body).not.toContain("erDiagram");
  });

  it("a diagram the renderer cannot draw is still in the PDF, as source", async () => {
    const kroki = new FakeKroki();
    kroki.failWith = "unavailable";
    const r = await renderPdf({
      title: SPEC.title,
      markdown,
      language: "en",
      versionLabel: "Version 3",
      date: new Date("2026-10-14T10:00:00Z"),
      brand,
      kroki,
    });
    const pdf = await readPdf(r.bytes);
    expect(pdf.text).toContain("Web --> Api --> Db");
    expect(pdf.text).toContain("Nurse --> Notes");
    expect(r.warnings.length).toBe(3);
  });
});

// ---------- the analysis report ----------

const factors = (score: number): Factors =>
  Object.fromEntries(FACTOR_KEYS.map((k) => [k, { score, rationale: "r" }])) as Factors;

const opportunity = (
  over: Partial<ReportOpportunity> & Pick<ReportOpportunity, "title">,
): ReportOpportunity => ({
  clusterKey: over.title,
  summary: `${over.title} summary.`,
  solutionClass: "software",
  rankScore: 3.2,
  factors: factors(4),
  stats: {
    participants: 6,
    facts: 20,
    roles: ["Nurse"],
    departments: [],
    tools: ["Excel"],
    minutesPerWeekTotal: 600,
    quotes: [],
  },
  processes: [],
  ...over,
});

const REPORT_INPUT: ReportInput = {
  campaignName: "Ward processes",
  generatedAt: new Date("2026-10-14T00:00:00Z"),
  participation: { invited: 12, completed: 9, sessionsAnalyzed: 9, facts: 187, thresholdMet: true },
  opportunities: [
    opportunity({
      title: "Single-entry charting",
      solutionClass: "software",
      rankScore: 4.5,
      stats: {
        participants: 7,
        facts: 40,
        roles: ["Nurse"],
        departments: [],
        tools: ["Excel", "EHR"],
        minutesPerWeekTotal: 1200,
        quotes: ["I type the same vitals twice"],
      },
      processes: [
        { name: "Vitals entry", steps: ["Measure", "Write on paper", "Key into EHR", "Key into ward sheet"] },
      ],
    }),
    opportunity({ title: "Automated shift handover", solutionClass: "automation", rankScore: 3.9 }),
    opportunity({
      title: "Clearer discharge checklist",
      solutionClass: "process",
      rankScore: 2.8,
      whyNotAi: "The problem is unclear ownership, not a missing tool.",
    }),
  ],
  narrative: {
    executiveSummary: "EXEC_SUMMARY_TEXT: nurses re-key the same data.",
    nextSteps: ["Pilot single-entry charting on one ward", "Agree a discharge checklist owner"],
    caveats: "CAVEATS_TEXT: durations are self-reported.",
  },
  sections: [...REPORT_SECTIONS],
  k: 5,
  language: "en",
};

describe("report fidelity", () => {
  const markdown = renderReport(REPORT_INPUT);
  const HEADINGS = [
    "Executive summary",
    "Participation and method",
    "Work map",
    "Department comparison",
    "Opportunities by solution class",
    "Quick wins and strategic bets",
    "Where AI is not the answer",
    "Recommended next steps",
  ];

  it("the Markdown has every enabled section, in the order of the section list", () => {
    const h2 = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(h2).toEqual(HEADINGS);
    expect(markdown).toContain("```mermaid");
  });

  it("a section that is switched off is absent from the Markdown and the PDF alike", async () => {
    const without = renderReport({ ...REPORT_INPUT, sections: ["executive_summary", "next_steps"] });
    expect([...without.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      "Executive summary",
      "Recommended next steps",
    ]);
    const r = await renderPdf({
      title: "",
      markdown: without,
      language: "en",
      versionLabel: "Report v1",
      date: new Date(),
      brand,
      kroki: null,
    });
    const text = (await readPdf(r.bytes)).text;
    expect(text).toContain("Executive summary");
    expect(text).not.toContain("Work map");
    expect(text).not.toContain("Opportunities by solution class");
  });

  it("the PDF has every section, the participation table, the ranked tables, quotes and the process map", async () => {
    const kroki = new FakeKroki();
    const r = await renderPdf({
      title: "",
      markdown,
      language: "en",
      versionLabel: "Report v1",
      date: new Date("2026-10-14T10:00:00Z"),
      brand,
      kroki,
    });
    expect(r.warnings).toEqual([]);
    const pdf = await readPdf(r.bytes);
    expect(pdf.title).toBe("Discovery report: Ward processes");
    const contents = pdf.text.slice(pdf.text.indexOf("Contents"));
    for (const h of HEADINGS) expect(contents, `contents: ${h}`).toContain(h);

    for (const needle of [
      "EXEC_SUMMARY_TEXT",
      "CAVEATS_TEXT",
      // participation table: its header and the numbers under it
      "Invited",
      "Completed interviews",
      "187",
      // each opportunity once in the tables and once in prose
      "Single-entry charting",
      "Automated shift handover",
      "Clearer discharge checklist",
      "I type the same vitals twice",
      "The problem is unclear ownership",
      "Pilot single-entry charting on one ward",
      "Agree a discharge checklist owner",
    ])
      expect(pdf.text, needle).toContain(needle);
    // the process map is a picture and is not printed as source beside it
    expect(pdf.imagesPerPage.reduce((a, b) => a + b, 0)).toBe(1);
    expect(kroki.calls[0]?.source).toContain("Key into EHR");
    expect(pdf.text).not.toContain("flowchart LR");
  });
});
