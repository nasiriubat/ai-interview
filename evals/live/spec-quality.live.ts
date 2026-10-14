/**
 * Live judge of specification quality (D-245). Costs real money; never run by CI (it is outside
 * `src/**\/*.eval.ts`).
 *
 *   SQ_DIR=<dir of artifacts from variance.live.ts / spec-replay.live.ts> \
 *   pnpm --filter @aidp/evals exec tsx live/spec-quality.live.ts
 *
 * For every saved interview (`<persona>-<n>.json` with its transcript and generated requirements)
 * a cheap model scores each requirement against the participant's own words: grounded (with a
 * quote the code verifies), atomic, one kind of thing, testable, scope tag, duplicate-of. One more
 * call per transcript lists the capabilities the participant stated (cached by transcript), and
 * one per specification says which of them no requirement covers: recall that does not depend on
 * how many requirements there are.
 *
 * The numbers are the model's reading, checked where code can check it (`src/spec-quality.ts`);
 * `SQ_LABELS` points at a manual label file to report agreement with a human reading.
 *
 * Environment:
 *   SQ_DIR                directory of artifacts (required)
 *   SQ_LABEL=judged       name of the output
 *   SQ_CAP_USD=0.5        hard cap on this script's spend; calls stop at it
 *   SQ_MODEL=openai/gpt-4.1-mini
 *   SQ_LABELS             JSON array of ManualLabel to compare against
 *
 * The key is read at runtime and never printed or written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findDuplicatePairs, groupPairs } from "@aidp/ai";
import { extractJson } from "../../scripts/live-run/src/pure.js";
import { chat, harnessSpend, loadOpenRouterKey, redact } from "../../scripts/live-run/src/runtime.js";
import {
  agreement,
  applyClusters,
  pool,
  scoreSpec,
  verifyVerdicts,
  type ManualLabel,
  type RawVerdict,
  type RequirementUnderJudgement,
  type SpecScore,
  type Verdict,
} from "../src/spec-quality.js";

const DIR = process.env.SQ_DIR;
if (!DIR) throw new Error("SQ_DIR is required");
const LABEL = process.env.SQ_LABEL ?? "judged";
const CAP = Number(process.env.SQ_CAP_USD ?? 0.5);
const MODEL = process.env.SQ_MODEL ?? "openai/gpt-4.1-mini";
/** Grouping the whole list is the hard part and a small prompt, so it gets the stronger model. */
const MODEL_CLUSTER = process.env.SQ_MODEL_CLUSTER ?? "openai/gpt-4.1";

interface Artifact {
  persona: string;
  messages: { seq: number; role: "user" | "assistant"; content: string }[];
  requirements: (RequirementUnderJudgement & {
    needsConfirmation?: boolean;
    evidence?: string;
    mergedFrom?: string[];
  })[];
}

const RUBRIC = `You are a strict reviewer of software requirements written from an interview. You see the interview transcript (INTERVIEWER lines are the questioner, PARTICIPANT lines are the owner of the idea) and a numbered list of requirements written from it. Judge every requirement on its own, against the PARTICIPANT's words only.

For each requirement return:
- grounded: "yes" when the participant stated, asked for or explicitly accepted it (accepting an interviewer's proposal counts when the transcript shows the proposal and the acceptance); "partial" when only a part is supported or it is inferred from what they said; "no" when nothing the participant said supports it. A requirement whose title is only "Removed", "Merged into FR-n" or similar is "no".
- quote: when grounded is "yes" or "partial", the participant's words that support it, copied exactly from a PARTICIPANT line (at most 200 characters); otherwise "".
- granularity: "ok" when it is one capability a person could demonstrate and test on its own; "too_fine" when it is a field, label, button, message wording, a single step, a measurement or an attribute of another capability (a load time of a screen, the text of a confirmation, which fields a form shows, a role's permission on a screen are all details of the capability they belong to); "too_coarse" when it bundles several separately testable capabilities.
- kind: "capability" (something the product does or lets a user do), "detail" (a part of a capability), "decision" (a choice already made about how to build or run it), "constraint" (a limit, a policy, a quality target, a test or acceptance criterion of the whole project), "question" (an open point).
- testable: "yes" when every acceptance criterion could be answered yes or no by a tester; "partly" when some could; "no" when there are none or they are vague ("easy", "fast", "user-friendly" with no number).
- scope: "wrong" ONLY when the participant explicitly said the opposite of the tag (they said later, deferred, v1.1, nice to have, or not for the first version, and it is tagged mvp; or they said it is needed from day one and it is tagged future); "correct" when the participant said the tag; "unclear" when the transcript says nothing about its timing.

Return one JSON object: {"verdicts":[{"id":string,"grounded":...,"quote":string,"granularity":...,"kind":...,"testable":...,"scope":...}]} with exactly one entry per requirement, in order.`;

