import type { Fact, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { agglomerate } from "../../src/analysis/cluster.js";
import { chunk, matchOverrides, orderBySimilarity, stableClusterKey } from "../../src/analysis/clustering.js";
import { cosine } from "../../src/analysis/embeddings.js";
import { runAnalysis, type AnalysisFact, type AnalysisInput } from "../../src/analysis/pipeline.js";
import type { CallRequest } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";

const logger = { warn: () => undefined, info: () => undefined };
const SECTIONS = ["executive_summary", "participation", "opportunities"] as ReportSection[];

const task = (name: string): Fact => ({
  kind: "task",
  name,
  frequency: "weekly",
  minutesPerOccurrence: 30,
  tools: [],
  painScore: 5,
});

/** A made-up word per (topic, slot) with its own stem, so no two topics share a stem bucket. */
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
function word(t: number, slot: number): string {
  // A bijection on six base-26 digits, so every (topic, slot) gets its own word and neighbours differ early.
  let n = ((t * 8 + slot + 1) * 7919) % 26 ** 6;
  let w = "";
  for (let i = 0; i < 6; i++) {
    w += LETTERS.charAt(n % 26);
    n = Math.floor(n / 26);
  }
  return `${w}${slot}`;
}

/** 500 facts: 40 topics of 12 near-duplicates (shared made-up vocabulary), 60 participants. */
function campaign(): AnalysisFact[] {
  const out: AnalysisFact[] = [];
  for (let t = 0; t < 40; t++) {
    for (let j = 0; j < 12; j++) {
      if (out.length >= 500) break;
      out.push({
        id: `f${String(t).padStart(2, "0")}${String(j).padStart(2, "0")}`,
        sessionId: `s${(t * 7 + j) % 60}`,
        participantKey: `p${(t * 7 + j) % 60}`,
        role: "Staff",
        fact: task(`Handling ${word(t, 0)} ${word(t, 1)} ${word(t, 2)} for ${word(t, 3)} v${j}${word(t, 4)}`),
      });
    }
  }
  // 20 unrelated singletons (480 + 20 = 500 facts) so the cap and the long tail are exercised.
  for (let i = 0; i < 20; i++) {
    out.push({
      id: `g${String(i).padStart(3, "0")}`,
      sessionId: `s${i}`,
      participantKey: `p${i}`,
      fact: task(`${word(100 + i, 0)} ${word(100 + i, 1)} ${word(100 + i, 2)}`),
    });
  }
  return out;
}

/** The topic number is recoverable from the first made-up word of a fact. */
const TOPIC_WORDS = new Map(Array.from({ length: 40 }, (_, t) => [word(t, 0), String(t)] as const));
function topicOf(text: string): string | undefined {
  for (const [w, t] of TOPIC_WORDS) if (text.includes(w)) return t;
  return undefined;
}

class Counting {
  calls: Record<string, number> = {};
  requests: CallRequest[] = [];
  failMergesAbove = Number.POSITIVE_INFINITY;
  failOpportunityFor: string | undefined;
  async embed(): Promise<undefined> {
    return undefined;
  }
  chat(): AsyncIterable<never> {
    throw new Error("no chat in analysis");
  }
  async complete<T>(
    _purpose: string,
    _ctx: unknown,
    req: CallRequest,
    schema: z.ZodType<T>,
    name?: string,
  ): Promise<T> {
    this.calls[name ?? "?"] = (this.calls[name ?? "?"] ?? 0) + 1;
    this.requests.push(req);
    const content = String(req.messages[0]?.content ?? "");
    if (name === "cluster_merges") {
      const drafts = [
        ...content.matchAll(
          /<untrusted-[0-9a-f]+ kind="draft_cluster" id="(\w+)">\n([^\n]*)\n([\s\S]*?)\n<\/untrusted-/g,
        ),
      ].map((m) => ({ id: m[1]!, text: m[3]! }));
      if (drafts.length > this.failMergesAbove) throw new Error("output cut off");
      const byTopic = new Map<string, string[]>();
      for (const d of drafts) {
        const topic = topicOf(d.text);
        if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), d.id]);
      }
      return schema.parse({
        merges: [...byTopic]
          .filter(([, ids]) => ids.length >= 2)
          .map(([topic, ids]) => ({ ids, name: `Topic ${topic}`, summary: "s" })),
        names: [],
      });
    }
    if (name === "opportunity") {
      if (this.failOpportunityFor && content.includes(this.failOpportunityFor)) throw new Error("boom");
      return schema.parse({
        title: "T",
        summary: "S",
        solutionClass: "automation",
        rationale: "R",
        factors: Object.fromEntries(
          [
            "expected_impact",
            "affected_employees",
            "frequency",
            "implementation_complexity",
            "data_availability",
            "risk",
            "ai_suitability",
          ].map((k) => [k, { score: 3, rationale: "r" }]),
        ),
        dataNeeded: [],
        risks: [],
      });
    }
    return schema.parse({ executiveSummary: "E", nextSteps: ["N"], caveats: "C" });
  }
}

