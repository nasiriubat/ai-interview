import type { SessionState } from "@aidp/shared";
import { z } from "zod";
import type { ModelCallerPort } from "../callModel.js";
import { languageName } from "../util/language.js";
import type { SessionSnapshot } from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";
import { chooseFocus } from "./selection.js";

/**
 * The resume recap (spec 06, blueprint feature 9, D-172).
 *
 * Built from the engine's state, not the transcript: which areas are covered and what is known
 * about them, and what the engine would ask next. That keeps the call small, keeps the model from
 * quoting the participant, and makes the fallback honest, since the fallback is a sentence made
 * from exactly the same facts.
 *
 * It is never a message: it is not stored in the transcript, not given to the interviewer and not
 * extracted from.
 */

export const RecapOutputSchema = z.object({ recap: z.string().min(1).max(400) });

export interface RecapResult {
  text: string;
  source: "model" | "fallback";
}

export interface RecapFacts {
  /** Names of the areas that are covered, in template order. */
  covered: string[];
  /** The area the engine would ask next; undefined when the interview is at its end or still on context. */
  next?: string;
  /** True when the next step is the closing question. */
  closing: boolean;
}

/** What the recap is about, from state alone. */
export function recapFacts(session: SessionSnapshot, maxTurns: number): RecapFacts {
  const { template, state } = session;
  const name = (key: string): string => template.coverageAreas.find((a) => a.key === key)?.name ?? key;
  const covered = template.coverageAreas
    .filter((a) => state.coverage[a.key]?.status === "covered")
    .map((a) => a.name);
  const focus = chooseFocus({
    template,
    state,
    ...(session.path ? { path: session.path } : {}),
    maxTurns,
    lastAnswerMinimal: false,
  });
  switch (focus.mode) {
    case "area":
    case "continue":
    case "thread":
      return { covered, next: name(focus.areaKey), closing: false };
    case "closing":
    case "summary":
    case "done":
      return { covered, closing: true };
    default:
      return { covered, closing: false };
  }
}

const joinNames = (names: string[], and: string): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;

/**
 * The deterministic recap: two short sentences from the same facts, in the interview's language
 * (Finnish for `fi`, English otherwise). Used when the model fails, the budget is used up, or a
 * tenant has no route for the purpose, so the feature never depends on the budget it explains.
 */
export function fallbackRecap(facts: RecapFacts, language: string): string {
  const fi = language.toLowerCase().startsWith("fi");
  const list = joinNames(facts.covered, fi ? "ja" : "and");
  if (fi) {
    const first =
      facts.covered.length > 0
        ? `Tervetuloa takaisin. Olemme käsitelleet jo ${list}.`
        : "Tervetuloa takaisin. Haastattelu on vasta alussa.";
    const second = facts.closing
      ? "Olemme lähellä loppua."
      : facts.next
        ? `Seuraavaksi puhutaan aiheesta ${facts.next}.`
        : "Jatketaan siitä, mihin jäimme.";
    return `${first} ${second}`;
  }
  const first =
    facts.covered.length > 0
      ? `Welcome back. We have already covered ${list}.`
      : "Welcome back. We were just getting started.";
  const second = facts.closing
    ? "We are close to the end."
    : facts.next
      ? `Next we will talk about ${facts.next}.`
      : "We will pick up where we left off.";
  return `${first} ${second}`;
}

function renderRecapInput(session: SessionSnapshot, facts: RecapFacts): string {
  const { template, state } = session;
  const lines = ["Areas:"];
  for (const a of template.coverageAreas) {
    const c = state.coverage[a.key];
    const status = c?.status ?? "untouched";
    lines.push(`- ${a.name}: ${status}${c?.known ? ` (known: ${c.known})` : ""}`);
  }
  lines.push(
    facts.closing ? "Next: the closing question." : facts.next ? `Next: ${facts.next}.` : "Next: continue.",
  );
  return lines.join("\n");
}

/**
 * Writes the recap with the `resume_summary` route (the purpose is shared with the rolling
 * summary; the ledger tells them apart by `recap@1`), falling back to the deterministic sentence
 * on any failure. Never throws.
 */
export async function generateRecap(
  deps: { caller: ModelCallerPort; prompts: PromptSource },
  session: SessionSnapshot,
  options: { maxTurns: number; useModel?: boolean },
): Promise<RecapResult> {
  const facts = recapFacts(session, options.maxTurns);
  const fallback = (): RecapResult => ({
    text: fallbackRecap(facts, session.template.language),
    source: "fallback",
  });
  // Nothing covered yet: the model has nothing to say that the fallback does not.
  if (options.useModel === false || facts.covered.length === 0) return fallback();
  try {
    const prompt = await deps.prompts.get(session.companyId, "recap", session.id);
    const out = await deps.caller.complete(
      "resume_summary",
      {
        companyId: session.companyId,
        sessionId: session.id,
        ...(session.campaignId ? { campaignId: session.campaignId } : {}),
        promptVersion: promptVersionTag(prompt),
        ref: { type: "session", id: session.id },
      },
      {
        system: prompt.body.replace("{{language}}", languageName(session.template.language)),
        messages: [{ role: "user", content: renderRecapInput(session, facts) }],
        maxOutputTokens: 200,
      },
      RecapOutputSchema,
      "recap",
    );
    const text = out.recap.trim();
    return text ? { text, source: "model" } : fallback();
  } catch {
    // Budget exhausted, no route, provider down, unparseable output: all the same to the person
    // reading it. The ledger already holds the reason when a call was attempted.
    return fallback();
  }
}

/** Whether a cached recap is still the right one for the session as it is now. */
export function recapIsCurrent(state: SessionState, lastSeq: number): boolean {
  return state.recap?.upToSeq === lastSeq;
}
