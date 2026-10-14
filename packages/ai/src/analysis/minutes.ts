import type { Fact } from "@aidp/shared";

/** Occurrences per working week for a task's stated frequency. */
export const PER_WEEK: Record<string, number> = {
  hourly: 40,
  daily: 5,
  weekly: 1,
  monthly: 0.25,
  rarely: 0.05,
};

/**
 * Self-reported minutes per week behind a set of facts, counting each task once per person.
 *
 * Extraction can hold the same task twice for one interview (a low-cost extractor re-emits what it
 * was shown as known). Summed naively, the 2026-10-15 simulation reported 167 hours a week for five
 * people. A person's task, by normalized name, now counts once: the largest stated time wins, so a
 * correction upwards is kept and a repeat adds nothing.
 */
export function weeklyMinutes(members: readonly { participantKey: string; fact: Fact }[]): number {
  const best = new Map<string, number>();
  for (const m of members) {
    if (m.fact.kind !== "task") continue;
    const key = `${m.participantKey}\u0000${m.fact.name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()}`;
    const minutes = m.fact.minutesPerOccurrence * (PER_WEEK[m.fact.frequency] ?? 1);
    best.set(key, Math.max(best.get(key) ?? 0, minutes));
  }
  let total = 0;
  for (const v of best.values()) total += v;
  return total;
}
