import { ExtractionResultSchema, SessionStateSchema, type Fact } from "@aidp/shared";
import type { ModelCallerPort } from "../callModel.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";

/** Messages per extraction call. A backlog (retries, a long session) is worked off in passes, each persisted. */
export const EXTRACTION_BATCH_MESSAGES = 24;

/**
 * Continuous fact extraction into layer 2 (FR-14). Processes messages after the last
 * extracted sequence in batches and filters to the template's expected kinds.
 *
 * Each batch is committed as one unit through `SessionStore.commitExtraction`: the fact rows, the
 * state's facts and cursor, and the event. A crash or a failure on a later batch therefore never
 * leaves a cursor that has moved past facts nobody wrote, which is how facts used to be lost for
 * good (the cursor advanced, the rows were written by the caller afterwards, and a retry saw
 * nothing pending). A `stale` commit means another run got there first; this run stops, since
 * that run owns the cursor and is itself retried if it fails.
 */
export async function extractFacts(
  deps: { caller: ModelCallerPort; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
): Promise<{ facts: Fact[]; upToSeq: number; stale: boolean }> {
  let state = SessionStateSchema.parse(session.state);
  const all: Fact[] = [];
  for (;;) {
    const pending = await deps.store.messagesAfter(session.id, state.lastExtractedSeq);
    if (pending.length === 0) break;
    const fresh = pending.slice(0, EXTRACTION_BATCH_MESSAGES);
    const { facts, upToSeq, promptVersion } = await extractBatch(deps, session, state, fresh);
    const outcome = await deps.store.commitExtraction(session.id, {
      companyId: session.companyId,
      fromSeq: state.lastExtractedSeq,
      toSeq: upToSeq,
      facts,
      extractorVersion: promptVersion,
      event: { count: facts.length, upToSeq, promptVersion },
    });
    if (outcome === "stale") return { facts: all, upToSeq: state.lastExtractedSeq, stale: true };
    state = { ...state, facts: [...state.facts, ...facts], lastExtractedSeq: upToSeq };
    all.push(...facts);
    if (pending.length <= EXTRACTION_BATCH_MESSAGES) break;
  }
  return { facts: all, upToSeq: state.lastExtractedSeq, stale: false };
}

async function extractBatch(
  deps: { caller: ModelCallerPort; store: SessionStore; prompts: PromptSource },
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
