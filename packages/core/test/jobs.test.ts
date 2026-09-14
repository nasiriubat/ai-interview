import { describe, expect, it } from "vitest";
import { MemoryJobPublisher, RECURRING_JOBS } from "../src/jobs/definitions.js";

describe("job definitions", () => {
  it("records a schedule and keeps one per (name, key)", async () => {
    const jobs = new MemoryJobPublisher();
    await jobs.schedule("privacy.retention-sweep", "17 3 * * *", {}, { tz: "UTC" });
    expect(jobs.scheduled).toHaveLength(1);
    expect(jobs.scheduled[0]).toMatchObject({
      name: "privacy.retention-sweep",
      cron: "17 3 * * *",
      payload: {},
      options: { tz: "UTC" },
    });
    expect(jobs.published).toHaveLength(0);

    // Registering the same schedule again (a second worker replica, a restart) replaces it.
    await jobs.schedule("privacy.retention-sweep", "30 4 * * *", {}, { tz: "UTC" });
    expect(jobs.scheduled).toHaveLength(1);
    expect(jobs.scheduled[0]?.cron).toBe("30 4 * * *");

    // A different key is a different schedule.
    await jobs.schedule("privacy.retention-sweep", "0 1 * * *", {}, { key: "extra" });
    expect(jobs.scheduled).toHaveLength(2);
  });

  it("validates the payload of a scheduled job like any other", async () => {
    const jobs = new MemoryJobPublisher();
    await expect(
      jobs.schedule("session.summarize", "0 * * * *", { sessionId: "s" } as never),
    ).rejects.toThrow();
  });

  it("puts the retention sweep on a daily timer at a quiet, off-the-hour minute", () => {
    const sweep = RECURRING_JOBS["privacy.retention-sweep"];
    expect(sweep).toBeDefined();
    expect(sweep?.cron).toBe("17 3 * * *");
    expect(sweep?.tz).toBe("UTC");
  });
});
