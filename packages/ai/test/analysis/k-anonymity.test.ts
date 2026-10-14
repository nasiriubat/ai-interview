import type { Fact, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { stableClusterKey } from "../../src/analysis/clustering.js";
import { clusterStats, runAnalysis, type AnalysisFact } from "../../src/analysis/pipeline.js";
import { sanitizeSnippet } from "../../src/analysis/sanitize.js";
import type { CallRequest } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";

/**
 * k-anonymity for evidence, tools and the words a model is shown (D-143). A cluster of one, of two
 * and of exactly k are built from real pipeline runs, so what is asserted is what a report holds.
 */
const K = 3;
const logger = { warn: () => undefined, info: () => undefined };

const task = (name: string, tools: string[], quote: string): Fact => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 20,
  tools,
  painScore: 5,
  quote,
});

/** One fact per participant, so a cluster of n facts is a cluster of n participants. */
const member = (
  id: string,
  participant: string,
  name: string,
  tools: string[],
  quote: string,
): AnalysisFact => ({
  id,
  sessionId: `s_${participant}`,
  participantKey: participant,
  role: "Nurse",
  fact: task(name, tools, quote),
});

const facts: AnalysisFact[] = [
  member(
    "solo1",
    "p1",
    "Chasing the lab by phone",
    ["SecretLabPortal"],
    "call me on +358 40 123 4567 or mia@ward.example",
  ),
  member("duo1", "p2", "Re-keying pharmacy orders", ["PharmaSheet"], "I retype the whole order sheet"),
  member("duo2", "p3", "Re-keying pharmacy orders again", ["PharmaSheet"], "my wrists hurt from retyping"),
  member(
    "trio1",
    "p4",
    "Charting twice",
    ["WardChart"],
    "I chart in two places, see https://intranet.example/chart",
  ),
  member("trio2", "p5", "Charting in two systems", ["WardChart"], "same numbers twice"),
  member("trio3", "p6", "Double charting", ["WardChart"], "**double** work every shift"),
];

/** Cluster keys are derived from member fact ids (stableClusterKey), so the tests name them the same way. */
const KEY = {
  solo: stableClusterKey(["solo1"]),
  duo: stableClusterKey(["duo1", "duo2"]),
  trio: stableClusterKey(["trio1", "trio2", "trio3"]),
};

/** The draft clusters the model was shown, read back out of the delimited blocks. */
function draftsIn(content: string): { id: string; text: string }[] {
  return [
    ...content.matchAll(/<untrusted-[0-9a-f]+ kind="draft_cluster" id="(\w+)">\n([\s\S]*?)\n<\/untrusted-/g),
  ].map((m) => ({ id: m[1]!, text: m[2]! }));
}

