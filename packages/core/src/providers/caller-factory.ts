import {
  BudgetGuard,
  ModelCaller,
  PriceTable,
  ProviderRegistry,
  type ModelCallerDeps,
  type SpeechRunner,
} from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
import { BudgetAlerts } from "../alerts/budget-alerts.js";
import type { AlertPort } from "../alerts/port.js";
import type { Crypto } from "../crypto.js";
import type { SettingsService } from "../settings/service.js";
import {
  PrismaBudgetLimits,
  PrismaLedger,
  PrismaProviderConfigSource,
  PrismaRouteResolver,
  loadPrices,
} from "./prisma-sources.js";

export interface CallerFactoryDeps {
  db: PrismaClient;
  crypto: Crypto;
  settings: SettingsService;
  /**
   * Where budget warnings and exhaustions go (D-90). Without it both are silent, which is what a
   * tool that has no operator wants and what production must never run with: the API and the
   * worker always pass one.
   */
  alerts?: AlertPort;
  /** Deep links in a budget notice are built from this. */
  publicWebUrl?: string;
  /** Extra observer of warnings, for logging; alerting is `alerts`. */
  onBudgetWarning?: ModelCallerDeps["onBudgetWarning"];
  /** The on-server Whisper runner (D-75); the process-wide one when absent. Tests pass a fake. */
  speech?: SpeechRunner;
  now?: () => Date;
}

/**
 * Builds a ModelCaller for one tenant. The provider registry is shared so SDK clients are
 * reused; prices and the warning threshold are loaded per call to reflect admin changes.
 */
export class CallerFactory {
  private readonly registry: ProviderRegistry;
  private readonly ledger: PrismaLedger;
  private readonly budgetAlerts: BudgetAlerts | undefined;

  constructor(private readonly deps: CallerFactoryDeps) {
    this.registry = new ProviderRegistry(deps.speech ? { speech: deps.speech } : {});
    this.ledger = new PrismaLedger(deps.db);
    this.budgetAlerts = deps.alerts
      ? new BudgetAlerts({
          db: deps.db,
          alerts: deps.alerts,
          publicWebUrl: deps.publicWebUrl ?? "http://localhost:3000",
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  }

  async forCompany(companyId: string): Promise<ModelCaller> {
    const prices = new PriceTable();
    await loadPrices(this.deps.db, companyId, prices);
    const warnFraction = await this.deps.settings.get("cost.warnFraction", [
      { scope: "tenant", scopeId: companyId },
    ]);
    const alerts = this.budgetAlerts;
    const observe = this.deps.onBudgetWarning;
    return new ModelCaller({
      routes: new PrismaRouteResolver(this.deps.db),
      providerConfigs: new PrismaProviderConfigSource(this.deps.db, this.deps.crypto),
      registry: this.registry,
      prices,
      ledger: this.ledger,
      budget: new BudgetGuard(new PrismaBudgetLimits(this.deps.db), this.ledger, { warnFraction }),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(alerts || observe
        ? {
            onBudgetWarning: (ctx, warnings) => {
              observe?.(ctx, warnings);
              alerts?.warn(ctx, warnings);
            },
          }
        : {}),
      ...(alerts ? { onBudgetExceeded: (ctx, check) => alerts.exceeded(ctx, check) } : {}),
    });
  }

  invalidateProvider(id: string): void {
    this.registry.invalidate(id);
  }
}
