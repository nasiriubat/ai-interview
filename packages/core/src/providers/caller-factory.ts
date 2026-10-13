import {
  BudgetGuard,
  ModelCaller,
  PriceTable,
  ProviderRegistry,
  type ModelCallerDeps,
  type SpeechRunner,
} from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";
import type { Crypto } from "../crypto.js";
import type { SettingsService } from "../settings/service.js";
import {
  PrismaBudgetLimits,
  PrismaLedger,
  PrismaProbeGuard,
  PrismaProviderConfigSource,
  PrismaRouteResolver,
  loadPrices,
} from "./prisma-sources.js";

export interface CallerFactoryDeps {
  db: PrismaClient;
  crypto: Crypto;
  settings: SettingsService;
  onBudgetWarning?: ModelCallerDeps["onBudgetWarning"];
  /** The on-server Whisper runner (D-75); the process-wide one when absent. Tests pass a fake. */
  speech?: SpeechRunner;
}

/**
 * Builds a ModelCaller for one tenant. The provider registry is shared so SDK clients are
 * reused; prices and the warning threshold are loaded per call to reflect admin changes.
 */
export class CallerFactory {
  private readonly registry: ProviderRegistry;
  private readonly ledger: PrismaLedger;

  constructor(private readonly deps: CallerFactoryDeps) {
    this.registry = new ProviderRegistry(deps.speech ? { speech: deps.speech } : {});
    this.ledger = new PrismaLedger(deps.db);
  }

  async forCompany(companyId: string): Promise<ModelCaller> {
    const prices = new PriceTable();
    await loadPrices(this.deps.db, companyId, prices);
    const warnFraction = await this.deps.settings.get("cost.warnFraction", [
      { scope: "tenant", scopeId: companyId },
    ]);
    const probeMaxPerDay = await this.deps.settings.get("cost.probeMaxPerDay", [
      { scope: "tenant", scopeId: companyId },
    ]);
    return new ModelCaller({
      probeGuard: new PrismaProbeGuard(this.deps.db, probeMaxPerDay),
      routes: new PrismaRouteResolver(this.deps.db),
      providerConfigs: new PrismaProviderConfigSource(this.deps.db, this.deps.crypto),
      registry: this.registry,
      prices,
      ledger: this.ledger,
      budget: new BudgetGuard(new PrismaBudgetLimits(this.deps.db), this.ledger, { warnFraction }),
      ...(this.deps.onBudgetWarning ? { onBudgetWarning: this.deps.onBudgetWarning } : {}),
    });
  }

  invalidateProvider(id: string): void {
    this.registry.invalidate(id);
  }
}
