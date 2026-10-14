import { normalizeSectionKey, type Fact } from "@aidp/shared";
import { titleOf } from "../spec/live.js";
import { DEFAULT_DUPLICATE_THRESHOLDS, reqViewOf, requirementSimilarity } from "../spec/quality.js";

/**
 * Two writers share a session's facts: the turn (the interviewer files a requirement as it hears
 * it) and the extraction job (it files what it finds in the transcript, minutes later, from a
 * snapshot). A spec field is one record per section and path, but only the turn's own write
 * replaces by key; the job's commit appends and a turn's stale write-back is unioned with what the
 * job added. A live run (D-302) found the same requirement id twice, and one id used by two
 * different capabilities, in a finished interview: the specification listed the whole requirement
 * list twice. These are the two places the collision is resolved, with one rule:
 *
 * - the same section and path with the same capability is one record (the one already held wins
 *   when the job is the late writer, the turn's wins when the turn is);
 * - the same functional id used for a different capability keeps both, the later arrival taking
 *   the next free FR number, so nothing the participant asked for is dropped.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const keyOf = (f: Fact & { kind: "spec_field" }): string =>
  `${normalizeSectionKey(f.section) ?? f.section}/${f.path.trim().toUpperCase()}`;

const isRequirement = (f: Fact): f is Fact & { kind: "spec_field" } =>
  f.kind === "spec_field" &&
  (normalizeSectionKey(f.section) ?? f.section) === "functional" &&
  isRecord(f.value);

const nextFrNumber = (facts: readonly Fact[]): number => {
  let n = 0;
  for (const f of facts) {
    if (f.kind !== "spec_field") continue;
    const m = /^FR-(\d+)$/i.exec(f.path.trim());
    if (m?.[1]) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
};

/** The same capability, by title: identical, or a restatement that words settle (D-241). */
function sameCapability(a: Fact & { kind: "spec_field" }, b: Fact & { kind: "spec_field" }): boolean {
  if (titleOf(a.value, "").trim().toLowerCase() === titleOf(b.value, "").trim().toLowerCase()) return true;
  return requirementSimilarity(reqViewOf(a), reqViewOf(b)) >= DEFAULT_DUPLICATE_THRESHOLDS.auto;
}

export interface AddedFacts {
  /** The whole list after the batch. */
  facts: Fact[];
  /** What of the incoming batch was kept (some renumbered); the rows to write. */
  accepted: Fact[];
  dropped: number;
  renumbered: { from: string; to: string }[];
}

/**
 * The extraction job's batch onto the facts the session holds now. A spec field already held under
 * the same section and path wins (the turn's record is authoritative, the spec is state), unless
 * it is a different capability, in which case the arrival is renumbered. A requirement that is a
 * restatement of one held under another id is dropped, as `fileSpecFacts` does against its snapshot.
 */
export function addExtractedFacts(existing: readonly Fact[], incoming: readonly Fact[]): AddedFacts {
  const facts: Fact[] = [...existing];
  const accepted: Fact[] = [];
  const renumbered: { from: string; to: string }[] = [];
  let dropped = 0;
  for (const f of incoming) {
    if (f.kind !== "spec_field") {
      facts.push(f);
      accepted.push(f);
      continue;
    }
    const held = facts.find(
      (e): e is Fact & { kind: "spec_field" } => e.kind === "spec_field" && keyOf(e) === keyOf(f),
    );
    if (!held) {
      if (isRequirement(f) && facts.some((e) => isRequirement(e) && sameCapability(e, f))) {
        dropped++;
        continue;
      }
      facts.push(f);
      accepted.push(f);
      continue;
    }
    if (isRequirement(f) && isRequirement(held) && !sameCapability(held, f)) {
      const to = `FR-${nextFrNumber(facts)}`;
      const moved = { ...f, path: to };
      if (facts.some((e) => isRequirement(e) && sameCapability(e, moved))) {
        dropped++;
        continue;
      }
      renumbered.push({ from: f.path, to });
      facts.push(moved);
      accepted.push(moved);
      continue;
    }
    dropped++;
  }
  return { facts, accepted, dropped, renumbered };
}

/**
 * The turn's facts layered over the stored list (which holds what the job added meanwhile). The
 * turn's record of a requirement replaces the job's under the same id; when they are different
 * capabilities the job's takes the next free number, since the interviewer's id is the one the
 * model was told and may refer to again.
 */
export function layerTurnFacts(stored: readonly Fact[], turn: readonly Fact[]): Fact[] {
  const out: Fact[] = [...stored];
  for (const f of turn) {
    if (f.kind !== "spec_field") {
      out.push(f);
      continue;
    }
    const at = out.findIndex((e) => e.kind === "spec_field" && keyOf(e) === keyOf(f));
    const held = at >= 0 ? out[at] : undefined;
    if (held?.kind !== "spec_field") {
      out.push(f);
      continue;
    }
    if (isRequirement(f) && isRequirement(held) && !sameCapability(held, f)) {
      out[at] = { ...held, path: `FR-${nextFrNumber(out)}` };
      out.push(f);
      continue;
    }
    out[at] = f;
  }
  return out;
}
