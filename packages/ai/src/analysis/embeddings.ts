/** Vectors for clustering. Provider embeddings when routed; a lexical fallback otherwise, so analysis never depends on a key. */
export interface EmbeddingSource {
  readonly kind: "provider" | "lexical";
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Widest vector. Words (and their stems) get their own dimension while the vocabulary fits, so two
 * unrelated facts cannot collide into a shared bucket; only a vocabulary larger than this is
 * hashed down. At 500 facts a 512-bucket hash put a noise floor above the clustering threshold
 * and average linkage chained the campaign into one cluster. Comparison is sparse (see
 * `sparsify`), so the width costs memory, not time.
 */
const MAX_DIM = 8192;
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

/** Bag of words with sublinear term frequency and document-frequency damping. Deterministic, no network. */
export class LexicalEmbeddings implements EmbeddingSource {
  readonly kind = "lexical" as const;

  async embed(texts: string[]): Promise<number[][]> {
    const docs = texts.map(tokenize);
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = docs.length;
    const stemOf = (t: string): string => t.slice(0, Math.max(4, t.length - 2));
    const vocab = new Map<string, number>();
    for (const d of docs) {
      for (const t of d) {
        if (!vocab.has(t)) vocab.set(t, vocab.size);
        const st = `~${stemOf(t)}`;
        if (!vocab.has(st)) vocab.set(st, vocab.size);
      }
    }
    const dim = Math.max(1, Math.min(vocab.size, MAX_DIM));
    const slot = (key: string): number =>
      vocab.size <= MAX_DIM ? (vocab.get(key) as number) : hash(key) % MAX_DIM;
    return docs.map((tokens) => {
      const v = new Array<number>(dim).fill(0);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, c] of tf) {
        const weight = (1 + Math.log(c)) * Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5));
        const i = slot(t);
        v[i] = (v[i] ?? 0) + weight;
        // also credit a stem bucket so inflections land together
        const j = slot(`~${stemOf(t)}`);
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
