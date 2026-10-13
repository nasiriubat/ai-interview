import type { Fact, ReportSection } from "@aidp/shared";
import { WEIGHT_PRESETS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { clusterStats, runAnalysis, type AnalysisFact } from "../../src/analysis/pipeline.js";
import { sanitizeSnippet } from "../../src/analysis/sanitize.js";
import type { CallRequest, ModelCaller } from "../../src/callModel.js";
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

const clusters = [
  { key: "solo", name: "Lab chasing", summary: "About this.", factIds: ["solo1"] },
  { key: "duo", name: "Pharmacy re-keying", summary: "About this.", factIds: ["duo1", "duo2"] },
  { key: "trio", name: "Charting twice", summary: "About this.", factIds: ["trio1", "trio2", "trio3"] },
];

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
    if (name === "clusters") return schema.parse({ clusters });
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
  asCaller(): ModelCaller {
    return this as unknown as ModelCaller;
  }
}

async function run(k = K) {
  const model = new Model();
  const result = await runAnalysis(
    {
      caller: model.asCaller(),
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
    const solo = byCluster("solo");

    expect(solo.stats.participants).toBe(1);
    expect(solo.evidence.map((e) => e.snippet)).toEqual([""]);
    expect(solo.stats.quotes).toEqual([]);
  });

  it("withholds the text for a cluster of two, one short of k", async () => {
    const { byCluster } = await run();
    const duo = byCluster("duo");

    expect(duo.stats.participants).toBe(2);
    expect(duo.evidence.map((e) => e.snippet)).toEqual(["", ""]);
    expect(duo.stats.quotes).toEqual([]);
  });

  it("shows the quotes, cleaned, for a cluster of exactly k", async () => {
    const { byCluster } = await run();
    const trio = byCluster("trio");

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

    expect(two.byCluster("duo").evidence.every((e) => e.snippet !== "")).toBe(true);
    expect(two.byCluster("solo").evidence.every((e) => e.snippet === "")).toBe(true);
    expect(four.byCluster("trio").evidence.every((e) => e.snippet === "")).toBe(true);
  });
});

describe("tools", () => {
  it("are a breakdown, so they are held back below k like roles and departments", async () => {
    const { byCluster } = await run();

    expect(byCluster("solo").stats.tools).toEqual([]);
    expect(byCluster("duo").stats.tools).toEqual([]);
    expect(byCluster("trio").stats.tools).toEqual(["WardChart"]);
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
    const solo = prompts.find((p) => p.includes("Lab chasing"))!;
    const duo = prompts.find((p) => p.includes("Pharmacy re-keying"))!;
    const trio = prompts.find((p) => p.includes("Charting twice"))!;

    expect(solo).not.toContain("call me on");
    expect(duo).not.toContain("my wrists hurt");
    expect(duo).toContain("Re-keying pharmacy orders");
    expect(trio).toContain("same numbers twice");
  });

  it("is never told quotes when it names clusters, because naming happens before membership is known", async () => {
    const { model } = await run();
    const naming = model.sent.find((m) => m.name === "clusters")!.content;

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
