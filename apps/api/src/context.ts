import { localSpeechRunner, type SpeechRunner } from "@aidp/ai";
import {
  AlertRouter,
  AnalysisService,
  AttachmentService,
  CallerFactory,
  Crypto,
  EgressGuard,
  EngineFactory,
  GitHubApi,
  MemoryEmail,
  MemoryJobAdmin,
  PrismaAlertState,
  RequirementsService,
  SettingsEmail,
  SettingsService,
  TenantGate,
  createStorage,
  egressConfigFromEnv,
  type AlertPort,
  type EmailPort,
  type GitHubPort,
  type JobAdminPort,
  type JobPublisher,
  type StoragePort,
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
  storage: StoragePort;
  attachments: AttachmentService;
  /** Whether a tenant may act at all (suspension, S8). */
  tenants: TenantGate;
  /** What the server may connect to on a tenant's say-so (S4). */
  egress: EgressGuard;
  /** Whisper on this server (D-75): one runner per process, shared by every `local` provider. */
  speech: SpeechRunner;
  /**
   * Aborted when the process is draining and the grace period for running turns is over. Streams
   * still open at that point end with an `error` event of code `shutting_down`, so the client
   * retries instead of seeing a reset connection.
   */
  shutdown: AbortController;
  /** Operator alerts (D-90): email and webhook, deduped and rate limited. */
  alerts: AlertPort;
  /** The queue's dead letters and counters, for the operator jobs page (D-92). */
  jobAdmin: JobAdminPort;
}

export function buildContext(input: {
  config: Config;
  db: PrismaClient;
  log: PinoLogger;
  jobs: JobPublisher;
  email?: EmailPort;
  github?: GitHubPort;
  /** Tests pass a MemoryStorage; production passes nothing and gets one from UPLOAD_DIR. */
  storage?: StoragePort;
  /** Tests pass a guard with a fake resolver; production builds one from the environment. */
  egress?: EgressGuard;
  /** Tests pass a runner over an in-memory engine, so nothing loads a model. */
  speech?: SpeechRunner;
  /** Tests pass a MemoryAlerts; production gets an AlertRouter over the database. */
  alerts?: AlertPort;
  /** Required in production (PgBossJobAdmin); tests get a MemoryJobAdmin. */
  jobAdmin?: JobAdminPort;
}): AppContext {
  const { config, db, log } = input;
  const speech = input.speech ?? localSpeechRunner();
  const crypto = new Crypto(config.PLATFORM_ENCRYPTION_KEY);
  const settings = new SettingsService(db, crypto, {
    warn: (message, meta) => {
      log.warn(meta ?? {}, message);
    },
  });
  const egress =
    input.egress ??
    new EgressGuard(
      egressConfigFromEnv({
        mode: config.EGRESS_MODE,
        allowHosts: config.EGRESS_ALLOW_HOSTS,
        nodeEnv: config.NODE_ENV,
        // The admin's one-step voice setup writes this URL onto a tenant's provider (D-77).
        trustedUrls: [config.OPENAI_BASE_URL],
      }),
    );
  const tenants = new TenantGate(db);
  // Every send resolves its SMTP settings from the tenant, then the platform, then the environment.
  const email =
    input.email ??
    new SettingsEmail({
      settings,
      env: { smtpUrl: config.EMAIL_SMTP_URL, from: config.EMAIL_FROM },
      fallback: new MemoryEmail((m) => {
        log.info({ to: m.to, subject: m.subject }, "email (console)");
      }),
      gate: tenants,
      egress,
    });
  // Budget warnings and exhaustion, dead letters and the rest reach a human through this (D-90).
  // Tests pass a MemoryAlerts to assert on what was raised.
  const alerts =
    input.alerts ??
    new AlertRouter({
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
    speech,
    alerts,
    publicWebUrl: config.PUBLIC_WEB_URL,
    onBudgetWarning: (ctx, warnings) => {
      log.warn({ companyId: ctx.companyId, warnings }, "budget warning");
    },
  });
  const engines = new EngineFactory(db, callers, settings, engineLogger(log));
  // The queue's own tables, for the operator jobs page. Tests pass a MemoryJobAdmin.
  if (!input.jobAdmin && config.NODE_ENV === "production")
    throw new Error("buildContext: jobAdmin is required in production; pass PgBossJobAdmin");
  const jobAdmin = input.jobAdmin ?? new MemoryJobAdmin();
  const analysis = new AnalysisService({ db, callers, settings, jobs: input.jobs, log: engineLogger(log) });
  const github = input.github ?? new GitHubApi();
  // The API stores uploads and hands them to the worker to read; it never ingests them itself,
  // so it needs no model caller here.
  const storage = input.storage ?? createStorage(config.UPLOAD_DIR);
  const attachments = new AttachmentService({ db, storage, settings, log: engineLogger(log) });
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
    storage,
    attachments,
    tenants,
    egress,
    speech,
    shutdown: new AbortController(),
    alerts,
    jobAdmin,
  };
}
