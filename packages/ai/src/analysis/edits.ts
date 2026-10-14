import { stableClusterKey } from "./clustering.js";

/** What the edit functions need to know about a cluster. */
export interface EditableCluster {
  key: string;
  name: string;
  summary: string;
  /** Member fact ids. */
  factIds: string[];
  /** The title an administrator gave a merge: the opportunity takes it over the model's. */
  title?: string | undefined;
}

/**
 * An administrator's merge or split, stored against fact ids and never against cluster keys
 * (FR-18, D-200): keys and draft ids change when the campaign is clustered again, facts do not.
 */
export type ClusterEditOp =
  | { id: string; op: "merge"; anchors: string[][]; title?: string | undefined }
  | { id: string; op: "split"; source: string[]; parts: string[][] };

/**
 * An anchor attaches to a cluster that holds at least this share of it. Containment rather than
 * Jaccard, so a cluster that has grown since still matches (blueprint section 3).
 */
export const ANCHOR_CONTAINMENT = 0.5;

/**
 * The cluster that holds the most of `anchorFactIds`, when that is at least half of them. Ties go
 * to the lower key so the answer does not depend on list order. `undefined` when the facts were
 * deleted or moved on (an orphaned anchor).
 */
export function matchAnchor<C extends { key: string; factIds: readonly string[] }>(
  clusters: readonly C[],
  anchorFactIds: readonly string[],
  minContainment: number = ANCHOR_CONTAINMENT,
): C | undefined {
  if (anchorFactIds.length === 0) return undefined;
  const anchor = new Set(anchorFactIds);
  let best: C | undefined;
  let bestN = 0;
  for (const c of clusters) {
    let n = 0;
    for (const id of c.factIds) if (anchor.has(id)) n++;
    if (n > bestN || (n === bestN && n > 0 && best !== undefined && c.key < best.key)) {
      best = c;
      bestN = n;
    }
  }
  return best && bestN / anchor.size >= minContainment ? best : undefined;
}

export interface AppliedEdits {
  clusters: EditableCluster[];
  /** Ids of edits that matched nothing (their facts were deleted or already re-formed). */
  orphaned: string[];
  /** Facts the split did not know, which joined the larger part. */
  unassignedNew: number;
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * Applies edits in the order given (oldest first) to a clustering, so the result is the same
 * whichever way the clustering happened to number its drafts. An edit that no longer matches is
 * skipped and reported rather than guessed at.
 */
export function applyClusterEdits(
  clusters: readonly EditableCluster[],
  edits: readonly ClusterEditOp[],
): AppliedEdits {
  let current = clusters.map((c) => ({ ...c, factIds: [...c.factIds] }));
  const orphaned: string[] = [];
  let unassignedNew = 0;

  for (const edit of edits) {
    if (edit.op === "merge") {
      const hit = new Map<string, EditableCluster>();
      let missing = false;
      for (const anchor of edit.anchors) {
        const c = matchAnchor(current, anchor);
        if (!c) missing = true;
        else hit.set(c.key, c);
      }
      // One anchor with no home means the admin's picture of the merge no longer holds; merging
      // only the rest would be a different edit from the one they made.
      if (missing) {
        orphaned.push(edit.id);
        continue;
      }
      const members = [...hit.values()];
      if (members.length === 1) {
        // Already one cluster, because the pipeline joined them itself: only the title remains.
        const only = members[0];
        if (only && edit.title)
          current = current.map((c) =>
            c.key === only.key ? { ...c, name: edit.title ?? c.name, title: edit.title } : c,
          );
        continue;
      }
      const lead = [...members].sort(
        (a, b) => b.factIds.length - a.factIds.length || a.key.localeCompare(b.key),
      )[0];
      const factIds = unique(members.flatMap((m) => m.factIds));
      const gone = new Set(members.map((m) => m.key));
      current = [
        ...current.filter((c) => !gone.has(c.key)),
        {
          key: stableClusterKey(factIds),
          name: edit.title ?? lead?.name ?? "",
          summary: lead?.summary ?? "",
          factIds,
          ...(edit.title ? { title: edit.title } : {}),
        },
      ];
      continue;
    }

    // split
    const parts = edit.parts.map((p) => new Set(p));
    const everything = unique(edit.parts.flat());
    const host = matchAnchor(current, everything);
    if (!host) {
      orphaned.push(edit.id);
      continue;
    }
    const buckets: string[][] = parts.map(() => []);
    const strays: string[] = [];
    for (const id of host.factIds) {
      const i = parts.findIndex((p) => p.has(id));
      if (i >= 0) buckets[i]?.push(id);
      else strays.push(id);
    }
    let largest = 0;
    buckets.forEach((b, i) => {
      if (b.length > (buckets[largest]?.length ?? 0)) largest = i;
    });
    if (strays.length > 0) {
      buckets[largest]?.push(...strays);
      unassignedNew += strays.length;
    }
    const filled = buckets.filter((b) => b.length > 0);
    if (filled.length < 2) {
      // The pipeline already separated these facts, or all but one part was deleted.
      orphaned.push(edit.id);
      unassignedNew -= strays.length;
      continue;
    }
    const label = (i: number): string => String.fromCharCode(65 + i);
    const made: EditableCluster[] = [];
    buckets.forEach((b, i) => {
      if (b.length === 0) return;
      const factIds = unique(b);
      made.push({
        key: stableClusterKey(factIds),
        name: i === largest ? host.name : `${host.name} (${label(i)})`,
        summary: i === largest ? host.summary : "",
        factIds,
      });
    });
    current = [...current.filter((c) => c.key !== host.key), ...made];
  }
  return {
    clusters: current.sort((a, b) => b.factIds.length - a.factIds.length || a.key.localeCompare(b.key)),
    orphaned,
    unassignedNew,
  };
}
