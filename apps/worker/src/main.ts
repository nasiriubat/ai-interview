import {
  AlertRouter,
  BossJobs,
  CallerFactory,
  createStorage,
  Crypto,
  EgressGuard,
  egressConfigFromEnv,
  ErasureLedger,
  HealthSweep,
  MemoryEmail,
  NoopMetrics,
  pinoRedact,
  pinoSerializers,
  PgBossJobAdmin,
  PrismaAlertState,
  PrismaHealthInputs,
  PromMetrics,
  reapplyErasures,
  SettingsEmail,
  SettingsService,
  startMetricsServer,
  startTelemetry,
  StatementService,
  storageKind,
  TenantExporter,
  TenantGate,
  TenantPurger,
  withLogBindings,
  type JobFailure,
  type JobName,
  type Metrics,
} from "@aidp/core";
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { deadLetterAlert } from "./alerts.js";
import { loadConfig } from "./config.js";
import { handlers } from "./handlers.js";
import { Heartbeat } from "./heartbeat.js";
import { registerSchedules } from "./schedules.js";
import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything that should be instrumented is constructed: auto-instrumentation patches
  // modules as they load, so this precedes `PrismaClient` (D-222). A no-op without an endpoint.
  const telemetry = await startTelemetry("aidp-worker", config.OTEL_EXPORTER_OTLP_ENDPOINT);
  // The same redaction as the API, from one module: tokens, message text, addresses and secrets
  // never reach the log aggregator (D-223).
  const log = pino({
    level: config.LOG_LEVEL,
    redact: pinoRedact({ development: config.NODE_ENV === "development" }),
    serializers: pinoSerializers(),
  });
  const metrics: Metrics = config.METRICS_PORT > 0 ? new PromMetrics() : new NoopMetrics();
  if (config.METRICS_PORT > 0) {
    await startMetricsServer(metrics, {
      port: config.METRICS_PORT,
      onError: (err) => {
        log.warn({ err }, "metrics server error");
      },
    });
    log.info({ port: config.METRICS_PORT }, "metrics endpoint listening");
  }
  // Every line a handler writes carries the tenant, session and job it is for (D-223): the
  // bindings come from the job wrapper's async-local scope, so handlers need no logger parameter.
  const jobLog = withLogBindings({
    info: (m: string, meta?: Record<string, unknown>) => {
      log.info(meta ?? {}, m);
    },
    warn: (m: string, meta?: Record<string, unknown>) => {
      log.warn(meta ?? {}, m);
    },
  });
  // Every query goes through the tenant scope: it pairs the statement with the Postgres setting
  // the row-level security policies read (packages/db/src/tenancy.ts).
  const db = withTenantScope(new PrismaClient());
  const crypto = Crypto.fromEnv(config);
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
  // Identical resolution to the API, so a message sent from a job looks like one sent from a request.
  const email = new SettingsEmail({
    settings,
    env: { smtpUrl: config.smtpRelayUrl, from: config.EMAIL_FROM },
    fallback: new MemoryEmail((m) => {
      log.info({ to: m.to, subject: m.subject }, "email (console)");
    }),
    gate: tenants,
    egress,
  });
  // The same router the API builds: the dedupe state is the table, so a condition both processes
  // see (an exhausted budget) is one notification (D-90).
  const alerts = new AlertRouter({
    db,
    state: new PrismaAlertState(db),
    settings,
    email,
    // The operator's webhook is held to the platform egress policy like a platform provider's URL.
    fetch: egress.fetchFor("platform"),
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
    egress,
    alerts,
    metrics,
    publicWebUrl: config.PUBLIC_WEB_URL,
    onBudgetWarning: (ctx, warnings) => {
      log.warn({ companyId: ctx.companyId, warnings }, "budget warning");
    },
  });
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
    metrics,
    recoveryLog: {
      info: (m, meta) => {
        log.info(meta ?? {}, m);
      },
      warn: (m, meta) => {
        log.warn(meta ?? {}, m);
      },
    },
  });
  await jobs.start();
  // Who runs which job, so jobs left `active` by a worker that died are failed and retried at
  // once, not when their time limit passes (D-281). Before the consumers, which claim their jobs.
  await jobs.recovery.start();
  const jobAdmin = new PgBossJobAdmin(jobs.boss, db);
  const health = new HealthSweep({
    inputs: new PrismaHealthInputs({
      db,
      admin: jobAdmin,
      opsStateDir: config.OPS_STATE_DIR,
      diskPath: config.UPLOAD_DIR ?? config.OPS_STATE_DIR,
    }),
    alerts,
    metrics,
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
  // What was erased on purpose, kept outside the database as well so a restore can re-apply it.
  const erasures = new ErasureLedger({
    db,
    filePath: config.OPS_STATE_DIR ? `${config.OPS_STATE_DIR}/erasures.jsonl` : undefined,
  });
  const exportLog = {
    info: (m: string, meta?: Record<string, unknown>) => {
      jobLog.info(m, meta);
    },
  };

  const h = handlers({
    db,
    callers,
    settings,
    email,
    jobs,
    crypto,
    storage,
    tenants,
    health,
    alerts,
    publicWebUrl: config.PUBLIC_WEB_URL,
    statements: new StatementService({
      db,
      currencyOf: (companyId) => settings.get("branding.currency", [{ scope: "tenant", scopeId: companyId }]),
    }),
    exporter: new TenantExporter({ db, storage, crypto, log: exportLog }),
    purger: new TenantPurger({ db, storage, ledger: erasures, alerts, log: exportLog }),
    erasures,
    log: jobLog,
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
  // The first pass reclaims what a previous process left behind; then every few seconds.
  jobs.recovery.startLoop();
  log.info({ workerId: jobs.recovery.workerId }, "worker started");

  // A restored database may hold what was erased after its backup was taken. The erasure file is
  // outside the backup, so compare it to the database and queue the erasures again (D-226).
  try {
    await reapplyErasures({ db, ledger: erasures, jobs, log: jobLog });
  } catch (err) {
    log.warn({ err }, "could not re-apply recorded erasures");
  }

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

  // One sequence for both signals (see shutdown.ts): drain with a deadline, say what was abandoned,
  // exit non-zero unless everything finished, and exit at once on a second signal. The heartbeat
  // stops first, so a draining worker stops claiming to be healthy.
  const shutdown = createShutdown({
    stopJobs: (timeoutMs) => {
      heartbeat?.stop();
      return jobs.stop({ timeoutMs }).finally(() => jobs.recovery.stop());
    },
    disconnect: async () => {
      await db.$disconnect();
      await telemetry?.shutdown();
    },
    inFlight: () => jobs.inFlight(),
    exit: (code) => process.exit(code),
    graceMs: config.WORKER_SHUTDOWN_GRACE_SECONDS * 1000,
    log: {
      info: (meta, m) => {
        log.info(meta, m);
      },
      warn: (meta, m) => {
        log.warn(meta, m);
      },
      error: (meta, m) => {
        log.error(meta, m);
      },
    },
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
