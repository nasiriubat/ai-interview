import { agglomerate } from "./cluster.js";
import { centroidOf } from "./clustering.js";
import { cosine, LexicalEmbeddings } from "./embeddings.js";

/** How much stricter than the run's own threshold a proposal is (blueprint section 3). */
export const SPLIT_STEP = 0.08;
const MAX_PARTS = 3;

/**
 * Proposes how to cut a cluster in two or three: the same similarity pass the run used, asked to be
 * stricter until the facts fall apart. Lexical vectors, so it makes no model call and the same
 * facts always give the same proposal; the administrator moves anything that is wrong. Returns the
 * part (0, 1, 2) of every text, in order, and always at least two parts for two or more texts.
 */
export async function proposeSplit(texts: readonly string[], baseThreshold: number): Promise<number[]> {
  const n = texts.length;
  if (n < 2) return texts.map(() => 0);
  const vectors = await new LexicalEmbeddings().embed([...texts]);
  for (let t = baseThreshold + SPLIT_STEP; t < 1; t += SPLIT_STEP) {
    const groups = agglomerate(vectors, t);
    if (groups.length < 2) continue;
    // The largest groups are the parts; anything smaller joins its nearest part.
    const keep = groups.slice(0, MAX_PARTS);
    const centroids = keep.map((g) => centroidOf(g.map((i) => vectors[i] ?? [])));
    const part = new Array<number>(n).fill(0);
    keep.forEach((g, p) => {
      for (const i of g) part[i] = p;
    });
    for (const g of groups.slice(MAX_PARTS)) {
      const c = centroidOf(g.map((i) => vectors[i] ?? []));
      let best = 0;
      let bestSim = -Infinity;
      centroids.forEach((k, p) => {
        const s = cosine(c, k);
        if (s > bestSim) {
          bestSim = s;
          best = p;
        }
      });
      for (const i of g) part[i] = best;
    }
    return part;
  }
  // Nothing separates them: cut in half in the order given, so the admin has two halves to move
  // facts between rather than an error.
  const half = Math.ceil(n / 2);
  return texts.map((_, i) => (i < half ? 0 : 1));
}
