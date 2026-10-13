import { describe, expect, it } from "vitest";
import { conclude, countSkipped, parseArgs, preflight } from "../../../scripts/check-lib.js";
import { dbMode } from "../src/describe-db.js";

describe("pnpm check preflight", () => {
  it("fails immediately, with the way out, when DATABASE_URL is missing and --no-db was not passed", () => {
    const r = preflight({}, parseArgs([]));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("DATABASE_URL is not set");
      expect(r.message).toContain("pnpm db:up");
      expect(r.message).toContain("--no-db");
    }
  });

  it("passes with a database, or with --no-db", () => {
    expect(preflight({ DATABASE_URL: "postgresql://x" }, parseArgs([])).ok).toBe(true);
    expect(preflight({}, parseArgs(["--no-db"])).ok).toBe(true);
  });

  it("refuses a flag it does not know rather than ignoring a typo", () => {
    expect(preflight({ DATABASE_URL: "postgresql://x" }, parseArgs(["--no-dB"])).ok).toBe(false);
  });
});

describe("skipped-test accounting", () => {
  const output = [
    "packages/core test:  Test Files  14 passed (14)",
    "packages/core test:       Tests  91 passed (91)",
    "apps/api test:       Tests  1 failed | 50 passed | 12 skipped (63)",
    "packages/db test:       Tests  \u001b[32m9 passed\u001b[39m | 3 skipped | 2 todo (14)",
    "packages/ai test: ✓ test/skipped-words.test.ts (4 tests) 2ms",
  ].join("\n");

  it("sums skipped and todo from every package's summary line and nothing else", () => {
    expect(countSkipped(output)).toBe(12 + 3 + 2);
  });

  it("is zero when nothing was skipped", () => {
    expect(countSkipped("apps/web test:       Tests  168 passed (168)")).toBe(0);
  });
});

describe("pnpm check outcome", () => {
  it("passes a full run with nothing skipped", () => {
    expect(conclude({ noDb: false, testsPassed: true, skipped: 0 })).toMatchObject({
      exitCode: 0,
      state: { db: true, skipped: 0 },
    });
  });

  it("fails a run with a database where tests were skipped anyway", () => {
    const r = conclude({ noDb: false, testsPassed: true, skipped: 4 });

    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("4 tests were skipped");
  });

  it("with --no-db exits 0 but prints the banner and records that the database did not run", () => {
    const r = conclude({ noDb: true, testsPassed: true, skipped: 177 });

    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain(
      "SKIPPED: 177 db tests (--no-db). This result does not satisfy the quality gate.",
    );
    expect(r.state).toEqual({ db: false, skipped: 177 });
  });

  it("fails on a failing test whatever the flags", () => {
    expect(conclude({ noDb: true, testsPassed: false, skipped: 0 }).exitCode).toBe(1);
    expect(conclude({ noDb: false, testsPassed: false, skipped: 0 }).exitCode).toBe(1);
  });
});

describe("describeDb mode", () => {
  it("runs with a database, skips only when explicitly allowed, and otherwise fails", () => {
    expect(dbMode({ DATABASE_URL: "postgresql://x" })).toBe("run");
    expect(dbMode({ AIDP_ALLOW_SKIP_DB: "1" })).toBe("skip");
    expect(dbMode({})).toBe("fail");
    // The allowance is a literal "1", not any truthy value.
    expect(dbMode({ AIDP_ALLOW_SKIP_DB: "true" })).toBe("fail");
  });
});
