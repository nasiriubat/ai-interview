import { BossJobs } from "@aidp/core";
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
  const db = new PrismaClient();
  const jobs = new BossJobs(config.DATABASE_URL);
  await jobs.start();
  const app = await buildApp(buildContext({ config, db, log, jobs }));

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    await app.close();
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
