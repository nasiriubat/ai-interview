import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { generateSpec, type SpecGenerationInput } from "../../src/spec/generate.js";
import {
  judgeCandidatePairs,
  MAX_CLUSTER_SIZE,
  MAX_MERGE_CALLS,
  MAX_MERGE_ITEMS,
} from "../../src/spec/merge.js";
import type { DuplicatePair, ReqView } from "../../src/spec/quality.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-10-14T10:00:00Z");

const view = (id: string, title: string): ReqView => ({ id, title, scope: "mvp", acceptance: ["a"] });
const pair = (a: string, b: string, kind: DuplicatePair["kind"] = "candidate"): DuplicatePair => ({
  a,
  b,
  score: 0.5,
  kind,
});
const deps = (caller: ScriptedCaller) => ({
  caller: caller.asCaller(),
  prompts: new ShippedPromptSource(),
  logger,
});

describe("the grouped merge pass over near-duplicate components (D-241, D-290)", () => {
  it("asks one call per batch of components, shows clusters only, and returns groups as merges", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({
        groups: [
          { ids: ["FR-1", "FR-2", "FR-5"] },
          { ids: ["FR-3", "FR-9"] }, // FR-9 is not in the cluster: no group
        ],
      }),
    ]);
    const r = await judgeCandidatePairs(deps(caller), {
      companyId: "c",
      sessionId: "s",
      reqs: [
        view("FR-1", "A"),
        view("FR-2", "A again"),
        view("FR-3", "B"),
        view("FR-4", "C"),
        view("FR-5", "A thrice"),
      ],
      pairs: [
        pair("FR-1", "FR-2"),
        pair("FR-2", "FR-5"),
        pair("FR-3", "FR-4"),
        pair("FR-7", "FR-8", "exact"),
      ],
    });
    expect(caller.requests).toHaveLength(1);
    expect(caller.requests[0]?.purpose).toBe("issue_detection");
    const body = String(caller.requests[0]?.req.messages[0]?.content);
    expect(body).toContain("Cluster 1");
    expect(body).toContain("Cluster 2");
    expect(body).toContain("FR-1: A");
    expect(body).not.toContain("FR-7"); // the exact pair is merged without a model
    // A group with an id from another cluster contributes only its own cluster's members.
    expect(r.same).toEqual([
      { a: "FR-1", b: "FR-2" },
      { a: "FR-1", b: "FR-5" },
    ]);
    // FR-3 and FR-4 were looked at and kept apart.
    expect(r.different).toEqual([{ a: "FR-3", b: "FR-4" }]);
  });

  it("makes no call when no pair needs one, cuts a large component, and stops at the call limit", async () => {
    const none = new ScriptedCaller([]);
    await judgeCandidatePairs(deps(none), {
      companyId: "c",
      sessionId: "s",
      reqs: [],
      pairs: [pair("FR-1", "FR-2", "exact")],
    });
    expect(none.requests).toHaveLength(0);

    // One chain of candidates longer than a cluster is cut in id order.
    const chain = new ScriptedCaller([JSON.stringify({ groups: [] }), JSON.stringify({ groups: [] })]);
    const n = MAX_CLUSTER_SIZE + 3;
    await judgeCandidatePairs(deps(chain), {
      companyId: "c",
      sessionId: "s",
      reqs: [],
      pairs: Array.from({ length: n - 1 }, (_, i) => pair(`FR-${i + 1}`, `FR-${i + 2}`)),
    });
    const shown = chain.requests.flatMap((q) => String(q.req.messages[0]?.content).match(/FR-\d+/g) ?? []);
    expect(Math.max(...shown.map((s) => Number(s.slice(3))))).toBe(n);

    // Many disjoint pairs: bounded by calls and items.
    const many = new ScriptedCaller(
      Array.from({ length: MAX_MERGE_CALLS + 2 }, () => JSON.stringify({ groups: [] })),
    );
    const pairs = Array.from({ length: MAX_MERGE_ITEMS * MAX_MERGE_CALLS }, (_, i) =>
      pair(`FR-${i}`, `FR-${i + 1000}`),
    );
    await judgeCandidatePairs(deps(many), { companyId: "c", sessionId: "s", reqs: [], pairs });
    expect(many.requests).toHaveLength(MAX_MERGE_CALLS);
    const sent = String(many.requests[0]?.req.messages[0]?.content).match(/Cluster \d+/g) ?? [];
    expect(sent).toHaveLength(MAX_MERGE_ITEMS / 2);
  });

  it("reads the id from a group that echoes the whole line it was shown (seen live)", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({
        groups: [
          {
            ids: [
              "FR-1: Confirm note before Epic | acceptance: a note is not sent until confirmed",
              "FR-2: Nurse review of notes before sending | acceptance: one review",
            ],
          },
        ],
      }),
    ]);
    const r = await judgeCandidatePairs(deps(caller), {
      companyId: "c",
      sessionId: "s",
      reqs: [view("FR-1", "Confirm note before Epic"), view("FR-2", "Nurse review of notes")],
      pairs: [pair("FR-1", "FR-2")],
    });
    expect(r.same).toEqual([{ a: "FR-1", b: "FR-2" }]);
  });

  it("keeps the candidates apart when the call fails instead of failing the specification", async () => {
    const caller = new ScriptedCaller(["{ not json"]);
    const r = await judgeCandidatePairs(deps(caller), {
      companyId: "c",
      sessionId: "s",
      reqs: [view("FR-1", "A"), view("FR-2", "B")],
      pairs: [pair("FR-1", "FR-2")],
    });
    expect(r).toEqual({ same: [], different: [] });
  });
});

