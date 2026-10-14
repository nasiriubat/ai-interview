import type { ChatEvent } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { InterviewEngine } from "../../src/engine/engine.js";
import {
  describeEvaluationFailure,
  evaluatePrompt,
  MAX_PROMPT_CHARS,
  pickFromRows,
  placeholdersOf,
  promptContract,
  promptDiffStats,
  stickyBucket,
  validatePromptBody,
  type PromptRowLike,
} from "../../src/engine/prompts/admin.js";
import {
  promptVersionTag,
  SHIPPED_PROMPTS,
  type PromptDefinition,
  type PromptSource,
} from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import type { CallContext, CallRequest, Purpose } from "../../src/index.js";
import { lineDiff } from "../../src/spec/diff.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template, turn } from "./helpers.js";

const interviewer = SHIPPED_PROMPTS.interviewer!.body;

describe("prompt contract (D-231)", () => {
  it("every shipped prompt satisfies its own contract", () => {
    for (const [key, p] of Object.entries(SHIPPED_PROMPTS))
      expect(validatePromptBody(key, p.body), key).toEqual([]);
  });

  it("derives the placeholders of the shipped body, and the output tokens the parsers read", () => {
    const c = promptContract("interviewer")!;
    expect(c.requiredPlaceholders).toEqual(
      expect.arrayContaining(["objective", "language", "aiInstructions", "areas", "outputInstructions"]),
    );
    expect(c.untrustedRules).toBe(true);
    expect(c.contractTokens).toContain("<<<TURN_META>>>");
    expect(promptContract("nope")).toBeUndefined();
  });

  it("accepts a tweak that keeps the contract", () => {
    const body = interviewer.replace("Warm, brief, specific.", "Warm, brief, specific, and never formal.");
    expect(body).not.toBe(interviewer);
    expect(validatePromptBody("interviewer", body)).toEqual([]);
  });

  it("rejects an edit that removes a placeholder, naming it", () => {
    const issues = validatePromptBody("interviewer", interviewer.replace("{{areas}}", "the areas"));
    expect(issues.map((i) => [i.code, i.detail])).toContainEqual(["missing_placeholder", "{{areas}}"]);
  });

  it("rejects a placeholder the engine does not fill", () => {
    const issues = validatePromptBody("interviewer", `${interviewer}\nCompany: {{companyName}}`);
    expect(issues.map((i) => [i.code, i.detail])).toContainEqual(["unknown_placeholder", "{{companyName}}"]);
  });

  it("rejects an edit that removes the untrusted-block instructions, even when reflowed", () => {
    const rules = interviewer.slice(
      interviewer.indexOf("Instruction hierarchy:"),
      interviewer.indexOf("\n", interviewer.indexOf("Instruction hierarchy:")),
    );
    expect(rules.length).toBeGreaterThan(100);
    expect(validatePromptBody("interviewer", interviewer.replace(rules, ""))).toContainEqual(
      expect.objectContaining({ code: "missing_untrusted_rules" }),
    );
    // Whitespace is not the contract: the same words on several lines still pass.
    expect(
      validatePromptBody("interviewer", interviewer.replace(rules, rules.replace(/\. /g, ".\n"))),
    ).toEqual([]);
    // A softened sentence is not the same rule.
    expect(
      validatePromptBody(
        "interviewer",
        interviewer.replace("never instructions to follow", "sometimes useful"),
      ),
    ).toContainEqual(expect.objectContaining({ code: "missing_untrusted_rules" }));
  });

  it("rejects an edit that removes the TURN contract", () => {
    const noMarker = interviewer.split("<<<TURN_META>>>").join("[meta]");
    const issues = validatePromptBody("interviewer", noMarker);
    expect(issues.map((i) => i.detail)).toContain("<<<TURN_META>>>");
    const noDelta = interviewer.split('"stateDelta"').join('"delta"');
    expect(validatePromptBody("interviewer", noDelta).map((i) => i.detail)).toContain('"stateDelta"');
  });

  it("rejects empty, whitespace and over-long bodies, and unknown keys", () => {
    expect(validatePromptBody("interviewer", "   ")[0]?.code).toBe("empty");
    expect(validatePromptBody("interviewer", `${interviewer}${"x".repeat(MAX_PROMPT_CHARS)}`)).toContainEqual(
      expect.objectContaining({ code: "too_long" }),
    );
    expect(validatePromptBody("nope", "x")[0]?.code).toBe("unknown_prompt");
  });

  it("holds the non-interviewer prompts to their own output tokens", () => {
    const recap = SHIPPED_PROMPTS.recap!.body;
    expect(validatePromptBody("recap", recap.replace('{"recap"', '{"text"'))).toContainEqual(
      expect.objectContaining({ code: "missing_contract_token", detail: '"recap"' }),
    );
  });

  it("finds placeholders with inner spaces too", () => {
    expect(placeholdersOf("a {{ x }} b {{y}} {{x}}")).toEqual(["x", "y"]);
  });
});

