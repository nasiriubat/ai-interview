import * as React from "react";

/**
 * The emphasis a model writes in a chat message, rendered instead of shown as asterisks.
 *
 * The interviewer is asked for plain text, but models still write `**bold**` and `*italic*` (the
 * owner saw "For the **staff** role" on the live site, 2026-11-03). Only these two are read, and
 * only as React text nodes: no HTML is ever produced, so model output cannot inject markup. Lists
 * and line breaks need nothing here; the bubble keeps the message's own line breaks.
 */
const EMPHASIS = /(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1|(?<![*\w])([*_])(?=\S)([^*_\n]+?)(?<=\S)\3(?![*\w])/g;

export function renderInlineMarkup(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(EMPHASIS)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    if (m[2] !== undefined) out.push(<strong key={n++}>{m[2]}</strong>);
    else out.push(<em key={n++}>{m[4]}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
