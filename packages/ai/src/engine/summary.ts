import { SessionStateSchema } from "@aidp/shared";
import type { ModelCaller } from "../callModel.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";

/**
 * Layer 3 maintenance: folds turns older than the recent window into the rolling summary.
 * Runs as a job after turns; idempotent because it records the sequence it summarized up to.
 */
export async function updateRollingSummary(
  deps: { caller: ModelCaller; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
  recentWindowTurns: number,
): Promise<{ updated: boolean; upToSeq: number }> {
  const state = SessionStateSchema.parse(session.state);
  const older = await deps.store.messagesAfter(session.id, state.summaryUpToSeq);
  const keep = recentWindowTurns * 2;
  const toFold = older.slice(0, Math.max(0, older.length - keep));
  if (toFold.length === 0) return { updated: false, upToSeq: state.summaryUpToSeq };

  const prompt = await deps.prompts.get(session.companyId, "summary");
  const transcript = toFold
    .map((m) => `${m.role === "user" ? "Participant" : "Interviewer"}: ${renderStoredMessage(m)}`)
    .join("\n");
  let summary = "";
  for await (const ev of deps.caller.chat(
    "resume_summary",
    {
      companyId: session.companyId,
      sessionId: session.id,
      promptVersion: promptVersionTag(prompt),
      ref: { type: "session", id: session.id },
    },
    {
      system: prompt.body,
      messages: [
        {
          role: "user",
          content: `Previous summary:\n${session.summary || "(none)"}\n\nNew turns:\n${transcript}\n\nUpdated summary:`,
        },
      ],
      maxOutputTokens: 1200,
    },
  )) {
    if (ev.type === "text") summary += ev.text;
  }
  const upToSeq = toFold[toFold.length - 1]?.seq ?? state.summaryUpToSeq;
  await deps.store.saveSummary(session.id, summary.trim());
  await deps.store.saveState(session.id, { ...state, summaryUpToSeq: upToSeq });
  return { updated: true, upToSeq };
}
