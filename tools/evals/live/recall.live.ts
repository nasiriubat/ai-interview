/**
 * Live recall measurement (D-300). Costs real money; never run by CI.
 *
 *   RECALL_DIRS=<dir>[,<dir>...] RECALL_LABEL=recall \
 *   pnpm --filter @aidp/evals exec tsx live/recall.live.ts
 *
 * For every saved interview (`<persona>-<n>.json`: transcript, recorded facts, generated
 * requirements) an extractor that is NOT a model of the pipeline lists the capabilities the OWNER
 * explicitly stated, each with a quote; the code keeps only those whose quote is verbatim in the
 * owner's own messages. Coverage by the final requirement list, and by the requirements as first
 * recorded (before curation), is decided by word overlap where it can be and by a second cheap model
 * for the uncertain middle only. The deterministic half and its tests are `src/recall.ts`.
 *
 *   RECALL_DIRS             comma separated artifact directories (required)
 *   RECALL_LABEL=recall     output name, written into each directory
 *   RECALL_CAP_USD=0.4      hard cap on this script's spend
 *   RECALL_EXTRACTOR=google/gemini-2.5-flash-lite   independent of the interviewer, extraction and generator
 *   RECALL_MATCHER=google/gemini-2.5-flash-lite
 *
 * The key is read at runtime and never printed or written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reqViewOf } from "@aidp/ai";
import { extractJson } from "../../live-run/src/pure.js";
import { chat, harnessSpend, loadOpenRouterKey, redact } from "../../live-run/src/runtime.js";
import {
  attributeLoss,
  lostTitles,
  matchCapabilities,
  mergedAway,
  precisionRows,
  settleMatches,
  summarize,
  verifyStated,
  type InterviewScore,
  type ListedRequirement,
} from "../src/recall.js";

const DIRS = (process.env.RECALL_DIRS ?? "").split(",").filter(Boolean);
if (DIRS.length === 0) throw new Error("RECALL_DIRS is required");
const LABEL = process.env.RECALL_LABEL ?? "recall";
const CAP = Number(process.env.RECALL_CAP_USD ?? 0.4);
const EXTRACTOR = process.env.RECALL_EXTRACTOR ?? "google/gemini-2.5-flash-lite";
const MATCHER = process.env.RECALL_MATCHER ?? "google/gemini-2.5-flash-lite";

interface Artifact {
  persona: string;
  messages: { seq: number; role: "user" | "assistant"; content: string }[];
  facts: { kind: string; section?: string; path?: string; value?: unknown }[];
  requirements: {
    id: string;
    title: string;
    acceptance: string[];
    evidence?: string;
    mergedFrom?: string[];
  }[];
}

const EXTRACT_PROMPT = `Below is an interview between an INTERVIEWER and the OWNER of a software idea. List every distinct product capability the OWNER explicitly stated or asked for in their own words: something the product must do or let people do, that a developer could build and a tester could demonstrate on its own.

Rules:
- Only what the OWNER said. A capability the interviewer proposed and the owner did not put in their own words is not listed.
- Work at the level of a feature a product owner would name in a release note, at most 25 entries for the whole interview: a screen, field, label, message text, validation or single step of a feature is part of it, not an entry of its own.
- One entry per distinct capability. Do not split one capability by its fields, labels or messages, and do not list the same capability twice.
- Stop at 25 entries. Set "kind" to exactly "feature" or "constraint": "feature" when the product itself does or offers something, "constraint" when it is a statement about HOW it is built or run: a technology, framework, library, language, cloud service, infrastructure, hosting, security control, policy, retention period, budget or schedule, or a quality target (naming a stack component is a constraint even when it is phrased as "will use" or "must integrate"). Skip open questions.
- "quote" must be copied exactly, character for character, from ONE OWNER line (at most 220 characters, at least 5 words).
- Return JSON only: {"capabilities":[{"text":"short description","kind":"feature","quote":"exact words of the owner"}]}`;

const MATCH_PROMPT = `You are given capabilities an owner stated in an interview and, for each, up to three candidate requirements from a specification. For each capability, say which candidate (if any) covers it: a developer who builds exactly that requirement, including its acceptance criteria, would have built the capability. A requirement that is merely about a related topic does not cover it. Return JSON only: {"answers":[{"key":"c1","by":"FR-3"|null}]} with one entry per capability.`;

/** A list cut off at the output limit: the complete objects before the cut are kept. */
function salvageList(text: string): unknown {
  const at = text.lastIndexOf("},");
  if (at < 0) return null;
  try {
    return JSON.parse(`${text.slice(text.indexOf("{"), at + 1)}]}`) as unknown;
  } catch {
    return null;
  }
}

