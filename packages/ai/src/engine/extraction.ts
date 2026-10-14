import { ExtractionResultSchema, SessionStateSchema, type Fact } from "@aidp/shared";
import type { ModelCallerPort } from "../callModel.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { renderStoredMessage } from "./context.js";
import type { SessionSnapshot, SessionStore } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";
import { verifyQuotes } from "./quotes.js";

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
    const { facts, upToSeq, promptVersion, quotesDropped } = await extractBatch(deps, session, state, fresh);
    const outcome = await deps.store.commitExtraction(session.id, {
      companyId: session.companyId,
      fromSeq: state.lastExtractedSeq,
      toSeq: upToSeq,
      facts,
      extractorVersion: promptVersion,
      event: { count: facts.length, upToSeq, promptVersion, quotesDropped },
    });
    if (outcome === "stale") return { facts: all, upToSeq: state.lastExtractedSeq, stale: true };
    state = { ...state, facts: [...state.facts, ...facts], lastExtractedSeq: upToSeq };
    all.push(...facts);
    if (pending.length <= EXTRACTION_BATCH_MESSAGES) break;
  }
  return { facts: all, upToSeq: state.lastExtractedSeq, stale: false };
}

/** What the extractor is told is already known: one short line per fact, newest last, bounded. */
export function knownFactLines(facts: Fact[], limit = 60, lineChars = 110): string {
  const line = (f: Fact): string => {
    switch (f.kind) {
      case "task":
        return `task: ${f.name}`;
      case "process":
        return `process: ${f.name} (${f.steps.length} steps)`;
      case "information_flow":
        return `information_flow: ${f.what} (${f.from} to ${f.to})`;
      case "pain_point":
        return `pain_point: ${f.description}`;
      case "opportunity_candidate":
        return `opportunity_candidate: ${f.title}`;
      case "spec_field":
        return `spec_field: ${f.section}.${f.path}`;
    }
  };
  const shown = facts.slice(-limit);
  const lines = shown.map((f) => `- ${line(f).replace(/\s+/g, " ").slice(0, lineChars)}`);
  if (facts.length > shown.length) lines.unshift(`(${facts.length - shown.length} earlier facts not shown)`);
  return lines.length ? lines.join("\n") : "(none yet)";
}

async function extractBatch(
  deps: { caller: ModelCallerPort; store: SessionStore; prompts: PromptSource },
  session: SessionSnapshot,
  state: ReturnType<typeof SessionStateSchema.parse>,
  fresh: Awaited<ReturnType<SessionStore["messagesAfter"]>>,
): Promise<{ facts: Fact[]; upToSeq: number; promptVersion: string; quotesDropped: number }> {
  const prompt = await deps.prompts.get(session.companyId, "extraction");
  const kinds = session.template.outputs;
  const nonce = newNonce();
  // The participant's words are delimited material; the interviewer's own questions are context.
  const transcript = fresh
    .map((m) =>
      m.role === "user"
        ? `Participant:\n${wrapUntrusted("participant_turn", renderStoredMessage(m), { nonce, id: m.seq })}`
        : `Interviewer: ${renderStoredMessage(m)}`,
    )
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
          content: `Facts already known (do not repeat):\n${wrapUntrusted("known_facts", knownFactLines(state.facts), { nonce })}\n\nTranscript excerpt:\n${transcript}`,
        },
      ],
    },
    ExtractionResultSchema,
    "extraction",
  );
  const wanted = result.facts.filter((f) => kinds.includes(f.kind));
  // A quote ends up in reports and as evidence: it must be the participant's own words.
  const spoken = fresh.filter((m) => m.role === "user").map((m) => renderStoredMessage(m));
  const { facts, dropped } = verifyQuotes(wanted, spoken);
  const upToSeq = fresh[fresh.length - 1]?.seq ?? state.lastExtractedSeq;
  return { facts, upToSeq, promptVersion: promptVersionTag(prompt), quotesDropped: dropped };
}
