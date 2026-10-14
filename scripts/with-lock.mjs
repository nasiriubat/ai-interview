#!/usr/bin/env node
// Runs a command while holding a named lock, so two package builds that need the same step never
// run it at once.
//
//   node scripts/with-lock.mjs <name> -- <command> [args...]
//
// `@aidp/db` and `@aidp/core` depend on each other (the seeds import core; core imports the
// client), so `pnpm -r build` cannot order them and used to start both together on a cold tree:
// core compiled before the Prisma client was generated. `@aidp/db`'s build and `@aidp/core`'s
// prebuild both run the database build through this script, so whichever gets there first builds
// it, the other waits and then builds it again (a few seconds), and core never compiles against a
// half-built `@aidp/db`.
//
// The lock is a directory (mkdir is atomic). A lock older than ten minutes belongs to a build that
// was killed and is taken over.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [name, sep, ...command] = process.argv.slice(2);
if (!name || sep !== "--" || command.length === 0) {
  console.error("usage: with-lock.mjs <name> -- <command> [args...]");
  process.exit(2);
}

const lock = join(tmpdir(), `aidp-build-lock-${name}`);
const STALE_MS = 10 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released between the two calls: try again.
      }
      await sleep(200);
    }
  }
}

await acquire();
const release = () => rmSync(lock, { recursive: true, force: true });
process.on("SIGINT", () => {
  release();
  process.exit(130);
});
process.on("SIGTERM", () => {
  release();
  process.exit(143);
});

const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: false });
child.on("exit", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (err) => {
  release();
  console.error(err.message);
  process.exit(1);
});
