import type { CallRequest, ModelCaller } from "@aidp/ai";
import { TURN_MARKER } from "@aidp/ai";
import type { ChatEvent, InterviewTemplate } from "@aidp/shared";
import type { z } from "zod";

/**
 * A deterministic stand-in for the model in a requirements interview. Reads the engine
 * focus from the last user message and behaves as an ideal model would: answers context
 * questions, opens and covers areas, records spec fields (two functional requirements),
 * settles findings it raised, re-records MVP items after the challenge, and returns one
 * finding from the issue-detection pass the first time it is asked.
 */
export class RequirementsScriptedModel {
  readonly requests: { purpose: string; req: CallRequest }[] = [];
  readonly issueScans: string[] = [];
  private lastFocus: { mode: string; key?: string } = { mode: "none" };

  constructor(private readonly template: InterviewTemplate) {}

  async *chat(purpose: string, _ctx: unknown, req: CallRequest): AsyncIterable<ChatEvent> {
    this.requests.push({ purpose, req });
    const last = String(req.messages.at(-1)?.content ?? "");
    const meta: Record<string, unknown> = { reason: "scripted" };
    const delta: Record<string, unknown> = {};
    const facts: unknown[] = [];

    // The previous focus decides what the participant's latest answer settled.
    const prev = this.lastFocus;
    const answered = /has just answered finding \[([^\]]+)\]/.exec(last)?.[1];
    if (answered) delta.findingOutcomes = [{ id: answered, outcome: "resolved", note: "scripted" }];
    if (prev.mode === "mvp_challenge" && prev.key) {
      facts.push({
        kind: "spec_field",
        section: "functional",
        path: prev.key,
        value: {
          title: prev.key === "FR-1" ? "Single entry charting" : "Excel export",
          scope: prev.key === "FR-1" ? "mvp" : "future",
          acceptance: ["scripted"],
          reason: prev.key === "FR-1" ? "core problem" : "not needed for version one",
        },
        source: "user",
      });
    }

    const context = /context question "([a-z_]+)"/.exec(last)?.[1];
    const area = /area "([a-z_]+)"/.exec(last)?.[1];
    const finding =
      /raise finding \[([^\]]+)\]/.exec(last)?.[1] ?? /rejected finding \[([^\]]+)\]/.exec(last)?.[1];
    const mvp = /MVP challenge for (FR-\d+)/.exec(last)?.[1];
    const closing = last.includes("closing question");
    const summary = last.includes("give a short summary");
    const continuing = last.includes("stay on area");

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
      text = `One thing to settle: finding ${finding}. The default is fine?`;
      this.lastFocus = { mode: "finding", key: finding };
    } else if (mvp) {
      meta.areaKey = "mvp_challenge";
      text = `If version one shipped without ${mvp}, what breaks?`;
      this.lastFocus = { mode: "mvp_challenge", key: mvp };
    } else if (area) {
      meta.areaKey = area;
      const name = this.template.coverageAreas.find((a) => a.key === area)?.name ?? area;
      if (continuing) {
        delta.coverage = { [area]: { status: "covered", known: "answered" } };
        if (area === "functional") {
          facts.push(
            {
              kind: "spec_field",
              section: "functional",
              path: "FR-1",
              value: { title: "Single entry charting", scope: "mvp", acceptance: ["one form"] },
              source: "user",
            },
            {
              kind: "spec_field",
              section: "functional",
              path: "FR-2",
              value: { title: "Excel export", scope: "mvp", acceptance: ["csv"] },
              source: "user",
            },
          );
        } else {
          facts.push({
            kind: "spec_field",
            section: area,
            path: "summary",
            value: `scripted ${name}`,
            source: "user",
          });
        }
        text = `Tell me more about ${name.toLowerCase()}.`;
      } else {
        delta.coverage = { [area]: { status: "partial", known: "opened" } };
        text = `Let's talk about ${name.toLowerCase()}.`;
      }
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
    yield { type: "text", text: `${text}\n${TURN_MARKER}\n${JSON.stringify(meta)}` };
    yield {
      type: "done",
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      stopReason: "end_turn",
      model: "scripted",
    };
  }

  async complete<T>(purpose: string, _ctx: unknown, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
    this.requests.push({ purpose, req });
    if (purpose !== "issue_detection") throw new Error(`unexpected purpose ${purpose}`);
    this.issueScans.push(String(req.messages[0]?.content ?? ""));
    const findings =
      this.issueScans.length === 1
        ? [
            {
              type: "missing_decision",
              section: "security",
              description: "No sign-in method has been decided",
              resolution: "Choose how users sign in",
              default: "magic link",
              confidence: "high",
            },
          ]
        : [];
    return schema.parse({ findings });
  }

  asCaller(): ModelCaller {
    return this as unknown as ModelCaller;
  }
}
