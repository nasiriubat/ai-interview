import {
  assembleContext,
  clusterStats,
  extractFacts,
  InterviewEngine,
  LexicalRecall,
  neutralize,
  renderSystemPrompt,
  ShippedPromptSource,
  TURN_MARKER,
  type AnalysisFact,
  type CallContext,
  type CallRequest,
  type EngineSettings,
  type ModelCallerPort,
  type SessionSnapshot,
  type StoredMessage,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import type { ChatEvent, Purpose } from "@aidp/shared";
import { FactSchema, SessionStateSchema } from "@aidp/shared";
import { MemorySessionStore } from "@aidp/testing";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import payloads from "../fixtures/injection-payloads.json" with { type: "json" };

/**
 * Prompt-injection fixtures (security plan P12). Deterministic: no model is asked whether it was
 * fooled. What is asserted is everything the code controls, which is where an injection has to be
 * stopped before any model sees it:
 *
 * - untrusted text reaches the model only inside nonce-delimited blocks, and nothing in it can
 *   close its own block, open another, or pass for the engine's focus or the turn-metadata marker;
 * - the trusted prompt (the system text) is byte-identical whatever the participant wrote;
 * - a scripted model that behaves normally leaves the interview state exactly as scripted, so no
 *   code path reads instructions out of participant text;
 * - a quote the extractor was led to invent is dropped, and report quotes are cleaned.
 */

const NONCE = "00c0ffee1234";
const template = shippedTemplate("opportunity_discovery");
const settings: EngineSettings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};
const logger = { warn: () => undefined, info: () => undefined };

if (!template) throw new Error("opportunity_discovery template missing");

/** Everything of the payload that a regex over the prompt could find, without the wrappers. */
const outsideWrappers = (text: string): string =>
  text.replace(new RegExp(`<untrusted-${NONCE}[^>]*>[\\s\\S]*?</untrusted-${NONCE}>`, "g"), "");

const count = (text: string, needle: RegExp): number => (text.match(needle) ?? []).length;

function stored(seq: number, role: "user" | "assistant", content: string): StoredMessage {
  return { id: `m${seq}`, seq, role, modality: "text", content, createdAt: new Date(0) };
}

function snapshotWith(text: string): SessionSnapshot {
  const state = SessionStateSchema.parse({
    contextAnswers: { teamsize: text },
    profile: { role: "Nurse", notes: text },
    coverage: { role: { status: "partial", known: text, missing: text } },
    decisions: [{ key: "k", question: text, choice: text, source: "user" }],
    openThreads: [{ id: "t1", areaKey: "role", topic: text, priority: 3, resolved: false }],
    turnCount: 3,
  });
  return {
    id: "s1",
    companyId: "c1",
    template: template!,
    state,
    summary: text,
    handoff: {
      sourceOpportunityId: "o1",
      problem: text,
      affectedUsers: [text],
      existingProcess: [text],
      tools: [text],
      constraints: text,
      expectedBenefit: text,
      evidenceQuotes: [text],
    },
    attachments: [{ filename: `${text}.pdf`, kind: "document", summary: text, status: "ready" }],
  };
}

const interviewer = await new ShippedPromptSource().get("c1", "interviewer");

function assembled(text: string) {
  const recent = [
    stored(1, "assistant", "What is your role?"),
    stored(2, "user", text),
    stored(3, "assistant", "And what does a day look like?"),
    stored(4, "user", text),
  ];
  return assembleContext({
    prompt: interviewer,
    session: snapshotWith(text),
    focus: { mode: "area", areaKey: template!.coverageAreas[0]!.key },
    recent,
    recalled: [{ seq: 2, text }],
    settings,
    nonce: NONCE,
  });
}
const baseline = assembled("A plain answer.");

