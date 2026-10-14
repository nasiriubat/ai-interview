import type { SessionState } from "@aidp/shared";
import { normalizeSectionKey } from "@aidp/shared";
import { asObject, scopeOf, titleOf, type SpecFieldFact } from "./live.js";

/**
 * Deterministic specification quality (D-241 to D-243). Extraction files every spec fact it sees
 * and the capture rules make each capability its own requirement, so one live interview produced
 * 25 to 45 requirements for a small tool, with duplicates, UI labels filed as requirements and
 * decisions filed as functional. Counting cannot see that; this module can:
 *
 * - `classifyRequirement` says whether a "requirement" is a capability, or really a decision, a
 *   constraint or an open question (those are rerouted, not deleted);
 * - `findDuplicateGroups` finds near-duplicates by word overlap, without a model: pairs that are
 *   plainly the same are merged, pairs that might be are returned for one cheap model pass;
 * - `curateRequirements` applies both to the facts of a session state, folding what it merges into
 *   the strongest survivor and recording `mergedFrom`.
 *
 * Everything here is pure; the model pass lives in `merge.ts`.
 */

// ---------- words ----------

/** Words that carry no capability: filler of a requirement title. */
const STOP = new Set(
  (
    "a an the and or of to in on for with by at from as is are be can able must should shall will would may might " +
    "it its this that these those their there them they his her our your we i you he she " +
    "user users system app application tool product feature allow allows allowing enable enables enabling let lets " +
    "ability support supports provide provides need needs want wants have has having so then when once after before " +
    "each every any all per via using use used into onto within also including include includes"
  ).split(/\s+/),
);

/** A light stemmer: enough that "saved", "saving" and "saves" meet, with no dictionary. */
function stem(w: string): string {
  if (w === "not" || w === "no" || w === "never" || w === "without") return "!neg";
  let r = w;
  if (r.length > 4 && r.endsWith("ies")) r = `${r.slice(0, -3)}y`;
  else if (r.length > 4 && r.endsWith("ing")) r = r.slice(0, -3);
  else if (r.length > 3 && r.endsWith("ed")) r = r.slice(0, -2);
  else if (r.length > 4 && /(ss|x|z|ch|sh)es$/.test(r)) r = r.slice(0, -2);
  else if (r.length > 3 && r.endsWith("s") && !/(ss|us|is)$/.test(r)) r = r.slice(0, -1);
  if (r.length > 3 && r.endsWith("e")) r = r.slice(0, -1);
  return r;
}

/** The content words of a text, lowercased and stemmed, without filler. */
export function contentTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)) {
    if (raw === "" || STOP.has(raw) || (raw.length < 2 && !/\d/.test(raw))) continue;
    const s = stem(raw);
    if (!STOP.has(s)) out.add(s);
  }
  return [...out];
}

function overlap(a: string[], b: string[]): { shared: number; jaccard: number; containment: number } {
  if (a.length === 0 || b.length === 0) return { shared: 0, jaccard: 0, containment: 0 };
  const sb = new Set(b);
  const shared = a.filter((x) => sb.has(x)).length;
  const union = a.length + b.length - shared;
  return { shared, jaccard: shared / union, containment: shared / Math.min(a.length, b.length) };
}

// ---------- requirement view ----------

/** What the quality rules read of a requirement; both facts and generated requirements fit. */
export interface ReqView {
  id: string;
  title: string;
  description?: string;
  scope: "mvp" | "future";
  acceptance: string[];
  reason?: string;
  evidence?: string;
  needsConfirmation?: boolean;
  mergedFrom?: string[];
}

export function reqViewOf(f: Pick<SpecFieldFact, "path" | "value">): ReqView {
  const v = asObject(f.value);
  const acceptance = Array.isArray(v.acceptance)
    ? v.acceptance.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  const str = (k: string): string | undefined =>
    typeof v[k] === "string" && v[k].trim() ? v[k].trim() : undefined;
  const description = str("description");
  const reason = str("reason");
  const evidence = str("evidence");
  const mergedFrom = Array.isArray(v.mergedFrom)
    ? v.mergedFrom.filter((a): a is string => typeof a === "string")
    : undefined;
  return {
    id: f.path,
    title: titleOf(f.value, f.path),
    scope: scopeOf(f.value),
    acceptance,
    ...(description ? { description } : {}),
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
    ...(v.needsConfirmation === true ? { needsConfirmation: true } : {}),
    ...(mergedFrom?.length ? { mergedFrom } : {}),
  };
}

// ---------- classification ----------

