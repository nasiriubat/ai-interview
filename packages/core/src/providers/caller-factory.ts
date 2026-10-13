import {
  BudgetGuard,
  ModelCaller,
  PriceTable,
  ProviderError,
  ProviderRegistry,
  createProvider,
  type ModelCallerDeps,
  type Provider,
} from "@aidp/ai";
import type { ProviderConfig } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { Crypto } from "../crypto.js";
import { EgressBlockedError, validateTenantHeaders, type EgressGuard } from "../net/egress.js";
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
  onBudgetWarning?: ModelCallerDeps["onBudgetWarning"];
  /**
   * The outbound-connection policy for provider calls (S4). Absent in tests of packages that
   * never leave the process; the API and the worker always pass one.
   */
  egress?: EgressGuard;
}

/**
 * Builds a ModelCaller for one tenant. The provider registry is shared so SDK clients are
 * reused; prices and the warning threshold are loaded per call to reflect admin changes.
 */
export class CallerFactory {
  private readonly registry: ProviderRegistry;
  private readonly ledger: PrismaLedger;

  constructor(private readonly deps: CallerFactoryDeps) {
    this.ledger = new PrismaLedger(deps.db);
    this.registry = new ProviderRegistry({ fetchFor: (cfg) => this.fetchFor(cfg) });
  }

  /**
   * The transport for one provider: tenant-owned providers get the strict policy, platform ones
   * the operator's. Custom headers a tenant saved are re-checked here too, so a row written
   * before the rule existed, or by hand, still cannot replace the credential or the host.
   */
  private fetchFor(cfg: ProviderConfig): typeof fetch | undefined {
    const { egress } = this.deps;
    if (!egress) return undefined;
    const origin = cfg.companyId === null ? "platform" : "tenant";
    if (origin === "tenant") {
      try {
        validateTenantHeaders(cfg.headers);
      } catch (err) {
        if (err instanceof EgressBlockedError) {
          throw new ProviderError("Provider headers are not allowed", "bad_request", false, err);
        }
        throw err;
      }
    }
    return egress.fetchFor(origin);
  }

  /** An adapter for one provider row, on the guarded transport. Used by "test connection" and "list models". */
  adapterFor(cfg: ProviderConfig): Provider {
    return createProvider(cfg, { fetchFor: (c) => this.fetchFor(c) });
  }

  async forCompany(companyId: string): Promise<ModelCaller> {
    const prices = new PriceTable();
    await loadPrices(this.deps.db, companyId, prices);
    const warnFraction = await this.deps.settings.get("cost.warnFraction", [
      { scope: "tenant", scopeId: companyId },
    ]);
    return new ModelCaller({
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
