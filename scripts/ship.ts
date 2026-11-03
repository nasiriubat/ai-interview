/**
 * `pnpm ship`: the only way a commit reaches the server (D-493).
 *
 *   pnpm ship              gate, browser suite, dependency audit; then push main and verified/<sha>
 *   pnpm ship --no-push    the same checks, and a local verified/<sha> tag, but nothing is pushed
 *
 * The server's autodeploy deploys a commit only when `verified/<sha>` exists for it, so what was
 * tested is exactly what runs. Every step must pass; there is no flag to skip one. The emergency
 * way around this lives on the server (`deploy/autodeploy.sh --allow-unverified`) and raises an
 * alert, so it is never the quiet path.
 *
 * Why these three: `pnpm check` (format, build, types, lint, the unit and database suites) is the
 * gate. The browser suite is not in it, because it needs Chromium and a production build, and it
 * stayed broken for three weeks unnoticed (D-489). The audit fails on a high or critical advisory
 * in a production dependency, with expiring exceptions in .github/security/audit-ignore.json (D-85);
 * the live site once ran a release with two critical advisories (D-487).
 */
import { execFileSync, spawn } from "node:child_process";

const argv = new Set(process.argv.slice(2));
const push = !argv.has("--no-push");
const branch = process.env.AIDP_DEPLOY_BRANCH ?? "main";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function step(label: string, command: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  console.log(`\n=== ship: ${label}`);
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = command;
    const child = spawn(bin as string, rest, { env, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${String(code)})`));
    });
  });
}

function refuse(message: string): never {
  console.error(`\nship: ${message}\n`);
  process.exit(1);
}

// What is verified has to be what is pushed: no uncommitted change to a tracked file may ride along
// unchecked, and none may be checked without being pushed. Untracked files are not part of a commit.
if (git("status", "--porcelain", "--untracked-files=no") !== "")
  refuse("commit or stash your changes first: the checks run on the commit, and it must be clean.");
if (!process.env.DATABASE_URL)
  refuse("DATABASE_URL is not set: the gate needs a migrated Postgres (pnpm db:up). Nothing was run.");

const sha = git("rev-parse", "HEAD");
const short = sha.slice(0, 12);
const started = Date.now();

try {
  await step("quality gate (pnpm check)", ["pnpm", "check"]);
  // CI=1: Playwright starts its own fake API and production server instead of reusing whatever is
  // listening on its ports, so a stale build or a fake API full of earlier test state cannot pass
  // in place of this commit. It refuses to start if the ports are taken.
  await step("browser suite (Playwright + axe)", ["pnpm", "--filter", "@aidp/web", "e2e"], {
    ...process.env,
    CI: "1",
  });
  await step("dependency audit", ["node", "scripts/audit-gate.mjs"]);
} catch (err) {
  refuse(`${err instanceof Error ? err.message : String(err)}. Nothing was tagged or pushed.`);
}

if (git("rev-parse", "HEAD") !== sha) refuse("HEAD moved while the checks ran; run ship again.");

const minutes = Math.round((Date.now() - started) / 60_000);
const tag = `verified/${sha}`;
git(
  "tag",
  "--force",
  "--annotate",
  tag,
  sha,
  "--message",
  `Verified by pnpm ship: quality gate, browser suite and dependency audit passed (${String(minutes)} min).`,
);
console.log(`\nship: ${short} verified (${tag}).`);

if (!push) {
  console.log("ship: --no-push: nothing was pushed.");
  process.exit(0);
}

// The tag goes first: the server polls the branch every minute, and a branch that moved before its
// tag existed would be reported as an unverified push.
await step("push the verification tag", ["git", "push", "origin", `refs/tags/${tag}`]);
await step(`push ${branch}`, ["git", "push", "origin", `HEAD:${branch}`]);
console.log(
  `\nship: ${short} pushed to ${branch}; the server deploys it within a minute (journalctl -u aidp-autodeploy).`,
);
