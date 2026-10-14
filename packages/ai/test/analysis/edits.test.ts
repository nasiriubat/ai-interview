import type { ChatEvent, Fact, OpportunityDraft, Purpose, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { stableClusterKey } from "../../src/analysis/clustering.js";
import {
  applyClusterEdits,
  matchAnchor,
  type ClusterEditOp,
  type EditableCluster,
} from "../../src/analysis/edits.js";
import { runAnalysis, type AnalysisFact } from "../../src/analysis/pipeline.js";
import { proposeSplit } from "../../src/analysis/split.js";
import type { CallContext, CallRequest, ModelCallerPort } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

const cluster = (key: string, name: string, factIds: string[]): EditableCluster => ({
  key,
  name,
  summary: `${name} summary`,
  factIds,
});

const A = ids("a", 6);
const B = ids("b", 4);
const C = ids("c", 3);

describe("matchAnchor", () => {
  it("takes the cluster holding the most of the anchor", () => {
    const clusters = [cluster("x", "X", [...A.slice(0, 2), ...B]), cluster("y", "Y", A.slice(2))];
    expect(matchAnchor(clusters, A)?.key).toBe("y");
  });

  it("accepts a cluster holding exactly half of the anchor and refuses one just under it", () => {
    const anchor = ids("f", 100);
    const half = [cluster("half", "Half", anchor.slice(0, 50))];
    const under = [cluster("under", "Under", anchor.slice(0, 49))];
    expect(matchAnchor(half, anchor)?.key).toBe("half");
    expect(matchAnchor(under, anchor)).toBeUndefined();
  });

  it("matches a cluster that has grown since (containment, not Jaccard)", () => {
    const grown = [cluster("g", "G", [...A, ...ids("new", 40)])];
    expect(matchAnchor(grown, A)?.key).toBe("g");
  });

  it("is orphaned when the facts are gone, and breaks ties on the lower key", () => {
    expect(matchAnchor([cluster("x", "X", ids("z", 3))], A)).toBeUndefined();
    const tie = [cluster("m", "M", A.slice(0, 3)), cluster("b", "B", A.slice(3))];
    expect(matchAnchor(tie, A)?.key).toBe("b");
  });
});

describe("applyClusterEdits", () => {
  const merge: ClusterEditOp = { id: "e1", op: "merge", anchors: [A, B], title: "Notes and orders" };

  it("merges the clusters its anchors name and keys the result on its smallest fact", () => {
    const out = applyClusterEdits(
      [cluster("k1", "A", A), cluster("k2", "B", B), cluster("k3", "C", C)],
      [merge],
    );
    expect(out.orphaned).toEqual([]);
    expect(out.clusters).toHaveLength(2);
    const merged = out.clusters.find((c) => c.name === "Notes and orders");
    expect(merged?.factIds).toEqual([...A, ...B].sort());
    expect(merged?.key).toBe(stableClusterKey([...A, ...B]));
  });

  it("gives the same result when the clustering numbered its clusters in another order (D-151)", () => {
    const one = applyClusterEdits(
      [cluster("d1", "A", A), cluster("d2", "B", B), cluster("d3", "C", C)],
      [merge],
    );
    const two = applyClusterEdits(
      [cluster("d9", "C", C), cluster("d4", "B", B), cluster("d7", "A", A)],
      [merge],
    );
    // Untouched clusters keep whatever key the clustering gave them; what must agree is the facts
    // in each cluster and the key of the one the edit made.
    const shape = (r: typeof one): string[] => r.clusters.map((c) => c.factIds.join(",")).sort();
    expect(two.clusters.find((c) => c.name === "Notes and orders")?.key).toBe(
      one.clusters.find((c) => c.name === "Notes and orders")?.key,
    );
    expect(shape(two)).toEqual(shape(one));
  });

  it("keeps the larger cluster's name when the edit has no title", () => {
    const out = applyClusterEdits(
      [cluster("k1", "Big", A), cluster("k2", "Small", B)],
      [{ id: "e", op: "merge", anchors: [A, B] }],
    );
    expect(out.clusters[0]?.name).toBe("Big");
  });

  it("does nothing when the pipeline already put the anchors in one cluster", () => {
    const out = applyClusterEdits([cluster("k1", "Joined", [...A, ...B])], [merge]);
    expect(out.orphaned).toEqual([]);
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]?.factIds).toEqual([...A, ...B].sort());
  });

  it("skips and reports a merge with an anchor that matches nothing", () => {
    const out = applyClusterEdits([cluster("k1", "A", A), cluster("k3", "C", C)], [merge]);
    expect(out.orphaned).toEqual(["e1"]);
    expect(out.clusters.map((c) => c.key).sort()).toEqual(["k1", "k3"]);
  });

  it("splits by parts, counts a fact the admin never saw, and puts it in the larger part", () => {
    const parts = [A.slice(0, 4), A.slice(4)];
    const split: ClusterEditOp = { id: "s1", op: "split", source: A, parts };
    const grown = cluster("k1", "Notes", [...A, "zzz-new"]);
    const out = applyClusterEdits([grown], [split]);
    expect(out.unassignedNew).toBe(1);
    expect(out.clusters).toHaveLength(2);
    const big = out.clusters.find((c) => c.factIds.includes("zzz-new"));
    expect(big?.factIds).toHaveLength(5);
    expect(big?.name).toBe("Notes");
    expect(out.clusters.find((c) => c.factIds.length === 2)?.name).toBe("Notes (B)");
  });

  it("reports a split whose facts the pipeline already separated", () => {
    const split: ClusterEditOp = { id: "s1", op: "split", source: A, parts: [A.slice(0, 3), A.slice(3)] };
    const out = applyClusterEdits(
      [cluster("k1", "One", A.slice(0, 3)), cluster("k2", "Two", A.slice(3))],
      [split],
    );
    // Two clusters either way, and the edit is reported as moot rather than applied twice.
    expect(out.clusters).toHaveLength(2);
    expect(out.orphaned).toEqual(["s1"]);
  });

  it("applies edits in order: a split of a merged cluster needs the merge before it", () => {
    const base = [cluster("k1", "A", A), cluster("k2", "B", B)];
    const split: ClusterEditOp = { id: "s", op: "split", source: [...A, ...B], parts: [A, B] };
    const right = applyClusterEdits(base, [{ id: "m", op: "merge", anchors: [A, B] }, split]);
    expect(right.clusters).toHaveLength(2);
    expect(right.orphaned).toEqual([]);
    // Split first: the facts are not one cluster yet, so the larger half is taken as its host and
    // the smaller one has nothing to split off; the edit is reported, not guessed.
    const wrong = applyClusterEdits(base, [split, { id: "m", op: "merge", anchors: [A, B] }]);
    expect(wrong.clusters).toHaveLength(1);
    expect(wrong.orphaned).toEqual(["s"]);
  });
});

