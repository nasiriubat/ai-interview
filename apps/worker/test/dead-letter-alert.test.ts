import { deadLetterKey } from "@aidp/core";
import { describe, expect, it } from "vitest";
import { deadLetterAlert } from "../src/alerts.js";

describe("deadLetterAlert", () => {
  const failure = { attempt: 3, retryLimit: 2, final: true, data: { analysisId: "an1", companyId: "co1" } };

  it("is keyed by the failing job, so the sweep and the handler announce one dead letter once", () => {
    const a = deadLetterAlert("analysis.run", "job-1", failure, new TypeError("x"));
    expect(a.key).toBe(deadLetterKey("analysis.run", "job-1"));
    expect(a).toMatchObject({
      kind: "job.dead_lettered",
      companyId: "co1",
      audience: ["operator"],
      context: { queue: "analysis.run", jobId: "job-1", attempts: 3, reason: "TypeError", tenantId: "co1" },
    });
  });

  it("carries the error's class and never its message", () => {
    const a = deadLetterAlert(
      "email.send",
      "job-2",
      { ...failure, data: { to: "x@y.z" } },
      new Error("550 rejected alice@example.com: mailbox full"),
    );
    expect(JSON.stringify(a)).not.toContain("alice@example.com");
    expect(JSON.stringify(a)).not.toContain("mailbox full");
    expect(a.companyId).toBeUndefined();
  });

  it("copes with a payload that failed validation and is not an object at all", () => {
    expect(deadLetterAlert("email.send", "j", { ...failure, data: null }, "boom").companyId).toBeUndefined();
    expect(deadLetterAlert("email.send", "j", { ...failure, data: "x" }, undefined).context).toMatchObject({
      reason: "Error",
    });
  });
});
