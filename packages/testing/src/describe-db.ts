import { describe } from "vitest";

export type DbMode = "run" | "skip" | "fail";

/**
 * What a database-backed suite should do in this environment.
 *
 * - `DATABASE_URL` set: run.
 * - Not set, and `AIDP_ALLOW_SKIP_DB=1` (which `pnpm check --no-db` sets): skip, visibly.
 * - Not set and no explicit permission: fail. A misconfigured CI job must go red, not green with
 *   a hundred tests quietly absent, which is exactly what `describe.skipIf(!DATABASE_URL)` did.
 */
export function dbMode(env: Record<string, string | undefined> = process.env): DbMode {
  if (env.DATABASE_URL) return "run";
  return env.AIDP_ALLOW_SKIP_DB === "1" ? "skip" : "fail";
}

/**
 * `describe` for suites that need a migrated Postgres. Use this instead of
 * `process.env.DATABASE_URL ? describe : describe.skip` so a skip is always an explicit choice.
 */
export function describeDb(name: string, fn: () => void): void {
  switch (dbMode()) {
    case "run":
      describe(name, fn);
      return;
    case "skip":
      describe.skip(`${name} [skipped: no DATABASE_URL, --no-db]`, fn);
      return;
    case "fail":
      throw new Error(
        `Database suite "${name}" needs DATABASE_URL, and it is not set. ` +
          `Point it at a migrated Postgres with pgvector ("pnpm db:up" or see docs/RUNNING.md), ` +
          `or run "pnpm check --no-db" to skip these suites deliberately.`,
      );
  }
}