export type RequirementClass = "capability" | "decision" | "constraint" | "question" | "withdrawn";

/** A title that is a question, a to-do for the owner, or an explicit open point. */
const QUESTION =
  /^(should|do we|does it|is it|are we|what|which|how|whether|who|when should|tbd|to be decided|open question|question:|unclear|unknown)\b|\?\s*$/i;
/** A choice already made about how to build or run it, not something a user can do. */
const DECISION =
  /^(decision\b|decided\b|we (will|have) (use|chosen|decided)|chosen\b|technology\b|tech stack\b|stack\b|hosting\b|host(ed)? on\b|deploy(ed)? (on|to|in)\b|built (with|in|on)\b|database (choice|engine)\b|language\b:|framework\b)/i;
/**
 * What a model writes to "delete" a requirement it can only re-record: "Removed", "Merged into
 * FR-6". The live runs left several of these as requirements; they are tombstones.
 */
const TOMBSTONE =
  /^(\(?removed\)?|deleted|withdrawn|obsolete|deprecated|n\/a|none|merged (into|with)\b|duplicate of\b|superseded by\b|replaced by\b|see FR-\d+)/i;
/** A limit or a rule about how the business or the system must behave, not a feature. */
const CONSTRAINT =
  /^(constraint\b|limitation\b|policy\b|compliance\b|comply with\b|complies with\b|regulatory\b|must (not exceed|comply|be compliant)|(no|not) more than\b|at most\b|maximum\b|max\.?\s|minimum\b|retention\b|data (is )?(kept|retained|stored) (for|in)\b|(gdpr|hipaa|iso)\b|success criteri|definition of\b|(pilot|acceptance) (pass )?test\b|pass test\b)/i;

/**
 * Whether a recorded "functional requirement" is one. Conservative: only an explicit shape moves
 * it, so a real capability is never rerouted on a guess. What this misses the judge measures.
 */
export function classifyRequirement(req: Pick<ReqView, "title" | "description">): RequirementClass {
  const t = req.title.trim();
  if (TOMBSTONE.test(t)) return "withdrawn";
  if (QUESTION.test(t)) return "question";
  if (DECISION.test(t)) return "decision";
  if (CONSTRAINT.test(t)) return "constraint";
  return "capability";
}

/** Where a non-capability goes: decisions and constraints become rules, questions open questions. */
export function sectionForClass(
  c: Exclude<RequirementClass, "capability" | "withdrawn">,
): "rules" | "open_questions" {
  return c === "question" ? "open_questions" : "rules";
}

// ---------- granularity ----------

/**
 * A requirement that is one widget of a screen: a label, a button, a colour, a column, a field.
 * Such a requirement is acceptance of the capability whose screen it is, not a requirement of its own.
 */
const UI_DETAIL =
  /\b(button|label|colou?r|icon|font|tooltip|placeholder|dropdown|drop-down|checkbox|radio|toggle|tab|column|banner|logo|spacing|margin|padding|text field|input field|header|footer|menu item|link text|wording|caption)\b/i;
/** Titles that name a capability even when they mention a widget ("export the list to CSV from a button"). */
const CAPABILITY_VERB =
  /^(let|allow|enable|nurses? can|users? can|send|sync|synchroni[sz]e|export|import|notify|alert|authenticate|log in|sign in|store|record|search|generate|schedule|share|print|upload|download|integrate|validate|approve|assign)\b/i;

/** Whether a title reads as a screen detail rather than a capability. */
export function isUiDetail(title: string): boolean {
  const t = title.trim();
  return UI_DETAIL.test(t) && !CAPABILITY_VERB.test(t);
}

// ---------- duplicates ----------

export interface DuplicatePair {
  a: string;
  b: string;
  score: number;
  /** `exact`: plainly the same, merged without a model. `candidate`: worth one cheap model look. */
  kind: "exact" | "candidate";
}

export interface DuplicateThresholds {
  /** Title word overlap (Jaccard) at or above which two requirements are the same. */
  auto: number;
  /** Overlap at or above which a pair goes to the model pass. */
  candidate: number;
}

export const DEFAULT_DUPLICATE_THRESHOLDS: DuplicateThresholds = { auto: 0.8, candidate: 0.3 };

