/**
 * The decisions behind `pnpm check`, kept apart from the process spawning so they can be tested.
 *
 * The gate used to be an inline script that ran every suite and passed. Integration suites
 * guarded themselves with `process.env.DATABASE_URL ? describe : describe.skip`, so a machine with
 * no database reported a green check with 125 tests never run, and nothing on the screen said so.
 * The gate now has three outcomes and each is loud:
 *
 * - everything ran and passed: exit 0;
 * - something failed, or the database was needed and missing, or tests were skipped with a
 *   database present: exit 1;
 * - `--no-db` was passed deliberately: the rest runs, a banner states how many tests did not, and
 *   the exit is 0 because the user asked, but the banner says it is not the quality gate.
 */

export interface CheckArgs {
  noDb: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): CheckArgs {
  const unknown: string[] = [];
  let noDb = false;
  for (const a of argv) {
    if (a === "--no-db") noDb = true;
    else unknown.push(a);
  }
  return { noDb, unknown };
}

export type Preflight = { ok: true } | { ok: false; message: string };

/** Fails before any work is done, so a missing database costs seconds and not a full build. */
export function preflight(env: Record<string, string | undefined>, args: CheckArgs): Preflight {
  if (args.unknown.length > 0)
    return { ok: false, message: `Unknown argument: ${args.unknown.join(" ")}. The only flag is --no-db.` };
  if (!args.noDb && !env.DATABASE_URL)
    return {
      ok: false,
      message:
        'DATABASE_URL is not set. Run "pnpm db:up" and export the URL it prints, or pass --no-db to run ' +
        "without the database-backed tests (the result then does not satisfy the quality gate).",
    };
  return { ok: true };
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Sums skipped and todo tests from Vitest's summary lines, e.g.
 * `packages/core test:       Tests  91 passed | 5 skipped (96)`.
 */
export function countSkipped(output: string): number {
  let total = 0;
  for (const line of output.replace(ANSI, "").split("\n")) {
    if (!/\bTests\s+/.test(line)) continue;
    for (const m of line.matchAll(/(\d+) (?:skipped|todo)\b/g)) total += Number(m[1]);
  }
  return total;
}

export interface CheckOutcome {
  exitCode: number;
  lines: string[];
  state: { db: boolean; skipped: number };
}

/** What to say and exit with, given how the test step went. */
export function conclude(input: { noDb: boolean; testsPassed: boolean; skipped: number }): CheckOutcome {
  const { noDb, testsPassed, skipped } = input;
  if (!testsPassed)
    return { exitCode: 1, lines: ["FAILED: see the step above."], state: { db: !noDb, skipped } };
  if (noDb)
    return {
      exitCode: 0,
      lines: [
        "",
        "============================================================",
        `SKIPPED: ${skipped} db tests (--no-db). This result does not satisfy the quality gate.`,
        'Run "pnpm db:up", export DATABASE_URL, and run "pnpm check" before you push.',
        "============================================================",
      ],
      state: { db: false, skipped },
    };
  if (skipped > 0)
    return {
      exitCode: 1,
      lines: [
        `FAILED: ${skipped} tests were skipped with a database present. The gate allows none:`,
        "a skipped test is a test that did not prove anything.",
      ],
      state: { db: true, skipped },
    };
  return {
    exitCode: 0,
    lines: ["pnpm check: everything ran, nothing was skipped."],
    state: { db: true, skipped: 0 },
  };
}
