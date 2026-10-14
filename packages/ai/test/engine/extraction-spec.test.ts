import { describe, expect, it } from "vitest";
import { extractFacts } from "../../src/engine/extraction.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { MemoryStore, ScriptedCaller, snapshot, template } from "./helpers.js";

const reqTemplate = template({ outputs: ["spec_field"] });

const spec = (section: string, path: string, value: unknown) => ({
  kind: "spec_field",
  section,
  path,
  value,
  source: "user",
});

async function fill(store: MemoryStore, answers: string[]) {
  for (const [i, a] of answers.entries()) {
    await store.appendMessage("s1", { role: "assistant", modality: "text", content: `Question ${i + 1}?` });
    await store.appendMessage("s1", { role: "user", modality: "text", content: a });
  }
}

/** Extraction used to append whatever sections and paths the model chose (D-190). */
describe("extraction of spec fields", () => {
  it("tells the extractor the capture rules for a template that produces a specification", async () => {
    const store = new MemoryStore();
    await fill(store, ["We need export"]);
    const caller = new ScriptedCaller([JSON.stringify({ facts: [] })]);
    await extractFacts(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      snapshot(reqTemplate),
    );
    const system = String(caller.requests[0]?.req.system);
    expect(system).toContain('section "functional" and path exactly "FR-<n>"');
    expect(system).not.toContain("{{specRules}}");
  });

  it("files extracted requirements as FR facts, moves one filed under rules and numbers after the known ones", async () => {
    const store = new MemoryStore();
    store.states.push({
      ...store.state,
      facts: [spec("functional", "FR-1", { title: "Enter once", scope: "mvp", acceptance: ["a"] })] as never,
    });
    await fill(store, ["We need export to Excel and a search", "Nurses sign off"]);
    const caller = new ScriptedCaller([
      JSON.stringify({
        facts: [
          spec("rules", "export", { title: "Export to Excel", scope: "future", acceptance: ["file"] }),
          spec("functional", "FR-1", { title: "Search by patient", scope: "mvp", acceptance: ["list"] }),
          spec("Business Rules", "signoff", "A note is locked once signed"),
          spec("functional", "FR-1", { title: "Enter once", scope: "mvp", acceptance: ["a"] }),
        ],
      }),
    ]);
    const r = await extractFacts(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      { ...snapshot(reqTemplate), state: store.state },
    );
    const filed = r.facts.flatMap((f) => (f.kind === "spec_field" ? [`${f.section}/${f.path}`] : []));
    // The identical requirement is not appended a second time; the clash on FR-1 became FR-3.
    expect(filed).toEqual(["functional/FR-2", "functional/FR-3", "rules/signoff"]);
    expect(r.facts.some((f) => f.kind === "spec_field" && f.section === "rules" && f.path === "export")).toBe(
      false,
    );
  });

  it("keeps what it cannot file as an open question instead of losing it", async () => {
    const store = new MemoryStore();
    await fill(store, ["Something odd"]);
    const caller = new ScriptedCaller([JSON.stringify({ facts: [spec("vibes", "mood", "good")] })]);
    const r = await extractFacts(
      { caller: caller.asCaller(), store, prompts: new ShippedPromptSource() },
      snapshot(reqTemplate),
    );
    expect(r.facts).toMatchObject([{ section: "open_questions", path: "vibes.mood" }]);
  });
});
