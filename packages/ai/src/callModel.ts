import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Effort,
  LedgerEntry,
  ProviderConfig,
  Purpose,
  Route,
  Transcript,
  TranscriptionInput,
  Usage,
} from "@aidp/shared";
import { emptyUsage } from "@aidp/shared";
import type { z } from "zod";
import { BudgetExceededError, type BudgetGuard } from "./cost/budget.js";
import type { LedgerSink } from "./cost/ledger.js";
import { costCents, estimateCents, estimateTokens, type PriceTable } from "./cost/pricing.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { ProviderError, type Provider } from "./providers/types.js";

export interface RouteResolver {
  /** Tenant override first, platform default second. */
  resolve(companyId: string, purpose: Purpose): Promise<Route | undefined>;
}
export interface ProviderConfigSource {
  /** Returns the decrypted config for a provider the tenant may use. */
  get(companyId: string, providerId: string): Promise<ProviderConfig | undefined>;
}

/** What callers pass. Route settings fill in whatever is omitted. */
export interface CallRequest {
  system?: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  effort?: Effort;
  temperature?: number;
  cachePrefix?: boolean;
}

export interface CallContext {
  companyId: string;
  campaignId?: string;
  sessionId?: string;
  ref?: { type: string; id: string };
  promptVersion?: string;
}

export interface ModelCallerDeps {
  routes: RouteResolver;
  providerConfigs: ProviderConfigSource;
  registry: ProviderRegistry;
  prices: PriceTable;
  ledger: LedgerSink;
  budget: BudgetGuard;
  now?: () => Date;
  onBudgetWarning?: (
    ctx: CallContext,
    warnings: Awaited<ReturnType<BudgetGuard["check"]>>["warnings"],
  ) => void;
}

/**
 * The single entry point for model calls. Resolves the route for the purpose, checks the
 * budget with a conservative estimate, invokes the adapter, and writes the ledger row
 * whatever happens. No other code may call a provider adapter directly.
 */
export class ModelCaller {
  private readonly now: () => Date;
  constructor(private readonly deps: ModelCallerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Streamed chat. Text events are yielded as they arrive; the final event carries usage. */
  async *chat(purpose: Purpose, ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    const { route, provider, price } = await this.prepare(purpose, ctx, req);
    const fullReq = this.applyRoute(route, provider, req);
    const started = this.now();
    let usage = emptyUsage();
    let status: LedgerEntry["status"] = "ok";
    try {
      for await (const ev of provider.chat(route.model, fullReq)) {
        if (ev.type === "done") {
          usage = ev.usage;
          if (ev.stopReason === "refusal") status = "refused";
        }
        yield ev;
      }
    } catch (e) {
      status = e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      throw e;
    } finally {
      await this.record(purpose, ctx, route, price, usage, status, started);
    }
  }

  /** Structured output validated against a Zod schema. */
  async complete<T>(
    purpose: Purpose,
    ctx: CallContext,
    req: CallRequest,
    schema: z.ZodType<T>,
    schemaName?: string,
  ): Promise<T> {
    const { route, provider, price } = await this.prepare(purpose, ctx, req);
    const fullReq = this.applyRoute(route, provider, req);
    const started = this.now();
    let usage = emptyUsage();
    let status: LedgerEntry["status"] = "ok";
    try {
      const res = await provider.complete(route.model, fullReq, schema, schemaName);
      usage = res.usage;
      return res.value;
    } catch (e) {
      status = e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      throw e;
    } finally {
      await this.record(purpose, ctx, route, price, usage, status, started);
    }
  }

  /** Audio to text through the `transcription` route. */
  async transcribe(ctx: CallContext, input: TranscriptionInput): Promise<Transcript> {
    const purpose: Purpose = "transcription";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) throw new ProviderError(`No route configured for purpose '${purpose}'`, "unsupported", false);
    const provider = await this.providerFor(ctx.companyId, route.providerId);
    if (!provider.transcribe)
      throw new ProviderError(`Provider '${route.providerId}' cannot transcribe audio`, "unsupported", false);
    const price = this.deps.prices.get(route.providerId, route.model);
    const check = await this.deps.budget.check(ctx, 0);
    if (!check.allowed) {
      await this.record(purpose, ctx, route, price, emptyUsage(), "budget_exceeded", this.now());
      throw new BudgetExceededError(check);
    }
    const started = this.now();
    let status: LedgerEntry["status"] = "ok";
    try {
      const res = await provider.transcribe(route.model, input);
      return res.transcript;
    } catch (e) {
      status = "error";
      throw e;
    } finally {
      await this.record(purpose, ctx, route, price, emptyUsage(), status, started);
    }
  }