const CLUSTER_PROMPT = `Below is the complete list of requirements of one specification. A developer builds one thing for each group of requirements that name the SAME capability: the same capability for the same actor, worded differently or at a different level of detail, or one that is merely a detail, an attribute or a measurement of another (for example "show a success message", "confirm the note was saved" and "success confirmation details" are one capability). Requirements with the same or nearly the same title are the same capability even if their acceptance criteria differ: the checks belong to one capability. Requirements that name different capabilities are different even if related.

Return JSON only: {"groups":[["FR-3","FR-9","FR-14"],["FR-4","FR-8"]]} listing every group of two or more requirements that are the same capability, by id. A requirement appears in at most one group. If there are no duplicates return {"groups":[]}.`;

const PAIR_PROMPT = `You are given pairs of requirements from one software specification. For each pair say whether they are the SAME capability, so that a developer would build one thing for both. They are the same when they name the same capability for the same actor, worded differently or at a different level of detail, or when one is only a detail, an attribute, a message text or a measurement of the other. Two requirements with the same or nearly the same title are the same capability even when their acceptance criteria list different checks: the checks belong to one capability. Say "different" only when the titles name different capabilities (a different actor, trigger, data item or outcome). Return JSON only: {"pairs":[{"a":"FR-1","b":"FR-2","same":true}]} with one entry per pair, ids as given.`;

const CAPS_PROMPT = `From the interview transcript, list the product features the PARTICIPANT stated, asked for or explicitly accepted: what the product must do or let people do. Work at the level of a feature a product owner would name in a release note: between 8 and 20 entries for the whole interview, each a capability that could be demonstrated and tested on its own, without screen details, technology decisions or constraints. Return JSON only: {"capabilities":[{"key":"c1","text":"short description"}]}`;

const COVER_PROMPT = `You are given a list of features the participant of an interview asked for, and the requirements written from that interview. For each feature say whether some requirement covers it (a developer building exactly the requirements would build that feature; a requirement that includes it among its acceptance criteria covers it). Return JSON only: {"covered":[{"key":"c1","by":"FR-3"|null}]} with one entry per feature.`;

function transcriptText(a: Artifact): { text: string; participant: string[] } {
  const lines: string[] = [];
  const participant: string[] = [];
  for (const m of a.messages) {
    if (m.role === "user") {
      participant.push(m.content);
      lines.push(`PARTICIPANT: ${m.content.slice(0, 700)}`);
    } else lines.push(`INTERVIEWER: ${m.content.slice(0, 500)}`);
  }
  return { text: lines.join("\n"), participant };
}

const reqLines = (a: Artifact): string =>
  a.requirements
    .map(
      (r) =>
        `${r.id} [${r.scope}${r.reason ? `; reason: ${r.reason}` : ""}] ${r.title}\n  acceptance: ${
          r.acceptance.length ? r.acceptance.map((x) => `- ${x}`).join(" ") : "(none)"
        }`,
    )
    .join("\n");