const transcript = (a: Artifact): string =>
  a.messages
    .map((m) => `${m.role === "user" ? "OWNER" : "INTERVIEWER"}: ${m.content.slice(0, 1500)}`)
    .join("\n");

/** The requirements as recorded in state, before curation: functional spec fields, not withdrawn. */
function recordedRequirements(a: Artifact): ListedRequirement[] {
  const out: ListedRequirement[] = [];
  for (const f of a.facts) {
    if (f.kind !== "spec_field" || f.section !== "functional" || typeof f.path !== "string") continue;
    const v = f.value;
    if (typeof v === "object" && v !== null && (v as { withdrawn?: unknown }).withdrawn === true) continue;
    const view = reqViewOf({ path: f.path, value: f.value });
    out.push({
      id: view.id,
      title: view.title,
      acceptance: view.acceptance,
      evidence: view.evidence,
    });
  }
  return out;
}

/**
 * What the specification holds outside its functional list: every other recorded field (rules,
 * technical choices, integrations, open questions), and the functional entries that curation moved
 * there (they are neither in the final list nor merged or folded into an entry of it).
 */
function elsewhereOf(
  a: Artifact,
  finalList: ListedRequirement[],
  recorded: ListedRequirement[],
): ListedRequirement[] {
  const out: ListedRequirement[] = [];
  for (const f of a.facts) {
    if (f.kind !== "spec_field" || f.section === "functional" || typeof f.path !== "string") continue;
    const v = typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? "");
    out.push({
      id: `S-${f.section}/${f.path.replace(/\s+/g, "_")}`,
      title: `${f.section} ${f.path}`,
      acceptance: [v.slice(0, 600)],
    });
  }
  const kept = new Set([...finalList.map((r) => r.id), ...a.requirements.flatMap((r) => r.mergedFrom ?? [])]);
  for (const r of recorded) if (!kept.has(r.id)) out.push({ ...r, id: `S-rerouted/${r.id}` });
  return out;
}

