import { BossJobs } from "@aidp/core";
import { withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { createLogger } from "./lib/logger.js";
import { startTelemetry } from "./otel.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = startTelemetry("aidp-api", config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV === "development");
  // Every query goes through the tenant scope: it pairs the statement with the Postgres setting
  // the row-level security policies read. The cast keeps the familiar PrismaClient shape at the
  // ~166 call sites; the extension only adds behaviour (packages/db/src/tenancy.ts).
  const db = withTenantScope(new PrismaClient()) as unknown as PrismaClient;
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
  });
  await jobs.start();
  const ctx = buildContext({ config, db, log, jobs });
  const app = await buildApp(ctx);

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
    await db.$disconnect();
    await telemetry?.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