async function main(): Promise<void> {
  const apiKey = loadOpenRouterKey();
  const files = readdirSync(DIR!)
    .filter((f) => /^(technical|nontechnical)-\d+\.json$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no artifacts in ${DIR}`);
  const spent = (): number => harnessSpend.usd;
  const cacheDir = join(DIR!, ".sq-cache");
  mkdirSync(cacheDir, { recursive: true });
  /** One judge call; the answer is cached by model and prompt so a re-run pays only for what changed. */
  const call = async (label: string, user: string, max: number, model = MODEL): Promise<unknown> => {
    const key = createHash("sha256").update(`${model}\n${user}`).digest("hex").slice(0, 24);
    const file = join(cacheDir, `call-${key}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (spent() >= CAP) throw new Error(`cost cap ${CAP} USD reached`);
    const r = await chat({
      apiKey,
      model,
      label,
      messages: [{ role: "user", content: user }],
      maxTokens: max,
      json: true,
      temperature: 0,
    });
    const out = extractJson(r.content);
    writeFileSync(file, JSON.stringify(out));
    return out;
  };
  const perSpec: {
    spec: string;
    persona: string;
    score: SpecScore;
    verdicts: Verdict[];
    capabilities: number;
    missing: { key: string; text: string }[];
    unconfirmed: number;
    mergedAway: number;
  }[] = [];

  const skipped: string[] = [];
  // A spec the cap stops in the middle is dropped whole, and the rest are listed as skipped.
  for (const f of files) {
    if (spent() >= CAP) {
      skipped.push(f);
      continue;
    }
    try {
      await judgeOne(f);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("cost cap")) throw e;
      skipped.push(f);
    }
  }
  if (skipped.length) console.warn(`skipped for cost: ${skipped.join(", ")}`);

  async function judgeOne(f: string): Promise<void> {
    const a = JSON.parse(readFileSync(join(DIR!, f), "utf8")) as Artifact;
    const spec = f.replace(/\.json$/, "");
    const { text, participant } = transcriptText(a);
    // Requirements judged one transcript at a time, in chunks the model keeps straight.
    const raw: RawVerdict[] = [];
    for (let i = 0; i < a.requirements.length; i += 20) {
      const chunk = { ...a, requirements: a.requirements.slice(i, i + 20) };
      const out = (await call(
        `judge:${spec}`,
        `${RUBRIC}\n\nTranscript:\n${text}\n\nRequirements to judge now:\n${reqLines(chunk)}`,
        6000,
      )) as { verdicts?: RawVerdict[] } | null;
      raw.push(...(out?.verdicts ?? []));
    }
    // Duplicates need the whole list in one view, not chunks of it: one grouping call.
    const clustered = (await call(
      `cluster:${spec}`,
      `${CLUSTER_PROMPT}\n\nRequirements:\n${a.requirements
        .map((r) => `${r.id}: ${r.title}${r.acceptance[0] ? ` | ${r.acceptance[0].slice(0, 140)}` : ""}`)
        .join("\n")}`,
      2500,
      MODEL_CLUSTER,
    )) as { groups?: string[][] } | null;
    // A second, independent route to duplicates: every pair that shares words, checked one by one.
    const reqViews = a.requirements.map((r) => ({
      id: r.id,
      title: r.title,
      scope: r.scope,
      acceptance: r.acceptance,
    }));
    const lexical = findDuplicatePairs(reqViews, { auto: 2, candidate: 0.25 }).slice(0, 200);
    const samePairs: { a: string; b: string }[] = [];
    for (let i = 0; i < lexical.length; i += 25) {
      const batch = lexical.slice(i, i + 25);
      const byId = new Map(reqViews.map((r) => [r.id, r]));
      const line = (id: string): string => {
        const r = byId.get(id);
        return `${id}: ${r?.title ?? ""}${r?.acceptance[0] ? ` | ${r.acceptance[0].slice(0, 120)}` : ""}`;
      };
      const out = (await call(
        `pairs:${spec}`,
        `${PAIR_PROMPT}\n\nPairs:\n${batch.map((p, n) => `${n + 1}. a = ${line(p.a)}\n   b = ${line(p.b)}`).join("\n")}`,
        3000,
        MODEL_CLUSTER,
      )) as { pairs?: { a: string; b: string; same: boolean }[] } | null;
      for (const p of out?.pairs ?? []) if (p.same) samePairs.push({ a: p.a, b: p.b });
    }
    const verdicts = applyClusters(verifyVerdicts(a.requirements, raw, participant), [
      ...(Array.isArray(clustered?.groups) ? clustered.groups.filter(Array.isArray) : []),
      ...groupPairs(
        a.requirements.map((r) => r.id),
        samePairs,
      ),
    ]);

    // The capabilities the participant stated: once per transcript, cached by its text.
    const tid = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const capFile = join(cacheDir, `caps2-${tid}.json`);
    let caps: { key: string; text: string }[];
    if (existsSync(capFile)) caps = JSON.parse(readFileSync(capFile, "utf8")) as typeof caps;
    else {
      const out = (await call(`caps:${spec}`, `${CAPS_PROMPT}\n\nTranscript:\n${text}`, 3000)) as {
        capabilities?: { key: string; text: string }[];
      } | null;
      caps = (out?.capabilities ?? []).filter((c) => c.key && c.text);
      writeFileSync(capFile, JSON.stringify(caps, null, 2));
    }
    const cov = (await call(
      `cover:${spec}`,
      `${COVER_PROMPT}\n\nCapabilities:\n${caps.map((c) => `${c.key}: ${c.text}`).join("\n")}\n\nRequirements:\n${reqLines(a)}`,
      3000,
    )) as { covered?: { key: string; by: string | null }[] } | null;
    const covered = new Set((cov?.covered ?? []).filter((c) => c.by).map((c) => c.key));
    const missing = caps.filter((c) => !covered.has(c.key));

    const unconfirmed = a.requirements.filter((r) => r.needsConfirmation).map((r) => r.id);
    perSpec.push({
      spec,
      persona: a.persona,
      score: scoreSpec(verdicts, { unconfirmedIds: unconfirmed }),
      verdicts,
      capabilities: caps.length,
      missing,
      unconfirmed: unconfirmed.length,
      mergedAway: a.requirements.reduce((n, r) => n + (r.mergedFrom?.length ?? 0), 0),
    });
    console.warn(
      `${spec}: ${a.requirements.length} requirements, ${caps.length} capabilities, ${missing.length} not covered, spent ${spent().toFixed(3)} USD`,
    );
  }

  const personas = [...new Set(perSpec.map((p) => p.persona))];
  const rows = [
    ...personas.map((p) => ({
      name: p,
      s: pool(perSpec.filter((x) => x.persona === p)),
      specs: perSpec.filter((x) => x.persona === p),
    })),
    { name: "all", s: pool(perSpec), specs: perSpec },
  ];
  const pct = (n: number | null): string => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
  const med = (xs: number[]): number => {
    const s = [...xs].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length === 0 ? 0 : s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
  };
  console.log(
    "| set | specs | requirements | median per spec | grounded (quote verified) | grounded (as judged) | duplicate | over-granular | non-requirement | testable | scope not contradicted | capabilities missed |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    const missed = r.specs.reduce((n, x) => n + x.missing.length, 0);
    const caps = r.specs.reduce((n, x) => n + x.capabilities, 0);
    console.log(
      `| ${r.name} | ${r.specs.length} | ${r.s.count} | ${med(r.specs.map((x) => x.score.count))} | ${pct(r.s.groundedRate)} | ${pct(r.s.groundedClaimedRate)} | ${pct(r.s.duplicateRate)} | ${pct(r.s.overGranularRate)} | ${pct(r.s.nonRequirementRate)} | ${pct(r.s.testableRate)} | ${pct(r.s.scopeAccuracy)} | ${missed} of ${caps} |`,
    );
  }

  let agree: ReturnType<typeof agreement> | undefined;
  if (process.env.SQ_LABELS) {
    const labels = JSON.parse(readFileSync(process.env.SQ_LABELS, "utf8")) as ManualLabel[];
    const pairs = labels.flatMap((m) => {
      const v = perSpec.find((p) => p.spec === m.spec)?.verdicts.find((x) => x.id === m.id);
      return v ? [{ judge: v, manual: m }] : [];
    });
    agree = agreement(pairs);
    console.log(`\nAgreement with manual labels on ${pairs.length} requirements:`);
    console.log("| dimension | n | agreement | kappa | judge only | manual only |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const r of agree)
      console.log(
        `| ${r.dimension} | ${r.n} | ${pct(r.agreement)} | ${r.kappa ?? "n/a"} | ${r.judgeOnly} | ${r.manualOnly} |`,
      );
  }

  const out = join(DIR!, `${LABEL}.json`);
  writeFileSync(
    out,
    redact(
      JSON.stringify(
        {
          model: MODEL,
          usd: Math.round(spent() * 1000) / 1000,
          rows: rows.map((r) => ({ name: r.name, ...r.s })),
          perSpec,
          agree,
        },
        null,
        2,
      ),
    ),
  );
  console.warn(`judge spend ${spent().toFixed(3)} USD; details: ${out}`);
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(1);
});
