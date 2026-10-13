import { extractFacts, promptVersionTag, ShippedPromptSource, SHIPPED_PROMPTS } from "@aidp/ai";
import { InterviewTemplateSchema, type InterviewTemplate } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { MemorySessionStore, ScriptedModel, type CommitFailPoint } from "../src/index.js";

const template: InterviewTemplate = InterviewTemplateSchema.parse({
  key: "t",
  version: 1,
  name: "Test",
  objective: "Understand the work.",
  privacyMode: "anonymous",
  coverageAreas: [{ key: "a", name: "A", description: "A.", doneWhen: "A known.", essential: true }],
  outputs: ["task", "pain_point"],
});

const task = (name: string) => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 5,
  tools: [],
  painScore: 1,
});
const reply = (...names: string[]) => JSON.stringify({ facts: names.map(task) });

/** 60 messages: three batches of 24, 24 and 12. */
async function backlog(store: MemorySessionStore): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await store.appendMessage("s1", { role: "assistant", modality: "text", content: `Question ${i}?` });
    await store.appendMessage("s1", { role: "user", modality: "text", content: `Answer ${i}` });
  }
}

const newStore = () => new MemorySessionStore({ template });

const run = async (store: MemorySessionStore, model: ScriptedModel) =>
  extractFacts({ caller: model, store, prompts: new ShippedPromptSource() }, await store.snapshot());

describe("session.extract commits per batch (D-100)", () => {
  it("writes state, rows and event together and stamps the prompt's own version", async () => {
    const store = newStore();
    await backlog(store);
    const model = new ScriptedModel([reply("a", "b"), reply("c"), reply("d")]);

    const r = await run(store, model);

    expect(r).toMatchObject({ upToSeq: 60, stale: false });
    expect(store.state.facts).toHaveLength(4);
    expect(store.factRows).toHaveLength(4);
    expect(store.factRows.map((f) => [f.batchEndSeq, f.ordinal])).toEqual([
      [24, 0],
      [24, 1],
      [48, 0],
      [60, 0],
    ]);
    // Never a literal: the version is whatever the prompt object says it is.
    expect(new Set(store.factRows.map((f) => f.extractorVersion))).toEqual(
      new Set([promptVersionTag(SHIPPED_PROMPTS.extraction!)]),
    );
    expect(store.events.filter((e) => e.type === "facts_extracted")).toHaveLength(3);
  });

  it("a rerun after success adds nothing: no duplicate rows, no duplicate facts", async () => {
    const store = newStore();
    await backlog(store);
    await run(store, new ScriptedModel([reply("a"), reply("b"), reply("c")]));
    const again = new ScriptedModel([reply("a"), reply("b"), reply("c")]);

    await run(store, again);

    expect(again.calls).toHaveLength(0);
    expect(store.factRows).toHaveLength(3);
    expect(store.state.facts).toHaveLength(3);
  });

  it("a failure injected between the state write and the row write rolls both back, and the retry loses nothing", async () => {
    const store = newStore();
    await backlog(store);
    store.failAt = "after_state";

    await expect(run(store, new ScriptedModel([reply("a")]))).rejects.toThrow("injected failure after_state");
    // Neither the cursor nor the facts moved: the pre-fix code advanced the cursor here and lost the batch.
    expect(store.state.lastExtractedSeq).toBe(0);
    expect(store.state.facts).toHaveLength(0);
    expect(store.factRows).toHaveLength(0);

    store.failAt = undefined;
    await run(store, new ScriptedModel([reply("a"), reply("b"), reply("c")]));
    expect(store.state.lastExtractedSeq).toBe(60);
    expect(store.factRows).toHaveLength(3);
    expect(store.state.facts).toHaveLength(3);
  });

  it("a model failure on batch 2 of 3 leaves batch 1 durable and the retry resumes at batch 2", async () => {
    const store = newStore();
    await backlog(store);
    const failing = new ScriptedModel([reply("a"), new Error("provider down")]);

    await expect(run(store, failing)).rejects.toThrow("provider down");
    expect(store.state.lastExtractedSeq).toBe(24);
    expect(store.factRows).toHaveLength(1);

    const retry = new ScriptedModel([reply("b"), reply("c")]);
    await run(store, retry);
    expect(retry.calls).toHaveLength(2);
    expect(String(retry.calls[0]?.req.messages[0]?.content)).toContain("Question 12?");
    expect(String(retry.calls[0]?.req.messages[0]?.content)).not.toContain("Question 11?");
    expect(store.factRows.map((f) => f.batchEndSeq)).toEqual([24, 48, 60]);
  });

  it("an overlapping run that lost the race writes nothing and says so", async () => {
    const store = newStore();
    await backlog(store);
    // Two runs read the same snapshot; the first commits, the second's compare-and-set fails.
    const snap = await store.snapshot();
    const first = new ScriptedModel([reply("a"), reply("b"), reply("c")]);
    await extractFacts({ caller: first, store, prompts: new ShippedPromptSource() }, snap);
    const second = await extractFacts(
      { caller: new ScriptedModel([reply("x")]), store, prompts: new ShippedPromptSource() },
      { ...snap, state: { ...snap.state, lastExtractedSeq: 0 } },
    );

    expect(second.stale).toBe(true);
    expect(second.facts).toHaveLength(0);
    expect(store.factRows).toHaveLength(3);
  });

  it("a session deleted mid-run is not resurrected", async () => {
    const store = newStore();
    await backlog(store);
    store.status = "deleted";

    const r = await run(store, new ScriptedModel([reply("a")]));

    expect(r.stale).toBe(true);
    expect(store.factRows).toHaveLength(0);
  });

  it.each<CommitFailPoint>(["after_state", "after_rows", "after_event"])(
    "property: a failure at %s in any batch never leaves state facts and rows disagreeing",
    async (point) => {
      for (const failingBatch of [0, 1, 2]) {
        const store = newStore();
        await backlog(store);
        // Fail the commit of batch `failingBatch` by arming the hook when that batch is reached.
        const armed = new ScriptedModel([reply("a"), reply("b"), reply("c")]);
        let reached = 0;
        const original = store.commitExtraction.bind(store);
        store.commitExtraction = async (id, c) => {
          store.failAt = reached++ === failingBatch ? point : undefined;
          return original(id, c);
        };

        await expect(run(store, armed)).rejects.toThrow("injected failure");
        expect(store.state.facts).toHaveLength(store.factRows.length);
        expect(store.state.facts).toHaveLength(failingBatch);

        // And the retry always ends in the same place.
        store.commitExtraction = original;
        store.failAt = undefined;
        await run(store, new ScriptedModel([reply("a"), reply("b"), reply("c")]));
        expect(store.state.lastExtractedSeq).toBe(60);
        expect(store.state.facts).toHaveLength(store.factRows.length);
        expect(store.factRows).toHaveLength(3);
      }
    },
  );
});
