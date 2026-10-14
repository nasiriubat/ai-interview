#!/usr/bin/env node
// Runs a command with the repository's root `.env` loaded, for development outside Docker:
//
//   node scripts/with-env.mjs tsx watch src/server.ts
//
// Tests, `pnpm check` and production never call this. A value already in the environment wins
// over the file, so `DATABASE_URL=... pnpm ...` still overrides. The legacy apps/api/.env is read
// underneath the root file so an install that has not migrated keeps working;
// scripts/migrate-env.mjs moves it. Values are never printed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { LEGACY_ENV, loadMerged } from "./env-files.mjs";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: with-env.mjs <command> [args...]");
  process.exit(2);
}
if (existsSync(LEGACY_ENV)) {
  console.error(
    "with-env: apps/api/.env is legacy and still read; run `pnpm env:migrate` to move it into .env",
  );
}
const child = spawn(cmd, args, { stdio: "inherit", env: { ...loadMerged(), ...process.env } });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (e) => {
  console.error(`with-env: cannot run ${cmd}: ${e.message}`);
  process.exit(127);
});
