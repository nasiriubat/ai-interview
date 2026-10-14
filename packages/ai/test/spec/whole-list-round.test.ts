import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { generateSpec, type SpecGenerationInput } from "../../src/spec/generate.js";
import { ScriptedCaller } from "../engine/helpers.js";

const logger = { warn: () => undefined, info: () => undefined };
const now = () => new Date("2026-10-14T10:00:00Z");

describe("the whole-list round finds a restatement in other words (D-290)", () => {
  const titles = [
    "Nurse enters a ward note",
    "Team leader gets a morning alert",
    "Export weekly figures to a spreadsheet",
    "Lock a note after two days",
    "Finance reads hours per nurse",
    "Pharmacy sees flagged medication",
    "Sign in with a hospital badge",
    "Send the ward record to the hospital system",
  ];
  const state = SessionStateSchema.parse({
    facts: titles.map((title, i) => ({
      kind: "spec_field",
      section: "functional",
      path: `FR-${i + 1}`,
      value: { title, scope: "mvp", acceptance: [`works ${i + 1}`] },
      source: "user",
    })),
  });
  const input: SpecGenerationInput = {
    companyId: "c",
    sessionId: "s",
    title: "Ward",
    language: "en",
    path: "nontechnical",
    state,
    summary: "",
    edits: {},
    sections: ["overview", "functional"],
    diagramTypes: [],
    bundleFormat: "claude_code",
  };

  it("merges words-apart duplicates the overlap never offered, and keeps both sets of acceptance", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [{ ids: ["FR-1", "FR-8"] }] }),
      JSON.stringify({ title: "T", sections: [], requirements: [] }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(caller.requests).toHaveLength(2);
    const ids = r.document.requirements.map((q) => q.id);
    expect(ids).toContain("FR-1");
    expect(ids).not.toContain("FR-8");
    expect(r.document.requirements.find((q) => q.id === "FR-1")?.acceptance).toEqual([
      "works 1",
      "works 8",
      // The restatement shares no words with its survivor, so its title is kept as a check (D-301).
      "Send the ward record to the hospital system",
    ]);
    expect(r.curation.merged).toEqual([{ into: "FR-1", from: ["FR-8"], via: "model" }]);
  });

  it("keeps all of them when the model finds nothing repeated", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ groups: [] }),
      JSON.stringify({ title: "T", sections: [], requirements: [] }),
    ]);
    const r = await generateSpec(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger, now },
      input,
    );
    expect(r.document.requirements).toHaveLength(8);
  });
});
