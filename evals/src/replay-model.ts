import type { CallContext, CallRequest, ModelCallerPort } from "@aidp/ai";
import type { ChatEvent, InterviewTemplate, Purpose } from "@aidp/shared";
import type { z } from "zod";
import type { Fixture, Flaw } from "./fixture.js";

const MARKER = "<<<TURN_META>>>";

interface Reply {
  text: string;
  /** What the structured repair call answers for this turn: the ground truth. */
  truth: Record<string, unknown>;
}

/**
 * The recorded model of a replay: deterministic, adaptive to the engine's focus, driven by the
 * fixture's labels. For the participant answer being processed it reports the requirements and
 * notes the labels say that answer introduced, exactly as an attentive model would, except that the
 * fixture's `modelBehavior.flaws` break the reply at named turns the way cheap models did in the
 * live runs: no marker, malformed or truncated JSON, a requirement filed under rules, a
 * descriptive id, a pile of rules, nothing captured. The repair call answers with the truth.
 */
export class ReplayModel implements ModelCallerPort {
  /** Interviewer calls so far; call k answers participant turn k - 1. */
  private calls = 0;
  private scans = 0;
  private nextFr = 1;
  private readonly assigned = new Map<string, string>();
  private readonly extracted = new Set<string>();
  private lastFocus: { mode: string; key?: string } = { mode: "none" };
  private truthByTurn = new Map<number, Record<string, unknown>>();
  readonly purposeCounts: Record<string, number> = {};

  constructor(
    private readonly fixture: Fixture,
    private readonly template: InterviewTemplate,
  ) {}

  private count(purpose: string): void {
    this.purposeCounts[purpose] = (this.purposeCounts[purpose] ?? 0) + 1;
  }

  /** The spec facts the labels of answer `n` introduce, with the ids a careful model would pick. */
  private factsFor(n: number): unknown[] {
    const turn = this.fixture.turns[n - 1];
    if (!turn) return [];
    const out: unknown[] = [];
    for (const id of turn.labels.requirements) {
      const gold = this.fixture.goldRequirements.find((g) => g.id === id);
      if (!gold) continue;
      const path = this.assigned.get(id) ?? `FR-${this.nextFr++}`;
      this.assigned.set(id, path);
      out.push({
        kind: "spec_field",
        section: "functional",
        path,
        value: { title: gold.title, scope: gold.scope, acceptance: gold.acceptance },
        source: "user",
      });
    }
    for (const id of turn.labels.rescopes) {
      const gold = this.fixture.goldRequirements.find((g) => g.id === id);
      const path = this.assigned.get(id);
      if (!gold || !path) continue;
      out.push({
        kind: "spec_field",
        section: "functional",
        path,
        value: {
          title: gold.title,
          scope: gold.finalScope ?? gold.scope,
          acceptance: gold.acceptance,
          reason: "the owner changed their mind",
        },
        source: "user",
      });
    }
    for (const section of turn.labels.sections)
      out.push({
        kind: "spec_field",
        section,
        path: `note-${n}`,
        value: turn.text.slice(0, 140),
        source: "user",
      });
    return out;
  }

  private broken(flaw: Flaw | undefined, facts: unknown[], n: number): unknown[] {
    switch (flaw) {
      case "wrong_section":
        return facts.map((f) =>
          (f as { section?: string }).section === "functional"
            ? { ...(f as object), section: "rules", path: `rule-${n}` }
            : f,
        );
      case "descriptive_id":
        return facts.map((f) =>
          (f as { section?: string }).section === "functional"
            ? {
                ...(f as object),
                path: `FR-${String((f as { value?: { title?: string } }).value?.title ?? n)
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .slice(0, 24)}`,
              }
            : f,
        );
      case "rules_flood":
        return Array.from({ length: 7 }, (_, i) => ({
          kind: "spec_field",
          section: "rules",
          path: `r${n}-${i}`,
          value: `The system lets people do thing ${i} (turn ${n})`,
          source: "user",
        }));
      case "no_capture":
        return [];
      default:
        return facts;
    }
  }

