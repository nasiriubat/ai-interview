import { SessionStateSchema } from "@aidp/shared";
import type { ModelCallerPort } from "../callModel.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";

/**
 * Layer 3 maintenance: folds turns older than the recent window into the rolling summary.
 * Runs as a job after turns; idempotent because it records the sequence it summarized up to.
 */
export async function updateRollingSummary(
  deps: { caller: ModelCallerPort; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
  recentWindowTurns: number,
): Promise<{ updated: boolean; upToSeq: number }> {
  const state = SessionStateSchema.parse(session.state);
  const older = await deps.store.messagesAfter(session.id, state.summaryUpToSeq);
  const keep = recentWindowTurns * 2;
  const toFold = older.slice(0, Math.max(0, older.length - keep));
  if (toFold.length === 0) return { updated: false, upToSeq: state.summaryUpToSeq };

  const prompt = await deps.prompts.get(session.companyId, "summary");
  const nonce = newNonce();
  const transcript = toFold
    .map((m) =>
      m.role === "user"
        ? `Participant:\n${wrapUntrusted("participant_turn", renderStoredMessage(m), { nonce, id: m.seq })}`
        : `Interviewer: ${renderStoredMessage(m)}`,
    )
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
          content: `Previous summary:\n${wrapUntrusted("summary", session.summary || "(none)", { nonce })}\n\nNew turns:\n${transcript}\n\nUpdated summary:`,
        },
      ],
    },
  )) {
    if (ev.type === "text") summary += ev.text;
  }
  const upToSeq = toFold[toFold.length - 1]?.seq ?? state.summaryUpToSeq;
  await deps.store.commitSummary(session.id, summary.trim(), upToSeq);
  return { updated: true, upToSeq };
}
