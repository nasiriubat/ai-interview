/**
 * A local AIScope instance for the bench: its own database on the development Postgres container,
 * migrated and bootstrapped with only the OpenRouter key (so the routes are the production
 * defaults: interviews and extraction on Claude Sonnet, clustering and the report on Claude Opus,
 * all through OpenRouter), then the built API and worker as child processes.
 *
 * Unlike live-run it keeps the database between runs unless `fresh` is set: re-analysing the same
 * interviews after a code change is the before/after comparison. The per-run secrets (encryption
 * key for the provider key in that database, the auth secret) live in `runs/<name>/stack.json`,
 * which is git-ignored and readable only by the owner.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client, mintStaffToken } from "./client.js";
import { listPrices, log, redact, registerSecret, REPO_ROOT, sleep } from "./openrouter.js";

const run = promisify(execFile);

export const BENCH_ADMIN_EMAIL = "bench-admin@example.test";
const OPERATOR_EMAIL = "bench-operator@example.test";

export interface LocalStack {
  baseUrl: string;
  authSecret: string;
  adminEmail: string;
  stop: () => Promise<void>;
}

interface StackSecrets {
  encryptionKey: string;
  authSecret: string;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // A minimal environment: no provider key from the developer's shell reaches the children, so the
  // bootstrap cannot pick a direct Anthropic or OpenAI route over OpenRouter.
  const base: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "TERM"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...extra };
}

async function runLogged(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<void> {
  const stream = createWriteStream(logFile, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const sink = (chunk: Buffer): void => void stream.write(redact(chunk.toString()));
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", reject);
    child.on("close", (code) => {
      stream.end();
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}; see ${logFile}`));
    });
  });
}

export async function startLocalStack(opts: {
  runDir: string;
  dbName: string;
  port: number;
  pgContainer: string;
  openRouterKey: string;
  fresh: boolean;
  /**
   * The platform embedding route to set, as production has it (an OpenRouter embedding model), or
   * null for none (clustering then falls back to word overlap).
   */
  embeddingModel: string | null;
}): Promise<LocalStack> {
  const secretsFile = join(opts.runDir, "stack.json");
  const psql = (sql: string): Promise<{ stdout: string }> =>
    run("docker", [
      "exec",
      opts.pgContainer,
      "psql",
      "-U",
      "app",
      "-d",
      "postgres",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ]);
  const exists =
    (await psql(`SELECT 1 FROM pg_database WHERE datname='${opts.dbName}'`)).stdout.trim() === "1";
  let secrets: StackSecrets | null =
    exists && !opts.fresh && existsSync(secretsFile)
      ? (JSON.parse(readFileSync(secretsFile, "utf8")) as StackSecrets)
      : null;
  if (!secrets) {
    log(`creating database ${opts.dbName}`);
    await psql(`DROP DATABASE IF EXISTS ${opts.dbName} WITH (FORCE)`);
    await psql(`CREATE DATABASE ${opts.dbName}`);
    secrets = {
      encryptionKey: randomBytes(32).toString("base64"),
      authSecret: randomBytes(32).toString("base64"),
    };
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  } else {
    log(`reusing database ${opts.dbName}`);
  }
  registerSecret(secrets.encryptionKey);
  registerSecret(secrets.authSecret);
  const databaseUrl = `postgresql://app:app@localhost:5432/${opts.dbName}`;
  const logs = {
    setup: join(opts.runDir, "setup.log"),
    api: join(opts.runDir, "api.log"),
    worker: join(opts.runDir, "worker.log"),
  };

  log("migrating and bootstrapping (idempotent)");
  await runLogged(
    "pnpm",
    ["--filter", "@aidp/db", "exec", "prisma", "migrate", "deploy"],
    childEnv({ DATABASE_URL: databaseUrl }),
    logs.setup,
  );
  await runLogged(
    "pnpm",
    ["--filter", "@aidp/db", "bootstrap"],
    childEnv({
      DATABASE_URL: databaseUrl,
      PLATFORM_ENCRYPTION_KEY: secrets.encryptionKey,
      BOOTSTRAP_OPERATOR_EMAIL: OPERATOR_EMAIL,
      BOOTSTRAP_ADMIN_EMAIL: BENCH_ADMIN_EMAIL,
      BOOTSTRAP_TENANT_NAME: "Report bench tenant",
      OPENROUTER_API_KEY: opts.openRouterKey,
      // Empty on purpose: with-env.mjs fills unset keys from a root .env, and a direct Anthropic
      // key there would win the default routes over OpenRouter.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
    }),
    logs.setup,
  );

  const shared = {
    DATABASE_URL: databaseUrl,
    PLATFORM_ENCRYPTION_KEY: secrets.encryptionKey,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
  };
  const pipe = (child: ChildProcess, file: string): void => {
    const stream = createWriteStream(file, { flags: "a" });
    const sink = (chunk: Buffer): void => void stream.write(redact(chunk.toString()));
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
  };
  log(`starting the built API on :${opts.port} and the worker`);
  const api = spawn("node", ["apps/api/dist/server.js"], {
    cwd: REPO_ROOT,
    env: childEnv({ ...shared, AUTH_SECRET: secrets.authSecret, PORT: String(opts.port), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipe(api, logs.api);
  const worker = spawn("node", ["apps/worker/dist/main.js"], {
    cwd: REPO_ROOT,
    env: childEnv({ ...shared, WORKER_CONCURRENCY: "4" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipe(worker, logs.worker);
  const stop = async (): Promise<void> => {
    for (const c of [api, worker]) c.kill("SIGTERM");
    await sleep(1500);
    for (const c of [api, worker]) if (c.exitCode === null) c.kill("SIGKILL");
  };
  const baseUrl = `http://127.0.0.1:${opts.port}/api/v1`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || api.exitCode !== null) {
      await stop();
      throw new Error(`API did not become ready; see ${logs.api}`);
    }
    await sleep(1000);
  }
  try {
    await routeEmbeddings(baseUrl, secrets.authSecret, opts.embeddingModel);
  } catch (e) {
    await stop();
    throw e;
  }
  return { baseUrl, authSecret: secrets.authSecret, adminEmail: BENCH_ADMIN_EMAIL, stop };
}

/** What text-embedding-3-small costs when OpenRouter's chat model list does not carry it. */
const EMBEDDING_PRICE_FALLBACK = 0.02;

/**
 * Sets (or clears) the platform `embedding` route the supported way, as the operator does on the
 * model-assignment page: through the operator API, with the model's price so the ledger is right.
 * Idempotent: a route that already says the same thing is left alone.
 */
async function routeEmbeddings(baseUrl: string, authSecret: string, model: string | null): Promise<void> {
  const operator = new Client(baseUrl, await mintStaffToken(OPERATOR_EMAIL, authSecret));
  const { routes } = await operator.ok<{ routes: { purpose: string; model?: string | null }[] }>(
    "GET",
    "/operator/routes",
  );
  const current = routes.find((r) => r.purpose === "embedding")?.model ?? null;
  if (current === model) {
    log(`embedding route: ${model ?? "none"} (unchanged)`);
    return;
  }
  if (model === null) {
    await operator.ok("PUT", "/operator/routes", { routes: [{ purpose: "embedding", providerId: null }] });
    log("embedding route cleared: clustering uses word overlap");
    return;
  }
  const { providers } = await operator.ok<{ providers: { id: string; kind: string }[] }>(
    "GET",
    "/operator/providers",
  );
  const openrouter = providers.find((p) => p.kind === "openrouter");
  if (!openrouter) throw new Error("no platform OpenRouter provider to route embeddings to");
  const listed = await listPrices().catch(() => new Map<string, { inputPerMtok: number }>());
  const inputPerMtok = listed.get(model)?.inputPerMtok ?? EMBEDDING_PRICE_FALLBACK;
  await operator.ok("PUT", `/operator/providers/${openrouter.id}/prices`, {
    prices: [{ model, inputPerMtok, outputPerMtok: 0 }],
  });
  await operator.ok("PUT", "/operator/routes", {
    routes: [{ purpose: "embedding", providerId: openrouter.id, model, maxOutputTokens: 0 }],
  });
  log(`embedding route set: ${model} via OpenRouter ($${inputPerMtok}/Mtok)`);
}
