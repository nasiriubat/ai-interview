import {
  BudgetGuard,
  CircuitBreaker,
  ModelCaller,
  breakerOptionsFromEnv,
  PriceTable,
  ProviderError,
  ProviderRegistry,
  createProvider,
  type ModelCallerDeps,
  type Provider,
  type RealtimeSocketFactory,
  type SpeechRunner,
} from "@aidp/ai";
import type { ProviderConfig } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { BudgetAlerts } from "../alerts/budget-alerts.js";
import type { AlertPort } from "../alerts/port.js";
import type { Crypto } from "../crypto.js";
import { EgressBlockedError, validateTenantHeaders, type EgressGuard } from "../net/egress.js";
import type { SettingsService } from "../settings/service.js";
import type { Metrics } from "../telemetry/metrics.js";
import {
  PrismaFallbackRouteResolver,
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
  /**
   * The outbound-connection policy for provider calls (S4). Absent in tests of packages that
   * never leave the process; the API and the worker always pass one.
   */
  egress?: EgressGuard;
  /** The on-server Whisper runner (D-75); the process-wide one when absent. Tests pass a fake. */
  speech?: SpeechRunner;
  now?: () => Date;
  /** Where call, circuit and budget numbers go (D-222). Absent in tests that do not measure. */
  metrics?: Metrics;
  /** The process-wide circuit breaker (D-228). The factory builds one when none is passed. */
  breaker?: CircuitBreaker;
}

/**
 * Builds a ModelCaller for one tenant. The provider registry is shared so SDK clients are
 * reused; prices and the warning threshold are loaded per call to reflect admin changes.
 */
export class CallerFactory {
  private readonly registry: ProviderRegistry;
  private readonly ledger: PrismaLedger;
  private readonly budgetAlerts: BudgetAlerts | undefined;
  /** One breaker per process, shared by every caller this factory builds. */
  readonly breaker: CircuitBreaker;

  constructor(private readonly deps: CallerFactoryDeps) {
    this.ledger = new PrismaLedger(deps.db);
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        ...breakerOptionsFromEnv(),
        ...(deps.now ? { now: () => (deps.now as () => Date)().getTime() } : {}),
        onChange: (providerId, _from, to) => {
          deps.metrics?.circuit(providerId, to);
          const key = `provider.circuit:${providerId}`;
          if (to === "open") {
            void deps.alerts
              ?.raise({
                kind: "provider.error_rate",
                key,
                title: "Provider circuit open",
                message: `Calls to provider '${providerId}' are failing and its circuit is open: new calls are refused or sent to a fallback route until a probe succeeds.`,
                context: { providerId },
                audience: ["operator"],
              })
              .catch(() => undefined);
          } else if (to === "closed") {
            void deps.alerts?.resolve(key).catch(() => undefined);
            void deps.alerts?.resolve(`provider.fallback_active:${providerId}`).catch(() => undefined);
          }
        },
      });
    this.registry = new ProviderRegistry({
      ...(deps.speech ? { speech: deps.speech } : {}),
      fetchFor: (cfg) => this.fetchFor(cfg),
      socketFor: (cfg) => this.socketFor(cfg),
    });
    this.budgetAlerts = deps.alerts
      ? new BudgetAlerts({
          db: deps.db,
          alerts: deps.alerts,
          publicWebUrl: deps.publicWebUrl ?? "http://localhost:3000",
          currencyOf: (companyId) =>
            deps.settings.get("branding.currency", [{ scope: "tenant", scopeId: companyId }]),
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
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

  /** The streaming-transcription socket for one provider, held to the same policy as its HTTP calls. */
  private socketFor(cfg: ProviderConfig): RealtimeSocketFactory | undefined {
    const { egress } = this.deps;
    if (!egress) return undefined;
    return egress.socketFor(cfg.companyId === null ? "platform" : "tenant");
  }

  /** An adapter for one provider row, on the guarded transport. Used by "test connection" and "list models". */
  adapterFor(cfg: ProviderConfig, extra: { speech?: SpeechRunner } = {}): Provider {
    const speech = extra.speech ?? this.deps.speech;
    return createProvider(cfg, {
      ...(speech ? { speech } : {}),
      fetchFor: (c) => this.fetchFor(c),
      socketFor: (c) => this.socketFor(c),
    });
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
    const alerts = this.budgetAlerts;
    const observe = this.deps.onBudgetWarning;
    const { metrics } = this.deps;
    const alertPort = this.deps.alerts;
    return new ModelCaller({
      breaker: this.breaker,
      fallbackRoutes: new PrismaFallbackRouteResolver(this.deps.db),
      onFallback: (n) => {
        void alertPort
          ?.raise({
            kind: "provider.fallback_active",
            key: `provider.fallback_active:${n.fromProviderId}`,
            title: `Fallback route active for ${n.purpose}`,
            message: `Calls for purpose '${n.purpose}' are being served by provider '${n.toProviderId}' because '${n.fromProviderId}' ${n.reason === "circuit_open" ? "is failing and its circuit is open" : "failed"}.`,
            context: { purpose: n.purpose, from: n.fromProviderId, to: n.toProviderId, reason: n.reason },
            audience: ["operator"],
          })
          .catch(() => undefined);
      },
      ...(metrics
        ? {
            observer: {
              recorded: (e) => {
                metrics.modelCall({
                  purpose: e.purpose,
                  provider: e.providerId,
                  model: e.model,
                  tenant: e.companyId,
                  status: e.status,
                  latencyMs: e.latencyMs,
                  firstTokenMs: e.firstTokenMs,
                  inputTokens: e.usage.inputTokens,
                  cacheReadTokens: e.usage.cacheReadTokens,
                  outputTokens: e.usage.outputTokens,
                  costCents: e.costCents,
                  audioSeconds: e.usage.audioSeconds,
                });
              },
            },
          }
        : {}),
      probeGuard: new PrismaProbeGuard(this.deps.db, probeMaxPerDay),
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
      ...(alerts || metrics
        ? {
            onBudgetExceeded: async (ctx, check) => {
              metrics?.budgetBlocked(ctx.companyId, check.blockedBy?.scope ?? "tenant");
              return alerts?.exceeded(ctx, check);
            },
          }
        : {}),
    });
  }

  invalidateProvider(id: string): void {
    this.registry.invalidate(id);
  }
}
