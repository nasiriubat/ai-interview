import {
  AnalysisService,
  CallerFactory,
  Crypto,
  EngineFactory,
  GitHubApi,
  MemoryEmail,
  RequirementsService,
  SettingsEmail,
  SettingsService,
  type EmailPort,
  type GitHubPort,
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
  requirements: RequirementsService;
  github: GitHubPort;
}

export function buildContext(input: {
  config: Config;
  db: PrismaClient;
  log: PinoLogger;
  jobs: JobPublisher;
  email?: EmailPort;
  github?: GitHubPort;
}): AppContext {
  const { config, db, log } = input;
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
  const engines = new EngineFactory(db, callers, settings, engineLogger(log));
  // Every send resolves its SMTP settings from the tenant, then the platform, then the environment.
  const email =
    input.email ??
    new SettingsEmail({
      settings,
      env: { smtpUrl: config.EMAIL_SMTP_URL, from: config.EMAIL_FROM },
      fallback: new MemoryEmail((m) => {
        log.info({ to: m.to, subject: m.subject }, "email (console)");
      }),
    });
  const analysis = new AnalysisService({ db, callers, settings, jobs: input.jobs, log: engineLogger(log) });
  const github = input.github ?? new GitHubApi();
  const requirements = new RequirementsService({
    db,
    callers,
    settings,
    jobs: input.jobs,
    log: engineLogger(log),
    email,
    publicWebUrl: config.PUBLIC_WEB_URL,
    crypto,
    github,
  });
  return {
    config,
    db,
    log,
    crypto,
    settings,
    callers,
    engines,
    jobs: input.jobs,
    email,
    analysis,
    requirements,
    github,
  };
}