const input = (facts: AnalysisFact[], over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  companyId: "c1",
  campaignId: "camp",
  campaignName: "Scale",
  facts,
  participation: { invited: 80, completed: 60, sessionsAnalyzed: 60 },
  thresholdMet: true,
  k: 3,
  weights: WEIGHT_PRESETS.balanced,
  similarityThreshold: 0.5,
  language: "en",
  sections: SECTIONS,
  overrides: {},
  ...over,
});

const deps = (m: Counting) => ({
  caller: m as never,
  prompts: new ShippedPromptSource(),
  logger,
  now: () => new Date("2026-10-14"),
});

describe("runAnalysis at pilot scale (live run bug 5)", () => {
  it("completes a 500-fact campaign, covers every fact once, in a bounded number of model calls", async () => {
    const facts = campaign();
    const model = new Counting();
    const started = Date.now();
    const r = await runAnalysis(deps(model), input(facts));
    const elapsed = Date.now() - started;

    expect(facts).toHaveLength(500);
    const covered = r.clusters.flatMap((c) => c.factIds);
    expect(covered).toHaveLength(facts.length);
    expect(new Set(covered).size).toBe(facts.length);
    expect(r.stats.facts).toBe(500);

    // 40 topics merged into 40 clusters of 12, plus 20 singletons.
    expect(r.clusters.filter((c) => c.factIds.length === 12)).toHaveLength(40);
    expect(r.clusters).toHaveLength(60);

    // Bounded calls: one merge call per batch of 40 drafts, at most 40 opportunities, one narrative.
    const total = Object.values(model.calls).reduce((a, b) => a + b, 0);
    expect(model.calls.opportunity).toBe(40);
    expect(model.calls.narrative).toBe(1);
    expect(model.calls.cluster_merges).toBeLessThanOrEqual(3 * Math.ceil(r.clusters.length / 40) + 10);
    expect(total).toBeLessThan(80);

    expect(r.opportunities).toHaveLength(40);
    expect(r.stats.longTailClusters).toBe(20);
    // The multi-person topics rank ahead of the one-person singletons.
    expect(r.opportunities.every((o) => o.stats.participants >= 3)).toBe(true);
    expect(elapsed).toBeLessThan(20_000);
  });

  it("never sends a hard-coded output cap: the route's maxOutputTokens applies", async () => {
    const model = new Counting();
    await runAnalysis(deps(model), input(campaign().slice(0, 60)));
    expect(model.requests.length).toBeGreaterThan(0);
    expect(model.requests.every((q) => q.maxOutputTokens === undefined)).toBe(true);
  });

  it("splits a merge batch whose answer cannot be used, and keeps the drafts where it still fails", async () => {
    const facts = campaign().slice(0, 240); // 20 topics of 12
    const model = new Counting();
    model.failMergesAbove = 10; // any batch of more than 10 drafts fails, even when halved at 40 -> 20 -> ...
    const r = await runAnalysis(deps(model), input(facts, { clusterBatchSize: 40 }));
    // Every fact is still covered exactly once; the run did not fail.
    const covered = r.clusters.flatMap((c) => c.factIds);
    expect(new Set(covered).size).toBe(facts.length);
    expect(covered).toHaveLength(facts.length);
    // Bounded: no more than three calls per batch of drafts.
    const batches = Math.ceil(r.clusters.length / 40) + 6;
    expect(model.calls.cluster_merges).toBeLessThanOrEqual(3 * batches);
  });

  it("leaves a cluster out, not the run, when its opportunity cannot be generated", async () => {
    const facts = campaign().slice(0, 120);
    const model = new Counting();
    model.failOpportunityFor = word(3, 0);
    const r = await runAnalysis(deps(model), input(facts));
    expect(r.stats.opportunitiesFailed).toBe(1);
    expect(r.opportunities.length).toBe(r.clusters.length - 1);
    expect(r.clusters.flatMap((c) => c.factIds)).toHaveLength(120);
  });

  it("fails the run when no cluster can be assessed at all", async () => {
    const model = new Counting();
    model.failOpportunityFor = "Handling";
    await expect(runAnalysis(deps(model), input(campaign().slice(0, 36)))).rejects.toThrow("boom");
  });

  it("keeps evidence text withheld below k at scale", async () => {
    const facts = campaign();
    const model = new Counting();
    const r = await runAnalysis(deps(model), input(facts, { k: 100 }));
    expect(r.opportunities.length).toBeGreaterThan(0);
    for (const o of r.opportunities) {
      expect(o.evidence.every((e) => e.snippet === "")).toBe(true);
      expect(o.stats.quotes).toEqual([]);
    }
  });
});

