import type { Fact, OpportunityDraft, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  applyMerges,
  commonBreakdowns,
  ensureTopCovered,
  groundDraft,
  mentionsTitle,
  runAnalysis,
  type AnalysisFact,
  type AnalysisOpportunity,
} from "../../src/analysis/pipeline.js";
import type { CallRequest, ModelCaller } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { ProviderError } from "../../src/providers/types.js";

/*
 * Grounding and point-level anonymity of the collective analysis (D-479). The clusters are given
 * as an edit-run seed so each test controls exactly which facts the opportunity pass sees.
 */

const logger = { warn: () => undefined, info: () => undefined };
const pain = (description: string, quote?: string): Fact => ({
  kind: "pain_point",
  description,
  severity: 7,
  ...(quote ? { quote } : {}),
});
const task = (name: string, tools: string[], quote?: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 20,
  tools,
  painScore: 6,
  ...(quote ? { quote } : {}),
});
const fact = (id: string, person: string, f: Fact, role?: string): AnalysisFact => ({
  id,
  sessionId: `s_${person}`,
  participantKey: person,
  ...(role ? { role } : {}),
  department: "Finance",
  fact: f,
});

const factors = (score = 4): OpportunityDraft["factors"] =>
  Object.fromEntries(
    [
      "expected_impact",
      "affected_employees",
      "frequency",
      "implementation_complexity",
      "data_availability",
      "risk",
      "ai_suitability",
    ].map((k) => [k, { score, rationale: "r" }]),
  ) as OpportunityDraft["factors"];

const draft = (over: Partial<OpportunityDraft> = {}): OpportunityDraft => ({
  title: "Item",
  summary: "Summary.",
  solutionClass: "automation",
  rationale: "Rationale.",
  factors: factors(),
  dataNeeded: [],
  risks: [],
  ...over,
});

/** Answers the opportunity pass per cluster (by the cluster name in the prompt) and the narrative. */
class GroundingModel {
  calls: { name?: string | undefined; content: string }[] = [];
  constructor(
    private readonly byCluster: Record<string, OpportunityDraft | (() => OpportunityDraft)>,
    private readonly story = { executiveSummary: "Summary.", nextSteps: ["Step."], caveats: "Caveat." },
  ) {}
  async embed(): Promise<undefined> {
    return undefined;
  }
  async complete<T>(
    _purpose: string,
    _ctx: unknown,
    req: CallRequest,
    schema: z.ZodType<T>,
    name?: string,
  ): Promise<T> {
    const content = String(req.messages[0]?.content ?? "");
    this.calls.push({ name, content });
    if (name === "opportunity") {
      const cluster = /^Cluster: (.+)$/m.exec(content)?.[1] ?? "";
      const answer = this.byCluster[cluster];
      if (!answer) throw new Error(`no scripted answer for ${cluster}`);
      return schema.parse(typeof answer === "function" ? answer() : answer);
    }
    return schema.parse(this.story);
  }
  asCaller(): ModelCaller {
    return this as unknown as ModelCaller;
  }
  narrativeInput(): string {
    return this.calls.find((c) => c.name === "narrative")?.content ?? "";
  }
}

const SECTIONS: ReportSection[] = [
  "executive_summary",
  "participation",
  "work_map",
  "opportunities",
  "not_ai",
  "next_steps",
];

function run(
  model: GroundingModel,
  facts: AnalysisFact[],
  clusters: { key: string; name: string; factIds: string[] }[],
  over: object = {},
) {
  const transcripts = new Map<string, string[]>();
  for (const f of facts) {
    const quote = "quote" in f.fact ? f.fact.quote : undefined;
    if (quote)
      transcripts.set(f.sessionId, [...(transcripts.get(f.sessionId) ?? []), `Well, ${quote}, honestly.`]);
  }
  return runAnalysis(
    {
      caller: model.asCaller(),
      prompts: new ShippedPromptSource(),
      logger,
      now: () => new Date("2026-10-21"),
    },
    {
      companyId: "c1",
      campaignId: "camp",
      campaignName: "Bench",
      facts,
      participation: { invited: 0, completed: 6, sessionsAnalyzed: 6 },
      thresholdMet: true,
      transcripts,
      k: 3,
      weights: WEIGHT_PRESETS.balanced,
      similarityThreshold: 0.5,
      language: "en",
      sections: SECTIONS,
      overrides: {},
      seed: { clusters: clusters.map((c) => ({ ...c, summary: "" })), reuse: new Map() },
      ...over,
    },
  );
}