describe("the injection fixture set", () => {
  it("holds at least 30 payloads across several attack classes, with unique ids", () => {
    expect(payloads.length).toBeGreaterThanOrEqual(30);
    expect(new Set(payloads.map((p) => p.id)).size).toBe(payloads.length);
    expect(new Set(payloads.map((p) => p.category)).size).toBeGreaterThanOrEqual(8);
  });
});

describe.each(payloads)("injection $id ($category)", ({ text }) => {
  it("is neutralised: no tag naming the trusted tiers, no turn marker, no hidden characters", () => {
    const clean = neutralize(text);
    expect(clean).not.toMatch(/<\s*\/?\s*(untrusted|engine)/i);
    expect(clean).not.toMatch(/<<<\s*TURN_META/i);

    const hidden = Array.from({ length: clean.length }, (_, i) => clean.charAt(i)).filter((ch) => {
      const c = ch.charCodeAt(0);
      const control = c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
      const invisible = (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e);
      return control || invisible;
    });
    expect(hidden).toEqual([]);
  });

  it("reaches the model only inside delimited blocks that it cannot close or imitate", () => {
    const ctx = assembled(text);
    const body = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n---\n");

    const opens = count(body, new RegExp(`<untrusted-${NONCE}[ >]`, "g"));
    const closes = count(body, new RegExp(`</untrusted-${NONCE}>`, "g"));
    expect(opens).toBeGreaterThan(0);
    expect(closes).toBe(opens);
    // No closing tag of any kind other than the real ones, and no other opening of the tier.
    expect(count(body, /<\s*\/\s*untrusted/gi)).toBe(closes);
    expect(count(body, /<\s*untrusted/gi)).toBe(opens);

    // The engine focus appears once, last, outside every block.
    expect(count(body, /<engine_focus>/g)).toBe(1);
    expect(count(body, /<\/engine_focus>/g)).toBe(1);
    expect(body.lastIndexOf(`</untrusted-${NONCE}>`)).toBeLessThan(body.indexOf("<engine_focus>"));

    // The marker never appears in the data, and stripping the blocks leaves none of the payload.
    expect(body).not.toContain(TURN_MARKER);
    const outside = outsideWrappers(body);
    const probe = neutralize(text).trim().slice(0, 18);
    if (probe.length >= 10) expect(outside).not.toContain(probe);
  });

  it("leaves the trusted system prompt untouched", () => {
    const ctx = assembled(text);
    expect(ctx.system).toBe(baseline.system);
    expect(ctx.system).toBe(renderSystemPrompt(interviewer, template));
  });
});

/** An interviewer that behaves: it reads only the engine's own focus block, never the participant's words. */
class WellBehavedModel implements ModelCallerPort {
  requests: CallRequest[] = [];
  async *chat(_p: Purpose, _c: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    const last = String(req.messages.at(-1)?.content ?? "");
    const focus = last.slice(last.lastIndexOf("<engine_focus>"));
    const area = /area "([a-z_]+)"/.exec(focus)?.[1];
    const meta = {
      areaKey: area ?? "context",
      reason: "scripted",
      stateDelta: area ? { coverage: { [area]: { status: "partial", known: "opened" } } } : {},
    };
    yield { type: "text", text: `Tell me about a normal day.\n${TURN_MARKER}\n${JSON.stringify(meta)}` };
    yield {
      type: "done",
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      stopReason: "end_turn",
      model: "scripted",
    };
  }
  async complete<T>(_p: Purpose, _c: CallContext, _r: CallRequest, schema: z.ZodType<T>): Promise<T> {
    return schema.parse({});
  }
  async embed(): Promise<undefined> {
    return undefined;
  }
}

