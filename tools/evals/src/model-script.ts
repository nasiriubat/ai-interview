import type { CallContext, CallRequest, ModelCallerPort } from "@aidp/ai";
import { TURN_MARKER } from "@aidp/ai";
import type { ChatEvent, InterviewTemplate, Purpose } from "@aidp/shared";

/**
 * A deterministic stand-in for the interviewer model: it reads the engine focus from the
 * last user message and answers as an ideal model would, marking the focused area covered
 * once the participant has answered on it. Lets evals exercise the engine end to end.
 */
export class IdealScriptedModel implements ModelCallerPort {
  readonly requests: CallRequest[] = [];
  constructor(private readonly template: InterviewTemplate) {}

  async *chat(_purpose: Purpose, _ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    const last = String(req.messages.at(-1)?.content ?? "");
    const area = /area "([a-z_]+)"/.exec(last)?.[1];
    const closing = last.includes("closing question");
    const summary = last.includes("give a short summary");
    const continuing = last.includes("stay on area");
    const meta: Record<string, unknown> = {
      areaKey: area ?? (closing ? "closing" : summary ? "summary" : "context"),
      reason: "scripted",
    };
    if (area && continuing)
      meta.stateDelta = { coverage: { [area]: { status: "covered", known: "answered" } } };
    else if (area) meta.stateDelta = { coverage: { [area]: { status: "partial", known: "opened" } } };
    if (summary) meta.endInterview = true;
    const name = this.template.coverageAreas.find((a) => a.key === area)?.name ?? "that";
    const text = closing
      ? "Anything I missed?"
      : summary
        ? "Thanks, here is what I captured."
        : continuing
          ? `Tell me more about ${name.toLowerCase()}.`
          : `Let's talk about ${name.toLowerCase()}.`;
    yield { type: "text", text: `${text}\n${TURN_MARKER}\n${JSON.stringify(meta)}` };
    yield {
      type: "done",
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
      stopReason: "end_turn",
      model: "scripted",
    };
  }

  async complete<T>(purpose: Purpose): Promise<T> {
    throw new Error(`IdealScriptedModel only scripts the interviewer; unexpected '${purpose}' completion`);
  }

  async embed(): Promise<undefined> {
    return undefined;
  }
}
