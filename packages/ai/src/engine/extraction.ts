import { ExtractionResultSchema, SessionStateSchema, type Fact } from "@aidp/shared";
import type { ModelCaller } from "../callModel.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";

/** Messages per extraction call. A backlog (retries, a long session) is worked off in passes, each persisted. */
export const EXTRACTION_BATCH_MESSAGES = 24;

/**
 * Continuous fact extraction into layer 2 (FR-14). Processes messages after the last
 * extracted sequence in batches, filters to the template's expected kinds, appends to
 * state after every batch so a failure never loses the batches before it.
 */
export async function extractFacts(
  deps: { caller: ModelCaller; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
): Promise<{ facts: Fact[]; upToSeq: number }> {
  let state = SessionStateSchema.parse(session.state);
  const all: Fact[] = [];
  for (;;) {
    const pending = await deps.store.messagesAfter(session.id, state.lastExtractedSeq);
    if (pending.length === 0) break;
    const fresh = pending.slice(0, EXTRACTION_BATCH_MESSAGES);
    const { facts, upToSeq, promptVersion } = await extractBatch(deps, session, state, fresh);
    state = { ...state, facts: [...state.facts, ...facts], lastExtractedSeq: upToSeq };
    await deps.store.saveState(session.id, state);
    await deps.store.appendEvent(session.id, "facts_extracted", {
      count: facts.length,
      upToSeq,
      promptVersion,
    });
    all.push(...facts);
    if (pending.length <= EXTRACTION_BATCH_MESSAGES) break;
  }
  return { facts: all, upToSeq: state.lastExtractedSeq };
}

async function extractBatch(
  deps: { caller: ModelCaller; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
  state: ReturnType<typeof SessionStateSchema.parse>,
  fresh: Awaited<ReturnType<SessionStore["messagesAfter"]>>,
): Promise<{ facts: Fact[]; upToSeq: number; promptVersion: string }> {
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
  return { facts, upToSeq, promptVersion: promptVersionTag(prompt) };
}
