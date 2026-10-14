import type { SpeechRunner } from "@aidp/ai";
import type {
  AnalysisService,
  AttachmentService,
  CallerFactory,
  Crypto,
  EgressGuard,
  EmailPort,
  SettingsService,
  TenantGate,
} from "@aidp/core";
import type { PrismaClient } from "@prisma/client";
import type { Logger as PinoLogger } from "pino";
import type { Config } from "./config.js";
import { AnalysisQueryService } from "./modules/analysis/service.js";
import { AuditService } from "./modules/audit/service.js";
import { CampaignService } from "./modules/campaigns/service.js";
import { HealthService } from "./modules/health/service.js";
import { VerificationTokenService } from "./modules/internal-auth/service.js";
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
  voiceSetup: VoiceSetupService;
  participant: ParticipantService;
  participantSession: ParticipantSessionReader;
  recordings: RecordingStore;
  turns: TurnStore;
  /** Auth.js magic-link tokens: not tenant-owned (a token belongs to an address, not a company). */
  verificationTokens: VerificationTokenService;
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
  );
  return {
    audit,
    users: new UsersService(d.db, audit),
    stats: new StatsService(d.db),
    sessions: new SessionsService(d.db, d.settings),
    privacy: new PrivacyService(d.db, d.settings),
    health: new HealthService(d.db),
    campaigns: new CampaignService(d.db, d.crypto, d.settings, d.email, d.config.PUBLIC_WEB_URL),
    templates: new TemplateService(d.db),
    providers,
    budgets: new BudgetService(d.db, audit),
    settingsAdmin: new SettingsAdminService(d.db, d.settings, d.egress, d.email, audit, {
      warn: (meta, message) => {
        d.log.warn(meta, message);
      },
    }),
    analysisQueries: new AnalysisQueryService(d.db, d.analysis, d.settings),
    operator: new OperatorService(d.db, d.settings, d.tenants, audit),
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
  };
}
