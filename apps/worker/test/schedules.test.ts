import { MemoryJobPublisher } from "@aidp/core";
import { describe, expect, it } from "vitest";
import { registerSchedules } from "../src/schedules.js";

describe("worker schedules", () => {
  it("registers the retention sweep on start, and re-registering it does not add a second one", async () => {
    const jobs = new MemoryJobPublisher();
    const lines: { message: string; meta?: Record<string, unknown> }[] = [];

    const registered = await registerSchedules(jobs, {
      info: (message, meta) => lines.push({ message, ...(meta ? { meta } : {}) }),
    });

    expect(registered).toContain("privacy.retention-sweep");
    expect(jobs.scheduled).toEqual([
      { name: "privacy.retention-sweep", cron: "17 3 * * *", payload: {}, options: { tz: "UTC" } },
    ]);
    expect(lines[0]?.meta).toMatchObject({ job: "privacy.retention-sweep", cron: "17 3 * * *" });

    // A restart, or a second replica.
    await registerSchedules(jobs);
    expect(jobs.scheduled).toHaveLength(1);
  });
});
