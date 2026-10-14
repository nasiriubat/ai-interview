import { SessionStateSchema, StateDeltaSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { InterviewEngine, type EngineEvent } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { chooseFocus } from "../../src/engine/selection.js";
import { applyDelta, mergeFacts } from "../../src/engine/state.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template, turn } from "./helpers.js";

const logger = { warn: () => undefined, info: () => undefined };

const reqTemplate = template({
  coverageAreas: [
    {
      key: "problem",
      name: "Problem",
      description: "The problem.",
      doneWhen: "Known.",
      maxFollowUps: 0,
      essential: true,
    },
    {
      key: "functional",
      name: "Functional",
      description: "What it does.",
      doneWhen: "Listed.",
      maxFollowUps: 0,
      essential: true,
    },
  ],
  outputs: ["spec_field"],
  completeness: { minRequirements: 0, requiredSections: [], requireAcceptance: false },
  issueDetection: {
    enabled: true,
    everyTurns: 2,
    aggressiveness: "standard",
    typesEnabled: ["ambiguity", "contradiction", "missing_decision", "over_complexity"],
    pushBackOnce: true,
    mvpChallenge: true,
  },
});

const fr = (path: string, title: string, scope: "mvp" | "future", reason?: string) => ({
  kind: "spec_field",
  section: "functional",
  path,
  value: { title, scope, acceptance: [], ...(reason ? { reason } : {}) },
  source: "user",
});

async function run(engine: InterviewEngine, ...args: Parameters<InterviewEngine["nextTurn"]>) {
  const events: EngineEvent[] = [];
  const gen = engine.nextTurn(...args);
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value, focus: events.find((e) => e.type === "turn")?.focus };
}