async function main(): Promise<void> {
  const apiKey = loadOpenRouterKey();
  const spent = (): number => harnessSpend.usd;
  const calls = { extract: 0, match: 0 };
  let lastRaw = "";

  for (const dir of DIRS) {
    const files = readdirSync(dir)
      .filter((f) => /^(technical|nontechnical)-\d+\.json$/.test(f))
      .sort();
    const cacheDir = join(dir, ".recall-cache");
    mkdirSync(cacheDir, { recursive: true });
    const call = async (label: string, model: string, user: string, max: number): Promise<unknown> => {
      const key = createHash("sha256").update(`${model}\n${user}`).digest("hex").slice(0, 24);
      const file = join(cacheDir, `call-${key}.json`);
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as unknown;
      // A reply that is not JSON is retried once with more room, and is never cached.
      for (const room of [max, max * 2]) {
        if (spent() >= CAP) throw new Error(`cost cap ${CAP} USD reached`);
        const r = await chat({
          apiKey,
          model,
          label,
          messages: [{ role: "user", content: user }],
          maxTokens: room,
          json: true,
          temperature: 0,
        });
        lastRaw = r.content;
        const out = extractJson(r.content) ?? salvageList(r.content);
        if (out !== null) {
          writeFileSync(file, JSON.stringify(out));
          return out;
        }
      }
      return null;
    };

    const details: unknown[] = [];
    const scores: InterviewScore[] = [];
    const recordedScores: InterviewScore[] = [];
    const anywhereScores: InterviewScore[] = [];
    const unreadable: string[] = [];
    for (const f of files) {
      const a = JSON.parse(readFileSync(join(dir, f), "utf8")) as Artifact;
      const spec = f.replace(/\.json$/, "");
      const owner = a.messages.filter((m) => m.role === "user").map((m) => m.content);
      const raw = (await call(
        `extract:${spec}`,
        EXTRACTOR,
        `${EXTRACT_PROMPT}\n\n${transcript(a)}`,
        4000,
      )) as {
        capabilities?: { text?: string; quote?: string }[];
      } | null;
      calls.extract++;
      if (!Array.isArray(raw?.capabilities)) {
        unreadable.push(
          `${spec} (${lastRaw.length} chars: ${JSON.stringify(lastRaw.slice(0, 80))} ... ${JSON.stringify(lastRaw.slice(-60))})`,
        );
        continue;
      }
      const stated = verifyStated(raw.capabilities, owner, 5);
      const rejected = stated.rejected;
      const verified = stated.verified.filter((c) => c.kind === "feature");
      const constraints = stated.verified.length - verified.length;

      const finalList: ListedRequirement[] = a.requirements.map((r) => ({
        id: r.id,
        title: r.title,
        acceptance: r.acceptance,
        evidence: r.evidence,
      }));
      const recorded = recordedRequirements(a);
      const away = mergedAway(a.requirements, new Map(recorded.map((r) => [r.id, r.title])));
      const lost = lostTitles(away);
      const cover = async (
        list: ListedRequirement[],
        tag: string,
      ): Promise<{
        covered: Set<string>;
        by: (string | null)[];
        how: Record<string, number>;
        settled: { key: string; by: string | null; how: string }[];
      }> => {
        const matches = matchCapabilities(verified, list);
        const unsure = matches.filter((m) => m.decision === "unsure");
        const answers: Record<string, string | null> = {};
        if (unsure.length) {
          const byId = new Map(list.map((r) => [r.id, r]));
          const body = unsure
            .map((m) => {
              const c = verified.find((x) => x.key === m.key)!;
              const cands = m.candidates
                .slice(0, 3)
                .map((x) => {
                  const r = byId.get(x.reqId);
                  return `  - ${x.reqId}: ${r?.title ?? ""}${r?.acceptance.length ? ` | acceptance: ${r.acceptance.slice(0, 3).join("; ").slice(0, 300)}` : ""}`;
                })
                .join("\n");
              return `${m.key}: ${c.text}\n  owner said: "${c.quote}"\n${cands}`;
            })
            .join("\n");
          const out = (await call(`match:${spec}:${tag}`, MATCHER, `${MATCH_PROMPT}\n\n${body}`, 1500)) as {
            answers?: { key: string; by: string | null }[];
          } | null;
          calls.match++;
          for (const x of out?.answers ?? [])
            answers[x.key] = typeof x.by === "string" ? (x.by.split(/[\s:]/)[0] ?? null) : null;
        }
        const settled = settleMatches(matches, answers, new Set(list.map((r) => r.id)));
        const how: Record<string, number> = {};
        for (const s of settled) how[s.how] = (how[s.how] ?? 0) + 1;
        return {
          covered: new Set(settled.filter((s) => s.covered).map((s) => s.key)),
          by: settled.map((s) => s.by),
          how,
          settled,
        };
      };

      const fin = await cover(finalList, "final");
      const rec = await cover(recorded, "recorded");
      const elsewhere = elsewhereOf(a, finalList, recorded);
      const els = await cover(elsewhere, "elsewhere");
      const anyCovered = new Set([...fin.covered, ...els.covered]);
      const prec = precisionRows(finalList, fin.by, owner);
      const loss = attributeLoss(
        rec.covered,
        fin.covered,
        verified.map((c) => c.key),
      );
      scores.push({
        spec,
        persona: a.persona,
        capabilities: verified.length,
        covered: fin.covered.size,
        requirements: finalList.length,
        supported: prec.filter((p) => p.supported).length,
      });
      anywhereScores.push({
        spec,
        persona: a.persona,
        capabilities: verified.length,
        covered: anyCovered.size,
        requirements: finalList.length,
        supported: 0,
      });
      recordedScores.push({
        spec,
        persona: a.persona,
        capabilities: verified.length,
        covered: rec.covered.size,
        requirements: recorded.length,
        supported: 0,
      });
      details.push({
        spec,
        persona: a.persona,
        ownerMessages: owner.length,
        extracted: raw.capabilities.length,
        verified: verified.length,
        constraintsExcluded: constraints,
        rejected,
        mergedAway: away.length,
        mergedTitlesLost: lost.map((x) => ({ into: x.survivor, id: x.id, title: x.title, kept: x.kept })),
        requirementsFinal: finalList.length,
        requirementsRecorded: recorded.length,
        coverFinal: fin.how,
        assignments: verified.map((c) => {
          const st = fin.settled.find((x) => x.key === c.key);
          const r = finalList.find((x) => x.id === st?.by);
          return {
            key: c.key,
            text: c.text,
            how: st?.how ?? "none",
            by: st?.by ?? null,
            byTitle: r?.title ?? null,
          };
        }),
        coverRecorded: rec.how,
        uncoveredFinal: verified
          .filter((c) => !fin.covered.has(c.key))
          .map((c) => ({
            ...c,
            stage: loss.lostAfterCapture.includes(c.key) ? "lost after capture" : "never recorded",
          })),
        loss,
        unsupportedRequirements: prec.filter((p) => !p.supported).map((p) => p.id),
      });
      console.warn(
        `${spec}: ${verified.length}/${raw.capabilities.length} verified, final covers ${fin.covered.size}, recorded covers ${rec.covered.size}, ${finalList.length}/${recorded.length} requirements, spent ${spent().toFixed(3)} USD`,
      );
    }

    const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
    const fmt = (s: ReturnType<typeof summarize>[number]["recall"]): string =>
      `${pct(s.rate)} (${s.k}/${s.n}; Wilson ${pct(s.low)}-${pct(s.high)}; bootstrap over interviews ${pct(s.bootstrap.low)}-${pct(s.bootstrap.high)})`;
    const finalSummary = summarize(scores);
    const recordedSummary = summarize(recordedScores);
    const anywhereSummary = summarize(anywhereScores);
    console.log(`\n${dir}`);
    console.log(
      "| persona | interviews | recall, final FR list | recall, anywhere in the spec | recall, FRs as recorded (before curation) | precision (supported) |",
    );
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const s of finalSummary) {
      const r = recordedSummary.find((x) => x.persona === s.persona);
      console.log(
        `| ${s.persona} | ${s.interviews} | ${fmt(s.recall)} | ${fmt(anywhereSummary.find((x) => x.persona === s.persona)?.recall ?? s.recall)} | ${r ? fmt(r.recall) : "n/a"} | ${pct(s.precision.rate)} (${s.precision.k}/${s.precision.n}; Wilson ${pct(s.precision.low)}-${pct(s.precision.high)}) |`,
      );
    }
    if (unreadable.length) console.warn(`extractor returned nothing usable for: ${unreadable.join(", ")}`);
    writeFileSync(
      join(dir, `${LABEL}.json`),
      redact(
        JSON.stringify(
          {
            extractor: EXTRACTOR,
            matcher: MATCHER,
            usd: Math.round(spent() * 1000) / 1000,
            final: finalSummary,
            recorded: recordedSummary,
            anywhere: anywhereSummary,
            details,
            unreadable,
          },
          null,
          2,
        ),
      ),
    );
  }
  console.warn(
    `recall spend ${spent().toFixed(3)} USD, ${calls.extract} extractions, ${calls.match} matches`,
  );
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