describe("counts come from the facts that support an item (D-479)", () => {
  it("counts only the supporting facts' people and keeps every member for edits", async () => {
    const facts = [
      fact("a1", "p1", pain("Invoices typed again into the ledger")),
      fact("a2", "p2", pain("Delivery data re-keyed into billing")),
      fact("a3", "p3", pain("Order emails copied by hand into the TMS")),
      fact("a4", "p4", pain("The canteen closes too early")),
    ];
    const model = new GroundingModel({ Rekeying: draft({ title: "Re-keying", supportingFacts: [1, 2, 3] }) });
    const r = await run(model, facts, [{ key: "k1", name: "Rekeying", factIds: ["a1", "a2", "a3", "a4"] }]);
    const o = r.opportunities[0]!;
    expect(o.stats.participants).toBe(3);
    expect(o.supportFactIds).toEqual(["a1", "a2", "a3"]);
    expect(o.factIds).toEqual(["a1", "a2", "a3", "a4"]);
    // The model is shown numbered facts with an anonymous person label.
    expect(model.calls[0]?.content).toMatch(/- F1 \(person A, pain_point\)/);
    expect(model.calls[0]?.content).toContain("Anonymity threshold: k = 3.");
  });

  it("drops an item nothing supports, and work described without a problem", async () => {
    const facts = [
      fact("a1", "p1", pain("Forklift logs exist")),
      fact("b1", "p2", task("Daily customer meeting", ["Teams"])),
    ];
    const model = new GroundingModel({
      Forklift: draft({ title: "Forklift downtime records", supportingFacts: [] }),
      Meetings: draft({ title: "Daily meetings", basis: "no_issue" }),
    });
    const r = await run(model, facts, [
      { key: "k1", name: "Forklift", factIds: ["a1"] },
      { key: "k2", name: "Meetings", factIds: ["b1"] },
    ]);
    expect(r.opportunities).toHaveLength(0);
    expect(r.stats.grounding).toMatchObject({ unsupported: 1, noIssue: 1 });
    expect(r.report.markdown).not.toContain("Forklift downtime records");
    expect(r.report.markdown).not.toContain("Daily meetings");
  });

  it("lists an idea without a problem apart, unranked, and tells the narrative so", async () => {
    const facts = [
      fact("a1", "p1", pain("Approvals wait in inboxes")),
      fact("a2", "p2", pain("Approvals arrive after the cut-off")),
      fact("a3", "p3", pain("Approval requests miss information")),
      fact("b1", "p4", {
        kind: "opportunity_candidate",
        title: "AI drafts",
        description: "Use AI for everything",
        relatedTasks: [],
        dataNeeded: [],
        risks: [],
      }),
    ];
    const model = new GroundingModel({
      Approvals: draft({ title: "Approval delays", supportingFacts: [1, 2, 3] }),
      Wishes: draft({ title: "AI-generated drafts of everything", solutionClass: "ai", basis: "idea" }),
    });
    const r = await run(model, facts, [
      { key: "k1", name: "Approvals", factIds: ["a1", "a2", "a3"] },
      { key: "k2", name: "Wishes", factIds: ["b1"] },
    ]);
    expect(r.opportunities.map((o) => o.title)).toEqual(["Approval delays"]);
    expect(r.stats.grounding?.ideas).toBe(1);
    expect(r.report.markdown).toContain("### Ideas mentioned");
    expect(r.report.markdown).toContain(
      "- AI-generated drafts of everything (mentioned in 1 of 6 interviews)",
    );
    expect(model.narrativeInput()).toMatch(/Ideas mentioned \(not ranked[^\n]*\n- AI-generated drafts/);
    expect(model.narrativeInput()).toMatch(/Ranked opportunities[^\n]*\n1\. Approval delays/);
  });

  it("reports what works well as no change recommended, ranked last, never in a class table", async () => {
    const facts = [
      fact("a1", "p1", pain("Approvals wait in inboxes")),
      fact("a2", "p2", pain("Approvals arrive late")),
      fact("w1", "p3", task("Proof of delivery in the app", ["POD app"])),
      fact("w2", "p4", task("Signatures captured in the app", ["POD app"])),
    ];
    const model = new GroundingModel({
      Approvals: draft({ title: "Approval delays", factors: factors(2) }),
      Delivery: draft({
        title: "Proof-of-delivery app",
        solutionClass: "software",
        basis: "works_well",
        whyNotAi: "It works; drivers rely on it.",
        factors: factors(5),
      }),
    });
    const r = await run(model, facts, [
      { key: "k1", name: "Approvals", factIds: ["a1", "a2"] },
      { key: "k2", name: "Delivery", factIds: ["w1", "w2"] },
    ]);
    const works = r.opportunities.find((o) => o.basis === "works_well")!;
    expect(works.solutionClass).toBe("none");
    expect(works.rankScore).toBe(0);
    expect(r.opportunities.at(-1)).toBe(works);
    expect(r.report.markdown).toContain("### Working well: no change recommended");
    expect(r.report.markdown).toContain("**Proof-of-delivery app.** It works; drivers rely on it.");
    expect(r.report.markdown).not.toMatch(/\| Proof-of-delivery app \|/);
    expect(model.narrativeInput()).toMatch(
      /Working well \(no change recommended\):\n- Proof-of-delivery app/,
    );
  });
});

describe("a quote is shown only when its own point is shared and it does not single anyone out (D-479)", () => {
  const facts = [
    fact("a1", "p1", pain("Manual tachograph check", "I'm the only one who knows how to do it")),
    fact("a2", "p2", pain("Data typed twice", "we type the same delivery data twice every day")),
    fact("a3", "p3", pain("Data typed twice", "the same numbers go in twice, into two systems")),
    fact("a4", "p4", pain("Data typed twice", "I copy every delivery from one screen to another")),
  ];

  it("never shows a self-identifying quote, whatever the group size", async () => {
    const model = new GroundingModel({ Manual: draft({ title: "Manual entry" }) });
    const r = await run(model, facts, [{ key: "k1", name: "Manual", factIds: ["a1", "a2", "a3", "a4"] }]);
    const o = r.opportunities[0]!;
    expect(o.stats.participants).toBe(4);
    expect(o.stats.quotes).not.toContain("I'm the only one who knows how to do it");
    expect(o.stats.quotes).toHaveLength(3);
    expect(r.report.markdown).not.toMatch(/only one who knows/);
    const row = o.evidence.find((e) => e.factId === "a1")!;
    expect(row.kind).toBe("paraphrase");
    expect(row.snippet).not.toMatch(/only one/);
    expect(r.stats.grounding?.quotesWithheld).toBe(1);
  });

  it("shows only the quotes the model says make a point k people share", async () => {
    const model = new GroundingModel({
      Manual: draft({ title: "Manual entry", sharedQuotes: [2, 3] }),
    });
    const r = await run(model, facts, [{ key: "k1", name: "Manual", factIds: ["a1", "a2", "a3", "a4"] }]);
    expect(r.opportunities[0]!.stats.quotes).toEqual([
      "we type the same delivery data twice every day",
      "the same numbers go in twice, into two systems",
    ]);
  });

  it("shows no quote at all when the supporting facts come from fewer than k people", async () => {
    const model = new GroundingModel({ Manual: draft({ title: "Manual entry", supportingFacts: [1, 2] }) });
    const r = await run(model, facts, [{ key: "k1", name: "Manual", factIds: ["a1", "a2", "a3", "a4"] }]);
    const o = r.opportunities[0]!;
    expect(o.stats.participants).toBe(2);
    expect(o.stats.quotes).toEqual([]);
    expect(o.evidence.every((e) => e.snippet === "")).toBe(true);
  });
});

describe("model-written text keeps nobody singled out (D-479)", () => {
  it("removes a sentence saying one person is the only one who knows, and names rare tools generically below k", async () => {
    const facts = [
      fact("a1", "p1", task("Contract renewal preparation", ["HubSpot", "Excel"])),
      fact("b1", "p2", task("Reports", ["Excel"])),
      fact("b2", "p3", task("Reports", ["Excel"])),
    ];
    const model = new GroundingModel({
      Renewals: draft({
        title: "Renewal preparation from HubSpot",
        summary:
          "Renewals are prepared by hand from HubSpot exports. She is the only one who knows the procedure. A checklist would help.",
      }),
      Reports: draft({ title: "Monthly reports", summary: "Reports are built in Excel." }),
    });
    const r = await run(model, facts, [
      { key: "k1", name: "Renewals", factIds: ["a1"] },
      { key: "k2", name: "Reports", factIds: ["b1", "b2"] },
    ]);
    const renewals = r.opportunities.find((o) => o.clusterKey === "k1")!;
    expect(renewals.summary).toBe(
      "Renewals are prepared by hand from a tool exports. A checklist would help.",
    );
    expect(renewals.title).toBe("Renewal preparation from a tool");
    expect(r.stats.grounding?.singlingRemoved).toBe(1);
    // Excel is used by three people, so it is not identifying and stays.
    expect(r.opportunities.find((o) => o.clusterKey === "k2")!.summary).toContain("Excel");
  });

  it("lists a role or department only when at least k people across the campaign share it", () => {
    const facts = [
      fact("a1", "p1", pain("x"), "Driver"),
      fact("a2", "p2", pain("x"), "Driver"),
      fact("a3", "p3", pain("x"), "Driver"),
      fact("a4", "p4", pain("x"), "Payroll administrator"),
    ];
    const common = commonBreakdowns(facts, 3);
    expect([...common.roles]).toEqual(["driver"]);
    expect([...common.departments]).toEqual(["finance"]);
  });
});

describe("the executive summary follows the ranking (D-479)", () => {
  const opp = (title: string, sessions: number): AnalysisOpportunity =>
    ({
      clusterKey: title,
      title,
      basis: "problem",
      stats: {
        participants: sessions,
        sessions,
        facts: sessions,
        roles: [],
        departments: [],
        tools: [],
        minutesPerWeekTotal: 0,
        quotes: [],
      },
    }) as unknown as AnalysisOpportunity;

  it("recognises a title by its content words", () => {
    expect(
      mentionsTitle("Re-keying of delivery data costs finance hours.", "Manual re-keying of delivery data"),
    ).toBe(true);
    expect(mentionsTitle("Approvals are slow.", "Paper shift handover forms")).toBe(false);
  });

  it("adds the top-ranked items the summary left out, with their counts", () => {
    const n = { executiveSummary: "Approval delays slow every team.", nextSteps: ["x"], caveats: "c" };
    const out = ensureTopCovered(
      n,
      [opp("Approval delays", 4), opp("Paper shift handover", 3), opp("Status calls", 2)],
      10,
    );
    expect(out.executiveSummary).toBe(
      "Approval delays slow every team. Also among the three highest-ranked: Paper shift handover (mentioned in 3 of 10 interviews) and Status calls (mentioned in 2 of 10 interviews).",
    );
    expect(ensureTopCovered(out, [opp("Approval delays", 4)], 10)).toEqual(out);
  });
});

describe("grounding answers and their fallbacks", () => {
  const numbered = [fact("a", "p1", pain("x")), fact("b", "p2", pain("y"))];

  it("reads fact numbers back, ignoring numbers that name no fact", () => {
    const g = groundDraft(draft({ supportingFacts: [2, 9, 2], sharedQuotes: [1] }), numbered);
    expect(g.support.map((f) => f.id)).toEqual(["b"]);
    expect([...(g.shared ?? [])]).toEqual(["a"]);
    expect(g.basis).toBe("problem");
  });

  it("treats a draft without grounding fields (an older or tenant prompt) as supported by every fact", () => {
    const g = groundDraft(draft(), numbered);
    expect(g.support).toHaveLength(2);
    expect(g.shared).toBeNull();
  });
});

describe("an opportunity answer that cannot be used is asked for once more (D-479)", () => {
  it("retries with the reason and keeps the item", async () => {
    let n = 0;
    const model = new GroundingModel({
      Approvals: () => {
        n++;
        if (n === 1)
          throw new ProviderError(
            "Structured output was not valid JSON: no JSON value in the output",
            "parse",
            true,
          );
        return draft({ title: "Approval delays" });
      },
    });
    const facts = [fact("a1", "p1", pain("Approvals wait"))];
    const r = await run(model, facts, [{ key: "k1", name: "Approvals", factIds: ["a1"] }]);
    expect(r.opportunities).toHaveLength(1);
    expect(r.stats.opportunitiesFailed).toBe(0);
    const asks = model.calls.filter((c) => c.name === "opportunity");
    expect(asks).toHaveLength(2);
    expect(asks[1]?.content).toContain(
      "Your previous answer could not be used: Structured output was not valid JSON",
    );
  });

  it("does not retry an error that is not about the answer", async () => {
    let n = 0;
    const model = new GroundingModel({
      Approvals: () => {
        n++;
        throw new ProviderError("down", "server", true);
      },
      Other: draft({ title: "Other" }),
    });
    const facts = [fact("a1", "p1", pain("Approvals wait")), fact("b1", "p2", pain("Other"))];
    const r = await run(model, facts, [
      { key: "k1", name: "Approvals", factIds: ["a1"] },
      { key: "k2", name: "Other", factIds: ["b1"] },
    ]);
    expect(n).toBe(1);
    expect(r.stats.opportunitiesFailed).toBe(1);
  });
});

describe("participation without invitations (D-479)", () => {
  it("prints no invited count for an open-link campaign, in the report or to the narrative", async () => {
    const model = new GroundingModel({ Approvals: draft({ title: "Approval delays" }) });
    const r = await run(
      model,
      [fact("a1", "p1", pain("Approvals wait"))],
      [{ key: "k1", name: "Approvals", factIds: ["a1"] }],
    );
    expect(r.report.markdown).toContain("| Completed interviews | Interviews analyzed | Facts extracted |");
    expect(r.report.markdown).not.toContain("Invited");
    expect(model.narrativeInput()).not.toMatch(/invited/i);
  });
});

describe("consolidation merges (D-479)", () => {
  const named = (key: string, ids: string[]) => ({ key, name: key, summary: "", factIds: ids });

  it("joins the named clusters into one with a stable key, each cluster in at most one merge", () => {
    const clusters = [named("x", ["f1", "f2"]), named("y", ["f3"]), named("z", ["f4"]), named("w", ["f5"])];
    const groups = clusters.map((_, i) => ({ id: `g${i + 1}` }));
    const out = applyMerges(clusters, groups, [
      { ids: ["g1", "g2", "bogus"], name: "Re-keying", summary: "Typed twice." },
      { ids: ["g2", "g3"], name: "Taken", summary: "" }, // g2 is already merged: one id left, no merge
    ]);
    expect(out.map((c) => c.factIds)).toEqual([["f1", "f2", "f3"], ["f5"], ["f4"]]); // larger first, then by key
    expect(out[0]?.name).toBe("Re-keying");
  });

  it("merges clusters from different merge-pass batches in one call", async () => {
    // Lexical vectors and no merges in the first pass: four drafts that consolidation joins.
    const facts = [
      fact("f1", "p1", pain("Supplier invoices typed into the ledger by hand")),
      fact("f2", "p2", pain("Delivery rows copied from the transport system to billing")),
      fact("f3", "p3", pain("Order emails retyped into the order screen")),
      fact("f4", "p4", pain("Night shift handover form is lost or unreadable")),
    ];
    const calls: string[] = [];
    const caller = {
      embed: async () => undefined,
      complete: async <T>(_p: string, _c: unknown, req: CallRequest, schema: z.ZodType<T>, name?: string) => {
        calls.push(name ?? "");
        const content = String(req.messages[0]?.content ?? "");
        if (name === "cluster_consolidation") {
          const ids = [
            ...content.matchAll(/kind="cluster" id="(g\d+)">\n\1: [^\n]*\n[^\n]*\n[^\n]*\n {2}- ([^\n]+)/g),
          ]
            .filter((m) => !/handover/i.test(m[2] ?? ""))
            .map((m) => m[1]);
          // A merge with one id must not cost the whole answer (first bench run, D-479).
          return schema.parse({
            merges: [
              { ids, name: "Data typed twice", summary: "Typed again." },
              { ids: ["g4"], name: "Alone", summary: "" },
            ],
          });
        }
        if (name === "opportunity")
          return schema.parse(draft({ title: /handover/i.test(content) ? "Handover" : "Typed twice" }));
        if (name === "cluster_merges") return schema.parse({ merges: [], names: [] });
        return schema.parse({ executiveSummary: "Typed twice. Handover.", nextSteps: ["x"], caveats: "c" });
      },
    } as unknown as ModelCaller;
    const r = await runAnalysis(
      { caller, prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c1",
        campaignId: "camp",
        campaignName: "Bench",
        facts,
        participation: { invited: 0, completed: 4, sessionsAnalyzed: 4 },
        thresholdMet: true,
        k: 3,
        weights: WEIGHT_PRESETS.balanced,
        similarityThreshold: 0.99,
        language: "en",
        sections: SECTIONS,
        overrides: {},
      },
    );
    expect(calls).toContain("cluster_consolidation");
    expect(r.clusters.map((c) => c.factIds.length).sort()).toEqual([1, 3]);
    expect(r.opportunities.find((o) => o.title === "Typed twice")?.stats.participants).toBe(3);
    expect(r.stats.promptVersions).toContain("consolidation@1");
  });
});

describe("the item-level merge (D-479)", () => {
  it("assesses items that turn out to be one problem again as one, with everyone behind it", async () => {
    const facts = [
      fact("f1", "p1", pain("Overtime approvals arrive after the payroll cut-off")),
      fact("f2", "p2", pain("Spare part purchases wait days for a manager's sign-off")),
      fact("f3", "p3", pain("Credit notes sit in an inbox until someone signs them off")),
      fact("f4", "p4", pain("Night shift handover form is lost or unreadable")),
    ];
    const asked: string[] = [];
    const caller = {
      embed: async () => undefined,
      complete: async <T>(_p: string, _c: unknown, req: CallRequest, schema: z.ZodType<T>, name?: string) => {
        const content = String(req.messages[0]?.content ?? "");
        asked.push(name ?? "");
        if (name === "item_consolidation") {
          const ids = [...content.matchAll(/id="(i\d+)">\n\1: ([^\n]+)/g)]
            .filter((m) => /approval/i.test(m[2] ?? ""))
            .map((m) => m[1]);
          return schema.parse({ merges: [{ ids, name: "Approval bottleneck", summary: "Sign-offs wait." }] });
        }
        if (name === "opportunity") {
          const cluster = /^Cluster: (.+)$/m.exec(content)?.[1] ?? "";
          const title =
            cluster === "Approval bottleneck"
              ? "Approval bottleneck"
              : /handover/i.test(content)
                ? "Handover"
                : `${cluster} approval`;
          return schema.parse(draft({ title }));
        }
        if (name === "cluster_merges" || name === "cluster_consolidation")
          return schema.parse({ merges: [], names: [] });
        return schema.parse({
          executiveSummary: "Approval bottleneck. Handover.",
          nextSteps: ["x"],
          caveats: "c",
        });
      },
    } as unknown as ModelCaller;
    const r = await runAnalysis(
      { caller, prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c1",
        campaignId: "camp",
        campaignName: "Bench",
        facts,
        participation: { invited: 0, completed: 4, sessionsAnalyzed: 4 },
        thresholdMet: true,
        k: 3,
        weights: WEIGHT_PRESETS.balanced,
        similarityThreshold: 0.99,
        language: "en",
        sections: SECTIONS,
        overrides: {},
      },
    );
    const merged = r.opportunities.find((o) => o.title === "Approval bottleneck")!;
    expect(merged.stats.participants).toBe(3);
    expect(merged.factIds).toEqual(["f1", "f2", "f3"]);
    expect(r.opportunities.map((o) => o.title).sort()).toEqual(["Approval bottleneck", "Handover"]);
    // The stored clusters are the merged ones, so an edit run starts from them.
    expect(r.baseClusters.map((c) => c.factIds.length).sort()).toEqual([1, 3]);
    expect(r.clusters.map((c) => c.factIds.length).sort()).toEqual([1, 3]);
    expect(r.stats.grounding?.itemsMerged).toBe(3);
    expect(asked.filter((n) => n === "item_consolidation")).toHaveLength(1);
  });
});