describe("requirements interview (spec 05)", () => {
  it("captures spec fields per turn, raises a detected finding, pushes back once, runs the MVP challenge, then closes", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([
      // turn 1: open problem
      turn("What problem are we solving?", {
        areaKey: "problem",
        stateDelta: {
          coverage: { problem: { status: "covered", known: "double charting" } },
          facts: [
            {
              kind: "spec_field",
              section: "overview",
              path: "problem",
              value: "Double charting",
              source: "user",
            },
          ],
        },
      }),
      // turn 2: open functional
      turn("What must version one do?", {
        areaKey: "functional",
        stateDelta: {
          coverage: { functional: { status: "covered" } },
          facts: [fr("FR-1", "Single entry", "mvp"), fr("FR-2", "Excel export", "mvp")],
        },
      }),
      // turn 3: final issue scan (areas complete) -> one finding raised
      JSON.stringify({
        findings: [
          {
            type: "missing_decision",
            section: "security",
            description: "No sign-in method decided",
            resolution: "Pick one",
            default: "magic link",
            confidence: "high",
          },
          {
            type: "ambiguity",
            section: "functional",
            path: "FR-2",
            description: "Export format unclear",
            resolution: "Name it",
            default: "csv",
            confidence: "low",
          },
        ],
      }),
      turn("Before we go on: how will people sign in? A magic link is the default.", {
        areaKey: "finding",
        // The answer to the functional question is filed on the turn that follows it.
        stateDelta: {
          facts: [
            {
              kind: "spec_field",
              section: "users",
              path: "nurse",
              value: { role: "nurse", needs: "chart once" },
              source: "user",
            },
          ],
        },
      }),
      // turn 4: user rejected -> push-back scheduled; focus moves to the MVP challenge
      turn("If version one shipped without single entry, what breaks?", {
        areaKey: "mvp_challenge",
        stateDelta: {
          findingOutcomes: [{ id: "f2-1", outcome: "rejected", note: "they say sign-in is not needed" }],
        },
      }),
      // turn 5: push back once
      turn("Without a sign-in, anyone with the link can read patient charts. Keep it that way?", {
        areaKey: "finding",
        stateDelta: { facts: [fr("FR-1", "Single entry", "mvp", "core problem")] },
      }),
      // turn 6: final rejection recorded as accepted; next MVP item
      turn("And Excel export: if version one shipped without it, what breaks?", {
        areaKey: "mvp_challenge",
        stateDelta: {
          findingOutcomes: [{ id: "f2-1", outcome: "rejected" }],
          facts: [fr("FR-1", "Single entry", "mvp", "core problem")],
        },
      }),
      // turn 7: the list is read back (D-244), through the finding flow
      turn("Here is the list: 1. Single entry 2. Excel export. Is anything wrong or missing?", {
        areaKey: "finding",
        // The answer to the MVP question is filed on the turn that follows it.
        stateDelta: { facts: [fr("FR-2", "Excel export", "future", "nice to have")] },
      }),
      // turn 8: closing
      turn("Is there anything else a developer would need?", { areaKey: "closing" }),
      // turn 9: summary
      turn("Thanks, here is what we captured.", { areaKey: "summary", endInterview: true }),
    ]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const last = () => String(caller.requests.at(-1)?.req.messages.at(-1)?.content);
    let s = snapshot(reqTemplate);
    let r = await run(engine, s, undefined, settings);
    expect(caller.requests[0]?.req.system).toContain("Specification capture");
    expect(r.focus).toEqual({ mode: "area", areaKey: "problem" });
    expect(r.result.state.facts).toHaveLength(1);

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "Nurses chart everything twice", modality: "text" }, settings);
    expect(r.focus).toEqual({ mode: "area", areaKey: "functional" });
    expect(r.result.state.phase).toBe("areas");

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "Single entry and Excel export", modality: "text" }, settings);
    expect(caller.requests.map((q) => q.purpose)).toContain("issue_detection");
    expect(r.result.state.findings).toHaveLength(1);
    expect(r.result.state.findings[0]).toMatchObject({
      id: "f2-1",
      type: "missing_decision",
      status: "raised",
      raisedTurn: 3,
    });
    expect(r.result.state.finalIssueScanDone).toBe(true);
    expect(r.focus).toEqual({ mode: "finding", findingId: "f2-1", pushBack: false });
    expect(last()).toContain("raise finding [f2-1]");
    expect(r.result.state.phase).toBe("findings");

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "No, we do not need sign-in", modality: "text" }, settings);
    expect(last()).toContain("has just answered finding [f2-1]");
    expect(r.focus).toEqual({ mode: "mvp_challenge", itemPath: "FR-1", title: "Single entry" });
    expect(r.result.state.findings[0]).toMatchObject({
      status: "open",
      pushedBack: true,
      note: "they say sign-in is not needed",
    });
    expect(r.result.state.mvpChallenge).toEqual({ started: true, done: false, asked: ["FR-1"] });
    expect(r.result.state.phase).toBe("mvp_challenge");

    s = { ...s, state: r.result.state };
    r = await run(
      engine,
      s,
      { content: "Nothing breaks, it is the whole point", modality: "text" },
      settings,
    );
    expect(r.focus).toEqual({ mode: "finding", findingId: "f2-1", pushBack: true });
    expect(last()).toContain("Push back once");
    expect(r.result.state.findings[0]).toMatchObject({ status: "raised", pushedBack: true, raisedTurn: 5 });

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "Yes, keep it open", modality: "text" }, settings);
    expect(r.focus).toEqual({ mode: "mvp_challenge", itemPath: "FR-2", title: "Excel export" });
    expect(r.result.state.findings[0]).toMatchObject({ status: "accepted", decidedTurn: 6 });
    // FR-1 was re-recorded: same path, replaced, not duplicated
    expect(r.result.state.facts.filter((f) => f.kind === "spec_field" && f.path === "FR-1")).toHaveLength(1);
    expect(r.result.state.mvpChallenge.asked).toEqual(["FR-1", "FR-2"]);

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "Nothing, that can wait", modality: "text" }, settings);
    expect(r.focus).toMatchObject({ mode: "finding", pushBack: false });
    expect(r.result.state.requirementsConfirmAsked).toBe(true);
    expect(r.result.state.findings.at(-1)?.description).toContain("1. Single entry");

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "That list is right", modality: "text" }, settings);
    expect(r.focus).toEqual({ mode: "closing" });
    expect(r.result.state.mvpChallenge.done).toBe(true);
    const fr2 = r.result.state.facts.find((f) => f.kind === "spec_field" && f.path === "FR-2");
    expect(fr2?.kind === "spec_field" ? fr2.value : undefined).toMatchObject({
      scope: "future",
      reason: "nice to have",
    });

    s = { ...s, state: r.result.state };
    r = await run(engine, s, { content: "No", modality: "text" }, settings);
    expect(r.result.ended).toBe(true);

    const kinds = store.events
      .filter((e) => e.type === "finding")
      .map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toEqual(["detected", "raised", "outcome", "pushed_back", "outcome", "detected", "raised"]);
    // The confirmation had no reported outcome: it is accepted as is, and never blocks the closing.
    expect(r.result.state.findings.at(-1)).toMatchObject({ status: "accepted" });
    // Only one issue-detection call: no scan while a finding is in play, and the final scan runs once
    // (the confirmation is deterministic and makes no call).
    expect(caller.requests.filter((q) => q.purpose === "issue_detection")).toHaveLength(1);
    // The stable prefix never changed.
    expect(
      new Set(caller.requests.filter((q) => q.purpose === "interview_turn").map((q) => q.req.system)).size,
    ).toBe(1);
  });

  it("settings can turn the MVP challenge off or make it mandatory", async () => {
    const st = SessionStateSchema.parse({
      turnCount: 3,
      coverage: { problem: { status: "covered" }, functional: { status: "covered" } },
      facts: [fr("FR-1", "A", "mvp")],
      finalIssueScanDone: true,
    });
    expect(
      chooseFocus({
        template: reqTemplate,
        state: st,
        maxTurns: 60,
        lastAnswerMinimal: false,
        mvpChallenge: "off",
      }),
    ).toEqual({ mode: "closing" });
    expect(
      chooseFocus({
        template: reqTemplate,
        state: st,
        maxTurns: 60,
        lastAnswerMinimal: false,
        mvpChallenge: "optional",
      }),
    ).toEqual({
      mode: "mvp_challenge",
      itemPath: "FR-1",
      title: "A",
    });
    const started = { ...st, mvpChallenge: { started: true, done: false, asked: ["FR-1"] } };
    const focus = { mode: "closing" as const };
    expect(
      applyDelta(started, StateDeltaSchema.parse({ endMvpChallenge: true }), reqTemplate, focus, {
        pushBackOnce: true,
        mvpChallengeMandatory: false,
      }).mvpChallenge.done,
    ).toBe(true);
    expect(
      applyDelta(started, StateDeltaSchema.parse({ endMvpChallenge: true }), reqTemplate, focus, {
        pushBackOnce: true,
        mvpChallengeMandatory: true,
      }).mvpChallenge.done,
    ).toBe(false);
  });

  it("an open finding is raised before any area question, and a raised finding without a reported outcome is accepted as is", () => {
    const st = SessionStateSchema.parse({
      turnCount: 4,
      findings: [
        {
          id: "f1",
          type: "ambiguity",
          section: "nfr",
          description: "d",
          resolution: "r",
          default: "x",
          status: "open",
        },
      ],
    });
    expect(chooseFocus({ template: reqTemplate, state: st, maxTurns: 60, lastAnswerMinimal: false })).toEqual(
      { mode: "finding", findingId: "f1", pushBack: false },
    );
    const raised = applyDelta(st, StateDeltaSchema.parse({}), reqTemplate, {
      mode: "finding",
      findingId: "f1",
      pushBack: false,
    });
    expect(raised.findings[0]).toMatchObject({ status: "raised", raisedTurn: 4 });
    const later = applyDelta({ ...raised, turnCount: 5 }, StateDeltaSchema.parse({}), reqTemplate, {
      mode: "area",
      areaKey: "problem",
    });
    expect(later.findings[0]).toMatchObject({
      status: "accepted",
      decidedTurn: 5,
      note: "No explicit outcome",
    });
    // a medium-confidence rejection is not pushed back on
    const medium = { ...raised, turnCount: 5 };
    const rejected = applyDelta(
      medium,
      StateDeltaSchema.parse({ findingOutcomes: [{ id: "f1", outcome: "rejected" }] }),
      reqTemplate,
      { mode: "area", areaKey: "problem" },
      { pushBackOnce: true, mvpChallengeMandatory: false },
    );
    expect(rejected.findings[0]?.status).toBe("accepted");
  });

  it("mergeFacts replaces a spec field at the same path and appends everything else", () => {
    const a = fr("FR-1", "A", "mvp");
    const merged = mergeFacts(
      StateDeltaSchema.parse({ facts: [a, { kind: "pain_point", description: "p", severity: 3 }] }).facts,
      StateDeltaSchema.parse({
        facts: [fr("FR-1", "A2", "future"), { kind: "pain_point", description: "p", severity: 3 }],
      }).facts,
    );
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ kind: "spec_field", value: { title: "A2", scope: "future" } });
  });
});

