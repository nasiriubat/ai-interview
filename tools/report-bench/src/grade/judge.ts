import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { extractJson } from "../../../live-run/src/pure.js";
import { chat, type ChatMessage } from "../openrouter.js";
import type { BenchReport } from "../report.js";
import type { Scenario } from "../scenario.js";
import { transcriptText, type Transcript } from "../simulate.js";
import type { Observed, OpportunityMatch } from "./match.js";
import { aggregateVerdicts, type JudgeVerdict } from "./scoring.js";

export interface JudgeConfig {
  apiKey: string;
  model: string;
  /** Directory of cached answers keyed by a hash of model and prompt; a re-grade reuses them. */
  cacheDir: string;
  /** How many independent judge answers to aggregate (default 3). */
  samples?: number;
}

/** A judge call at temperature 0, answered from the cache when the same prompt was asked before. */
async function cachedJson(
  cfg: JudgeConfig,
  label: string,
  messages: ChatMessage[],
  maxTokens: number,
  sample = 0,
): Promise<unknown> {
  const key = createHash("sha256")
    .update(JSON.stringify(sample ? { model: cfg.model, messages, sample } : { model: cfg.model, messages }))
    .digest("hex")
    .slice(0, 32);
  const file = join(cfg.cacheDir, `${label.split(":")[0] ?? "judge"}-${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as unknown;
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // A second attempt gets twice the room: the usual failure is an answer cut off at the limit.
    const text = await chat({
      apiKey: cfg.apiKey,
      model: cfg.model,
      label,
      messages,
      maxTokens: maxTokens * (attempt + 1),
      temperature: 0,
      seed: 1 + sample,
      json: true,
    });
    last = text;
    const parsed = extractJson(text);
    if (parsed !== null) {
      mkdirSync(cfg.cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      return parsed;
    }
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  writeFileSync(join(cfg.cacheDir, `failed-${key}.txt`), last);
  throw new Error(`${label}: the judge did not return JSON twice (last answer in failed-${key}.txt)`);
}

// ---------------------------------------------------------------------------------------------
// Observation: which planted items each participant actually described.
// ---------------------------------------------------------------------------------------------

const ObservationSchema = z.object({
  present: z.array(z.object({ id: z.string(), evidence: z.string().default("") })),
});

export function observationPrompt(scenario: Scenario, t: Transcript): ChatMessage[] {
  const items = scenario.problems.map((p) => `- ${p.id}: ${p.title}. ${p.description}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You audit one interview transcript. Decide which of the listed items the PARTICIPANT actually described from their own work.",
        "Count an item only when the participant's own answers state it with at least one concrete element of the description (the activity and the pain, or for a works-well item, that it works well).",
        "Do not count what only the interviewer said, guesses, or vague agreement. A participant may answer in Finnish; judge the meaning.",
        'Answer with JSON only: {"present": [{"id": "<item id>", "evidence": "<short participant words>"}]}. An empty list is a valid answer.',
      ].join("\n"),
    },
    { role: "user", content: `Items:\n${items}\n\nTranscript:\n${transcriptText(t, t.personaId)}` },
  ];
}