// ---- the pipeline: edits applied after clustering, and the edit run ---------------------------

const logger = { warn: () => undefined, info: () => undefined };
const task = (name: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 20,
  tools: [],
  painScore: 5,
});
const members = (topic: string, n: number, firstId: number, personFrom: number): AnalysisFact[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${String(firstId + i).padStart(3, "0")}`,
    sessionId: `s${personFrom + i}`,
    participantKey: `p${personFrom + i}`,
    role: "Nurse",
    department: i % 2 === 0 ? "Ward" : "Pharmacy",
    fact: task(`${topic} variant ${i}`),
  }));

class Counting implements ModelCallerPort {
  opportunities = 0;
  embeds = 0;
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<ChatEvent> {
    throw new Error("the analysis does not stream");
  }
  async embed(): Promise<undefined> {
    this.embeds++;
    return undefined;
  }
  async complete<T>(
    _purpose: Purpose,
    _ctx: CallContext,
    _req: CallRequest,
    schema: z.ZodType<T>,
    name?: string,
  ): Promise<T> {
    if (name === "cluster_merges") return schema.parse({ merges: [], names: [] });
    if (name === "opportunity") {
      this.opportunities++;
      return schema.parse(draft("Generated"));
    }
    return schema.parse({ executiveSummary: "E", nextSteps: ["Next"], caveats: "C" });
  }
}

const factor = { score: 4, rationale: "r" };
const draft = (title: string): OpportunityDraft => ({
  title,
  summary: "S",
  solutionClass: "automation",
  rationale: "R",
  factors: {
    expected_impact: factor,
    affected_employees: factor,
    frequency: factor,
    implementation_complexity: factor,
    data_availability: factor,
    risk: factor,
    ai_suitability: factor,
  },
  dataNeeded: [],
  risks: [],
});

const base = (facts: AnalysisFact[], over: object = {}) => ({
  companyId: "c1",
  campaignId: "camp",
  campaignName: "Ward",
  facts,
  participation: { invited: 10, completed: 9, sessionsAnalyzed: 9 },
  thresholdMet: true,
  k: 3,
  weights: WEIGHT_PRESETS.balanced,
  similarityThreshold: 0.5,
  language: "en",
  sections: ["opportunities", "department_comparison"] as ReportSection[],
  overrides: {},
  ...over,
});

describe("runAnalysis with edits", () => {
  // Three unrelated topics so the similarity pass keeps them apart.
  const facts = [
    ...members("Charting patient notes in two systems", 4, 1, 1),
    ...members("Ordering pharmacy stock from the supplier portal", 3, 10, 10),
    ...members("Rostering night shift staff by phone", 3, 20, 20),
  ];
  const deps = (m: Counting) => ({ caller: m, prompts: new ShippedPromptSource(), logger });

  it("merges the clusters an edit names and a second run with the facts in another order agrees", async () => {
    const plain = await runAnalysis(deps(new Counting()), base(facts));
    expect(plain.clusters).toHaveLength(3);
    const [first, second] = plain.clusters;
    const edit: ClusterEditOp = {
      id: "m1",
      op: "merge",
      anchors: [first!.factIds, second!.factIds],
      title: "Merged by an admin",
    };
    const one = await runAnalysis(deps(new Counting()), base(facts, { edits: [edit] }));
    const two = await runAnalysis(deps(new Counting()), base([...facts].reverse(), { edits: [edit] }));
    for (const r of [one, two]) {
      expect(r.clusters).toHaveLength(2);
      expect(r.opportunities.some((o) => o.title === "Generated")).toBe(true);
      expect(r.clusters.find((c) => c.name === "Merged by an admin")?.factIds).toHaveLength(
        first!.factIds.length + second!.factIds.length,
      );
      expect(r.stats.orphanedEdits).toEqual([]);
    }
    expect(one.clusters.map((c) => c.key).sort()).toEqual(two.clusters.map((c) => c.key).sort());
    // The base is what an undo starts from.
    expect(one.baseClusters).toHaveLength(3);
  });

  it("an edit run clusters nothing again and asks the model only for the clusters that changed", async () => {
    const first = await runAnalysis(deps(new Counting()), base(facts));
    const [a, b] = first.clusters;
    const reuse = new Map(
      first.opportunities.map((o) => [
        o.clusterKey,
        { factIds: o.factIds, draft: draft(`Kept ${o.clusterKey}`) },
      ]),
    );
    const model = new Counting();
    const edited = await runAnalysis(
      deps(model),
      base(facts, {
        seed: { clusters: first.baseClusters, reuse },
        edits: [{ id: "m", op: "merge", anchors: [a!.factIds, b!.factIds] }],
      }),
    );
    expect(model.embeds).toBe(0);
    // One merged cluster is new; the third cluster is unchanged and keeps its generated opportunity.
    expect(model.opportunities).toBe(1);
    expect(edited.stats.reusedOpportunities).toBe(1);
    expect(edited.opportunities.some((o) => o.title.startsWith("Kept "))).toBe(true);
    // Undo: the same seed with no edit gets the three clusters back, with no model call at all.
    const undone = await runAnalysis(
      deps(((model.opportunities = 0), model)),
      base(facts, { seed: { clusters: first.baseClusters, reuse } }),
    );
    expect(undone.clusters).toHaveLength(3);
    expect(model.opportunities).toBe(0);
  });

  it("an edit run ignores facts that were erased since the base run", async () => {
    const first = await runAnalysis(deps(new Counting()), base(facts));
    const remaining = facts.filter((f) => f.id !== "f001");
    const r = await runAnalysis(
      deps(new Counting()),
      base(remaining, { seed: { clusters: first.baseClusters, reuse: new Map() } }),
    );
    expect(r.clusters.flatMap((c) => c.factIds)).not.toContain("f001");
    expect(r.clusters.flatMap((c) => c.factIds)).toHaveLength(remaining.length);
  });
});

describe("proposeSplit", () => {
  it("separates facts about different things and is deterministic", async () => {
    const texts = [
      "Charting patient notes twice in the ward system",
      "Charting patient notes again in the ward system",
      "Ordering stock from the supplier portal by hand",
      "Ordering stock from the supplier portal each week",
    ];
    const a = await proposeSplit(texts, 0.08);
    const b = await proposeSplit(texts, 0.08);
    expect(a).toEqual(b);
    expect(a[0]).toBe(a[1]);
    expect(a[2]).toBe(a[3]);
    expect(a[0]).not.toBe(a[2]);
  });

  it("cuts in half when nothing separates the facts, so there are always two parts", async () => {
    const parts = await proposeSplit(["same words here", "same words here", "same words here"], 0.08);
    expect(new Set(parts).size).toBe(2);
  });
});
