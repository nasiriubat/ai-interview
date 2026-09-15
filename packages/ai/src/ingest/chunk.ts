/**
 * Cutting extracted text into the pieces the interview recalls on demand (FR-31).
 *
 * The size is a compromise between two failure modes. Chunks that are too small retrieve a
 * sentence with no context, and the model answers from a fragment it cannot situate. Chunks that
 * are too large spend the recall budget on three hits that are mostly irrelevant. Around a
 * thousand characters is roughly a long paragraph or a short section, which is the unit a person
 * would actually quote when answering "where does it say that".
 */

export interface ChunkOptions {
  /** Target size. A chunk may exceed it only when a single paragraph does. */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next. */
  overlapChars?: number;
  /** Chunks shorter than this are folded into their neighbour rather than kept alone. */
  minChars?: number;
}

export const DEFAULT_CHUNK: Required<ChunkOptions> = {
  maxChars: 1100,
  overlapChars: 120,
  minChars: 80,
};

/**
 * Splits on paragraph boundaries first, sentence boundaries second, and only cuts mid-sentence
 * when a single sentence is itself longer than the target — which happens in spreadsheets and
 * badly extracted PDFs, where "paragraph" is not a thing the source had.
 *
 * Consecutive chunks overlap slightly so a passage that straddles a boundary is retrievable from
 * either side. Without it, the one sentence that answers the question is the one that got cut in
 * half, and neither half scores.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const { maxChars, overlapChars, minChars } = { ...DEFAULT_CHUNK, ...options };
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const pieces = splitToPieces(trimmed, maxChars);
  const chunks: string[] = [];
  let current = "";

  for (const piece of pieces) {
    if (current.length === 0) {
      current = piece;
      continue;
    }
    if (current.length + 1 + piece.length <= maxChars) {
      current = `${current}\n${piece}`;
      continue;
    }
    chunks.push(current);
    // The overlap is a courtesy, not an obligation: prepending it must never push the new chunk
    // past the target, or a piece that is already near the limit produces an oversized chunk and
    // the guarantee this function makes to its callers quietly stops holding.
    const carry = overlapChars > 0 ? tail(current, overlapChars) : "";
    current = carry.length > 0 && carry.length + 1 + piece.length <= maxChars ? `${carry}\n${piece}` : piece;
  }
  if (current.length > 0) chunks.push(current);

  // A short trailing chunk is a fragment of the one before it, not a passage of its own.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1] ?? "";
    if (last.length < minChars) {
      chunks.pop();
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1] ?? ""}\n${last}`;
    }
  }
  return chunks;
}

/** Paragraphs, then sentences, then a hard cut — whatever it takes to get under the target. */
function splitToPieces(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (p.length === 0) continue;
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= maxChars) out.push(sentence);
      else for (const part of hardWrap(sentence, maxChars)) out.push(part);
    }
  }
  return out;
}

/**
 * Sentence ends, without a natural-language library.
 *
 * Splits after `.`, `!` or `?` followed by whitespace and something that starts a new sentence.
 * It gets abbreviations wrong ("approx. 3 hours" becomes two pieces) and that is acceptable: the
 * pieces are reassembled up to the target size immediately afterwards, so a bad split inside a
 * paragraph usually vanishes. Only a split that lands exactly on a chunk boundary is visible, and
 * the overlap covers that.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9"'“([])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Last resort: cut on a word boundary near the limit. */
function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = window.lastIndexOf(" ");
    const at = cut > maxChars * 0.6 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** The tail of a chunk, from a word boundary, to prefix the next one. */
function tail(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const window = text.slice(text.length - chars);
  const space = window.indexOf(" ");
  return (space === -1 ? window : window.slice(space + 1)).trim();
}