export async function observe(
  cfg: JudgeConfig,
  scenario: Scenario,
  transcripts: Transcript[],
): Promise<Observed> {
  const known = new Set(scenario.problems.map((p) => p.id));
  const out: Observed = Object.fromEntries(scenario.problems.map((p) => [p.id, [] as string[]]));
  for (const t of transcripts) {
    const raw = await cachedJson(cfg, `observe:${t.personaId}`, observationPrompt(scenario, t), 1500);
    const parsed = ObservationSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`observe ${t.personaId}: ${parsed.error.message}`);
    for (const p of parsed.data.present)
      if (known.has(p.id)) out[p.id] = [...new Set([...(out[p.id] ?? []), t.personaId])];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The report judge.
// ---------------------------------------------------------------------------------------------

const JudgeSchema = z.object({
  mapping: z.array(
    z.object({
      item: z.number().int(),
      // The judge sometimes names the ground-truth kind instead ("distractor", "works_well"); the
      // problem ids it gives decide the mapping then, so an unknown kind reads as other_supported.
      kind: z
        .string()
        .transform((k): "planted" | "other_supported" | "unsupported" =>
          k === "planted" || k === "unsupported" ? k : "other_supported",
        ),
      problemIds: z.array(z.string()).default([]),
      note: z.string().default(""),
    }),
  ),
  hallucinations: z
    .array(z.object({ claim: z.string(), severity: z.enum(["major", "minor"]), why: z.string().default("") }))
    .default([]),
  anonymityConcerns: z.array(z.object({ detail: z.string(), why: z.string().default("") })).default([]),
  actionability: z.object({ score: z.number(), evidence: z.array(z.string()).default([]) }),
  executiveSummary: z.object({ score: z.number(), evidence: z.array(z.string()).default([]) }),
});

const RUBRIC = `You are a strict, fair auditor of an organisational discovery report. The report was produced by software from the interview transcripts below. You also get the GROUND TRUTH: the problems that were deliberately planted in the simulated employees, an area that works well, and a distractor. Judge only against the transcripts and the ground truth, never against what you think the company might have.

Return JSON only, with exactly these keys:

"mapping": one entry per numbered report item, in order: {"item": <number>, "kind": "planted" | "other_supported" | "unsupported", "problemIds": [<ground-truth ids this item covers>], "note": "<one line>"}.
  - "planted": the item is about one or more ground-truth entries (problems, the works-well area or the distractor). List every id it substantially covers; an item that lumps two planted problems together lists both. Map to an id only when the item is about that same activity or system (a different system that also "works well" is not the works-well item).
  - "other_supported": anything at least one participant actually described that is not in the ground truth, including low-pain routine work, "no action needed" findings and wishes. Being minor, low-pain or not in the ground truth does NOT make an item unsupported.
  - "unsupported": no participant said anything like it; the item is invented. Use this rarely and only after checking every transcript.
  An item built on the distractor's wishes (AI everywhere, chatbots, AI-written offers, AI forecasting) maps to the distractor id.

"hallucinations": claims in the report text (executive summary, item summaries, numbers, durations, tools, next steps' factual premises) that no transcript supports. {"claim": "...", "severity": "major" | "minor", "why": "..."}. major = a wrong number, a made-up problem, tool, process or finding a reader would act on; minor = an embellishment or over-generalisation. Do not list whole items already marked "unsupported" in mapping. Do not list reasonable recommendations as hallucinations; list only false or unsupported statements of fact. Never list a claim you found support for: a participant's own estimate, repeated or converted to other units (days to minutes, per day to per week), is supported, even if it is only one person's estimate. Data artefacts of the report template (such as an "Invited" count) are not hallucinations. Judge each claim once; do not list the same claim twice.

"anonymityConcerns": details that would let a colleague identify an individual participant (a name, a unique role in a small group, a personal detail), especially for a theme raised by fewer than K participants. {"detail": "...", "why": "..."}. Department names and generic role names for groups of K or more are fine.

"actionability": {"score": 0-10, "evidence": [<2-4 short lines>]}. Anchors: 10 = every next step names a concrete action, who is affected and the evidence it rests on, sequenced sensibly, with the cheap process fixes before the large builds; 7 = concrete but missing owners or sequencing; 4 = generic ("explore AI opportunities", "run a workshop") or partly unrelated to the findings; 0 = none or misleading.

"executiveSummary": {"score": 0-10, "evidence": [<2-4 short lines>]}. Anchors: 10 = names the largest problems in the right order of prevalence, with accurate counts, mentions what works well, and claims nothing unsupported; 7 = right top themes, minor omissions or imprecise counts; 4 = misses a top problem or leads with a minor or unsupported theme; 0 = wrong or empty.

Be consistent: the same report must get the same answer. Quote short evidence.`;

export function judgePrompt(
  scenario: Scenario,
  report: BenchReport,
  transcripts: Transcript[],
  k: number,
): ChatMessage[] {
  const truth = scenario.problems
    .map(
      (p) =>
        `- ${p.id} [${p.kind}] ${p.title}. ${p.description} Accepted classes: ${p.expectedClasses.join("/")}.`,
    )
    .join("\n");
  const items = report.opportunities
    .map(
      (o, i) =>
        `${i + 1}. "${o.title}" [class ${o.solutionClass || "?"}; participants ${o.participants ?? "?"}; rank ${o.rankScore ?? "?"}]\n   ${o.summary}`,
    )
    .join("\n");
  const ts = transcripts
    .map((t, i) => transcriptText(t, `Participant P${String(i + 1).padStart(2, "0")}`))
    .join("\n\n");
  return [
    {
      role: "system",
      content: RUBRIC.replaceAll("K participants", `${k} participants`).replaceAll(
        "K or more",
        `${k} or more`,
      ),
    },
    {
      role: "user",
      content: `GROUND TRUTH\n${truth}\n\nK (anonymity threshold) = ${k}\n\nREPORT ITEMS\n${items || "(none)"}\n\nREPORT MARKDOWN\n${report.markdown || "(empty)"}\n\nTRANSCRIPTS\n${ts}`,
    },
  ];
}

/** One judge sample of the report. */
async function judgeOnce(
  cfg: JudgeConfig,
  scenario: Scenario,
  report: BenchReport,
  transcripts: Transcript[],
  k: number,
  sample: number,
): Promise<JudgeVerdict> {
  const raw = await cachedJson(
    cfg,
    "judge:report",
    judgePrompt(scenario, report, transcripts, k),
    8000,
    sample,
  );
  const parsed = JudgeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`judge output did not match the schema: ${parsed.error.message}`);
  const known = new Set(scenario.problems.map((p) => p.id));
  const mapping: OpportunityMatch[] = report.opportunities.map((o, i) => {
    const m = parsed.data.mapping.find((x) => x.item === i + 1);
    if (!m)
      return { opportunityId: o.id, kind: "other_supported", problemIds: [], note: "judge gave no mapping" };
    const ids = m.problemIds.filter((id) => known.has(id));
    return {
      opportunityId: o.id,
      kind: ids.length ? "planted" : m.kind === "planted" ? "other_supported" : m.kind,
      problemIds: ids,
      note: m.note,
    };
  });
  return {
    mapping,
    hallucinations: parsed.data.hallucinations,
    anonymityConcerns: parsed.data.anonymityConcerns,
    actionability: parsed.data.actionability,
    executiveSummary: parsed.data.executiveSummary,
  };
}

/**
 * The judge, asked `cfg.samples` times (default 3) and aggregated by majority and median: even at
 * temperature 0 one answer moves by a point or two between calls, the median of three much less.
 */
export async function judgeReport(
  cfg: JudgeConfig,
  scenario: Scenario,
  report: BenchReport,
  transcripts: Transcript[],
  k: number,
): Promise<{ verdict: JudgeVerdict; samples: JudgeVerdict[] }> {
  const samples: JudgeVerdict[] = [];
  for (let i = 0; i < Math.max(1, cfg.samples ?? 3); i++)
    samples.push(await judgeOnce(cfg, scenario, report, transcripts, k, i));
  return { verdict: aggregateVerdicts(samples), samples };
}
