import { z } from "zod";
import type { ModelCallerPort } from "../callModel.js";
import type { Logger } from "../engine/ports.js";
import { promptVersionTag, type PromptSource } from "../engine/prompts/index.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import type { DuplicatePair, ReqView } from "./quality.js";

/** The most pairs one merge call is shown; the strongest candidates go first. */
export const MAX_MERGE_PAIRS = 24;

export const MergeVerdictSchema = z.object({
  pairs: z.array(z.object({ a: z.string(), b: z.string(), same: z.boolean() })).default([]),
});

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);
const pairKey = (a: string, b: string): string => [a, b].sort().join("|");

/**
 * One cheap structured call over the near-duplicate candidate pairs (D-241). Never over the whole
 * list and never the transcript. A failure is not an error: the pairs stay as they were and the
 * specification is built without the merge, which is what it did before this pass existed.
 */
export async function judgeCandidatePairs(
  deps: { caller: ModelCallerPort; prompts: PromptSource; logger: Logger },
  input: { companyId: string; sessionId: string; reqs: ReqView[]; pairs: DuplicatePair[] },
): Promise<{ same: { a: string; b: string }[]; different: { a: string; b: string }[] }> {
  const pairs = input.pairs.filter((p) => p.kind === "candidate").slice(0, MAX_MERGE_PAIRS);
  if (pairs.length === 0) return { same: [], different: [] };
  const byId = new Map(input.reqs.map((r) => [r.id, r]));
  const show = (id: string): string => {
    const r = byId.get(id);
    if (!r) return id;
    const acc = r.acceptance.slice(0, 2).map((a) => clip(a, 100));
    return `${id}: ${clip(r.title, 140)}${acc.length ? ` | acceptance: ${acc.join("; ")}` : ""}`;
  };
  try {
    const prompt = await deps.prompts.get(input.companyId, "requirement_merge");
    const body = pairs.map((p, i) => `Pair ${i + 1}\n  a = ${show(p.a)}\n  b = ${show(p.b)}`).join("\n");
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
            content: `Pairs to compare:\n${wrapUntrusted("requirement_pairs", body, { nonce: newNonce() })}`,
          },
        ],
      },
      MergeVerdictSchema,
      "requirement_merge",
    );
    const allowed = new Set(pairs.map((p) => pairKey(p.a, p.b)));
    const verdicts = res.pairs.filter((p) => allowed.has(pairKey(p.a, p.b)));
    return {
      same: verdicts.filter((p) => p.same).map(({ a, b }) => ({ a, b })),
      different: verdicts.filter((p) => !p.same).map(({ a, b }) => ({ a, b })),
    };
  } catch (e) {
    deps.logger.warn("requirement merge pass failed; keeping the candidates apart", {
      sessionId: input.sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { same: [], different: [] };
  }
}
