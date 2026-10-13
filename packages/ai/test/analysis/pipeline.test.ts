import type { Fact, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agglomerate } from "../../src/analysis/cluster.js";
import { cosine, LexicalEmbeddings } from "../../src/analysis/embeddings.js";
import { stableClusterKey } from "../../src/analysis/clustering.js";
import { clusterStats, reconcile, runAnalysis, type AnalysisFact } from "../../src/analysis/pipeline.js";
import { processMap, renderReport } from "../../src/analysis/report.js";
import type { CallRequest, ModelCaller } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";

const logger = { warn: () => undefined, info: () => undefined };
const task = (name: string, tools: string[], minutes = 30, quote?: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: minutes,
  tools,
  painScore: 6,
  ...(quote ? { quote } : {}),
});
const facts: AnalysisFact[] = [
  {
    id: "f1",
    sessionId: "s1",
    participantKey: "p1",
    role: "Nurse",
    fact: task(
      "Charting patient notes twice in two systems",
      ["Patient system", "Excel"],
      45,
      "I type everything twice",
    ),
  },
  {
    id: "f2",
    sessionId: "s2",
    participantKey: "p2",
    role: "Nurse",
    fact: task(
      "Double entry of patient notes into the ward spreadsheet and the patient system",
      ["Excel", "Patient system"],
      40,
      "same numbers in two places",
    ),
  },
  {
    id: "f3",
    sessionId: "s3",
    participantKey: "p3",
    role: "Nurse",
    fact: task("Entering charting notes again in Excel after the patient system", ["Excel"], 30),
  },
  {
    id: "f4",
    sessionId: "s1",
    participantKey: "p1",
    role: "Nurse",
    fact: {
      kind: "process",
      name: "Lab result handling",
      steps: ["Call the lab", "Wait for the result", "Type the result into the system"],
      inputs: [],
      outputs: [],
      tools: ["Phone"],
      manualSteps: ["Type the result"],
    },
  },
  {
    id: "f5",
    sessionId: "s4",
    participantKey: "p4",
    role: "Doctor",
    fact: { kind: "pain_point", description: "Staffing on night shifts is too thin", severity: 8 },
  },
];

/** Scripted structured-output model: answers by purpose and schema name. */
class ScriptedAnalysisModel {
  calls: { purpose: string; name?: string | undefined }[] = [];
  embedCalls = 0;
  constructor(private readonly failClustering = false) {}
  async embed(): Promise<undefined> {
    this.embedCalls++;
    return undefined; // no embedding route: lexical fallback
  }
  async complete<T>(
    purpose: string,
    _ctx: unknown,
    req: CallRequest,
    schema: z.ZodType<T>,
    name?: string,
  ): Promise<T> {
    this.calls.push({ purpose, name });
    if (name === "cluster_merges") {
      if (this.failClustering) throw new Error("model down");
      const content = String(req.messages[0]?.content ?? "");
      const drafts = [
        ...content.matchAll(
          /<untrusted-[0-9a-f]+ kind="draft_cluster" id="(\w+)">\n([\s\S]*?)\n<\/untrusted-/g,
        ),
      ].map((m) => ({ id: m[1] as string, text: m[2] as string }));
      const notes = drafts.filter((d) => /notes/i.test(d.text)).map((d) => d.id);
      const lab = drafts.filter((d) => /Lab result/i.test(d.text)).map((d) => d.id);
      return schema.parse({
        merges:
          notes.length >= 2
            ? [
                {
                  ids: [...notes, "bogus"],
                  name: "Double entry of patient notes",
                  summary: "Notes are typed twice.",
                },
              ]
            : [],
        names: [
          ...(notes.length === 1 && notes[0]
            ? [{ id: notes[0], name: "Double entry of patient notes", summary: "Notes are typed twice." }]
            : []),
          ...(lab[0]
            ? [{ id: lab[0], name: "Manual lab result handling", summary: "Results arrive by phone." }]
            : []),
        ],
      });
    }
    if (name === "opportunity") {
      const notAi = req.messages[0] && String(req.messages[0].content).includes("Staffing");
      return schema.parse({
        title: notAi ? "Night shift staffing" : "Single entry of patient notes",
        summary: "Summary.",
        solutionClass: notAi ? "process" : "automation",
        rationale: "Rationale.",
        factors: {
          expected_impact: { score: 4, rationale: "r" },
          affected_employees: { score: 4, rationale: "r" },
          frequency: { score: 5, rationale: "r" },
          implementation_complexity: { score: notAi ? 2 : 4, rationale: "r" },
          data_availability: { score: 4, rationale: "r" },
          risk: { score: 4, rationale: "r" },
          ai_suitability: { score: notAi ? 1 : 2, rationale: "r" },
        },
        dataNeeded: ["Patient system export"],
        risks: [],
        ...(notAi ? { whyNotAi: "This is a rota and staffing decision." } : {}),
      });
    }
    return schema.parse({
      executiveSummary: "Summary for leadership.",
      nextSteps: ["Single entry of patient notes"],
      caveats: "Small sample.",
    });
  }
  asCaller(): ModelCaller {
    return this as unknown as ModelCaller;
  }
}

const input = (over: object = {}) => ({
  companyId: "c1",
  campaignId: "camp",
  campaignName: "Ward interviews",
  facts,
  participation: { invited: 10, completed: 4, sessionsAnalyzed: 4 },
  thresholdMet: false,
  k: 3,
  weights: WEIGHT_PRESETS.balanced,
  similarityThreshold: 0.5,
  language: "en",
  sections: [
    "executive_summary",
    "participation",
    "work_map",
    "opportunities",
    "quick_wins_vs_strategic",
    "not_ai",
    "next_steps",
  ] as ReportSection[],
  overrides: {},
  ...over,
});

