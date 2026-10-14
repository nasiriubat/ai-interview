import type { SpeechRunner } from "@aidp/ai";
import type {
  AnalysisService,
  AttachmentService,
  CallerFactory,
  Crypto,
  EgressGuard,
  EmailPort,
  JobAdminPort,
  JobPublisher,
  SettingsService,
  TenantCeilings,
  TenantExporter,
  TenantGate,
  TenantOnboarding,
} from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger as PinoLogger } from "pino";
import type { Config } from "./config.js";
import { AnalysisQueryService } from "./modules/analysis/service.js";
import { AuditService } from "./modules/audit/service.js";
import { CampaignService } from "./modules/campaigns/service.js";
import { HealthService } from "./modules/health/service.js";
import { VerificationTokenService } from "./modules/internal-auth/service.js";
import { CryptoAdminService } from "./modules/operator/crypto.js";
import { OperatorService } from "./modules/operator/service.js";
import { RecordingStore } from "./modules/participant/recordings.js";
import { ParticipantService } from "./modules/participant/service.js";
import { ParticipantSessionReader } from "./modules/participant/session-view.js";
import { PrivacyService } from "./modules/privacy/service.js";
import { BudgetService } from "./modules/providers/budgets.js";
import { ProviderService } from "./modules/providers/service.js";
import { SessionsService } from "./modules/sessions/service.js";
import { TurnStore } from "./modules/sessions/turn-store.js";
import { SettingsAdminService } from "./modules/settings/service.js";
import { StatsService } from "./modules/stats/service.js";
import { TemplateService } from "./modules/templates/service.js";
import { UsersService } from "./modules/users/service.js";
import { VoiceSetupService } from "./modules/voice/service.js";

/**
 * Every query the HTTP layer makes, behind a service. A route file receives `RouteContext`, which
 * has no database client, so reaching a table from a route is a type error and the only way to a
 * tenant's rows is a method here whose first parameter is the `companyId` (AGENTS.md rule 4).
 *
 * The platform operator's module and the provider service take a nullable scope instead, because
 * "no company" is how a platform row is addressed; both say so on the class.
 */
export interface Services {
  audit: AuditService;
  users: UsersService;
  stats: StatsService;
  sessions: SessionsService;
  privacy: PrivacyService;
  health: HealthService;
  campaigns: CampaignService;
  templates: TemplateService;
  providers: ProviderService;
  budgets: BudgetService;
  settingsAdmin: SettingsAdminService;
  analysisQueries: AnalysisQueryService;
  operator: OperatorService;
  cryptoAdmin: CryptoAdminService;
  voiceSetup: VoiceSetupService;
  participant: ParticipantService;
  participantSession: ParticipantSessionReader;
  recordings: RecordingStore;
  turns: TurnStore;
  /** Auth.js magic-link tokens: not tenant-owned (a token belongs to an address, not a company). */
  verificationTokens: VerificationTokenService;
  /** The getting-started checklist, derived from what the tenant has (D-189). */
  onboarding: TenantOnboarding;
}

export interface ServiceDeps {
  db: PrismaClient;
  config: Config;
  log: PinoLogger;
  crypto: Crypto;
  settings: SettingsService;
  callers: CallerFactory;
  egress: EgressGuard;
  speech: SpeechRunner;
  email: EmailPort;
  tenants: TenantGate;
  analysis: AnalysisService;
  attachments: AttachmentService;
  jobs: JobPublisher;
  ceilings: TenantCeilings;
  onboarding: TenantOnboarding;
  exporter?: TenantExporter;
  /** Queue depth and dead letters, for the health tiles. */
  jobAdmin: JobAdminPort;
}

export function buildServices(d: ServiceDeps): Services {
  const audit = new AuditService(d.db);
  const providers = new ProviderService(d.db, d.crypto, d.callers, d.egress, d.speech);
  const participant = new ParticipantService(
    d.db,
    d.crypto,
    d.settings,
    d.email,
    d.tenants,
    (event, meta) => {
      d.log.warn({ event, ...meta }, "abuse signal");
    },
    d.ceilings,
  );
  return {
    audit,
    users: new UsersService(d.db, audit),
    stats: new StatsService(d.db, {
      weightsFor: (campaignId, companyId) => d.analysis.weightsFor(campaignId, companyId),
      k: async (companyId) => d.settings.get("privacy.kAnonymity", [{ scope: "tenant", scopeId: companyId }]),
      preliminaryVisibleToMembers: async (companyId) =>
        d.settings.get("analysis.preliminaryVisibleToMembers", [{ scope: "tenant", scopeId: companyId }]),
      queues: async () =>
        (await d.jobAdmin.list()).map((q) => ({
          name: q.name,
          queued: q.queued,
          active: q.active,
          deadLettered: q.deadLettered,
        })),
      deadLetters: async (companyId) => {
        let n = 0;
        for (const q of await d.jobAdmin.list()) {
          if (q.deadLettered === 0) continue;
          const jobs = await d.jobAdmin.deadLetters(q.name, 200);
          n += jobs.filter((j) => j.companyId === companyId).length;
        }
        return n;
      },
      storageQuotaBytes: async (companyId) => {
        const mb = await d.settings.get("files.tenantQuotaMb", [{ scope: "tenant", scopeId: companyId }]);
        return mb > 0 ? mb * 1024 * 1024 : null;
      },
    }),
    sessions: new SessionsService(d.db, d.settings),
    privacy: new PrivacyService(d.db, d.settings),
    health: new HealthService(d.db),
    campaigns: new CampaignService(d.db, d.crypto, d.settings, d.email, d.config.PUBLIC_WEB_URL, d.ceilings),
    templates: new TemplateService(d.db, d.settings),
    providers,
    budgets: new BudgetService(d.db, audit),
    settingsAdmin: new SettingsAdminService(d.db, d.settings, d.egress, d.email, audit, {
      warn: (meta, message) => {
        d.log.warn(meta, message);
      },
    }),
    analysisQueries: new AnalysisQueryService(d.db, d.analysis, d.settings),
    cryptoAdmin: new CryptoAdminService(d.db, d.crypto, audit),
    operator: new OperatorService(d.db, d.settings, d.tenants, audit, {
      jobs: d.jobs,
      ceilings: d.ceilings,
      onboarding: d.onboarding,
      publicWebUrl: d.config.PUBLIC_WEB_URL,
      ...(d.exporter ? { exporter: d.exporter } : {}),
    }),
    voiceSetup: new VoiceSetupService({
      db: d.db,
      settings: d.settings,
      providers,
      openaiBaseUrl: d.config.OPENAI_BASE_URL,
    }),
    participant,
    participantSession: new ParticipantSessionReader(
      d.db,
      d.settings,
      d.attachments,
      participant,
      (companyId) => d.callers.forCompany(companyId),
    ),
    recordings: new RecordingStore(d.db),
    turns: new TurnStore(d.db),
    verificationTokens: new VerificationTokenService(d.db),
    onboarding: d.onboarding,
  };
}
