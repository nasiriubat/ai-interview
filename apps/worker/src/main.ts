import {
  AlertRouter,
  BossJobs,
  CallerFactory,
  createStorage,
  Crypto,
  HealthSweep,
  MemoryEmail,
  PgBossJobAdmin,
  PrismaAlertState,
  PrismaHealthInputs,
  SettingsEmail,
  SettingsService,
  storageKind,
  type JobFailure,
  type JobName,
} from "@aidp/core";
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { deadLetterAlert } from "./alerts.js";
import { loadConfig } from "./config.js";
import { handlers } from "./handlers.js";
import { Heartbeat } from "./heartbeat.js";
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
  // Identical resolution to the API, so a message sent from a job looks like one sent from a request.
  const email = new SettingsEmail({
    settings,
    env: { smtpUrl: config.EMAIL_SMTP_URL, from: config.EMAIL_FROM },
    fallback: new MemoryEmail((m) => {
      log.info({ to: m.to, subject: m.subject }, "email (console)");
    }),
  });
  // The same router the API builds: the dedupe state is the table, so a condition both processes
  // see (an exhausted budget) is one notification (D-90).
  const alerts = new AlertRouter({
    db,
    state: new PrismaAlertState(db),
    settings,
    email,
    publicWebUrl: config.PUBLIC_WEB_URL,
    env: {
      alertEmail: config.ALERT_EMAIL,
      alertWebhookUrl: config.ALERT_WEBHOOK_URL,
      alertWebhookFormat: config.ALERT_WEBHOOK_FORMAT,
    },
    log: {
      warn: (message, meta) => {
        log.warn(meta ?? {}, message);
      },
    },
  });
  const callers = new CallerFactory({
    db,
    crypto,
    settings,
    alerts,
    publicWebUrl: config.PUBLIC_WEB_URL,
  });
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
  });
  await jobs.start();
  const jobAdmin = new PgBossJobAdmin(jobs.boss, db);
  const health = new HealthSweep({
    inputs: new PrismaHealthInputs({
      db,
      admin: jobAdmin,
      opsStateDir: config.OPS_STATE_DIR,
      diskPath: config.UPLOAD_DIR ?? config.OPS_STATE_DIR,
    }),
    alerts,
    thresholds: async () => {
      const v = await settings.resolveMany(
        [
          "ops.diskWarnPercent",
          "ops.diskCriticalPercent",
          "ops.providerErrorRateWarn",
          "ops.backupMaxAgeHours",
        ],
        [],
      );
      return {
        diskWarnPercent: Number(v["ops.diskWarnPercent"]),
        diskCriticalPercent: Number(v["ops.diskCriticalPercent"]),
        providerErrorRate: Number(v["ops.providerErrorRateWarn"]),
        backupMaxAgeHours: Number(v["ops.backupMaxAgeHours"]),
      };
    },
    log: {
      warn: (message, meta) => {
        log.warn(meta ?? {}, message);
      },
    },
  });

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
    health,
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
  const failed = (name: JobName) => (jobId: string, err: unknown, failure: JobFailure) => {
    log.error({ err, job: name, jobId, attempt: failure.attempt, final: failure.final }, "job failed");
    // The last attempt: after this the job sits in `<name>.dead` and nothing else reports it.
    if (failure.final) void alerts.raise(deadLetterAlert(name, jobId, failure, err));
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

  // Proof of life for the container healthcheck, and the self-restart when the queue is gone
  // (D-92). Started last: a healthy file means the consumers above are registered.
  const heartbeatFile =
    config.HEARTBEAT_FILE ?? (config.OPS_STATE_DIR ? `${config.OPS_STATE_DIR}/heartbeat/worker` : undefined);
  const heartbeat = heartbeatFile
    ? new Heartbeat({
        file: heartbeatFile,
        probe: () => jobs.boss.getQueueStats("ops.health-sweep"),
        onFatal: () => {
          process.exit(1);
        },
        log: {
          info: (m, meta) => {
            log.info(meta ?? {}, m);
          },
          warn: (m, meta) => {
            log.warn(meta ?? {}, m);
          },
          error: (m, meta) => {
            log.error(meta ?? {}, m);
          },
        },
      })
    : undefined;
  await heartbeat?.start();

  const shutdown = async (): Promise<void> => {
    heartbeat?.stop();
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
