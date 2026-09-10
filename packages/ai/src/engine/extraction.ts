import { ExtractionResultSchema, SessionStateSchema, type Fact } from "@aidp/shared";
import type { ModelCaller } from "../callModel.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";

/**
 * Continuous fact extraction into layer 2 (FR-14). Processes messages after the last
 * extracted sequence, filters to the template's expected kinds, appends to state.
 */
export async function extractFacts(
  deps: { caller: ModelCaller; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
): Promise<{ facts: Fact[]; upToSeq: number }> {
  const state = SessionStateSchema.parse(session.state);
  const fresh = await deps.store.messagesAfter(session.id, state.lastExtractedSeq);
  if (fresh.length === 0) return { facts: [], upToSeq: state.lastExtractedSeq };

  const prompt = await deps.prompts.get(session.companyId, "extraction");
  const kinds = session.template.outputs;
  const transcript = fresh
    .map((m) => `${m.role === "user" ? "Participant" : "Interviewer"}: ${renderStoredMessage(m)}`)
    .join("\n");
  const result = await deps.caller.complete(
    "extraction",
    {
      companyId: session.companyId,
      sessionId: session.id,
      promptVersion: promptVersionTag(prompt),
      ref: { type: "session", id: session.id },
    },
    {
      system: prompt.body.replace("{{kinds}}", kinds.join(", ")),
      messages: [
        {
          role: "user",
          content: `Facts already known (do not repeat): ${state.facts.length}\n\nTranscript excerpt:\n${transcript}`,
        },
      ],
      maxOutputTokens: 4000,
    },
    ExtractionResultSchema,
    "extraction",
  );
  const facts = result.facts.filter((f) => kinds.includes(f.kind));
  const upToSeq = fresh[fresh.length - 1]?.seq ?? state.lastExtractedSeq;
  await deps.store.saveState(session.id, {
    ...state,
    facts: [...state.facts, ...facts],
    lastExtractedSeq: upToSeq,
  });
  await deps.store.appendEvent(session.id, "facts_extracted", {
    count: facts.length,
    upToSeq,
    promptVersion: promptVersionTag(prompt),
  });
  return { facts, upToSeq };
}
