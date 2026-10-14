import { createHash } from "node:crypto";
import type { OpportunityOverride } from "@aidp/shared";
import { cosine } from "./embeddings.js";

/** A group of facts the similarity pass put together, before the model has looked at it. */
export interface DraftCluster {
  /** Short id the model sees; positional and only meaningful inside one run. */
  id: string;
  /** Fact ids, ascending. */
  factIds: string[];
  centroid: number[];
}

/**
 * The key a cluster is stored under (`Opportunity.clusterKey`): derived from the smallest member
 * fact id, never from a position or from a name the model chose.
 *
 * Fact ids are time-ordered cuids, so facts added by a later interview sort after the ones already
 * there and a cluster that grows keeps its key; the key moves only when its oldest fact is
 * deleted, and `matchOverrides` carries admin edits across that by overlap (blueprint section 0
 * item 1). Disjoint clusters have different minima, so keys never collide.
 */
export function stableClusterKey(factIds: readonly string[]): string {
  let min = factIds[0] ?? "";
  for (const id of factIds) if (id < min) min = id;
  return `c_${createHash("sha256").update(min).digest("hex").slice(0, 12)}`;
}

export function centroidOf(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) return [];
  const out = new Array<number>(first.length).fill(0);
  for (const v of vectors) for (let d = 0; d < out.length; d++) out[d] = (out[d] ?? 0) + (v[d] ?? 0);
  return out.map((x) => x / vectors.length);
}

/**
 * Puts related drafts next to each other: start from the largest, then repeatedly take the nearest
 * unplaced centroid. Batches cut from this order contain neighbours, so the merges a batch-sized
 * model call can make are the ones that exist. Quadratic in drafts, which is fine at the few
 * hundred a campaign yields; deterministic (ties go to the earlier draft).
 */
export function orderBySimilarity(drafts: DraftCluster[]): DraftCluster[] {
  const left = [...drafts];
  if (left.length <= 2) return left;
  left.sort((a, b) => b.factIds.length - a.factIds.length);
  const out: DraftCluster[] = [];
  let cur = left.shift();
  while (cur) {
    out.push(cur);
    let bi = -1;
    let best = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = cosine(cur.centroid, left[i]?.centroid ?? []);
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    cur = bi >= 0 ? left.splice(bi, 1)[0] : undefined;
  }
  return out;
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface OverrideAnchor {
  /** Fact ids the override was made against: the evidence rows of the opportunity it sat on. */
  factIds: string[];
  override: OpportunityOverride;
}

/**
 * Re-attaches admin overrides to the clusters of a new run by fact-id overlap (blueprint section 3:
 * containment, not Jaccard, so a cluster that grew still matches). An anchor attaches to the
 * cluster holding the most of its facts, accepted at half or more of the anchor; when two anchors
 * want the same cluster the larger overlap wins and the other is reported as orphaned. Returns the
 * override per cluster key and the anchors that matched nothing.
 */
export function matchOverrides(
  clusters: readonly { key: string; factIds: readonly string[] }[],
  anchors: readonly OverrideAnchor[],
): { byKey: Map<string, OpportunityOverride>; orphaned: OverrideAnchor[] } {
  const owner = new Map<string, string>();
  for (const c of clusters) for (const id of c.factIds) owner.set(id, c.key);
  const claims = new Map<string, { overlap: number; anchor: OverrideAnchor }>();
  const orphaned: OverrideAnchor[] = [];
  for (const anchor of anchors) {
    const counts = new Map<string, number>();
    for (const id of anchor.factIds) {
      const key = owner.get(id);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let bestKey: string | undefined;
    let best = 0;
    for (const [key, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      if (n > best) {
        best = n;
        bestKey = key;
      }
    }
    if (!bestKey || anchor.factIds.length === 0 || best / anchor.factIds.length < 0.5) {
      orphaned.push(anchor);
      continue;
    }
    const held = claims.get(bestKey);
    if (!held || best > held.overlap) {
      if (held) orphaned.push(held.anchor);
      claims.set(bestKey, { overlap: best, anchor });
    } else orphaned.push(anchor);
  }
  return { byKey: new Map([...claims].map(([k, v]) => [k, v.anchor.override])), orphaned };
}
