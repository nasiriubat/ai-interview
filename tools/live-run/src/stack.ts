import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  API_BASE,
  API_PORT,
  DB_NAME,
  ensureDir,
  log,
  PG_CONTAINER,
  redact,
  registerSecret,
  REPO_ROOT,
  SCRATCH_DIR,
  sleep,
} from "./runtime.js";

const run = promisify(execFile);

export const OPERATOR_EMAIL = "live-operator@example.test";
export const ADMIN_EMAIL = "live-admin@example.test";

export interface Stack {
  authSecret: string;
  databaseUrl: string;
  api: ChildProcess;
  worker: ChildProcess;
  logs: { api: string; worker: string; bootstrap: string };
  stop: () => Promise<void>;
}

function psql(sql: string): Promise<{ stdout: string; stderr: string }> {
  return run("docker", [
    "exec",
    PG_CONTAINER,
    "psql",
    "-U",
    "app",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

/** Drops and recreates the live database, so every run starts from nothing. */
async function recreateDatabase(): Promise<void> {
  await psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await psql(`CREATE DATABASE ${DB_NAME}`);
  // pgvector is created by the migrations; nothing else to do here.
}

async function runLogged(
  label: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<void> {
  const stream = createWriteStream(logFile, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const sink = (chunk: Buffer): void => {
      stream.write(redact(chunk.toString()));
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", reject);
    child.on("close", (code) => {
      stream.end();
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code}; see ${logFile}`));
    });
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  // A minimal environment: no inherited provider keys reach the API or the worker.
  const base: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "TERM"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...extra };
}

function pipeTo(child: ChildProcess, file: string): WriteStream {
  const stream = createWriteStream(file, { flags: "a" });
  const sink = (chunk: Buffer): void => {
    stream.write(redact(chunk.toString()));
  };
  child.stdout?.on("data", sink);
  child.stderr?.on("data", sink);
  return stream;
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/health/ready`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(1000);
  }
  throw new Error("API did not become ready within 90 s");
}

/** Read-only SQL against the live database, returning pipe-separated rows. Never writes. */
async function queryRows(sql: string): Promise<string[][]> {
  const out = await run("docker", [
    "exec",
    PG_CONTAINER,
    "psql",
    "-U",
    "app",
    "-d",
    DB_NAME,
    "-t",
    "-A",
    "-F",
    "|",
    "-c",
    sql,
  ]);
  return out.stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split("|"));
}

export interface DbIntegrity {
  /** One row per interview session: stored turn counter against the transcript it should describe. */
  sessions: {
    sessionId: string;
    status: string;
    turnCount: number;
    assistantMessages: number;
    lastExtractedSeq: number;
    maxSeq: number;
    factsInState: number;
    factRows: number;
  }[];
  /** Queue rows: how many jobs ended in each state and how often pg-boss retried them. */
  jobs: { name: string; state: string; jobs: number; maxRetries: number }[];
  llmByPurpose: {
    purpose: string;
    status: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
  }[];
}

/**
 * Cross-checks what the API cannot show: whether session state agrees with the transcript and
 * with the fact rows the analysis reads, and how many model calls failed and what they booked.
 */
export async function dbIntegrity(): Promise<DbIntegrity> {
  const sessions = await queryRows(
    `select s.id, s.status, coalesce((s.state->>'turnCount')::int,0),
       (select count(*) from "Message" m where m."sessionId"=s.id and m.role='assistant'),
       coalesce((s.state->>'lastExtractedSeq')::int,0),
       coalesce((select max(seq) from "Message" m where m."sessionId"=s.id),0),
       coalesce(jsonb_array_length(s.state->'facts'),0),
       (select count(*) from "Fact" f where f."sessionId"=s.id)
     from "Session" s where s.status <> 'deleted' order by s."createdAt"`,
  );
  const calls = await queryRows(
    `select purpose, status, count(*), coalesce(sum("inputTokens"),0), coalesce(sum("outputTokens"),0),
       round(coalesce(sum("costCents"),0)::numeric, 3)
     from "LlmCall" group by 1,2 order by 1,2`,
  );
  const jobs = await queryRows(
    `select name, state, count(*), max(retry_count) from pgboss.job group by 1,2 order by 1,2`,
  ).catch(() => []);
  const n = (v: string | undefined): number => Number(v ?? 0);
  return {
    jobs: jobs.map((r) => ({
      name: r[0] ?? "",
      state: r[1] ?? "",
      jobs: n(r[2]),
      maxRetries: n(r[3]),
    })),
    sessions: sessions.map((r) => ({
      sessionId: r[0] ?? "",
      status: r[1] ?? "",
      turnCount: n(r[2]),
      assistantMessages: n(r[3]),
      lastExtractedSeq: n(r[4]),
      maxSeq: n(r[5]),
      factsInState: n(r[6]),
      factRows: n(r[7]),
    })),
    llmByPurpose: calls.map((r) => ({
      purpose: r[0] ?? "",
      status: r[1] ?? "",
      calls: n(r[2]),
      inputTokens: n(r[3]),
      outputTokens: n(r[4]),
      costCents: n(r[5]),
    })),
  };
}

export async function startStack(openRouterKey: string): Promise<Stack> {
  ensureDir(SCRATCH_DIR);
  const logs = {
    api: join(SCRATCH_DIR, "api.log"),
    worker: join(SCRATCH_DIR, "worker.log"),
    bootstrap: join(SCRATCH_DIR, "bootstrap.log"),
  };
  for (const file of Object.values(logs)) writeFileSync(file, "");
  // Generated per run and never written anywhere: provider keys in this throwaway database are
  // encrypted with a key that exists only in the memory of this process and its children.
  const encryptionKey = randomBytes(32).toString("base64");
  const authSecret = randomBytes(32).toString("base64");
  registerSecret(encryptionKey);
  registerSecret(authSecret);
  const databaseUrl = `postgresql://app:app@localhost:5432/${DB_NAME}`;

  log(`recreating database ${DB_NAME}`);
  await recreateDatabase();

  log("running migrations");
  await runLogged(
    "migrate",
    "pnpm",
    ["--filter", "@aidp/db", "exec", "prisma", "migrate", "deploy"],
    childEnv({ DATABASE_URL: databaseUrl }),
    logs.bootstrap,
  );

  log("bootstrapping operator, tenant, OpenRouter provider and templates");
  // Only the OpenRouter key is passed: an Anthropic or OpenAI key in the developer's environment
  // would win the default routes, and this run is about the OpenRouter path.
  await runLogged(
    "bootstrap",
    "pnpm",
    ["--filter", "@aidp/db", "bootstrap"],
    childEnv({
      DATABASE_URL: databaseUrl,
      PLATFORM_ENCRYPTION_KEY: encryptionKey,
      BOOTSTRAP_OPERATOR_EMAIL: OPERATOR_EMAIL,
      BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
      BOOTSTRAP_TENANT_NAME: process.env.LIVE_TENANT_NAME ?? "Live run tenant",
      OPENROUTER_API_KEY: openRouterKey,
    }),
    logs.bootstrap,
  );

  const shared = {
    DATABASE_URL: databaseUrl,
    PLATFORM_ENCRYPTION_KEY: encryptionKey,
    LOG_LEVEL: "info",
    // "test" keeps the API on JSON log lines (development switches to pretty printing).
    NODE_ENV: "test",
  };
  log(`starting API on :${API_PORT} and the worker`);
  const api = spawn("node", ["apps/api/dist/server.js"], {
    cwd: REPO_ROOT,
    env: childEnv({
      ...shared,
      AUTH_SECRET: authSecret,
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      // Where people open the web app, so a campaign's shareable link points at it. Set LIVE_WEB_URL
      // when the web app is not on the default port (the browser demo runs it on 3200).
      ...(process.env.LIVE_WEB_URL
        ? { PUBLIC_WEB_URL: process.env.LIVE_WEB_URL, WEB_ORIGIN: process.env.LIVE_WEB_URL }
        : {}),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const apiStream = pipeTo(api, logs.api);
  const worker = spawn("node", ["apps/worker/dist/main.js"], {
    cwd: REPO_ROOT,
    env: childEnv({ ...shared, WORKER_CONCURRENCY: "4" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const workerStream = pipeTo(worker, logs.worker);

  const stop = async (): Promise<void> => {
    for (const child of [api, worker]) child.kill("SIGTERM");
    await sleep(1500);
    for (const child of [api, worker]) if (child.exitCode === null) child.kill("SIGKILL");
    apiStream.end();
    workerStream.end();
  };
  try {
    await waitReady();
  } catch (err) {
    await stop();
    throw err;
  }
  return { authSecret, databaseUrl, api, worker, logs, stop };
}
