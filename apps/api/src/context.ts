import {
  AnalysisService,
  CallerFactory,
  Crypto,
  EngineFactory,
  MemoryEmail,
  SettingsService,
  SmtpEmail,
  type EmailPort,
  type JobPublisher,
} from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger as PinoLogger } from "pino";
import type { Config } from "./config.js";
import { engineLogger } from "./lib/logger.js";

/** Everything routes need, built once per process. Tests build it with fakes. */
export interface AppContext {
  config: Config;
  db: PrismaClient;
  log: PinoLogger;
  crypto: Crypto;
  settings: SettingsService;
  callers: CallerFactory;
  engines: EngineFactory;
  jobs: JobPublisher;
  email: EmailPort;
  analysis: AnalysisService;
}

export function buildContext(input: {
  config: Config;
  db: PrismaClient;
  log: PinoLogger;
  jobs: JobPublisher;
  email?: EmailPort;
}): AppContext {
  const { config, db, log } = input;
  const crypto = new Crypto(config.PLATFORM_ENCRYPTION_KEY);
  const settings = new SettingsService(db);
  const callers = new CallerFactory({
    db,
    crypto,
    settings,
    onBudgetWarning: (ctx, warnings) => {
      log.warn({ companyId: ctx.companyId, warnings }, "budget warning");
    },
  });
  const engines = new EngineFactory(db, callers, settings, engineLogger(log));
  const email =
    input.email ??
    (config.EMAIL_SMTP_URL
      ? new SmtpEmail(config.EMAIL_SMTP_URL, config.EMAIL_FROM)
      : new MemoryEmail((m) => {
          log.info({ to: m.to, subject: m.subject }, "email (console)");
        }));
  const analysis = new AnalysisService({ db, callers, settings, jobs: input.jobs, log: engineLogger(log) });
  return { config, db, log, crypto, settings, callers, engines, jobs: input.jobs, email, analysis };
}