describe("context block never loops", () => {
  it("counts asks, nudges the model on a repeat, and records the participant's words after two asks", async () => {
    const store = new MemoryStore();
    const t = template({
      contextBlock: [
        { key: "timeline", question: "When?" },
        { key: "budget", question: "How much?" },
      ],
    });
    const caller = new ScriptedCaller([
      turn("When does this need to be live?", { areaKey: "context" }),
      turn("Sorry, when exactly?", { areaKey: "context" }),
      turn("And the budget?", { areaKey: "context", stateDelta: { contextAnswers: { budget: "small" } } }),
    ]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    let s = snapshot(t);
    let r = await run(engine, s, undefined, settings);
    expect(r.result.state.contextAsks).toEqual({ timeline: 1 });
    s = { ...s, state: r.result.state };
    r = await run(
      engine,
      s,
      { content: "Before the winter rota, about three months", modality: "text" },
      settings,
    );
    expect(String(caller.requests[1]?.req.messages.at(-1)?.content)).toContain("already asked once");
    expect(r.result.state.contextAsks).toEqual({ timeline: 2 });
    expect(r.result.state.contextAnswers).toEqual({});
    s = { ...s, state: r.result.state };
    r = await run(
      engine,
      s,
      { content: "Three months, before the winter rota starts.", modality: "text" },
      settings,
    );
    expect(r.result.state.contextAnswers.timeline).toBe("Three months, before the winter rota starts.");
    expect(r.focus).toEqual({ mode: "context", questionKey: "budget" });
    expect(r.result.state.contextAnswers.budget).toBe("small");
  });
});

describe("follow-up scheduling", () => {
  it("asks for a summary only when enough turns have accumulated beyond the recent window", async () => {
    const store = new MemoryStore();
    const replies = Array.from({ length: 20 }, (_, i) => turn(`Question ${i + 1}?`, { areaKey: "problem" }));
    const caller = new ScriptedCaller(replies);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const t = template({
      coverageAreas: [{ key: "problem", name: "P", description: "P", doneWhen: "never", maxFollowUps: 10 }],
    });
    const small = { ...settings, recentWindowTurns: 3, summarizeEveryTurns: 2 };
    let s = snapshot(t);
    const wanted: number[] = [];
    let r = await run(engine, s, undefined, small);
    for (let i = 0; i < 9; i++) {
      s = { ...s, state: r.result.state };
      r = await run(engine, s, { content: `Answer ${i + 1} with some detail`, modality: "text" }, small);
      if (r.result.followUps.summarize) wanted.push(store.messages.length);
    }
    // 3 turns kept verbatim (6 messages) + 2 turns to fold (4 messages): first summary at 10 messages, not before.
    expect(wanted[0]).toBe(11);
    // With summaryUpToSeq never updated (no worker in this test) the request repeats; a worker that folds resets it.
    expect(wanted.length).toBeGreaterThan(0);
  });
});
