import { cosine } from "./embeddings.js";

interface Sparse {
  idx: Int32Array;
  val: Float64Array;
  norm: number;
}

/** Only the non-zero entries: a hashed lexical vector has a few dozen out of thousands. */
export function sparsify(v: number[]): Sparse {
  const idx: number[] = [];
  const val: number[] = [];
  let sq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    if (x !== 0) {
      idx.push(i);
      val.push(x);
      sq += x * x;
    }
  }
  return { idx: Int32Array.from(idx), val: Float64Array.from(val), norm: Math.sqrt(sq) };
}

export function sparseCosine(a: Sparse, b: Sparse): number {
  if (a.norm === 0 || b.norm === 0) return 0;
  let i = 0;
  let j = 0;
  let dot = 0;
  while (i < a.idx.length && j < b.idx.length) {
    const x = a.idx[i] as number;
    const y = b.idx[j] as number;
    if (x === y) {
      dot += (a.val[i] as number) * (b.val[j] as number);
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return dot / (a.norm * b.norm);
}

/** Above this many items the quadratic similarity matrix is not built; see `leaderClusters`. */
export const MAX_AGGLOMERATE = 2500;

/**
 * Average-linkage agglomerative clustering with a similarity threshold. Deterministic: ties break
 * on the lower index.
 *
 * Linkage sums are kept in a matrix and updated on every merge (Lance-Williams for average
 * linkage), and each cluster remembers its best neighbour, so a merge costs a few row scans
 * instead of a full re-evaluation of every pair. The earlier version recomputed every pairwise
 * linkage on each iteration, which is cubic and was the first thing to stall at pilot scale.
 */
export function agglomerate(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n > MAX_AGGLOMERATE) return leaderClusters(vectors, threshold);

  // Sum of pairwise similarities between clusters i and j (initially the single similarity).
  const sum = new Float64Array(n * n);
  const sparse = vectors.map(sparsify);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = sparseCosine(sparse[i] as Sparse, sparse[j] as Sparse);
      sum[i * n + j] = s;
      sum[j * n + i] = s;
    }
  }
  const members: number[][] = vectors.map((_, i) => [i]);
  const size = new Int32Array(n).fill(1);
  const active = new Uint8Array(n).fill(1);
  const nn = new Int32Array(n).fill(-1);
  const nnVal = new Float64Array(n).fill(-Infinity);

  const avg = (i: number, j: number): number => (sum[i * n + j] ?? 0) / ((size[i] ?? 1) * (size[j] ?? 1));
  const rescan = (i: number): void => {
    let best = -Infinity;
    let bj = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || !active[j]) continue;
      const v = avg(i, j);
      if (v > best) {
        best = v;
        bj = j;
      }
    }
    nn[i] = bj;
    nnVal[i] = best;
  };
  for (let i = 0; i < n; i++) rescan(i);

  for (;;) {
    let bi = -1;
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      if (active[i] && (nn[i] ?? -1) >= 0 && (nnVal[i] ?? -Infinity) > best) {
        best = nnVal[i] ?? -Infinity;
        bi = i;
      }
    }
    if (bi < 0 || best < threshold) break;
    const other = nn[bi] ?? -1;
    const a = Math.min(bi, other);
    const b = Math.max(bi, other);
    members[a] = [...(members[a] ?? []), ...(members[b] ?? [])].sort((x, y) => x - y);
    members[b] = [];
    for (let k = 0; k < n; k++) {
      if (k === a || k === b || !active[k]) continue;
      const v = (sum[a * n + k] ?? 0) + (sum[b * n + k] ?? 0);
      sum[a * n + k] = v;
      sum[k * n + a] = v;
    }
    size[a] = (size[a] ?? 0) + (size[b] ?? 0);
    active[b] = 0;
    rescan(a);
    for (let k = 0; k < n; k++) {
      if (k === a || !active[k]) continue;
      if (nn[k] === a || nn[k] === b) {
        rescan(k);
      } else {
        const v = avg(k, a);
        if (v > (nnVal[k] ?? -Infinity) || (v === nnVal[k] && a < (nn[k] ?? n))) {
          nn[k] = a;
          nnVal[k] = v;
        }
      }
    }
  }
  const out: number[][] = [];
  for (let i = 0; i < n; i++) if (active[i]) out.push(members[i] ?? []);
  return out.sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * One pass for very large inputs: each vector joins the first existing cluster whose running
 * centroid is at least `threshold` similar, otherwise starts one. Order-dependent and coarser than
 * agglomeration, but linear in clusters per item and never allocates a matrix.
 */
export function leaderClusters(vectors: number[][], threshold: number): number[][] {
  const clusters: { idx: number[]; centroid: number[] }[] = [];
  vectors.forEach((v, i) => {
    let target: { idx: number[]; centroid: number[] } | undefined;
    let best = threshold;
    for (const c of clusters) {
      const s = cosine(c.centroid, v);
      if (s >= best) {
        best = s;
        target = c;
      }
    }
    if (!target) {
      clusters.push({ idx: [i], centroid: [...v] });
      return;
    }
    const n = target.idx.length;
    target.centroid = target.centroid.map((x, d) => (x * n + (v[d] ?? 0)) / (n + 1));
    target.idx.push(i);
  });
  return clusters.map((c) => c.idx).sort((a, b) => b.length - a.length || (a[0] ?? 0) - (b[0] ?? 0));
}
