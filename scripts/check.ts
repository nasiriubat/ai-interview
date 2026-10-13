/**
 * `pnpm check`: the quality gate (AGENTS.md rule 7, plan 5.1 to 5.3).
 *
 *   pnpm check            everything, against the database in DATABASE_URL; nothing may be skipped
 *   pnpm check --no-db    everything except the database-backed suites, with a banner saying so
 *
 * Cheapest first, so a formatting slip fails in seconds and not after a full build.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { conclude, countSkipped, parseArgs, preflight } from "./check-lib.js";

const args = parseArgs(process.argv.slice(2));
const pre = preflight(process.env, args);
if (!pre.ok) {
  console.error(`\n${pre.message}\n`);
  process.exit(1);
}

const env: NodeJS.ProcessEnv = { ...process.env };
if (args.noDb) {
  // Explicit, not accidental: the suites read this to turn "needs a database" into a visible skip,
  // and the URL is removed so --no-db means no database even on a machine that has one set.
  env.AIDP_ALLOW_SKIP_DB = "1";
  delete env.DATABASE_URL;
} else {
  // A stray allowance in the shell must never turn a gated run into a quiet one.
  delete env.AIDP_ALLOW_SKIP_DB;
}

function run(label: string, command: string[], capture = false): Promise<{ code: number; output: string }> {
  console.log(`\n> ${label}`);
  return new Promise((resolve) => {
    const [bin, ...rest] = command;
    const child = spawn(bin as string, rest, { env, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    const forward = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      stream.write(chunk);
      if (capture) output += chunk.toString();
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });
}

const steps: [string, string[]][] = [
  ["format:check", ["pnpm", "format:check"]],
  ["build", ["pnpm", "-r", "build"]],
  ["typecheck", ["pnpm", "-r", "typecheck"]],
  ["lint", ["pnpm", "lint"]],
];
for (const [label, command] of steps) {
  const { code } = await run(label, command);
  if (code !== 0) {
    console.error(`\nFAILED at "${label}".`);
    process.exit(code);
  }
}

const tests = await run("test", ["pnpm", "-r", "test"], true);
const outcome = conclude({
  noDb: args.noDb,
  testsPassed: tests.code === 0,
  skipped: countSkipped(tests.output),
});
for (const line of outcome.lines) console.log(line);
writeFileSync(
  new URL("../.check-state.json", import.meta.url),
  `${JSON.stringify({ ...outcome.state, at: new Date().toISOString() }, null, 2)}\n`,
);
process.exit(outcome.exitCode);
