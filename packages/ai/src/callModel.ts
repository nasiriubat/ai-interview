import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Effort,
  LedgerEntry,
  ProviderConfig,
  Purpose,
  Route,
  SpeechInput,
  SpeechOutput,
  SttStreamEvent,
  SttStreamInput,
  SttStreamSession,
  Transcript,
  TranscriptionInput,
  Usage,
} from "@aidp/shared";
import { emptyUsage } from "@aidp/shared";
import type { z } from "zod";
import { BudgetExceededError, type BudgetCheck, type BudgetGuard } from "./cost/budget.js";
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
  /**
   * Cancels the call. The adapter is handed the same signal, so the request itself is torn down,
   * and the ledger row is written with status `aborted`. A call made with a signal that is already
   * aborted never reaches the provider and writes nothing: no work was done.
   */
  signal?: AbortSignal;
}

/**
 * Thrown by `chat` and `complete` when the caller's signal aborted the call. Not a provider
 * failure: callers that cancelled on purpose (a client disconnected, a lock was lost) recognise it
 * and stop quietly instead of reporting an error to anyone.
 */
export class CallAbortedError extends Error {
  constructor(cause?: unknown) {
    super("The model call was aborted");
    this.name = "CallAbortedError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CallContext {
  companyId: string;
  campaignId?: string;
  sessionId?: string;
  ref?: { type: string; id: string };
  promptVersion?: string;
}

/** Decides whether a tenant may run another provider probe. Throws `ProbeLimitError` when not. */
export interface ProbeGuard {
  check(companyId: string, at: Date): Promise<void>;
}

export class ProbeLimitError extends Error {
  constructor(readonly limitPerDay: number) {
    super(`Provider tests are limited to ${limitPerDay} per day`);
    this.name = "ProbeLimitError";
  }
}

/** What a probe is aimed at. The only call that names its provider instead of resolving a route. */
export interface ProbeTarget {
  providerId: string;
  model: string;
}

export interface ProbeResult {
  text: string;
  usage: Usage;
  latencyMs: number;
  costCents: number;
  /** False for a platform-level probe, which has no tenant to attribute a ledger row to. */
  ledgered: boolean;
}

export interface ModelCallerDeps {
  routes: RouteResolver;
  providerConfigs: ProviderConfigSource;
  registry: ProviderRegistry;
  prices: PriceTable;
  ledger: LedgerSink;
  budget: BudgetGuard;
  now?: () => Date;
  /** Caps `probe`. Omitted in tests that do not exercise the limit. */
  probeGuard?: ProbeGuard;
  onBudgetWarning?: (
    ctx: CallContext,
    warnings: Awaited<ReturnType<BudgetGuard["check"]>>["warnings"],
  ) => void;
  /**
   * Called once for every call a budget refuses, after the ledger row and before the error is
   * thrown (D-90). It is how an exhausted budget reaches a human instead of ending in a log line.
   *
   * It is awaited, because the participant-facing sentence depends on whether anyone was told,
   * and its answer travels on the thrown error as `notified`. It must not throw; if it does, the
   * refusal still happens and `notified` stays false.
   */
  onBudgetExceeded?: (ctx: CallContext, check: BudgetCheck) => Promise<{ notified: boolean } | undefined>;
}

/**
 * What the engine, extraction, summary, issue detection, spec generation and analysis need from a
 * model caller: streamed chat, schema-validated completion and embeddings.
 *
 * The class has private fields, so `implements ModelCaller` is not expressible and test doubles
 * used to be cast (`this as unknown as ModelCaller`), which let a fake drift from the real
 * signatures without the compiler noticing. Consumers that only chat and complete depend on this
 * port instead, and the class and every fake are checked against it.
 */
export interface ModelCallerPort {
  chat(purpose: Purpose, ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent>;
  complete<T>(
    purpose: Purpose,
    ctx: CallContext,
    req: CallRequest,
    schema: z.ZodType<T>,
    schemaName?: string,
  ): Promise<T>;
  /** Embeddings, or undefined when no `embedding` route is configured (callers fall back). */
  embed(ctx: CallContext, texts: string[]): Promise<{ vectors: number[][]; model: string } | undefined>;
}

/**
 * The single entry point for model calls. Resolves the route for the purpose, checks the
 * budget with a conservative estimate, invokes the adapter, and writes the ledger row
 * whatever happens. No other code may call a provider adapter directly.
 */
export class ModelCaller implements ModelCallerPort {
  private readonly now: () => Date;
  constructor(private readonly deps: ModelCallerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Streamed chat. Text events are yielded as they arrive; the final event carries usage. */
  async *chat(purpose: Purpose, ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    if (req.signal?.aborted) throw new CallAbortedError();
    const { route, provider, price } = await this.prepare(purpose, ctx, req);
    const fullReq = this.applyRoute(route, provider, req);
    const started = this.now();
    let usage = emptyUsage();
    let status: LedgerEntry["status"] = "ok";
    let streamed = "";
    let finished = false;
    try {
      for await (const ev of provider.chat(route.model, fullReq)) {
        // An adapter that ignores the signal must not keep a cancelled turn alive.
        if (req.signal?.aborted) throw new CallAbortedError();
        if (ev.type === "text") streamed += ev.text;
        if (ev.type === "done") {
          finished = true;
          usage = ev.usage;
          if (ev.stopReason === "refusal") status = "refused";
        }
        yield ev;
      }
    } catch (e) {
      if (req.signal?.aborted) {
        status = "aborted";
        // The provider reports usage only at the end of a stream, and an aborted stream never
        // gets there, so what it cost is estimated from what was sent and what arrived. Recording
        // zero here is how abandoned streams used to look free.
        usage = this.abortedUsage(req, streamed);
        throw e instanceof CallAbortedError ? e : new CallAbortedError(e);
      }
      status = e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      throw e;
    } finally {
      // The consumer abandoning the generator (an early `return`, a barge-in) lands here with the
      // status still "ok" and no `done` event seen: the same situation as an abort, recorded as one.
      if (status === "ok" && !finished) {
        status = "aborted";
        usage = this.abortedUsage(req, streamed);
      }
      await this.record(purpose, ctx, route, price, usage, status, started);
    }
  }

  private abortedUsage(req: CallRequest, streamed: string): Usage {
    return {
      inputTokens: estimateTokens((req.system ?? "") + JSON.stringify(req.messages)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: estimateTokens(streamed),
    };
  }

  /** Structured output validated against a Zod schema. */
  async complete<T>(
    purpose: Purpose,
    ctx: CallContext,
    req: CallRequest,
    schema: z.ZodType<T>,
    schemaName?: string,
  ): Promise<T> {
    if (req.signal?.aborted) throw new CallAbortedError();
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
      if (req.signal?.aborted) {
        status = "aborted";
        usage = this.abortedUsage(req, "");
        throw e instanceof CallAbortedError ? e : new CallAbortedError(e);
      }
      status = e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      throw e;
    } finally {
      await this.record(purpose, ctx, route, price, usage, status, started);
    }
  }

  /**
   * One tiny request to a named provider and model: the admin "test connection" (FR-43).
   *
   * Everything else here resolves a route and checks a budget; a probe does neither, because its
   * whole point is to ask a specific provider that may not be routed yet, and an admin whose
   * budget is spent still has to be able to find out why their provider is failing. It is bounded
   * the other way instead: `probeGuard` caps how many a tenant may run per day. The provider must
   * be one this tenant may use (its own, or platform-level), the key never leaves the config
   * source, and the call is ledgered under purpose `probe` with the provider as its reference.
   *
   * `ctx.companyId` is null for the platform operator testing a platform provider. There is no
   * tenant to attribute the row to, so that case is not ledgered (`ledgered: false`).
   */
  async probe(
    ctx: { companyId: string | null },
    target: ProbeTarget,
    options: { prompt?: string; maxOutputTokens?: number; signal?: AbortSignal } = {},
  ): Promise<ProbeResult> {
    const tenant = ctx.companyId;
    if (tenant !== null) await this.deps.probeGuard?.check(tenant, this.now());
    const provider = await this.providerFor(tenant ?? "", target.providerId);
    const price = this.deps.prices.get(target.providerId, target.model);
    const route: Route = {
      companyId: tenant,
      purpose: "probe",
      providerId: target.providerId,
      model: target.model,
      maxOutputTokens: options.maxOutputTokens ?? 16,
      batchAllowed: false,
    };
    const request: ChatRequest = {
      messages: [{ role: "user", content: options.prompt ?? "Reply with the single word: ready" }],
      maxOutputTokens: route.maxOutputTokens,
      cachePrefix: false,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const started = this.now();
    let usage = emptyUsage();
    let text = "";
    let status: LedgerEntry["status"] = "ok";
    try {
      for await (const ev of provider.chat(target.model, request)) {
        if (ev.type === "text") text += ev.text;
        if (ev.type === "done") usage = ev.usage;
      }
      return {
        text,
        usage,
        latencyMs: Math.max(0, this.now().getTime() - started.getTime()),
        costCents: price ? costCents(price, usage) : 0,
        ledgered: tenant !== null,
      };
    } catch (e) {
      status = options.signal?.aborted ? "aborted" : "error";
      throw e;
    } finally {
      if (tenant !== null)
        await this.record(
          "probe",
          { companyId: tenant, ref: { type: "provider", id: target.providerId } },
          route,
          price,
          usage,
          status,
          started,
        );
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
    if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
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

  /**
   * Streaming speech to text through the `stt_stream` route (FR-30a, D-77).
   *
   * Undefined when no route is configured, the signal `speak` and `embed` use: the live call then
   * transcribes per utterance through `transcription`, which is the rung below on the spec's chain,
   * rather than failing.
   *
   * Metered like `transcribe`: one ledger row per completed utterance, carrying whatever usage the
   * provider reported for it, and an error row if the session dies. The budget is checked when the
   * session opens; a session is one call, and the turns it feeds are each checked on their own.
   */
  async transcribeStream(ctx: CallContext, input: SttStreamInput): Promise<SttStreamSession | undefined> {
    const purpose: Purpose = "stt_stream";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const provider = await this.providerFor(ctx.companyId, route.providerId);
    if (!provider.transcribeStream || !provider.capabilities.streamingTranscription)
      throw new ProviderError(
        `Provider '${route.providerId}' cannot stream transcription`,
        "unsupported",
        false,
      );
    const price = this.deps.prices.get(route.providerId, route.model);
    const check = await this.deps.budget.check(ctx, 0);
    if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
    const opened = this.now();
    let session: SttStreamSession;
    try {
      session = await provider.transcribeStream(route.model, input);
    } catch (e) {
      await this.record(purpose, ctx, route, price, emptyUsage(), "error", opened);
      throw e;
    }
    const record = this.record.bind(this);
    const now = this.now;
    const routed: Route = route;
    // Each utterance is timed from the end of the previous one, so latency is per utterance.
    let since = now();
    async function* metered(): AsyncIterable<SttStreamEvent> {
      for await (const ev of session.events) {
        if (ev.type === "final") {
          await record(purpose, ctx, routed, price, ev.usage ?? emptyUsage(), "ok", since);
          since = now();
        } else if (ev.type === "error" && ev.fatal) {
          await record(purpose, ctx, routed, price, emptyUsage(), "error", since);
        } else if (ev.type === "speech_started") {
          since = now();
        }
        yield ev;
      }
    }
    return {
      push: (pcm) => {
        session.push(pcm);
      },
      close: () => {
        session.close();
      },
      events: metered(),
    };
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
    if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
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
    if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
    if (check.warnings.length) this.deps.onBudgetWarning?.(ctx, check.warnings);
    return { route, provider, price };
  }

  /** Records the refused call, tells the hook, and returns the error for the caller to throw. */
  private async refuse(
    purpose: Purpose,
    ctx: CallContext,
    route: Route,
    price: ReturnType<PriceTable["get"]>,
    check: BudgetCheck,
  ): Promise<BudgetExceededError> {
    await this.record(purpose, ctx, route, price, emptyUsage(), "budget_exceeded", this.now());
    const error = new BudgetExceededError(check);
    try {
      const told = await this.deps.onBudgetExceeded?.(ctx, check);
      error.notified = told?.notified === true;
    } catch {
      error.notified = false;
    }
    return error;
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
    if (req.signal) out.signal = req.signal;
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (effort && provider.capabilities.effort) out.effort = effort;
    return out;
  }

  /**
   * Speaks a piece of text through the `tts` route (FR-30a).
   *
   * Returns undefined when no route is configured, the same signal `embed` uses, because a tenant
   * without a speech model should fall back to a text interview rather than see an error: the
   * spec's fallback chain is real-time → recorded → text, without losing the session.
   *
   * The ledger row is written before the audio is consumed, not after. Synthesis is billed at the
   * moment the provider accepts the request, and barge-in means the stream is usually abandoned
   * part-way; waiting for the stream to end would under-count exactly the calls that get
   * interrupted, which in a live interview is most of them.
   */
  async speak(ctx: CallContext, input: SpeechInput, signal?: AbortSignal): Promise<SpeechOutput | undefined> {
    const purpose: Purpose = "tts";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const provider = await this.providerFor(ctx.companyId, route.providerId);
    if (!provider.speak)
      throw new ProviderError(`Provider '${route.providerId}' cannot speak`, "unsupported", false);
    const price = this.deps.prices.get(route.providerId, route.model);
    // Speech is priced per character. Charging it as output tokens is the closest the ledger's
    // shape allows, and roughly four characters to a token keeps the estimate honest enough to
    // stop a runaway before it empties a budget.
    const usage: Usage = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: Math.ceil(input.text.length / 4),
    };
    const check = await this.deps.budget.check(ctx, price ? estimateCents(price, 0, usage.outputTokens) : 0);
    if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
    const started = this.now();
    try {
      const out = await provider.speak(route.model, input, signal);
      await this.record(purpose, ctx, route, price, usage, "ok", started);
      return out;
    } catch (err) {
      await this.record(purpose, ctx, route, price, emptyUsage(), "error", started);
      throw err;
    }
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
