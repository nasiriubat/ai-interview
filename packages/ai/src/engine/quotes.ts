import type { Fact } from "@aidp/shared";

/** Case, accents' compatibility forms, punctuation and spacing reduced away, so a quote compares as words. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

/**
 * Whether a quote is the participant's own words: after normalizing, a substring of what they said
 * in the excerpt, or at least 90% of its words occurring in it (a quote the model trimmed or
 * re-punctuated passes; one it wrote itself does not). Quotes of fewer than three words must be an
 * exact substring: a short phrase is too easy to assemble from scattered words.
 */
export function quoteIsVerbatim(quote: string, participantTexts: readonly string[]): boolean {
  const q = normalizeForQuote(quote);
  if (!q) return false;
  const corpus = participantTexts.map(normalizeForQuote).join(" \n ");
  if (corpus.includes(q)) return true;
  const words = q.split(" ");
  if (words.length < 3) return false;
  const have = new Set(corpus.split(/\s+/));
  const found = words.filter((w) => have.has(w)).length;
  return found / words.length >= 0.9;
}

/**
 * Removes the `quote` of every fact whose quote is not found in the participant's words. The fact
 * itself stays: a task is still a task without its quote. Returns the cleaned facts and how many
 * quotes were dropped, so the number reaches the event log.
 */
export function verifyQuotes(
  facts: Fact[],
  participantTexts: readonly string[],
): { facts: Fact[]; dropped: number } {
  let dropped = 0;
  const out = facts.map((f) => {
    if (!("quote" in f) || typeof f.quote !== "string" || f.quote === "") return f;
    if (quoteIsVerbatim(f.quote, participantTexts)) return f;
    dropped++;
    const { quote: _quote, ...rest } = f;
    return rest as Fact;
  });
  return { facts: out, dropped };
}
