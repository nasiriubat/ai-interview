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