describe("stable cluster keys and anchored overrides (blueprint section 0 item 1)", () => {
  it("keys a cluster by its oldest member, so growing it keeps the key and shuffling does not matter", () => {
    expect(stableClusterKey(["f1", "f3", "f2"])).toBe(stableClusterKey(["f2", "f1", "f3"]));
    expect(stableClusterKey(["f1", "f2"])).toBe(stableClusterKey(["f1", "f2", "f9"]));
    expect(stableClusterKey(["f1", "f2"])).not.toBe(stableClusterKey(["f3", "f4"]));
  });

  it("gives the same keys on a re-run whatever order the facts arrive in", async () => {
    const facts = campaign().slice(0, 120);
    const a = await runAnalysis(deps(new Counting()), input(facts));
    const b = await runAnalysis(deps(new Counting()), input([...facts].reverse()));
    expect(b.clusters.map((c) => c.key).sort()).toEqual(a.clusters.map((c) => c.key).sort());
  });

  it("re-attaches an override to the cluster that now holds its facts, after the cluster grew", async () => {
    const before = campaign().slice(0, 48); // topics 0 to 3
    const first = await runAnalysis(deps(new Counting()), input(before));
    const target = first.opportunities.find((o) => o.evidence.some((e) => e.factId === "f0100"))!;
    const anchor = {
      factIds: target.evidence.map((e) => e.factId),
      override: { title: "Admin chose this title" },
    };
    // A later run has more facts (a new interview added to topic 1) and the opportunities reorder.
    const grown = [
      ...before,
      {
        id: "z9999",
        sessionId: "s61",
        participantKey: "p61",
        fact: task(`Handling ${word(1, 0)} ${word(1, 1)} ${word(1, 2)} for ${word(1, 3)} v99${word(1, 4)}`),
      },
    ];
    const second = await runAnalysis(deps(new Counting()), input(grown, { anchoredOverrides: [anchor] }));
    const carried = second.opportunities.filter((o) => o.override?.title === "Admin chose this title");
    expect(carried).toHaveLength(1);
    expect(carried[0]?.title).toBe("Admin chose this title");
    expect(carried[0]?.evidence.some((e) => e.factId === "f0100")).toBe(true);
    expect(second.stats.orphanedOverrides).toBe(0);
  });
});

