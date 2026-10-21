import { ErrorRecorder, MemoryErrorStore, runBatch } from "@aidp/core";
import { describe, expect, it } from "vitest";
import { jobFailureEvent } from "../src/alerts.js";

/** A failed job in the error log (D-477): every attempt recorded, a retry told apart from the last. */
describe("jobFailureEvent", () => {
  const data = { analysisId: "an1", companyId: "co1", extra: "never stored" };

  it("records a retry as a warning and the last attempt as an error, in separate groups", () => {
    const retry = jobFailureEvent(
      "analysis.run",
      new Error("provider timed out"),
      {
        attempt: 1,
        retryLimit: 2,
        final: false,
        data,
      },
      "2026.10.3",
    );
    const last = jobFailureEvent(
      "analysis.run",
      new Error("provider timed out"),
      {
        attempt: 3,
        retryLimit: 2,
        final: true,
        data,
      },
      "2026.10.3",
    );
    expect(retry).toMatchObject({
      source: "worker",
      severity: "warning",
      jobName: "analysis.run",
      jobAttempt: 1,
      jobFinal: false,
      companyId: "co1",
      release: "2026.10.3",
      message: "provider timed out",
    });
    expect(last).toMatchObject({ severity: "error", jobAttempt: 3, jobFinal: true });
    expect(JSON.stringify(retry)).not.toContain("never stored");

    const store = new MemoryErrorStore();
    const rec = new ErrorRecorder({ store, autoFlush: false });
    rec.capture(retry);
    rec.capture(last);
    return rec.flush().then(() => {
      const keys = new Set(store.writes.map((w) => w.record.groupKey));
      expect(keys.size).toBe(2);
    });
  });

  it("is what a failing handler in a batch produces, through the consumer's error hook", async () => {
    const store = new MemoryErrorStore();
    const rec = new ErrorRecorder({ store, autoFlush: false });
    await runBatch(
      "session.extract",
      [{ id: "j1", data: { sessionId: "s1", companyId: "co1" }, retryCount: 3, retryLimit: 3 }],
      async () => {
        throw new TypeError("cannot read properties of undefined");
      },
      {
        onError: (_id, err, failure) => {
          rec.capture(jobFailureEvent("session.extract", err, failure, undefined));
        },
      },
    );
    await rec.flush();
    expect(store.stored()).toHaveLength(1);
    expect(store.stored()[0]?.record).toMatchObject({
      source: "worker",
      severity: "error",
      name: "TypeError",
      jobName: "session.extract",
      jobFinal: true,
      jobAttempt: 4,
      companyId: "co1",
    });
  });
});