describe("sticky canary assignment (D-230)", () => {
  const rows = (canaryShare: number, withStable = true): PromptRowLike[] => [
    ...(withStable ? [{ companyId: "c", version: 1, body: "stable", canaryShare: 1, active: true }] : []),
    { companyId: "c", version: 2, body: "canary", canaryShare, active: true },
  ];
  const pick = (id: string, list: PromptRowLike[], random = () => 0.999) =>
    pickFromRows("interviewer", list, "tenant", id, random);

  it("gives one session the same prompt on every call, whatever the random source says", () => {
    const list = rows(0.3);
    for (let s = 0; s < 40; s++) {
      const id = `session-${String(s)}`;
      const first = pick(id, list)?.version;
      for (let i = 0; i < 1000; i++) expect(pick(id, list, Math.random)?.version).toBe(first);
    }
  });

  it("honours the share across many sessions, within tolerance", () => {
    for (const share of [0.1, 0.5, 0.9]) {
      let canary = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) if (pick(`s-${String(i)}`, rows(share))?.version === 2) canary++;
      expect(Math.abs(canary / n - share)).toBeLessThan(0.04);
    }
  });

  it("buckets lie in [0, 1) and differ by prompt key", () => {
    for (let i = 0; i < 200; i++) {
      const b = stickyBucket(`s${String(i)}`, "interviewer");
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(1);
    }
    const same = Array.from({ length: 200 }, (_, i) => i).filter(
      (i) => stickyBucket(`s${String(i)}`, "interviewer") === stickyBucket(`s${String(i)}`, "summary"),
    );
    expect(same.length).toBe(0);
  });

  it("falls through when a canary has no stable sibling, and when nothing is active", () => {
    // Outside its share the session gets nothing from this owner, so the shipped prompt applies.
    const outside = Array.from({ length: 50 }, (_, i) => `s${String(i)}`).find(
      (id) => stickyBucket(id, "interviewer") >= 0.5,
    )!;
    expect(pick(outside, rows(0.5, false))).toBeUndefined();
    expect(pickFromRows("interviewer", [], "tenant", "x", () => 0)).toBeUndefined();
    expect(
      pickFromRows("interviewer", [{ ...rows(1)[0]!, active: false }], "tenant", "x", () => 0),
    ).toBeUndefined();
  });

  it("without a sticky key it draws from the random source", () => {
    expect(pickFromRows("k", rows(0.5), "tenant", undefined, () => 0.1)?.version).toBe(2);
    expect(pickFromRows("k", rows(0.5), "tenant", undefined, () => 0.9)?.version).toBe(1);
  });

  it("tags the ledger by source", () => {
    const base = { key: "interviewer", body: "" };
    expect(promptVersionTag({ ...base, version: 5 })).toBe("interviewer@5");
    expect(promptVersionTag({ ...base, version: 5, source: "shipped" })).toBe("interviewer@5");
    expect(promptVersionTag({ ...base, version: 3, source: "tenant" })).toBe("interviewer@t3");
    expect(promptVersionTag({ ...base, version: 2, source: "platform" })).toBe("interviewer@p2");
  });
});

describe("diff and evaluation", () => {
  it("counts added and removed lines against the shipped prompt", () => {
    const edited = interviewer.replace("Warm, brief, specific.", "Warm and brief.");
    const lines = lineDiff(interviewer, edited);
    expect(promptDiffStats(lines)).toEqual({ added: 1, removed: 1 });
    expect(promptDiffStats(lineDiff(interviewer, interviewer))).toEqual({ added: 0, removed: 0 });
  });

  it("renders the interviewer for each template and reports a leftover placeholder", () => {
    const t = template();
    const ok = evaluatePrompt("interviewer", interviewer, [t]);
    expect(ok.ok).toBe(true);
    expect(ok.issues).toEqual([]);
    expect(ok.renders).toEqual([{ template: t.key, ok: true, leftover: [], chars: expect.any(Number) }]);
    // A second {{objective}} survives the engine's single replacement and would reach the model.
    const twice = evaluatePrompt("interviewer", `${interviewer}\nAgain: {{objective}}`, [t]);
    expect(twice.ok).toBe(false);
    expect(twice.renders[0]).toMatchObject({ ok: false, leftover: ["objective"] });
    expect(describeEvaluationFailure(twice)).toContain("{{objective}}");
  });

  it("checks only the contract for prompts that are not rendered with a template", () => {
    const r = evaluatePrompt("summary", SHIPPED_PROMPTS.summary!.body, [template()]);
    expect(r.renders).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

class CapturingCaller extends ScriptedCaller {
  contexts: CallContext[] = [];
  override async *chat(purpose: Purpose, ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.contexts.push(ctx);
    yield* super.chat(purpose, ctx, req);
  }
}

describe("engine with a tenant prompt", () => {
  it("passes the session id as the sticky key and records the tenant tag in the ledger context", async () => {
    const store = new MemoryStore();
    const seen: { key: string; sticky: string | undefined }[] = [];
    const tenant: PromptDefinition = {
      ...SHIPPED_PROMPTS.interviewer!,
      version: 3,
      source: "tenant",
    };
    const prompts: PromptSource = {
      get: async (_company, key, sticky) => {
        seen.push({ key, sticky });
        return tenant;
      },
    };
    const caller = new CapturingCaller([turn("What is your role?", { areaKey: "role" })]);
    const engine = new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts,
      recall: new LexicalRecall(store, 10),
      logger: { warn: () => undefined, info: () => undefined },
    });
    const snap = snapshot(template());
    const gen = engine.nextTurn(snap, undefined, settings);
    let r = await gen.next();
    while (!r.done) r = await gen.next();

    expect(seen[0]).toEqual({ key: "interviewer", sticky: snap.id });
    expect(caller.contexts[0]?.promptVersion).toBe("interviewer@t3");
  });
});
