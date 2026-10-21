/*
 * Point-level anonymity for the collective analysis (D-479).
 *
 * k-anonymity used to be decided per group: a group of k or more people could show quotes, roles
 * and tools. A group is not a point, though. A one-person problem merged into a three-person group
 * was quoted verbatim ("I'm the only one who knows how to do it"), and a role held by one person
 * in the whole campaign printed next to a group tells its readers who spoke. The rules here are
 * deterministic and work on any campaign; they are the floor under what the model is asked to do:
 *
 * - a quote that says what only the speaker does, knows or built, or how long they have been there,
 *   is never shown, whatever the group size (`isSelfIdentifying`);
 * - model-written text loses every sentence that singles one person out (`stripSingling`);
 * - a breakdown value (a role, a department, a tool) is shown only when at least k people across
 *   the campaign share it (`commonValues`), and in a group of fewer than k people the names of
 *   tools fewer than k people use are replaced by a generic word (`genericizeTerms`).
 */

/** First-person statements that single the speaker out, in English and Finnish. */
const SELF_IDENTIFYING: RegExp[] = [
  /\b(?:i'?m|i am|i was|i'?ve been)\s+(?:the\s+)?(?:only|sole|single|one and only)\b/iu,
  /\b(?:only|nobody but|no one but|none but)\s+(?:i|me|myself)\b/iu,
  /\b(?:nobody|no one|no-one|none of the others)\s+else\b/iu,
  /\bi\s+(?:built|made|created|wrote|designed|set up|developed|came up with)\b[^.!?]*\b(?:myself|on my own|alone|from scratch)\b/iu,
  /\b(?:i'?ve|i have)\s+been\s+(?:here|working here|with (?:the|this) (?:company|firm|team))\s+(?:for\s+)?(?:\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|over|almost|nearly)\b/iu,
  /\bfor\s+(?:\d+|over \d+)\s+years?\s+(?:now\s+)?(?:i|i've|i have)\b/iu,
  /\b(?:minä|mä|mie)\s+(?:olen|oon)\s+ainoa\b/iu,
  /\bainoa,?\s+(?:joka|ken|kuka)\b/iu,
  /\b(?:kukaan|kenenkään)\s+muu\b/iu,
  /\b(?:vain|ainoastaan)\s+(?:minä|mä|mie|minulla|mulla)(?!\p{L})/iu,
  /\b(?:tein|rakensin|loin|kehitin)\b[^.!?]*\bitse\b/iu,
];

/** Whether a participant's quote says what only they do, know or built, or how long they have been there. */
export function isSelfIdentifying(quote: string): boolean {
  return SELF_IDENTIFYING.some((re) => re.test(quote));
}

const PERSON = "(?:person|people|one|employee|individual|staff member|colleague|member of staff|worker)";
/** Sentences, in model-written text, that say one person is the only one who knows or does something. */
const SINGLING: RegExp[] = [
  new RegExp(
    `\\b(?:the\\s+)?(?:only|sole|single)\\s+${PERSON}\\s+(?:who|that|to|in|on|at|with|able)\\b`,
    "iu",
  ),
  new RegExp(
    `\\bonly\\s+(?:one|1)\\s+${PERSON}\\b[^.!?]*\\b(?:knows?|can|does|is able|handles?|understands?|built)\\b`,
    "iu",
  ),
  /\b(?:is|are|was)\s+the\s+only\s+one\b/iu,
  /\b(?:nobody|no one|no-one)\s+else\b/iu,
  /\b(?:depends|relies|rests|hinges)\s+(?:entirely\s+)?on\s+(?:one|a single|a sole)\s+(?:person|employee|individual|colleague)\b/iu,
  /\bwhen\s+(?:she|he|that person|this person)\s+is\s+(?:away|absent|off|on holiday|on vacation|on leave|ill|sick)\b/iu,
  /\b(?:ainoa|ainut)\s+(?:henkilö|ihminen|työntekijä)(?!\p{L})/iu,
  /\b(?:vain|ainoastaan)\s+yksi\s+(?:henkilö|ihminen|työntekijä)\s+(?:osaa|tietää|tekee|hallitsee)(?!\p{L})/iu,
  /\b(?:kukaan|kenenkään)\s+muu\b/iu,
];

/** Sentences, each keeping its own trailing punctuation and space. */
function sentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+(?:\s+|$)|$)/g) ?? [text];
}

/**
 * Removes every sentence that singles one person out ("she is the only one who knows the
 * procedure"). When every sentence would go, the text is returned as it was minus nothing: a field
 * that must not be empty is not emptied, and the count says what was found.
 */
export function stripSingling(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = sentences(text).filter((s) => {
    const hit = SINGLING.some((re) => re.test(s));
    if (hit) removed++;
    return !hit;
  });
  if (removed === 0) return { text, removed };
  const out = kept.join("").trim();
  return out ? { text: out, removed } : { text, removed: 0 };
}

/**
 * The values that at least `k` distinct participants share across the campaign. A role, a
 * department or a tool outside this set points at fewer than k people, so it is not printed.
 */
export function commonValues(
  entries: readonly { participantKey: string; values: readonly (string | undefined)[] }[],
  k: number,
): Set<string> {
  const holders = new Map<string, Set<string>>();
  for (const e of entries)
    for (const raw of e.values) {
      const v = raw?.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      const set = holders.get(key) ?? new Set<string>();
      set.add(e.participantKey);
      holders.set(key, set);
    }
  return new Set([...holders].filter(([, who]) => who.size >= k).map(([v]) => v));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const GENERIC_TOOL: Record<string, string> = { en: "a tool", fi: "työkalu" };

/**
 * Replaces each of `terms` (whole words, any case) with a generic word: what a group of fewer than
 * k people keeps of the tools only they use. Terms shorter than three characters are left alone.
 * In Finnish a name takes case endings ("HubSpotissa"), so there the inflected word goes too.
 */
export function genericizeTerms(text: string, terms: readonly string[], language: string): string {
  const lang = language.slice(0, 2).toLowerCase();
  const word = GENERIC_TOOL[lang] ?? "a tool";
  const suffix = lang === "fi" ? "\\p{L}*" : "";
  // "the HubSpot export" becomes "a tool export", not "the a tool export".
  const article = lang === "en" ? "(?:(?:the|a|an)\\s+)?" : "";
  let out = text;
  for (const t of [...terms].sort((a, b) => b.length - a.length)) {
    const term = t.trim();
    if (term.length < 3) continue;
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${article}${escape(term)}${suffix}(?![\\p{L}\\p{N}])`, "giu"),
      word,
    );
  }
  return out;
}