describe("matchOverrides", () => {
  const clusters = [
    { key: "A", factIds: ["1", "2", "3", "4"] },
    { key: "B", factIds: ["5", "6"] },
  ];
  it("accepts an anchor at half or more of its facts and orphans the rest", () => {
    const r = matchOverrides(clusters, [
      { factIds: ["1", "2", "x"], override: { title: "a" } }, // 2 of 3 in A
      { factIds: ["5", "y", "z"], override: { title: "b" } }, // 1 of 3: orphaned
    ]);
    expect(r.byKey.get("A")?.title).toBe("a");
    expect(r.byKey.has("B")).toBe(false);
    expect(r.orphaned).toHaveLength(1);
  });
  it("gives a cluster to the larger overlap when two anchors want it", () => {
    const r = matchOverrides(clusters, [
      { factIds: ["1", "9"], override: { title: "small" } },
      { factIds: ["1", "2", "3"], override: { title: "large" } },
    ]);
    expect(r.byKey.get("A")?.title).toBe("large");
    expect(r.orphaned.map((o) => o.override.title)).toEqual(["small"]);
  });
  it("orphans an anchor whose facts were deleted", () => {
    const r = matchOverrides(clusters, [{ factIds: ["gone"], override: { title: "t" } }]);
    expect(r.byKey.size).toBe(0);
    expect(r.orphaned).toHaveLength(1);
  });
});

describe("agglomerate at scale", () => {
  /** The straightforward average-linkage the optimized version must agree with. */
  function naive(vectors: number[][], threshold: number): number[][] {
    const clusters: number[][] = vectors.map((_, i) => [i]);
    const sim = vectors.map((a) => vectors.map((b) => cosine(a, b)));
    const link = (x: number[], y: number[]) => {
      let s = 0;
      for (const i of x) for (const j of y) s += sim[i]![j]!;
      return s / (x.length * y.length);
    };
    for (;;) {
      let best = -1;
      let bi = -1;
      let bj = -1;
      for (let i = 0; i < clusters.length; i++)
        for (let j = i + 1; j < clusters.length; j++) {
          const l = link(clusters[i]!, clusters[j]!);
          if (l > best) {
            best = l;
            bi = i;
            bj = j;
          }
        }
      if (best < threshold || bi < 0) break;
      const merged = [...clusters[bi]!, ...clusters[bj]!].sort((a, b) => a - b);
      clusters.splice(bj, 1);
      clusters.splice(bi, 1, merged);
    }
    return clusters.sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  }

  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  it("agrees with the plain algorithm on random vectors", () => {
    const rand = rng(7);
    for (const threshold of [0.2, 0.5, 0.8]) {
      const vectors = Array.from({ length: 60 }, () => Array.from({ length: 6 }, () => rand() - 0.3));
      expect(agglomerate(vectors, threshold)).toEqual(naive(vectors, threshold));
    }
  });

  it("clusters 1500 vectors in well under the time the cubic version needed", () => {
    const rand = rng(11);
    const centers = Array.from({ length: 30 }, () => Array.from({ length: 16 }, () => rand() - 0.5));
    const vectors = Array.from({ length: 1500 }, (_, i) =>
      centers[i % 30]!.map((x) => x + (rand() - 0.5) * 0.1),
    );
    const t = Date.now();
    const out = agglomerate(vectors, 0.9);
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(out.flat()).toHaveLength(1500);
  });

  it("orders drafts so neighbours are adjacent and chunks evenly", () => {
    const drafts = [0, 1, 2, 3].map((i) => ({
      id: `d${i}`,
      factIds: [`f${i}`],
      centroid: i % 2 === 0 ? [1, 0] : [0, 1],
    }));
    const ordered = orderBySimilarity(drafts);
    expect(ordered.map((d) => d.centroid[0])).toEqual([1, 1, 0, 0]);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
