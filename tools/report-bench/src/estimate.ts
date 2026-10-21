/**
 * A pre-run cost estimate from token assumptions and per-million-token prices. Deliberately
 * pessimistic (a 1.3 margin on top): it decides whether a run may start under `--max-cost`. The
 * real number is measured during the run (OpenRouter key usage before and after, the product's
 * ledger and the harness's own calls).
 */
export interface Price {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface EstimateInput {
  personas: number;
  turns: number;
  /** Product routes (null when the product's spend is not ours to estimate, e.g. a cached run). */
  interview: Price | null;
  extraction: Price | null;
  analysis: Price | null;
  simulator: Price | null;
  judge: Price | null;
}

export interface EstimateLine {
  part: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export const ESTIMATE_MARGIN = 1.3;

const usd = (p: Price, input: number, output: number): number =>
  (input * p.inputPerMtok + output * p.outputPerMtok) / 1_000_000;

export function estimateCost(e: EstimateInput): { lines: EstimateLine[]; totalUsd: number } {
  const T = e.turns;
  const N = e.personas;
  const lines: EstimateLine[] = [];
  const add = (part: string, price: Price | null, input: number, output: number): void => {
    if (!price) return;
    lines.push({
      part,
      inputTokens: Math.round(input),
      outputTokens: Math.round(output),
      usd: usd(price, input, output),
    });
  };
  // The interviewer re-reads its system prompt and the growing conversation every turn.
  add("interview turns (product)", e.interview, N * (4500 * T + (300 * T * (T - 1)) / 2), N * T * 250);
  // Extraction, issue detection and the resume summary per session.
  add("extraction and summaries (product)", e.extraction, N * (9000 + 900 * T), N * (2000 + 200 * T));
  // Clustering over roughly two facts per turn, one opportunity pass per cluster, the narrative.
  const facts = 2 * T * N;
  add(
    "analysis and report (product)",
    e.analysis,
    6000 + 150 * facts + 10 * 5000 + 12000,
    50 * facts + 10 * 1500 + 3000,
  );
  add("persona simulator (harness)", e.simulator, N * (1000 * T + (220 * T * (T - 1)) / 2), N * T * 130);
  add(
    "judge and observation (harness)",
    e.judge,
    N * (2000 + 200 * T) + (12000 + N * T * 200),
    N * 250 + 4000,
  );
  const total = lines.reduce((s, l) => s + l.usd, 0) * ESTIMATE_MARGIN;
  return { lines, totalUsd: Math.round(total * 100) / 100 };
}

export function renderEstimate(est: { lines: EstimateLine[]; totalUsd: number }): string {
  return [
    "Cost estimate (USD, before the run):",
    ...est.lines.map(
      (l) =>
        `  ${l.part.padEnd(38)} ${String(Math.round(l.inputTokens / 1000)).padStart(6)}k in ${String(Math.round(l.outputTokens / 1000)).padStart(5)}k out  $${l.usd.toFixed(2)}`,
    ),
    `  total with a ${ESTIMATE_MARGIN}x margin: $${est.totalUsd.toFixed(2)}`,
  ].join("\n");
}
