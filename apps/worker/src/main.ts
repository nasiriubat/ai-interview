import {
  BossJobs,
  CallerFactory,
  createStorage,
  Crypto,
  EgressGuard,
  egressConfigFromEnv,
  MemoryEmail,
  SettingsEmail,
  SettingsService,
  storageKind,
  TenantGate,
  type JobName,
} from "@aidp/core";
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { loadConfig } from "./config.js";
import { handlers } from "./handlers.js";
import { registerSchedules } from "./schedules.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Same redaction as the API: a connection string or key must not reach the log aggregator.
  const log = pino({
    level: config.LOG_LEVEL,
    redact: ["*.apiKey", "*.password", "*.smtpUrl", "*.apiKeyEnc"],
  });
  // Every query goes through the tenant scope: it pairs the statement with the Postgres setting
  // the row-level security policies read. The cast keeps the familiar PrismaClient shape at the
  // ~166 call sites; the extension only adds behaviour (packages/db/src/tenancy.ts).
  const db = withTenantScope(new PrismaClient()) as unknown as PrismaClient;
  const crypto = new Crypto(config.PLATFORM_ENCRYPTION_KEY);
  const settings = new SettingsService(db, crypto, {
    warn: (message, meta) => {
      log.warn(meta ?? {}, message);
    },
  });
  const tenants = new TenantGate(db);
  const egress = new EgressGuard(
    egressConfigFromEnv({
      mode: config.EGRESS_MODE,
      allowHosts: config.EGRESS_ALLOW_HOSTS,
      nodeEnv: config.NODE_ENV,
    }),
  );
  const callers = new CallerFactory({
    db,
    crypto,
    settings,
    egress,
    onBudgetWarning: (ctx, warnings) => {
      log.warn({ companyId: ctx.companyId, warnings }, "budget warning");
    },
  });
  // Identical resolution to the API, so a message sent from a job looks like one sent from a request.
  const email = new SettingsEmail({
    settings,
    env: { smtpUrl: config.EMAIL_SMTP_URL, from: config.EMAIL_FROM },
    fallback: new MemoryEmail((m) => {
      log.info({ to: m.to, subject: m.subject }, "email (console)");
    }),
    gate: tenants,
    egress,
  });
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
  });
  await jobs.start();

  const storage = createStorage(config.UPLOAD_DIR);
  log.info({ storage: storageKind(storage) }, "upload store");

  const h = handlers({
    db,
    callers,
    settings,
    email,
    jobs,
    crypto,
    storage,
    tenants,
    publicWebUrl: config.PUBLIC_WEB_URL,
    log: {
      info: (m, meta) => {
        log.info(meta ?? {}, m);
      },
      warn: (m, meta) => {
        log.warn(meta ?? {}, m);
      },
    },
  });
  const failed = (name: string) => (jobId: string, err: unknown) => {
    log.error({ err, job: name, jobId }, "job failed");
  };

  /**
   * How many of each job may run at once.
   *
   * The default is the configured concurrency. The ones listed here are capped at one because they
   * are long, expensive, or sweep every tenant, and two of them racing is worse than one of them
   * waiting.
   */
  const CONCURRENCY: Partial<Record<JobName, number>> = {
    "privacy.delete-session": 1,
    "privacy.retention-sweep": 1,
    "auth.prune-verification-tokens": 1,
    "analysis.run": 1,
    "spec.generate": 1,
    "attachment.ingest": 1,
  };

  /**
   * Every handler gets a consumer, derived from the handler map rather than listed here.
   *
   * It used to be one `consume` call per job, written out by hand, and phase 4 walked straight
   * into what that costs: `attachment.ingest` was defined, published and queued, its handler was
   * implemented, TypeScript was satisfied — and nothing consumed it, so uploads sat at `pending`
   * forever with no error anywhere. The `Handlers` type makes a missing handler a compile error;
   * nothing made a missing consumer anything at all. Now the loop cannot miss one.
   *
   * A job carries its tenant in the payload, so it runs fenced in exactly like a request does.
   * A job without one sweeps every tenant and runs as system (packages/db/src/tenancy.ts).
   */
  for (const name of Object.keys(h) as JobName[]) {
    await jobs.consume(
      name,
      h[name] as (payload: unknown) => Promise<void>,
      CONCURRENCY[name] ?? config.WORKER_CONCURRENCY,
      failed(name),
    );
  }
  log.info({ jobs: Object.keys(h).length }, "job consumers registered");

  // Timers last: the queues they feed are already consuming.
  await registerSchedules(jobs, {
    info: (m, meta) => {
      log.info(meta ?? {}, m);
    },
  });
  log.info("worker started");

  const shutdown = async (): Promise<void> => {
    await jobs.stop();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
