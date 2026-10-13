/**
 * Cleans a participant's quote before it is stored as evidence and shown in a report (D-143).
 *
 * A quote that clears the k gate is still the person's own sentence, and people put identifiers in
 * sentences: an address, a phone number, a ticket URL, an employee number. None of those help a
 * reader weigh the evidence, and each one narrows "one of five nurses" to one nurse. They are
 * replaced with a bracketed word, so the quote still reads as a quote.
 *
 * Markup is dropped as well: a quote ends up in Markdown that is rendered, and `<img>` or a link
 * written by a participant should not become part of a report.
 */
const REPLACEMENTS: [RegExp, string][] = [
  // HTML tags and comments.
  [/<!--[\s\S]*?-->/g, ""],
  [/<\/?[a-z][^>]*>/gi, ""],
  // Markdown links and images keep their visible text only.
  [/!?\[([^\]]*)\]\([^)]*\)/g, "$1"],
  // Addresses before URLs: `name@host.tld` must not be eaten as a host.
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b(?:https?:\/\/|www\.)[^\s)>\]]+/gi, "[link]"],
  // Phone numbers and other digit groups: 7 or more digits, however they are punctuated.
  [/(?:\+?\d[\s().-]?){7,}\d/g, "[number]"],
];

/** Collapses runs of whitespace the replacements leave behind. */
export function sanitizeSnippet(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  // Emphasis and code markers a participant typed have no place in a quoted line. Underscores stay:
  // they are as likely to be part of a file or field name as emphasis.
  out = out.replace(/[`*~]+/g, "");
  return out.replace(/\s+/g, " ").trim();
}