describe("generation curates before it writes (D-241 to D-243)", () => {
  const fr = (n: number, title: string, extra: object = {}) => ({
    kind: "spec_field" as const,
    section: "functional",
    path: `FR-${n}`,
    value: { title, scope: "mvp", acceptance: [`works ${n}`], ...extra },
    source: "user" as const,
  });
  const input: SpecGenerationInput = {
    companyId: "c",
    sessionId: "s",
    title: "Ward notes",
    language: "en",
    path: "nontechnical",
    state: SessionStateSchema.parse({
      facts: [
        fr(1, "Nurse enters a ward note once", { evidence: "type it once" }),
        fr(2, "The nurse enters the ward note once"),
        fr(3, "Retry failed Epic save"),
        fr(4, "Retry failed Epic save after a timeout or an error message"),
        fr(5, "Removed"),
        fr(6, "Should notes be kept for ten years?"),
      ],
    }),
    summary: "",
    edits: {},
    sections: ["overview", "functional"],
    diagramTypes: [],
    bundleFormat: "claude_code",
  };

  it("writes one requirement for a duplicated capability, reroutes the question, drops the tombstone, and records mergedFrom", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [{ ids: ["FR-3", "FR-4"] }] }),
      JSON.stringify({ title: "T", sections: [{ key: "overview", markdown: "o" }], requirements: [] }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(r.document.requirements.map((q) => q.id)).toEqual(["FR-1", "FR-3"]);
    expect(r.document.requirements[0]?.mergedFrom).toEqual(["FR-2"]);
    expect(r.document.requirements[0]?.evidence).toBe("type it once");
    expect(r.document.requirements[1]?.mergedFrom).toEqual(["FR-4"]);
    expect(r.curation.rerouted).toEqual([{ id: "FR-6", as: "question", section: "open_questions" }]);
    expect(r.curation.withdrawn).toEqual(["FR-5"]);
    // The generator is shown the curated state, not the duplicates.
    const prompt = String(caller.requests[1]?.req.messages[0]?.content);
    expect(prompt).not.toContain("The nurse enters the ward note once");
    expect(r.stats.requirements).toBe(2);
  });

  it("keeps what the quality pass learned when the model echoes the requirement, and folds a model-added restatement", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [{ ids: ["FR-3", "FR-4"] }] }),
      JSON.stringify({
        title: "T",
        sections: [],
        requirements: [
          { id: "FR-1", title: "Nurse enters a ward note once", scope: "mvp", acceptance: ["reworded"] },
          {
            id: "roster_membership",
            title: "Nurse enters a ward note once",
            scope: "mvp",
            acceptance: ["adds a check"],
          },
        ],
      }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    const first = r.document.requirements.find((q) => q.id === "FR-1");
    expect(first?.evidence).toBe("type it once");
    expect(first?.mergedFrom).toEqual(["FR-2", "roster_membership"]);
    expect(first?.acceptance).toEqual(["reworded", "adds a check"]);
    expect(r.document.requirements.some((q) => q.id === "roster_membership")).toBe(false);
  });

  it("does not fold a model-added requirement into a different capability that shares a word", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [] }),
      JSON.stringify({
        title: "T",
        sections: [],
        requirements: [{ id: "FR-40", title: "Edit a note", scope: "mvp", acceptance: ["x"] }],
      }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(r.document.requirements.find((q) => q.id === "FR-40")?.needsConfirmation).toBe(true);
  });

  it("flags a requirement only the model wrote as needing confirmation, and never drops one the interview recorded", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [] }),
      JSON.stringify({
        title: "T",
        sections: [],
        requirements: [{ id: "FR-40", title: "Invented export", scope: "mvp", acceptance: ["x"] }],
      }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    const invented = r.document.requirements.find((q) => q.id === "FR-40");
    expect(invented?.needsConfirmation).toBe(true);
    expect(r.document.requirements.map((q) => q.id)).toEqual(["FR-1", "FR-3", "FR-4", "FR-40"]);
  });
});