  /** Embeddings through the `embedding` route, or undefined when no route is configured (callers fall back). */
  async embed(
    ctx: CallContext,
    texts: string[],
  ): Promise<{ vectors: number[][]; model: string } | undefined> {
    const purpose: Purpose = "embedding";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const provider = await this.providerFor(ctx.companyId, route.providerId);
    if (!provider.embed)
      throw new ProviderError(`Provider '${route.providerId}' cannot embed text`, "unsupported", false);
    const price = this.deps.prices.get(route.providerId, route.model);
    const inputTokens = estimateTokens(texts.join(" "));
    const check = await this.deps.budget.check(ctx, price ? estimateCents(price, inputTokens, 0) : 0);
    if (!check.allowed) {
      await this.record(purpose, ctx, route, price, emptyUsage(), "budget_exceeded", this.now());
      throw new BudgetExceededError(check);
    }
    const started = this.now();
    let usage = emptyUsage();
    let status: LedgerEntry["status"] = "ok";
    try {
      const res = await provider.embed(route.model, texts);
      usage = res.usage;
      return { vectors: res.vectors, model: route.model };
    } catch (e) {
      status = "error";
      throw e;
    } finally {
      await this.record(purpose, ctx, route, price, usage, status, started);
    }
  }

  private async prepare(purpose: Purpose, ctx: CallContext, req: CallRequest) {
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) throw new ProviderError(`No route configured for purpose '${purpose}'`, "unsupported", false);
    const provider = await this.providerFor(ctx.companyId, route.providerId);
    const price = this.deps.prices.get(route.providerId, route.model);
    const inputTokens = estimateTokens((req.system ?? "") + JSON.stringify(req.messages));
    const estimate = price
      ? estimateCents(price, inputTokens, req.maxOutputTokens ?? route.maxOutputTokens)
      : 0;
    const check = await this.deps.budget.check(ctx, estimate);
    if (!check.allowed) {
      await this.record(purpose, ctx, route, price, emptyUsage(), "budget_exceeded", this.now());
      throw new BudgetExceededError(check);
    }
    if (check.warnings.length) this.deps.onBudgetWarning?.(ctx, check.warnings);
    return { route, provider, price };
  }

  private async providerFor(companyId: string, providerId: string): Promise<Provider> {
    const cfg = await this.deps.providerConfigs.get(companyId, providerId);
    if (!cfg?.enabled)
      throw new ProviderError(
        `Provider '${providerId}' is not available to this tenant`,
        "unsupported",
        false,
      );
    return this.deps.registry.get(cfg);
  }

  private applyRoute(route: Route, provider: Provider, req: CallRequest): ChatRequest {
    const effort = req.effort ?? route.effort;
    const out: ChatRequest = {
      messages: req.messages,
      maxOutputTokens: req.maxOutputTokens ?? route.maxOutputTokens,
      cachePrefix: provider.capabilities.caching && (req.cachePrefix ?? false),
    };
    if (req.system !== undefined) out.system = req.system;
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (effort && provider.capabilities.effort) out.effort = effort;
    return out;
  }

  private async record(
    purpose: Purpose,
    ctx: CallContext,
    route: Route,
    price: ReturnType<PriceTable["get"]>,
    usage: Usage,
    status: LedgerEntry["status"],
    started: Date,
  ): Promise<void> {
    const entry: LedgerEntry = {
      companyId: ctx.companyId,
      purpose,
      providerId: route.providerId,
      model: route.model,
      usage,
      latencyMs: Math.max(0, this.now().getTime() - started.getTime()),
      status,
      costCents: price ? costCents(price, usage) : 0,
      createdAt: this.now(),
      ...(ctx.promptVersion ? { promptVersion: ctx.promptVersion } : {}),
      ...(ctx.ref ? { ref: ctx.ref } : {}),
      ...(ctx.campaignId ? { campaignId: ctx.campaignId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    };
    await this.deps.ledger.record(entry);
  }
}
