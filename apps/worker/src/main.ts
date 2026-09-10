import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { BossJobs, CallerFactory, Crypto, MemoryEmail, SettingsService, SmtpEmail } from "@aidp/core";
import { loadConfig } from "./config.js";
import { handlers } from "./handlers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  const db = new PrismaClient();
  const crypto = new Crypto(config.PLATFORM_ENCRYPTION_KEY);
  const settings = new SettingsService(db);
  const callers = new CallerFactory({
    db,
    crypto,
    settings,
    onBudgetWarning: (ctx, warnings) => log.warn({ companyId: ctx.companyId, warnings }, "budget warning"),
  });
  const email = config.EMAIL_SMTP_URL
    ? new SmtpEmail(config.EMAIL_SMTP_URL, config.EMAIL_FROM)
    : new MemoryEmail((m) => log.info({ to: m.to, subject: m.subject }, "email (console)"));
  const jobs = new BossJobs(config.DATABASE_URL);
  await jobs.start();

  const h = handlers({
    db,
    callers,
    settings,
    email,
    log: { info: (m, meta) => log.info(meta ?? {}, m), warn: (m, meta) => log.warn(meta ?? {}, m) },
  });
  await jobs.consume("session.summarize", h["session.summarize"], config.WORKER_CONCURRENCY);
  await jobs.consume("session.extract", h["session.extract"], config.WORKER_CONCURRENCY);
  await jobs.consume("email.send", h["email.send"], config.WORKER_CONCURRENCY);
  await jobs.consume("privacy.delete-session", h["privacy.delete-session"], 1);
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
