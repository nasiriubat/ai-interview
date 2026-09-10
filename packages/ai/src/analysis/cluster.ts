import { cosine } from "./embeddings.js";

/**
 * Average-linkage agglomerative clustering with a similarity threshold. Deterministic:
 * ties break on the lower index. Fine for the hundreds of facts a campaign produces.
 */
export function agglomerate(vectors: number[][], threshold: number): number[][] {
  const clusters: number[][] = vectors.map((_, i) => [i]);
  const sim = vectors.map((a) => vectors.map((b) => cosine(a, b)));
  const linkage = (x: number[], y: number[]): number => {
    let s = 0;
    for (const i of x) for (const j of y) s += sim[i]?.[j] ?? 0;
    return s / (x.length * y.length);
  };
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i] ?? [], clusters[j] ?? []);
        if (l > best) {
          best = l;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < threshold || bi < 0) break;
    const merged = [...(clusters[bi] ?? []), ...(clusters[bj] ?? [])].sort((a, b) => a - b);
    clusters.splice(bj, 1);
    clusters.splice(bi, 1, merged);
  }
  return clusters.sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
}