  private reply(last: string): Reply {
    const n = this.calls - 1; // the participant answer this call processes (0 on the opening call)
    const meta: Record<string, unknown> = { reason: "scripted" };
    const delta: Record<string, unknown> = {};
    const area = /area "([a-z_]+)"/.exec(last)?.[1];
    const context = /context question "([a-z_]+)"/.exec(last)?.[1];
    const answeredFinding = /has just answered finding \[([^\]]+)\]/.exec(last)?.[1];
    const finding =
      /raise finding \[([^\]]+)\]/.exec(last)?.[1] ?? /rejected finding \[([^\]]+)\]/.exec(last)?.[1];
    const mvp = /MVP challenge for (FR-\d+)/.exec(last)?.[1];
    const closing = last.includes("closing question");
    const summary = last.includes("give a short summary");
    const continuing = last.includes("stay on area");
    const producesSpec = this.template.outputs.includes("spec_field");

    if (answeredFinding)
      delta.findingOutcomes = [{ id: answeredFinding, outcome: "resolved", note: "scripted" }];
    const flaw = this.fixture.modelBehavior.flaws[String(n)];
    const truthFacts = producesSpec && n > 0 ? this.factsFor(n) : [];
    const facts = this.broken(flaw, truthFacts, n);

    let text: string;
    if (context) {
      meta.areaKey = "context";
      delta.contextAnswers = { [context]: "scripted answer" };
      delta.decisions = [
        { key: context, question: context, choice: "scripted answer", source: "default_accepted" },
      ];
      text = `About ${context}: what applies?`;
      this.lastFocus = { mode: "context", key: context };
    } else if (finding) {
      meta.areaKey = "finding";
      text = `One thing to settle, finding ${finding}. Is the default fine?`;
      this.lastFocus = { mode: "finding", key: finding };
    } else if (mvp) {
      meta.areaKey = "mvp_challenge";
      text = `If version one shipped without ${mvp}, what breaks?`;
      this.lastFocus = { mode: "mvp_challenge", key: mvp };
    } else if (area) {
      meta.areaKey = area;
      const name = this.template.coverageAreas.find((a) => a.key === area)?.name ?? area;
      delta.coverage = {
        [area]: continuing
          ? { status: "covered", known: "answered" }
          : { status: "partial", known: "opened" },
      };
      text = continuing
        ? `Tell me more about ${name.toLowerCase()}.`
        : `Let's talk about ${name.toLowerCase()}.`;
      this.lastFocus = { mode: "area", key: area };
    } else if (closing) {
      meta.areaKey = "closing";
      text = "Anything a developer would still need?";
      this.lastFocus = { mode: "closing" };
    } else if (summary) {
      meta.areaKey = "summary";
      meta.endInterview = true;
      text = "Thanks, here is what we captured.";
      this.lastFocus = { mode: "summary" };
    } else {
      meta.areaKey = "context";
      text = "Go on.";
      this.lastFocus = { mode: "other" };
    }
    if (facts.length) delta.facts = facts;
    meta.stateDelta = delta;
    const truth = { ...meta, stateDelta: { ...delta, facts: truthFacts } };
    this.truthByTurn.set(this.calls, truth);
    const json = JSON.stringify(meta);
    switch (flaw) {
      case "marker_missing":
        return { text, truth };
      case "malformed_json":
        return { text: `${text}\n${MARKER}\n{"areaKey": "x", "stateDelta": {"facts": [ {`, truth };
      case "truncated":
        return { text: `${text}\n${MARKER}\n${json.slice(0, Math.floor(json.length * 0.55))}`, truth };
      default:
        return { text: `${text}\n${MARKER}\n${json}`, truth };
    }
  }

  async *chat(purpose: Purpose, _ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.count(purpose);
    let text: string;
    if (purpose === "interview_turn") {
      this.calls += 1;
      text = this.reply(String(req.messages.at(-1)?.content ?? "")).text;
    } else if (purpose === "resume_summary") {
      // Lossy on purpose: the first sentence of each folded participant turn.
      const body = String(req.messages.at(-1)?.content ?? "");
      const lines = this.fixture.turns
        .filter((t) => body.includes(t.text))
        .map((t) => `- ${t.text.split(/(?<=[.!?])\s/)[0]}`);
      text = lines.join("\n") || "(nothing new)";
    } else {
      throw new Error(`ReplayModel: unexpected chat purpose '${purpose}'`);
    }
    yield { type: "text", text };
    yield {
      type: "done",
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      stopReason: "end_turn",
      model: "replay",
    };
  }

  async complete<T>(purpose: Purpose, _ctx: CallContext, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
    this.count(purpose);
    if (purpose === "interview_turn") {
      // The structured repair call: the ground truth of the turn being repaired.
      const truth = this.truthByTurn.get(this.calls) ?? {};
      return schema.parse(truth);
    }
    if (purpose === "issue_detection") {
      const findings = this.fixture.modelBehavior.scans[this.scans] ?? [];
      this.scans += 1;
      return schema.parse({ findings });
    }
    if (purpose === "extraction") {
      const body = String(req.messages.at(-1)?.content ?? "");
      const facts = this.fixture.goldFacts
        .filter((g) => !this.extracted.has(g.id))
        .filter((g) => body.includes(this.fixture.turns[g.introducedAtTurn - 1]?.text ?? "\u0000"));
      for (const g of facts) this.extracted.add(g.id);
      return schema.parse({ facts: facts.map((g) => g.fact) });
    }
    throw new Error(`ReplayModel: unexpected completion purpose '${purpose}'`);
  }

  async embed(): Promise<undefined> {
    return undefined;
  }
}
