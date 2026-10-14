/**
 * Preparing an interviewer turn to be spoken aloud (FR-30a).
 *
 * Text written to be read and text written to be heard are not the same thing, and the gap shows
 * immediately in a voice interview. Three problems in particular:
 *
 * - **Markdown.** The interviewer sometimes emphasizes a word or lists options. Read aloud,
 *   asterisks and hyphens become noises, or worse, the model's own punctuation gets pronounced.
 * - **Widgets.** A turn can carry six options with explanatory detail. On screen that is a list to
 *   scan; spoken in full it is forty seconds of monologue nobody can hold in their head.
 * - **Length.** A paragraph that reads fine takes half a minute to say, and the participant has no
 *   way to skim it.
 *
 * None of this changes what is stored. The transcript keeps the interviewer's actual words; this
 * produces a separate spoken rendering of them.
 */

import type { Widget } from "@aidp/shared";

/** Beyond this many characters, a spoken turn is trimmed to its first questions. */
export const MAX_SPOKEN_CHARS = 420;

/** Options beyond this many are summarized rather than read out one by one. */
export const MAX_SPOKEN_OPTIONS = 4;

export interface SpokenTurn {
  /** What the speech model should say. */
  text: string;
  /** True when something was left out, so the interface can say "the options are on screen". */
  shortened: boolean;
}

/**
 * Renders one interviewer turn as speech.
 *
 * `voiceShortForm` wins when the model supplied one: the interviewer prompt already asks for a
 * spoken variant of its own question, and a model that wrote one knows better than this function
 * what it meant to ask.
 */
export function toSpokenTurn(message: string, widget?: Widget, voiceShortForm?: string): SpokenTurn {
  // An empty or whitespace-only short form falls back to the written message, which `??` would
  // not do: a model that emitted `voiceShortForm: ""` would otherwise be spoken as silence.
  const short = voiceShortForm?.trim();
  const base = plainSpeech(short !== undefined && short.length > 0 ? short : message);
  const spokenWidget = widget ? speakWidget(widget) : undefined;
  const joined = spokenWidget ? `${base} ${spokenWidget.text}` : base;
  const clipped = clipToSentence(joined, MAX_SPOKEN_CHARS);
  return {
    text: clipped.text,
    shortened: clipped.shortened || (spokenWidget?.shortened ?? false),
  };
}

/**
 * Strips the markup a speech model would otherwise pronounce.
 *
 * Deliberately conservative: it removes the characters that carry no sound and leaves everything
 * else alone. Rewriting the sentence would be a second model call on the latency budget the whole
 * feature is fighting for.
 */
export function plainSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reads a widget in short form, which is what the spec asks for.
 *
 * Option *details* are never spoken. They exist to disambiguate a label someone is reading, and a
 * listener who needs them can look at the screen, which stays in sync throughout. Past four
 * options the list becomes a count and an invitation, because a spoken list of seven is a memory
 * test rather than a question.
 */
export function speakWidget(widget: Widget): SpokenTurn {
  switch (widget.type) {
    case "yes_no":
      return { text: "Yes or no?", shortened: false };
    case "scale": {
      const { min, max, minLabel, maxLabel } = widget;
      const ends = minLabel && maxLabel ? `, where ${min} is ${minLabel} and ${max} is ${maxLabel}` : "";
      return { text: `On a scale from ${min} to ${max}${ends}, what would you say?`, shortened: false };
    }
    case "single_choice":
    case "multi_choice": {
      const labels = widget.options.map((o) => o.label);
      const many = labels.length > MAX_SPOKEN_OPTIONS;
      if (many) {
        return {
          text: `There are ${labels.length} options on screen. You can pick from those, or just tell me in your own words.`,
          shortened: true,
        };
      }
      const list = readableList(labels);
      const prefix = widget.type === "multi_choice" ? "You can pick more than one:" : "Is it";
      return { text: `${prefix} ${list}? Or say it in your own words.`, shortened: false };
    }
    case "ranking":
      return {
        text: `There are ${widget.options.length} things on screen to put in order. Tell me which matters most and we can work down from there.`,
        shortened: true,
      };
    default:
      return { text: "", shortened: false };
  }
}

/** "a, b and c" — spoken lists need the conjunction that a bulleted list does not. */
export function readableList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1] ?? ""}`;
}

/**
 * Trims to a sentence boundary under the limit, keeping whole questions.
 *
 * Cutting mid-sentence is worse than saying less: the participant hears the interviewer stop
 * apparently at random. If even the first sentence is over the limit it is spoken anyway, because
 * a truncated question is not a question.
 */
export function clipToSentence(text: string, maxChars: number): { text: string; shortened: boolean } {
  if (text.length <= maxChars) return { text, shortened: false };
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    if (out.length > 0 && out.length + sentence.length > maxChars) break;
    out += sentence;
  }
  const kept = out.trim();
  return kept.length > 0
    ? { text: kept, shortened: true }
    : { text: (sentences[0] ?? text).trim(), shortened: true };
}

/** A first spoken segment shorter than this is extended with the next sentence ("Thanks." alone sounds clipped). */
export const MIN_EARLY_SPOKEN_CHARS = 25;

/**
 * The first sentence or two of a reply that is still streaming, in the form it will be spoken
 * (D-280), or `undefined` while the text so far does not contain a complete sentence.
 *
 * A sentence is complete only when its terminator is followed by whitespace: the stream may be
 * about to continue a number ("3.5 hours") or an abbreviation. The result is what `plainSpeech`
 * makes of that leading text, so the rest of the reply can be cut from `toSpokenTurn`'s output by
 * prefix and the two segments together say exactly what the whole turn would have said.
 */
export function firstSpokenSentence(streamed: string): string | undefined {
  const terminator = /[.!?…]+["')\]]*(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(streamed)) !== null) {
    const spoken = plainSpeech(streamed.slice(0, match.index + match[0].length));
    if (spoken.length >= MIN_EARLY_SPOKEN_CHARS) return spoken;
  }
  return undefined;
}

/**
 * What is left to say once `spokenSoFar` has been spoken: the turn's full spoken text without that
 * prefix. When the full text does not begin with it (it should always, because the first sentence
 * is never clipped), the whole text is returned, so nothing the participant should hear is lost.
 */
export function remainingSpoken(full: SpokenTurn, spokenSoFar: string): SpokenTurn {
  if (!full.text.startsWith(spokenSoFar)) return full;
  return { text: full.text.slice(spokenSoFar.length).trim(), shortened: full.shortened };
}
