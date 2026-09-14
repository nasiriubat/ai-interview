import { describe, expect, it } from "vitest";
import { extractFacts } from "../../src/engine/extraction.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { updateRollingSummary } from "../../src/engine/summary.js";
import { MemoryStore, ScriptedCaller, snapshot, template } from "./helpers.js";

async function fill(store: MemoryStore, turns: number) {
  for (let i = 1; i <= turns; i++) {
    await store.appendMessage("s1", { role: "assistant", modality: "text", content: `Question ${i}?` });
    await store.appendMessage("s1", {
      role: "user",
      modality: "text",
      content: i === 2 ? "We reconcile supplier invoices in Excel every Friday" : `Answer ${i}`,
    });
  }
}

describe("rolling summary", () => {
  it("folds only turns older than the window and records the sequence", async () => {
    const store = new MemoryStore();
    await fill(store, 8); // 16 messages
    const caller = new ScriptedCaller(["Summary: supplier invoices reconciled in Excel on Fridays."]);
    const r = await updateRollingSummary(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      snapshot(template()),
      3,
    );
    expect(r).toEqual({ updated: true, upToSeq: 10 }); // 16 - 6 kept
    expect(store.summaries[0]).toContain("Excel");
    expect(store.state.summaryUpToSeq).toBe(10);
    const again = await updateRollingSummary(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      { ...snapshot(template()), state: store.state },
      3,
    );
    expect(again.updated).toBe(false);
  });
});

describe("extraction", () => {
  it("extracts only the template's fact kinds and advances the cursor", async () => {
    const store = new MemoryStore();
    await fill(store, 2);
    const caller = new ScriptedCaller([
      JSON.stringify({
        facts: [
          {
            kind: "task",
            name: "Invoice reconciliation",
            frequency: "weekly",
            minutesPerOccurrence: 90,
            tools: ["Excel"],
            painScore: 6,
          },
          { kind: "process", name: "x", steps: ["a"] },
        ],
      }),
    ]);
    const r = await extractFacts(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      snapshot(template()),
    );
    expect(r.facts.map((f) => f.kind)).toEqual(["task"]);
    expect(r.upToSeq).toBe(4);
    expect(store.state.facts).toHaveLength(1);
    expect(store.events[0]?.type).toBe("facts_extracted");
  });
});

describe("lexical recall", () => {
  it("finds older participant turns by keyword and skips the recent window", async () => {
    const store = new MemoryStore();
    await fill(store, 8);
    const hits = await new LexicalRecall(store, 2).recall("s1", "invoices Excel", 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.seq).toBe(4);
    expect(await new LexicalRecall(store, 10).recall("s1", "invoices", 3)).toEqual([]);
  });
});

describe("live-model tolerance", () => {
  it("accepts a bare array from the extraction pass and drops malformed facts", async () => {
    const store = new MemoryStore();
    await fill(store, 2);
    const caller = new ScriptedCaller([
      JSON.stringify([
        {
          kind: "task",
          name: "Reconcile invoices",
          frequency: "weekly",
          minutesPerOccurrence: 60,
          tools: ["Excel"],
          painScore: 5,
        },
        { kind: "task", name: "broken" },
      ]),
    ]);
    const r = await extractFacts(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      snapshot(template()),
    );
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]).toMatchObject({ kind: "task", name: "Reconcile invoices" });
  });
});

describe("extraction batches", () => {
  it("works off a backlog in batches, persisting state after each so a later failure loses nothing", async () => {
    const store = new MemoryStore();
    await fill(store, 30); // 60 messages: three batches of 24, 24, 12
    const fact = (name: string) =>
      JSON.stringify({
        facts: [{ kind: "task", name, frequency: "daily", minutesPerOccurrence: 5, tools: [], painScore: 1 }],
      });
    const caller = new ScriptedCaller([fact("a"), fact("b"), "{ not json"]);
    await expect(
      extractFacts(
        { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
        snapshot(template()),
      ),
    ).rejects.toThrow();
    expect(caller.requests).toHaveLength(3);
    expect(store.state.lastExtractedSeq).toBe(48);
    expect(store.state.facts.map((f) => (f.kind === "task" ? f.name : ""))).toEqual(["a", "b"]);
    expect(store.events.filter((e) => e.type === "facts_extracted")).toHaveLength(2);
    // The next run picks up only the remaining messages.
    const again = new ScriptedCaller([fact("c")]);
    const r = await extractFacts(
      { caller: again.asCaller(), store, prompts: new ShippedPromptSource() },
      { ...snapshot(template()), state: store.state },
    );
    expect(r).toMatchObject({ upToSeq: 60 });
    expect(String(again.requests[0]?.req.messages[0]?.content)).toContain("Question 25?");
    expect(String(again.requests[0]?.req.messages[0]?.content)).not.toContain("Question 24?");
  });
});