const normalizeTitle = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The similarity of two requirements: title words first, then title plus acceptance for the near ones. */
export function requirementSimilarity(a: ReqView, b: ReqView): number {
  if (normalizeTitle(a.title) === normalizeTitle(b.title)) return 1;
  const ta = contentTokens(a.title);
  const tb = contentTokens(b.title);
  const titles = overlap(ta, tb);
  // A short title contained in a longer one by two or more words is a likely rewording.
  const containment = titles.shared >= 2 ? titles.containment * 0.75 : 0;
  const full = overlap(
    contentTokens(`${a.title} ${a.acceptance.join(" ")}`),
    contentTokens(`${b.title} ${b.acceptance.join(" ")}`),
  );
  // Acceptance overlap alone is weaker evidence than the title; it only lifts a title that already shares words.
  const lifted = titles.shared >= 2 ? full.jaccard * 0.85 : 0;
  return Math.max(titles.jaccard, containment, lifted);
}

/** Pairs of requirements that are, or may be, the same capability. Deterministic; O(n^2) on a few dozen. */
export function findDuplicatePairs(
  reqs: ReqView[],
  thresholds: DuplicateThresholds = DEFAULT_DUPLICATE_THRESHOLDS,
): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  for (let i = 0; i < reqs.length; i++) {
    for (let j = i + 1; j < reqs.length; j++) {
      const a = reqs[i];
      const b = reqs[j];
      if (!a || !b) continue;
      const score = requirementSimilarity(a, b);
      if (score >= thresholds.auto) out.push({ a: a.id, b: b.id, score, kind: "exact" });
      else if (score >= thresholds.candidate) out.push({ a: a.id, b: b.id, score, kind: "candidate" });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Groups of ids connected by the given pairs (union-find), each group in input order. */
export function groupPairs(ids: string[], pairs: Pick<DuplicatePair, "a" | "b">[]): string[][] {
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  for (const p of pairs) {
    if (!parent.has(p.a) || !parent.has(p.b)) continue;
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

const idNumber = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);

/**
 * Share of a merged title's content words the survivor must already hold for the title to be
 * dropped; a title with a single word the survivor lacks is a detail of it, not a capability.
 */
export const TITLE_KEPT = 0.8;

/**
 * Folds a group into one requirement. The survivor is the one with the most acceptance criteria
 * (then the earliest id); the others' distinct criteria are appended, so nothing testable is lost,
 * and so is a merged title the survivor's own words do not hold (D-301).
 * Scope: the owner's recorded decision wins (a requirement with a reason is one they moved), else
 * MVP if any copy is MVP. `needsConfirmation` survives only if every copy lacked evidence.
 */
export function mergeGroup(members: ReqView[]): ReqView {
  const sorted = [...members].sort(
    (x, y) => y.acceptance.length - x.acceptance.length || idNumber(x.id) - idNumber(y.id),
  );
  const keep = sorted[0];
  if (!keep) throw new Error("mergeGroup needs at least one requirement");
  const seen = new Set(keep.acceptance.map(normalizeTitle));
  const acceptance = [...keep.acceptance];
  for (const m of sorted.slice(1)) {
    for (const a of m.acceptance) {
      const k = normalizeTitle(a);
      if (k && !seen.has(k)) {
        seen.add(k);
        acceptance.push(a);
      }
    }
  }
  // A merged title the survivor's words do not hold is a capability that would vanish from the
  // document (D-301): it stays as an acceptance criterion, which is a check a tester can run.
  const kept = new Set(contentTokens(`${keep.title} ${acceptance.join(" ")}`));
  for (const m of sorted.slice(1)) {
    const t = contentTokens(m.title);
    if (t.length === 0) continue;
    const held = t.filter((w) => kept.has(w)).length / t.length;
    const k = normalizeTitle(m.title);
    const missing = t.filter((w) => !kept.has(w)).length;
    if (held < TITLE_KEPT && missing >= 2 && k && !seen.has(k)) {
      seen.add(k);
      acceptance.push(m.title);
      for (const w of t) kept.add(w);
    }
  }
  const decided = members.find((m) => m.reason);
  const scope = decided ? decided.scope : members.some((m) => m.scope === "mvp") ? "mvp" : "future";
  const evidence = keep.evidence ?? members.find((m) => m.evidence)?.evidence;
  const reason = keep.reason ?? decided?.reason;
  const description = keep.description ?? members.find((m) => m.description)?.description;
  const unconfirmed = members.every((m) => m.needsConfirmation === true || m.evidence === undefined);
  const mergedFrom = [
    ...new Set([
      ...(keep.mergedFrom ?? []),
      ...members.filter((m) => m !== keep).flatMap((m) => [m.id, ...(m.mergedFrom ?? [])]),
    ]),
  ].sort((x, y) => idNumber(x) - idNumber(y));
  return {
    id: keep.id,
    title: keep.title,
    scope,
    acceptance,
    ...(description ? { description } : {}),
    ...(reason ? { reason } : {}),
    ...(evidence ? { evidence } : {}),
    ...(evidence === undefined && unconfirmed ? { needsConfirmation: true } : {}),
    mergedFrom,
  };
}

// ---------- applying to a session state ----------

export interface CurationReport {
  /** Requirements folded into another one: `from` ids into `into`. */
  merged: { into: string; from: string[]; via: "exact" | "model" }[];
  /** Capabilities that were really decisions, constraints or questions, and where they went. */
  rerouted: { id: string; as: Exclude<RequirementClass, "capability" | "withdrawn">; section: string }[];
  /** Tombstones ("Removed") and requirements the owner withdrew, dropped from the list. */
  withdrawn: string[];
  /** Requirements whose id was not an FR number, and the number they were given. */
  renumbered: { from: string; to: string }[];
  /** Screen details folded into the capability they belong to as acceptance criteria. */
  folded: { id: string; into: string }[];
  /** Pairs left for the model pass (empty once it ran). */
  candidates: DuplicatePair[];
}

export interface CurationOptions {
  thresholds?: DuplicateThresholds;
  /** Pairs a model judged to be the same capability. */
  modelDuplicates?: { a: string; b: string }[];
  /** Pairs a model judged to be different; they are not offered again. */
  modelDistinct?: { a: string; b: string }[];
}

/** The value of a key that the caller has just checked is there. */
function indexOf<K, V>(m: Map<K, V>, k: K): V {
  const v = m.get(k);
  if (v === undefined) throw new Error("quality: index out of step with the fact list");
  return v;
}

const isRequirementFact = (f: SessionState["facts"][number]): f is SpecFieldFact =>
  f.kind === "spec_field" &&
  (normalizeSectionKey(f.section) ?? f.section) === "functional" &&
  f.value !== null &&
  typeof f.value === "object" &&
  !Array.isArray(f.value);

const reqValue = (r: ReqView, base: Record<string, unknown>): Record<string, unknown> => {
  const { id: _id, ...rest } = r;
  return { ...base, ...rest, scope: r.scope, acceptance: r.acceptance };
};

/**
 * Curates the functional requirements of a state: reroutes what is not a capability, folds screen
 * details into the nearest capability, merges duplicates. Ids of survivors never change (other
 * records refer to them), so the list may have gaps; every merged id is in the survivor's
 * `mergedFrom`. The facts' other kinds and sections pass through untouched.
 */
export function curateRequirements(
  state: Pick<SessionState, "facts">,
  options: CurationOptions = {},
): { facts: SessionState["facts"]; report: CurationReport } {
  const report: CurationReport = {
    merged: [],
    rerouted: [],
    withdrawn: [],
    renumbered: [],
    folded: [],
    candidates: [],
  };
  const thresholds = options.thresholds ?? DEFAULT_DUPLICATE_THRESHOLDS;
  const facts = state.facts.map((f) => f);
  const byId = new Map<string, number>();
  facts.forEach((f, i) => {
    if (isRequirementFact(f)) byId.set(f.path, i);
  });
  const drop = new Set<number>();
  const viewAt = (i: number): ReqView => reqViewOf(facts[i] as SpecFieldFact);
  const setView = (i: number, r: ReqView): void => {
    const f = facts[i] as SpecFieldFact;
    facts[i] = { ...f, section: "functional", value: reqValue(r, asObject(f.value)) };
  };

  // 0. Tombstones and withdrawn requirements leave the list; an id that is not an FR number
  // takes the next free one, so the list has one id scheme.
  let nextNumber = 1;
  for (const f of facts)
    if (isRequirementFact(f)) {
      const n = /^FR-(\d+)$/i.exec(f.path)?.[1];
      if (n) nextNumber = Math.max(nextNumber, Number(n) + 1);
    }
  for (const [id, i] of [...byId]) {
    const f = facts[i] as SpecFieldFact;
    const r = viewAt(i);
    if (asObject(f.value).withdrawn === true || classifyRequirement(r) === "withdrawn") {
      drop.add(i);
      byId.delete(id);
      report.withdrawn.push(id);
      continue;
    }
    if (!/^FR-\d+$/i.test(id)) {
      const to = `FR-${nextNumber++}`;
      facts[i] = { ...f, path: to };
      byId.delete(id);
      byId.set(to, i);
      report.renumbered.push({ from: id, to });
    }
  }

  // 1. Not a capability: rerouted to rules or open questions, never deleted.
  for (const [id, i] of byId) {
    const r = viewAt(i);
    const c = classifyRequirement(r);
    if (c === "capability" || c === "withdrawn") continue;
    const section = sectionForClass(c);
    const f = facts[i] as SpecFieldFact;
    facts[i] = {
      ...f,
      section,
      path: r.title.replace(/\s+/g, " ").slice(0, 80),
      value: c === "question" ? r.title : { ...asObject(f.value), reroutedFrom: id, class: c },
    };
    byId.delete(id);
    report.rerouted.push({ id, as: c, section });
  }

  // 2. Duplicates: exact ones and the ones a model confirmed.
  const live = (): ReqView[] => [...byId.values()].filter((i) => !drop.has(i)).map(viewAt);
  const pairs = findDuplicatePairs(live(), thresholds);
  const distinct = new Set((options.modelDistinct ?? []).map((p) => [p.a, p.b].sort().join("|")));
  const same = [
    ...pairs.filter((p) => p.kind === "exact"),
    ...(options.modelDuplicates ?? []).map((p) => ({ ...p, kind: "candidate" as const, score: 1 })),
  ].filter((p) => byId.has(p.a) && byId.has(p.b));
  const viaOf = new Map<string, "exact" | "model">();
  for (const p of same) viaOf.set([p.a, p.b].sort().join("|"), p.kind === "exact" ? "exact" : "model");
  for (const group of groupPairs([...byId.keys()], same)) {
    const members = group.map((id) => viewAt(indexOf(byId, id)));
    const merged = mergeGroup(members);
    const at = indexOf(byId, merged.id);
    setView(at, merged);
    const from = group.filter((id) => id !== merged.id);
    for (const id of from) {
      drop.add(indexOf(byId, id));
      byId.delete(id);
    }
    const via = group.some((a) => group.some((b) => a < b && viaOf.get([a, b].sort().join("|")) === "model"))
      ? "model"
      : "exact";
    report.merged.push({ into: merged.id, from, via });
  }

  // 3. Screen details become acceptance criteria of the closest capability.
  for (const id of [...byId.keys()]) {
    const i = indexOf(byId, id);
    const r = viewAt(i);
    if (!isUiDetail(r.title)) continue;
    const others = [...byId.entries()]
      .filter(([oid]) => oid !== id)
      .map(([oid, oi]) => ({ r: viewAt(oi), oi, oid }))
      .filter((o) => !isUiDetail(o.r.title));
    const tokens = contentTokens(`${r.title} ${r.description ?? ""} ${r.acceptance.join(" ")}`);
    let best: { oi: number; oid: string; score: number } | undefined;
    for (const o of others) {
      const ov = overlap(tokens, contentTokens(`${o.r.title} ${o.r.description ?? ""}`));
      if (ov.shared >= 1 && (!best || ov.containment > best.score))
        best = { oi: o.oi, oid: o.oid, score: ov.containment };
    }
    if (!best || best.score < 0.2) continue;
    const parent = viewAt(best.oi);
    const note = r.acceptance.length ? r.acceptance : [r.title];
    const have = new Set(parent.acceptance.map(normalizeTitle));
    setView(best.oi, {
      ...parent,
      acceptance: [...parent.acceptance, ...note.filter((a) => !have.has(normalizeTitle(a)))],
      mergedFrom: [...new Set([...(parent.mergedFrom ?? []), id])],
    });
    drop.add(i);
    byId.delete(id);
    report.folded.push({ id, into: best.oid });
  }

  // 4. What is left of the near-duplicates, unless a model already looked at it.
  const left = findDuplicatePairs(live(), thresholds).filter(
    (p) => p.kind === "candidate" && !distinct.has([p.a, p.b].sort().join("|")),
  );
  report.candidates = left;
  return { facts: facts.filter((_, i) => !drop.has(i)), report };
}

/** A quality summary of a requirement list, for the interview's confirmation and the metrics. */
export function requirementStats(reqs: ReqView[]): {
  count: number;
  mvp: number;
  future: number;
  withoutAcceptance: number;
  unconfirmed: number;
  duplicatePairs: number;
} {
  return {
    count: reqs.length,
    mvp: reqs.filter((r) => r.scope === "mvp").length,
    future: reqs.filter((r) => r.scope === "future").length,
    withoutAcceptance: reqs.filter((r) => r.acceptance.length === 0).length,
    unconfirmed: reqs.filter((r) => r.needsConfirmation).length,
    duplicatePairs: findDuplicatePairs(reqs).filter((p) => p.kind === "exact").length,
  };
}