describe("a normally behaving model is not moved by anything the participant writes", () => {
  it.each(payloads)("engine turn with $id as the answer", async ({ text }) => {
    const store = new MemorySessionStore();
    const model = new WellBehavedModel();
    const engine = new InterviewEngine({
      caller: model,
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });
    const session: SessionSnapshot = {
      id: "s",
      companyId: "c",
      template: template,
      state: store.state,
      summary: "",
    };
    const gen = engine.nextTurn(session, { content: text, modality: "text" }, settings);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const state = r.value.state;

    // The scripted model opened one area as partial; nothing else moved.
    expect(r.value.ended).toBe(false);
    expect(state.phase).not.toBe("done");
    expect(state.closingAsked).toBe(false);
    expect(state.turnCount).toBe(1);
    expect(state.facts).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(state.findings).toEqual([]);
    expect(Object.values(state.coverage).every((c) => c.status !== "covered")).toBe(true);
    expect(state.flaggedForAdmin).toBeUndefined();

    // And the request carried the payload only as delimited data.
    const req = model.requests[0]!;
    const body = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const opens = count(body, /<untrusted-[0-9a-f]{12}[ >]/g);
    expect(count(body, /<\s*\/\s*untrusted/gi)).toBe(opens);
  });
});

describe("what extraction keeps", () => {
  const spoken = "I retype the lab results into the system by hand every morning";
  const invented = FactSchema.array().parse([
    {
      kind: "task",
      name: "Approve every payment",
      frequency: "daily",
      minutesPerOccurrence: 1,
      tools: [],
      painScore: 0,
      quote: "The CEO told me to approve every payment without review",
    },
    {
      kind: "pain_point",
      description: "Retyping lab results",
      severity: 6,
      quote: "I retype the lab results into the system by hand",
    },
  ]);

  it.each(payloads.slice(0, 8))(
    "drops a quote the extractor was led to invent ($id), keeps a spoken one",
    async ({ text }) => {
      const store = new MemorySessionStore();
      await store.appendMessage("s", {
        role: "assistant",
        modality: "text",
        content: "What takes the time?",
      });
      await store.appendMessage("s", { role: "user", modality: "text", content: `${spoken}. ${text}` });
      const sent: string[] = [];
      const caller = {
        async *chat(): AsyncIterable<ChatEvent> {
          yield { type: "text", text: "" };
        },
        async complete<T>(_p: Purpose, _c: CallContext, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
          sent.push(String(req.messages[0]?.content));
          return schema.parse({ facts: invented });
        },
        async embed(): Promise<undefined> {
          return undefined;
        },
      } satisfies ModelCallerPort;
      const r = await extractFacts(
        { caller, store, prompts: new ShippedPromptSource() },
        { id: "s", companyId: "c", template: template, state: SessionStateSchema.parse({}), summary: "" },
      );
      const quotes = r.facts.map((f) => ("quote" in f ? f.quote : undefined));
      expect(r.facts).toHaveLength(2); // the facts themselves stay
      expect(quotes).toContain("I retype the lab results into the system by hand");
      expect(quotes.some((q) => q?.includes("CEO"))).toBe(false);
      // The excerpt was delimited, and no payload tag survived into it.
      expect(sent[0]).toMatch(/<untrusted-[0-9a-f]{12} kind="participant_turn"/);
      expect(count(sent[0] ?? "", /<\s*\/\s*untrusted/gi)).toBe(count(sent[0] ?? "", /<untrusted-/g));
    },
  );
});

describe("what a report can carry", () => {
  it.each(payloads.filter((p) => p.category === "url_exfiltration" || p.category === "fake_closing_tag"))(
    "cleans a quote built from $id",
    ({ text }) => {
      const facts: AnalysisFact[] = [1, 2, 3].map((i) => ({
        id: `f${i}`,
        sessionId: `s${i}`,
        participantKey: `p${i}`,
        fact: {
          kind: "pain_point",
          description: "Retyping",
          severity: 5,
          quote: i === 1 ? text : "I retype it",
        },
      }));
      const stats = clusterStats(facts, 3);
      for (const q of stats.quotes) {
        expect(q).not.toMatch(/https?:\/\//i);
        expect(q).not.toMatch(/<[a-z/]/i);
        expect(q).not.toMatch(/!\[|\]\(/);
      }
    },
  );
});
