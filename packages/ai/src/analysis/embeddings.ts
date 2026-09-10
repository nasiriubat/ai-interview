/** Vectors for clustering. Provider embeddings when routed; a lexical fallback otherwise, so analysis never depends on a key. */
export interface EmbeddingSource {
  readonly kind: "provider" | "lexical";
  embed(texts: string[]): Promise<number[][]>;
}

const DIM = 512;
/** Hashed sparse vectors score low in absolute terms: paraphrases land around 0.1 to 0.2, unrelated facts near 0. */
export const LEXICAL_THRESHOLD = 0.08;
const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "that",
  "this",
  "i",
  "we",
  "you",
  "our",
  "at",
  "by",
  "from",
  "be",
  "are",
  "was",
  "as",
  "into",
  "then",
  "than",
  "so",
  "do",
  "does",
  "have",
  "has",
]);

/** Hashed bag of words with sublinear term frequency and document-frequency damping. Deterministic, no network. */
export class LexicalEmbeddings implements EmbeddingSource {
  readonly kind = "lexical" as const;

  async embed(texts: string[]): Promise<number[][]> {
    const docs = texts.map(tokenize);
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    return docs.map((tokens) => {
      const v = new Array<number>(DIM).fill(0);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, c] of tf) {
        const weight = (1 + Math.log(c)) * Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
        const i = hash(t) % DIM;
        v[i] = (v[i] ?? 0) + weight;
        // also credit a stem bucket so inflections land together
        const j = hash(t.slice(0, Math.max(4, t.length - 2))) % DIM;
        v[j] = (v[j] ?? 0) + weight * 0.5;
      }
      return normalize(v);
    });
  }
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9äöåü]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
