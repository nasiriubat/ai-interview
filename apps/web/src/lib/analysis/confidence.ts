import { interviewsOf } from "@aidp/shared";

/*
 * How much evidence is behind an opportunity (D-478): the distinct interviews it was mentioned in,
 * out of the interviews analysed, and whether that is a small sample. Counts are fine to show under
 * the anonymity rule; who said it never is.
 */

/** `analysis.smallSampleInterviews` when the page could not read it. */
export const DEFAULT_SMALL_SAMPLE = 2;

export interface Confidence {
  interviews: number;
  /** Interviews analysed in the version; 0 when unknown. */
  total: number;
  small: boolean;
}

export function confidenceOf(
  stats: { participants: number; sessions?: number | undefined },
  total: number,
  smallSample: number = DEFAULT_SMALL_SAMPLE,
): Confidence {
  const interviews = interviewsOf(stats);
  return { interviews, total, small: interviews <= smallSample };
}

/** Reads `analysis.smallSampleInterviews` from a settings value. */
export function parseSmallSample(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 10
    ? raw
    : DEFAULT_SMALL_SAMPLE;
}