describe("lexical embeddings and clustering", () => {
  it("puts paraphrases of the same task closer than unrelated facts and clusters them", async () => {
    const v = await new LexicalEmbeddings().embed(
      facts.map((f) => (f.fact.kind === "task" ? f.fact.name : "x")),
    );
    expect(cosine(v[0]!, v[1]!)).toBeGreaterThan(cosine(v[0]!, v[4]!));
    const clusters = agglomerate(v, 0.08);
    const withF1 = clusters.find((c) => c.includes(0));
    expect(withF1).toContain(1);
    expect(withF1).not.toContain(4);
  });
});

describe("reconcile", () => {
  it("drops unknown ids, keeps every fact once, and gives strays their own cluster", () => {
    const r = reconcile(
      [
        { key: "a", name: "A", summary: "", factIds: ["f1", "bogus", "f1"] },
        { key: "a", name: "A2", summary: "", factIds: ["f2"] },
      ],
      facts,
    );
    expect(r.map((c) => c.key)).toEqual(["a", "a_2", "single_f3", "single_f4", "single_f5"]);
    expect(r.flatMap((c) => c.factIds).sort()).toEqual(["f1", "f2", "f3", "f4", "f5"]);
  });
});

describe("cluster stats", () => {
  it("applies k-anonymity to quotes, roles and departments and sums weekly minutes", () => {
    const three = clusterStats(facts.slice(0, 3), 3);
    expect(three.participants).toBe(3);
    expect(three.quotes).toEqual(["I type everything twice", "same numbers in two places"]);
    expect(three.roles).toEqual(["Nurse"]);
    expect(three.minutesPerWeekTotal).toBe((45 + 40 + 30) * 5);
    const two = clusterStats(facts.slice(0, 2), 3);
    expect(two.quotes).toEqual([]);
    expect(two.roles).toEqual([]);
  });
});

describe("runAnalysis", () => {
  it("clusters, generates opportunities per cluster, ranks, applies overrides, and renders the report", async () => {
    const model = new ScriptedAnalysisModel();
    const r = await runAnalysis(
      {
        caller: model.asCaller(),
        prompts: new ShippedPromptSource(),
        logger,
        now: () => new Date("2026-09-10"),
      },
      input({
        // Anchored to fact ids from an earlier run, not to a key: it must find the cluster by overlap.
        anchoredOverrides: [
          {
            factIds: ["f1", "f2"],
            override: {
              title: "Single source for patient notes",
              factors: { expected_impact: { score: 5, rationale: "admin: whole ward" } },
            },
          },
        ],
      }),
    );
    const doubleEntry = stableClusterKey(["f1", "f2", "f3"]);
    const lab = stableClusterKey(["f4"]);
    const staffingKey = stableClusterKey(["f5"]);
    expect(r.stats).toMatchObject({ facts: 5, clusters: 3, participants: 4, embedding: "lexical" });
    expect(r.clusters.map((c) => c.key).sort()).toEqual([doubleEntry, lab, staffingKey].sort());
    const top = r.opportunities[0]!;
    expect(top.clusterKey).toBe(doubleEntry);
    expect(top.title).toBe("Single source for patient notes");
    expect(top.factors.expected_impact.score).toBe(5);
    expect(top.stats.quotes).toHaveLength(2);
    expect(top.evidence.every((e) => e.anonymized)).toBe(true);
    const staffing = r.opportunities.find((o) => o.clusterKey === staffingKey)!;
    expect(staffing.solutionClass).toBe("process");
    expect(staffing.whyNotAi).toContain("rota");
    expect(r.report.markdown).toContain("# Discovery report: Ward interviews");
    expect(r.report.markdown).toContain("preliminary");
    // The process map comes from one participant, below k = 3, so it is withheld (D-143).
    expect(r.report.markdown).not.toContain("```mermaid");
    expect(r.report.markdown).toContain("Where AI is not the answer");
    expect(r.report.markdown).toContain("Night shift staffing");
    expect(model.calls.filter((c) => c.name === "opportunity")).toHaveLength(3);
    expect(r.stats.promptVersions).toEqual(["clustering@2", "opportunity@2", "report@2"]);
  });

  it("draws the process map once enough participants stand behind the cluster", async () => {
    const model = new ScriptedAnalysisModel();
    const r = await runAnalysis(
      { caller: model.asCaller(), prompts: new ShippedPromptSource(), logger },
      input({ k: 1 }),
    );
    expect(r.report.markdown).toContain("```mermaid");
  });

  it("falls back to similarity drafts when the naming pass fails", async () => {
    const model = new ScriptedAnalysisModel(true);
    const r = await runAnalysis(
      { caller: model.asCaller(), prompts: new ShippedPromptSource(), logger },
      input(),
    );
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.clusters.flatMap((c) => c.factIds).sort()).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(r.opportunities).toHaveLength(r.clusters.length);
  });
});

describe("report rendering", () => {
  it("quotes process step labels for Mermaid and respects section toggles", () => {
    expect(processMap({ name: 'Lab "results"', steps: ["Call", "Wait; type"] })).toContain('s0["Call"]');
    expect(processMap({ name: 'Lab "results"', steps: ["Call", "Wait; type"] })).toContain(
      "subgraph \"Lab 'results'\"",
    );
    const md = renderReport({
      campaignName: "X",
      generatedAt: new Date("2026-09-10"),
      participation: { invited: 1, completed: 1, sessionsAnalyzed: 1, facts: 0, thresholdMet: true },
      opportunities: [],
      narrative: { executiveSummary: "E", nextSteps: ["N"], caveats: "C" },
      sections: ["executive_summary"],
      k: 3,
      language: "en",
    });
    expect(md).toContain("## Executive summary");
    expect(md).not.toContain("## Participation");
  });
});
