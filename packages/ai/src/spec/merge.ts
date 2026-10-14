import { z } from "zod";
import type { ModelCallerPort } from "../callModel.js";
import type { Logger } from "../engine/ports.js";
import { promptVersionTag, type PromptSource } from "../engine/prompts/index.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { groupPairs, type DuplicatePair, type ReqView } from "./quality.js";

/** The most requirements one cluster shows the model; a larger component is cut in id order. */
export const MAX_CLUSTER_SIZE = 30;
/** The most requirements one merge call is shown, over however many clusters fit. */
export const MAX_MERGE_ITEMS = 60;
/** The most calls one specification spends on this pass: a few cents on the cheap route. */
export const MAX_MERGE_CALLS = 6;

export const MergeVerdictSchema = z.object({
  groups: z.array(z.object({ ids: z.array(z.string()).default([]) })).default([]),
});

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);
const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);

interface Verdict {
  same: { a: string; b: string }[];
  different: { a: string; b: string }[];
}
interface Deps {
  caller: ModelCallerPort;
  prompts: PromptSource;
  logger: Logger;
}
interface Input {
  companyId: string;
  sessionId: string;
  reqs: ReqView[];
  pairs: DuplicatePair[];
}

/**
 * The grouped merge pass (D-241, D-290). The candidate pairs are joined into components (a
 * capability restated three times is one component of three, not three pairs to judge
 * consistently) and the cheap model partitions each component into the requirements that are one
 * capability. Never the whole list and never the transcript. A failure is not an error: the
 * candidates stay as they were and the specification is built without the merge.
 */
export async function judgeCandidatePairs(deps: Deps, input: Input): Promise<Verdict> {
  const candidates = input.pairs.filter((p) => p.kind === "candidate");
  const out: Verdict = { same: [], different: [] };
  if (candidates.length === 0) return out;
  const ids = [...new Set(candidates.flatMap((p) => [p.a, p.b]))];
  const components = groupPairs(ids, candidates)
    .map((g) => [...g].sort((x, y) => idNumber(x) - idNumber(y)))
    .flatMap((g) => {
      const chunks: string[][] = [];
      for (let i = 0; i < g.length; i += MAX_CLUSTER_SIZE) chunks.push(g.slice(i, i + MAX_CLUSTER_SIZE));
      return chunks.filter((c) => c.length > 1);
    })
    .sort((x, y) => y.length - x.length);
  // Pack clusters into calls of at most MAX_MERGE_ITEMS requirements.
  const calls: string[][][] = [];
  for (const c of components) {
    const last = calls[calls.length - 1];
    if (last && last.reduce((n, x) => n + x.length, 0) + c.length <= MAX_MERGE_ITEMS) last.push(c);
    else calls.push([c]);
  }
  for (const clusters of calls.slice(0, MAX_MERGE_CALLS)) {
    const r = await judgeClusters(deps, { ...input, clusters });
    out.same.push(...r.same);
    out.different.push(...r.different);
  }
  return out;
}

async function judgeClusters(deps: Deps, input: Input & { clusters: string[][] }): Promise<Verdict> {
  const byId = new Map(input.reqs.map((r) => [r.id, r]));
  const show = (id: string): string => {
    const r = byId.get(id);
    if (!r) return id;
    const acc = r.acceptance.slice(0, 2).map((a) => clip(a, 100));
    return `${id}: ${clip(r.title, 140)}${acc.length ? ` | acceptance: ${acc.join("; ")}` : ""}`;
  };
  const clusterOf = new Map<string, number>();
  input.clusters.forEach((c, i) => {
    c.forEach((id) => clusterOf.set(id, i));
  });
  try {
    const prompt = await deps.prompts.get(input.companyId, "requirement_merge");
    const body = input.clusters
      .map((c, i) => `Cluster ${i + 1}\n${c.map((id) => `  ${show(id)}`).join("\n")}`)
      .join("\n");
    const res = await deps.caller.complete(
      "issue_detection",
      {
        companyId: input.companyId,
        sessionId: input.sessionId,
        promptVersion: promptVersionTag(prompt),
        ref: { type: "session", id: input.sessionId },
      },
      {
        system: prompt.body,
        messages: [
          {
            role: "user",
            content: `Clusters to group:\n${wrapUntrusted("requirement_clusters", body, { nonce: newNonce() })}`,
          },
        ],
      },
      MergeVerdictSchema,
      "requirement_merge",
    );
    // A model under a strict schema sometimes answers with the whole line it was shown ("FR-3:
    // title | acceptance: ...") as the id (seen live with a small model); the id is its first token.
    const idOf = (s: string): string => /^\s*([^\s:|]+)/.exec(s)?.[1] ?? s;
    const used = new Set<string>();
    const same: { a: string; b: string }[] = [];
    for (const g of res.groups) {
      const first = g.ids.map(idOf).find((id) => clusterOf.has(id));
      if (first === undefined) continue;
      const cluster = clusterOf.get(first);
      // Only ids of one cluster, each id in one group.
      const members = [...new Set(g.ids.map(idOf))].filter(
        (id) => clusterOf.get(id) === cluster && !used.has(id),
      );
      if (members.length < 2) continue;
      members.forEach((id) => used.add(id));
      const [headId, ...rest] = members;
      for (const b of rest) if (headId !== undefined) same.push({ a: headId, b });
    }
    const head = new Map<string, string>(); // id -> head of its group
    for (const p of same) {
      head.set(p.a, p.a);
      head.set(p.b, p.a);
    }
    // Everything else the model was shown in a cluster was looked at and kept apart.
    const different: { a: string; b: string }[] = [];
    for (const c of input.clusters)
      c.forEach((a, i) => {
        for (const b of c.slice(i + 1)) {
          if (head.has(a) && head.get(a) === head.get(b)) continue;
          different.push({ a, b });
        }
      });
    deps.logger.info("requirement merge pass", {
      sessionId: input.sessionId,
      clusters: input.clusters.length,
      shown: input.clusters.reduce((n, c) => n + c.length, 0),
      groups: res.groups.length,
      merged: same.length,
    });
    return { same, different };
  } catch (e) {
    deps.logger.warn("requirement merge pass failed; keeping the candidates apart", {
      sessionId: input.sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { same: [], different: [] };
  }
}
