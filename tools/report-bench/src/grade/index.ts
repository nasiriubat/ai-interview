import type { BenchReport } from "../report.js";
import type { Scenario } from "../scenario.js";
import { participantText, type Transcript } from "../simulate.js";
import { judgeReport, observe, type JudgeConfig } from "./judge.js";
import { keywordMapping } from "./match.js";
import { buildScorecard, type Scorecard } from "./scorecard.js";
import { scoreAll, type JudgeVerdict } from "./scoring.js";

/**
 * Grades one report against the scenario and the transcripts it was made from. With a judge the
 * mapping, hallucinations and the two narrative criteria come from it and the observed prevalence
 * from a per-transcript pass; without one (`judge` null) only the deterministic criteria score and
 * the mapping falls back to keywords.
 */
export async function grade(args: {
  scenario: Scenario;
  run: string;
  report: BenchReport;
  transcripts: Transcript[];
  judge: JudgeConfig | null;
  spend?: Record<string, number> | null;
  notes?: string[];
}): Promise<Scorecard> {
  const { scenario, report, transcripts } = args;
  const k = report.k ?? scenario.k;
  const kw = keywordMapping(scenario, report.opportunities);
  let verdict: JudgeVerdict | null = null;
  let observed = null;
  const judgeNotes: string[] = [];
  if (args.judge) {
    observed = await observe(args.judge, scenario, transcripts);
    const judged = await judgeReport(args.judge, scenario, report, transcripts, k);
    verdict = judged.verdict;
    if (judged.samples.length > 1)
      judgeNotes.push(
        `judge samples: ${judged.samples.length}; actionability ${judged.samples.map((s) => s.actionability.score).join("/")}, executive summary ${judged.samples.map((s) => s.executiveSummary.score).join("/")}, hallucination findings ${judged.samples.map((s) => s.hallucinations.length).join("/")}, unsupported items ${judged.samples.map((s) => s.mapping.filter((m) => m.kind === "unsupported").length).join("/")} (median or majority used)`,
      );
  }
  const mapping = verdict?.mapping ?? kw;
  const notes = [...(args.notes ?? []), ...judgeNotes];
  const unfinished = transcripts.filter((t) => !t.ended);
  if (unfinished.length)
    notes.push(
      `${unfinished.length} interview(s) did not end through the engine: ${unfinished.map((t) => `${t.personaId} (${t.endReason})`).join(", ")}`,
    );
  const criteria = scoreAll({
    scenario,
    report,
    answers: transcripts.flatMap(participantText),
    mapping,
    observed,
    judge: verdict,
    k,
  });
  return buildScorecard({
    scenario,
    run: args.run,
    report,
    criteria,
    mapping,
    keywordMapping: kw,
    mappingSource: verdict ? "judge" : "keywords",
    observed,
    judgeModel: args.judge?.model ?? null,
    spend: args.spend ?? null,
    notes,
  });
}