class Model {
  /** Every user message sent for each schema name, so the prompts can be inspected. */
  sent: { name: string; content: string }[] = [];
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
    this.sent.push({ name: name ?? "", content });
    if (name === "cluster_merges") {
      // Merge the drafts of one topic, whatever ids the pipeline gave them.
      const drafts = draftsIn(content);
      const merges = [];
      const names = [];
      for (const [word, label] of [
        ["pharmacy", "Pharmacy re-keying"],
        ["chart", "Charting twice"],
      ] as const) {
        const ids = drafts.filter((d) => d.text.toLowerCase().includes(word)).map((d) => d.id);
        if (ids.length >= 2) merges.push({ ids, name: label, summary: "About this." });
        else if (ids[0]) names.push({ id: ids[0], name: label, summary: "About this." });
      }
      return schema.parse({ merges, names });
    }
    if (name === "opportunity") {
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
  /** The analysis never streams a chat turn; the port asks for it, so it is refused loudly. */
  chat(): AsyncIterable<never> {
    throw new Error("the analysis does not use chat");
  }
}

async function run(k = K) {
  const model = new Model();
  const result = await runAnalysis(
    {
      caller: model,
      prompts: new ShippedPromptSource(),
      logger,
      now: () => new Date("2026-10-01"),
    },
    {
      companyId: "c1",
      campaignId: "camp",
      campaignName: "Ward",
      facts,
      participation: { invited: 10, completed: 6, sessionsAnalyzed: 6 },
      thresholdMet: true,
      k,
      weights: WEIGHT_PRESETS.balanced,
      similarityThreshold: 0.5,
      language: "en",
      sections: ["executive_summary", "participation", "work_map", "opportunities"] as ReportSection[],
      overrides: {},
    },
  );
  const byCluster = (key: string) => result.opportunities.find((o) => o.clusterKey === key)!;
  return { model, result, byCluster };
}

describe("evidence snippets", () => {
  it("withholds the text for a cluster of one", async () => {
    const { byCluster } = await run();
    const solo = byCluster(KEY.solo);

    expect(solo.stats.participants).toBe(1);
    expect(solo.evidence.map((e) => e.snippet)).toEqual([""]);
    expect(solo.stats.quotes).toEqual([]);
  });

  it("withholds the text for a cluster of two, one short of k", async () => {
    const { byCluster } = await run();
    const duo = byCluster(KEY.duo);

    expect(duo.stats.participants).toBe(2);
    expect(duo.evidence.map((e) => e.snippet)).toEqual(["", ""]);
    expect(duo.stats.quotes).toEqual([]);
  });

  it("shows the quotes, cleaned, for a cluster of exactly k", async () => {
    const { byCluster } = await run();
    const trio = byCluster(KEY.trio);

    expect(trio.stats.participants).toBe(3);
    expect(trio.evidence.map((e) => e.snippet).sort()).toEqual([
      "I chart in two places, see [link]",
      "double work every shift",
      "same numbers twice",
    ]);
    expect(trio.stats.quotes).toHaveLength(3);
  });

  it("follows the k in force: at k = 2 the pair is shown, at k = 4 the trio is withheld", async () => {
    const two = await run(2);
    const four = await run(4);

    expect(two.byCluster(KEY.duo).evidence.every((e) => e.snippet !== "")).toBe(true);
    expect(two.byCluster(KEY.solo).evidence.every((e) => e.snippet === "")).toBe(true);
    expect(four.byCluster(KEY.trio).evidence.every((e) => e.snippet === "")).toBe(true);
  });
});

describe("tools", () => {
  it("are a breakdown, so they are held back below k like roles and departments", async () => {
    const { byCluster } = await run();

    expect(byCluster(KEY.solo).stats.tools).toEqual([]);
    expect(byCluster(KEY.duo).stats.tools).toEqual([]);
    expect(byCluster(KEY.trio).stats.tools).toEqual(["WardChart"]);
    expect(clusterStats(facts.slice(0, 1), K).tools).toEqual([]);
    expect(clusterStats(facts.slice(3, 6), K).tools).toEqual(["WardChart"]);
  });
});

describe("the report", () => {
  it("carries no quote, tool or process detail from a cluster below k, and says why", async () => {
    const { result } = await run();
    const md = result.report.markdown;

    expect(md).not.toContain("SecretLabPortal");
    expect(md).not.toContain("PharmaSheet");
    expect(md).not.toContain("mia@ward.example");
    expect(md).not.toContain("my wrists hurt");
    expect(md).toContain("Fewer than 3 participants described this");
    expect(md).toContain("WardChart");
    expect(md).toContain("same numbers twice");
  });
});

describe("what the model is shown", () => {
  it("is not told a participant's words when the cluster is below k", async () => {
    const { model } = await run();
    const prompts = model.sent.filter((m) => m.name === "opportunity").map((m) => m.content);
    const solo = prompts.find((p) => p.includes("Chasing the lab"))!;
    const duo = prompts.find((p) => p.includes("Pharmacy re-keying"))!;
    const trio = prompts.find((p) => p.includes("Charting twice"))!;

    expect(solo).not.toContain("call me on");
    expect(duo).not.toContain("my wrists hurt");
    expect(duo).toContain("Re-keying pharmacy orders");
    expect(trio).toContain("same numbers twice");
  });

  it("is never told quotes when it names clusters, because naming happens before membership is known", async () => {
    const { model } = await run();
    const naming = model.sent.find((m) => m.name === "cluster_merges")!.content;

    expect(naming).not.toContain("my wrists hurt");
    expect(naming).not.toContain("same numbers twice");
    expect(naming).toContain("Re-keying pharmacy orders");
  });
});

describe("sanitizeSnippet", () => {
  it("replaces addresses, links and phone numbers and drops markup", () => {
    expect(sanitizeSnippet("mail mia.k@ward.example or call +358 40 123 4567")).toBe(
      "mail [email] or call [number]",
    );
    expect(sanitizeSnippet("see https://intranet.example/a?b=1 and www.example.org/x")).toBe(
      "see [link] and [link]",
    );
    expect(sanitizeSnippet("a <b>bold</b> <img src=x onerror=y> claim [click](http://evil.example)")).toBe(
      "a bold claim click",
    );
  });

  it("replaces long digit runs such as employee numbers and leaves ordinary numbers alone", () => {
    expect(sanitizeSnippet("employee 20481937 said")).toBe("employee [number] said");
    expect(sanitizeSnippet("it takes 45 minutes, 3 times a week")).toBe(
      "it takes 45 minutes, 3 times a week",
    );
  });
});
