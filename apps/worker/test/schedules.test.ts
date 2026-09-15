import { MemoryJobPublisher, RECURRING_JOBS } from "@aidp/core";
import { describe, expect, it } from "vitest";
import { registerSchedules } from "../src/schedules.js";

describe("worker schedules", () => {
  // Deliberately derived from RECURRING_JOBS rather than a literal list. An earlier version of
  // this test pinned the exact array, so adding a recurring job broke it in a way that said
  // nothing about the job and nothing about the scheduler. What actually matters is the shape of
  // the registration, and that a restart or a second replica does not double it.
  it("puts every recurring job on its timer, with its own cron and timezone", async () => {
    const jobs = new MemoryJobPublisher();
    const lines: { message: string; meta?: Record<string, unknown> }[] = [];

    const registered = await registerSchedules(jobs, {
      info: (message, meta) => lines.push({ message, ...(meta ? { meta } : {}) }),
    });

    const expected = Object.entries(RECURRING_JOBS);
    expect(expected.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual(expected.map(([name]) => name).sort());
    expect(jobs.scheduled).toHaveLength(expected.length);

    for (const [name, spec] of expected) {
      expect(jobs.scheduled).toContainEqual({
        name,
        cron: spec.cron,
        payload: spec.payload,
        options: { tz: spec.tz },
      });
      expect(lines).toContainEqual({
        message: "job scheduled",
        meta: { job: name, cron: spec.cron, tz: spec.tz },
      });
    }
  });

  it("does not add a second copy when a restart or a second replica registers again", async () => {
    const jobs = new MemoryJobPublisher();
    await registerSchedules(jobs);
    const afterFirst = jobs.scheduled.length;

    await registerSchedules(jobs);

    expect(jobs.scheduled).toHaveLength(afterFirst);
  });
});
