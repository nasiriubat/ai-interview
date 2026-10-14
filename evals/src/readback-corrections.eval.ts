import {
  generateSpec,
  InterviewEngine,
  LexicalRecall,
  ShippedPromptSource,
  UNREVIEWED_LIST_QUESTION,
  type EngineEvent,
  type SessionSnapshot,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import type { Path } from "@aidp/shared";
import { MemorySessionStore } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/charting-nontechnical.json" with { type: "json" };
import { RequirementsScriptedModel } from "./requirements-model.js";

/**
 * The read-back with an owner who disagrees (D-290, D-249). The list is read back through the
 * finding flow (D-244); the owner edits one item, withdraws one and adds one. The checks are on
 * what the engine does with such an answer and on what the specification then says: a corrected
 * title replaces the old one under the same id, a withdrawn item is gone from every view, a new
 * item is a new FR, and none of it is lost on the way through curation and generation. Whether a
 * real model records the corrections is the live half (`live/readback.live.ts`).
 */

const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 120,
};
const logger = { warn: () => undefined, info: () => undefined };

const fr = (path: string, value: Record<string, unknown>) => ({
  kind: "spec_field" as const,
  section: "functional",
  path,
  value,
  source: "user" as const,
});

/** A specification model that adds nothing of its own: the document is the recorded list. */
const specCaller = {
  chat: async function* () {
    /* unused */
  },
  complete: async (_p: unknown, _c: unknown, _r: unknown, schema: { parse(x: unknown): unknown }) =>
    schema.parse({ title: "Charting", sections: [], requirements: [] }),
  embed: async () => undefined,
};

async function interview(opts: { corrections: unknown[]; stopAtReadBack: boolean; stopAtFacts?: boolean }) {
  const template = shippedTemplate(fixture.templateKey);
  if (!template) throw new Error("template missing");
  const store = new MemorySessionStore();
  const model = new RequirementsScriptedModel(template, opts.corrections);
  const engine = new InterviewEngine({
    caller: model,
    store,
    prompts: new ShippedPromptSource(),
    recall: new LexicalRecall(store, 10),
    logger,
  });
  const session: SessionSnapshot = {
    id: "eval",
    companyId: "c",
    template,
    state: store.state,
    summary: "",
    path: fixture.path as Path,
  };
  const focuses: string[] = [];
  const run = async (answer?: string | { control: { type: "finish" } }) => {
    const gen = engine.nextTurn(
      { ...session, state: store.state },
      typeof answer === "string" ? { content: answer, modality: "text" } : answer,
      settings,
    );
    let r = await gen.next();
    while (!r.done) {
      const ev: EngineEvent = r.value;
      if (ev.type === "turn")
        focuses.push(ev.focus.mode === "finding" ? `finding:${ev.focus.findingId}` : ev.focus.mode);
      r = await gen.next();
    }
    return r.value;
  };
  const readBackRaised = () =>
    store.state.findings.some(
      (f) => f.description.startsWith("Requirements confirmation.") && f.status !== "open",
    );
  let result = await run();
  let turns = 1;
  const answers = [...fixture.answers];
  while (!result.ended && turns < 80) {
    if (opts.stopAtReadBack && readBackRaised()) break;
    if (opts.stopAtFacts && store.state.facts.some((f) => f.kind === "spec_field" && /^FR-\d+$/.test(f.path)))
      break;
    result = await run(answers.shift() ?? "Yes, that is right, go on.");
    turns++;
  }
  return { store, template, session, run, focuses };
}

describe("the read-back with an owner who disagrees (D-290)", () => {
  it("applies an edit, a withdrawal and an addition, and the specification reflects all three", async () => {
    const { store } = await interview({
      stopAtReadBack: false,
      corrections: [
        fr("FR-1", {
          title: "One-tap charting",
          scope: "mvp",
          acceptance: ["a nurse charts in one tap"],
          evidence: "it has to be one tap",
        }),
        fr("FR-2", { title: "Excel export", scope: "future", acceptance: ["csv"], withdrawn: true }),
        fr("FR-4", {
          title: "Night shift handover summary",
          scope: "mvp",
          acceptance: ["the handover lists open notes"],
          evidence: "nights need a handover summary",
        }),
      ],
    });
    const finding = store.state.findings.find((f) => f.description.startsWith("Requirements confirmation."));
    expect(finding?.status).toBe("resolved");
    expect(store.state.requirementsConfirmAsked).toBe(true);

    const result = await generateSpec(
      { caller: specCaller as never, prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c",
        sessionId: "eval",
        title: "Charting",
        language: "en",
        path: fixture.path as Path,
        state: store.state,
        summary: "",
        edits: {},
        sections: ["overview", "functional", "open_questions"],
        diagramTypes: [],
        bundleFormat: "claude_code",
      } as never,
    );
    const byId = new Map(result.document.requirements.map((r) => [r.id, r]));
    expect(byId.get("FR-1")?.title).toBe("One-tap charting");
    expect(byId.has("FR-2")).toBe(false);
    expect(byId.get("FR-4")?.title).toBe("Night shift handover summary");
    expect(byId.get("FR-3")?.title).toBe("Offline mode"); // untouched by the owner
    expect(result.markdown).not.toContain("Excel export");
    expect(result.markdown).toContain("One-tap charting");
    expect(result.readBack).toBe("confirmed");
    expect(result.document.openQuestions.map((q) => q.question)).not.toContain(UNREVIEWED_LIST_QUESTION);
  });

  it("reads the list back when the owner presses done with the interview still open (live: 11 of 14 skipped it)", async () => {
    // Stopped as soon as a requirement is recorded: areas are still open when finish is pressed.
    const t = await interview({ stopAtReadBack: false, stopAtFacts: true, corrections: [] });
    expect(t.store.state.requirementsConfirmAsked).toBe(false);
    expect(t.store.state.coverage).not.toEqual({});
    await t.run({ control: { type: "finish" } });
    const last = t.focuses.at(-1);
    expect(last).toMatch(/^finding:/);
    const f = t.store.state.findings.find((x) => x.description.startsWith("Requirements confirmation."));
    expect(f).toBeDefined();
    expect(t.store.state.requirementsConfirmAsked).toBe(true);
    // And the turn after the answer closes.
    await t.run("Yes, that is the list.");
    expect(t.focuses.at(-1)).toBe("closing");
  });

  it("marks the specification when the participant leaves during the read-back (D-249)", async () => {
    const { store } = await interview({ stopAtReadBack: true, corrections: [] });
    const finding = store.state.findings.find((f) => f.description.startsWith("Requirements confirmation."));
    expect(finding?.status).toBe("raised");
    const result = await generateSpec(
      { caller: specCaller as never, prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c",
        sessionId: "eval",
        title: "Charting",
        language: "en",
        path: fixture.path as Path,
        state: store.state,
        summary: "",
        edits: {},
        sections: ["overview", "functional", "open_questions"],
        diagramTypes: [],
        bundleFormat: "claude_code",
      } as never,
    );
    expect(result.readBack).toBe("unanswered");
    expect(result.document.requirements.length).toBeGreaterThan(0);
    expect(result.document.openQuestions.map((q) => q.question)).toContain(UNREVIEWED_LIST_QUESTION);
    expect(result.markdown).toContain("did not review the requirement list");
  });
});
