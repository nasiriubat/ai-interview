import { BossJobs, CallerFactory, Crypto, MemoryEmail, SettingsEmail, SettingsService } from "@aidp/core";
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
  const callers = new CallerFactory({
    db,
    crypto,
    settings,
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
  });
  const jobs = new BossJobs(config.DATABASE_URL, {
    onError: (err) => {
      log.error({ err }, "job queue error");
    },
  });
  await jobs.start();

  const h = handlers({
    db,
    callers,
    settings,
    email,
    jobs,
    crypto,
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
   * A job carries its tenant in the payload, so it runs fenced in exactly like a request does.
   * A job without one sweeps every tenant and runs as system (packages/db/src/tenancy.ts).
   */
  await jobs.consume(
    "session.summarize",
    h["session.summarize"],
    config.WORKER_CONCURRENCY,
    failed("session.summarize"),
  );
  await jobs.consume(
    "session.extract",
    h["session.extract"],
    config.WORKER_CONCURRENCY,
    failed("session.extract"),
  );
  await jobs.consume("email.send", h["email.send"], config.WORKER_CONCURRENCY, failed("email.send"));
  await jobs.consume(
    "privacy.delete-session",
    h["privacy.delete-session"],
    1,
    failed("privacy.delete-session"),
  );
  await jobs.consume(
    "privacy.retention-sweep",
    h["privacy.retention-sweep"],
    1,
    failed("privacy.retention-sweep"),
  );
  await jobs.consume(
    "auth.prune-verification-tokens",
    h["auth.prune-verification-tokens"],
    1,
    failed("auth.prune-verification-tokens"),
  );
  await jobs.consume("analysis.run", h["analysis.run"], 1, failed("analysis.run"));
  await jobs.consume("spec.generate", h["spec.generate"], 1, failed("spec.generate"));
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
