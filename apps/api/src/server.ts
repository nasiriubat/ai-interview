import {
  BossJobs,
  describeThrown,
  NoopMetrics,
  PgBossJobAdmin,
  PromMetrics,
  startMetricsServer,
  startTelemetry,
  type Metrics,
} from "@aidp/core";
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { warmLocalSpeech } from "./lib/local-speech.js";
import { createLogger } from "./lib/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = await startTelemetry("aidp-api", config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === "development");
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
  // Every query goes through the tenant scope: it pairs the statement with the Postgres setting
  // the row-level security policies read (packages/db/src/tenancy.ts).
  const db = withTenantScope(new PrismaClient());
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
    metrics,
  });
  await jobs.start();
  const ctx = buildContext({
    config,
    db,
    log,
    jobs,
    metrics,
    jobAdmin: new PgBossJobAdmin(jobs.boss, db),
  });
  const app = await buildApp(ctx);
  // A failure outside any request still reaches the error log (D-477), and still ends the process
  // as Node would have: what is waiting is written first, for at most two seconds.
  const crash = (kind: string) => (err: unknown) => {
    log.error({ err }, kind);
    ctx.errors.capture({
      source: "api",
      ...describeThrown(err),
      route: kind,
      ...(config.AIDP_VERSION ? { release: config.AIDP_VERSION } : {}),
    });
    void ctx.errors.close().finally(() => process.exit(1));
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
  // The on-server speech model is this process's to report (the worker never loads it). Read at
  // scrape time: 0 absent, 1 downloading, 2 ready, 3 failed.
  if (metrics instanceof PromMetrics) {
    const states: Record<string, number> = { not_loaded: 0, downloading: 1, ready: 2, error: 3 };
    metrics.beforeRender(() => {
      metrics.gauge("speech_model_state", states[ctx.speech.status().state] ?? 0);
    });
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      log.warn({ signal }, "second signal during shutdown; exiting now");
      process.exit(1);
    }
    stopping = true;
    log.info({ signal, drainSeconds: config.API_SHUTDOWN_DRAIN_SECONDS }, "shutting down");
    // `app.close()` stops accepting and waits for open responses, which includes turns that are
    // still streaming. They get the drain period to finish; after it the stragglers are aborted
    // and told to retry, so close() can complete inside the container's stop grace period.
    const drain = setTimeout(() => {
      ctx.shutdown.abort();
    }, config.API_SHUTDOWN_DRAIN_SECONDS * 1000);
    drain.unref();
    await app.close();
    clearTimeout(drain);
    await jobs.stop();
    await ctx.errors.close();
    await db.$disconnect();
    await telemetry?.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
  // After listen, not before: the health check must answer while a first boot downloads the
  // speech model, and a failed download must never keep the API down (D-75).
  void warmLocalSpeech(db, log, ctx.speech);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
