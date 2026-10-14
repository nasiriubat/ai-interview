import type {
  AttemptReport,
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
import { emptyUsage, STT_STREAM_SAMPLE_RATE } from "@aidp/shared";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { z } from "zod";
import { BudgetExceededError, type BudgetCheck, type BudgetGuard } from "./cost/budget.js";
import type { LedgerSink } from "./cost/ledger.js";
import { costCents, estimateCents, estimateTokens, type PriceTable } from "./cost/pricing.js";
import { countsAgainstProvider, type CircuitBreaker } from "./providers/breaker.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { ProviderError, type Provider } from "./providers/types.js";

/**
 * The refusal for a capability the admission step already checked. Calls are made with optional
 * chaining and a missing result lands here, so there is no non-null assertion at the call sites and
 * a provider swapped between the two steps gets the refusal admission would have given.
 */
const cannot = (route: Route, what: string): ProviderError =>
  new ProviderError(`Provider '${route.providerId}' cannot ${what}`, "unsupported", false);

/** Bytes of PCM16 mono audio per second at the streaming rate. */
const STREAM_BYTES_PER_SECOND = STT_STREAM_SAMPLE_RATE * 2;

/** Spans are no-ops until the process starts an SDK (packages/core telemetry), so tests pay nothing. */
const tracer = trace.getTracer("aidp.ai");

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

/** What a metrics sink hears about every ledger row. Must not throw into the call path. */
export interface CallObserver {
  recorded(entry: LedgerEntry): void;
}

/** What the caller reports when a purpose's fallback route served a call (D-228). */
export interface FallbackNotice {
  companyId: string;
  purpose: Purpose;
  /** The provider that was skipped or failed. */
  fromProviderId: string;
  /** The fallback provider that served the call. */
  toProviderId: string;
  reason: "circuit_open" | "error";
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
  /** Hears every ledger row after it is written: the metrics sink (D-222). */
  observer?: CallObserver;
  /**
   * The per-provider circuit breaker, shared by every caller in the process (D-228). Without it
   * calls go straight to the provider, as before.
   */
  breaker?: CircuitBreaker;
  /**
   * Fallback routes: tried when the primary's circuit is open, or when the primary fails with a
   * provider-side error before producing any output. A purpose with none behaves as before.
   */
  fallbackRoutes?: RouteResolver;
  onFallback?: (notice: FallbackNotice) => void;
}

/** One provider and route a call is about to be made against. */
interface Attempt {
  route: Route;
  provider: Provider;
  price: ReturnType<PriceTable["get"]>;
  tier: "primary" | "fallback";
}

/** Builds an attempt for a route: provider loaded, capability checked, budget checked. */
type Admit = (route: Route, tier: "primary" | "fallback") => Promise<Attempt>;

interface RecordExtras {
  latencyMs?: number;
  firstTokenMs?: number;
  estimated?: boolean;
  tier?: "primary" | "fallback";
  span?: Span;
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
    const admit = this.chatAdmit(purpose, ctx, req);
    let attempt = await this.begin(purpose, ctx, await this.primaryRoute(purpose, ctx), admit);
    for (;;) {
      const failure = yield* this.chatOnce(purpose, ctx, req, attempt);
      if (failure === undefined) return;
      // The provider failed before saying anything, so nothing reached the caller yet and the
      // call can move to the purpose's fallback route without the participant seeing a seam.
      const next = await this.fallbackAfterFailure(purpose, ctx, attempt, admit);
      if (!next) throw failure;
      attempt = next;
    }
  }

  /**
   * One streamed attempt against one provider. Returns the provider-side error when the attempt
   * failed before any output and a fallback may be tried; throws every other failure.
   */
  private async *chatOnce(
    purpose: Purpose,
    ctx: CallContext,
    req: CallRequest,
    attempt: Attempt,
  ): AsyncGenerator<ChatEvent, ProviderError | undefined> {
    const { route, provider, price, tier } = attempt;
    const fullReq = this.applyRoute(route, provider, req);
    const started = this.now();
    const span = this.startSpan(purpose, ctx, route, tier);
    let usage = emptyUsage();
    let status: LedgerEntry["status"] = "ok";
    let streamed = "";
    let finished = false;
    let estimated = false;
    let firstTokenMs: number | undefined;
    let settled = false;
    let handoff: ProviderError | undefined;
    try {
      for await (const ev of provider.chat(route.model, fullReq)) {
        // An adapter that ignores the signal must not keep a cancelled turn alive.
        if (req.signal?.aborted) throw new CallAbortedError();
        if (ev.type === "text") {
          firstTokenMs ??= this.elapsed(started);
          streamed += ev.text;
        }
        if (ev.type === "done") {
          finished = true;
          usage = ev.usage;
          if (ev.stopReason === "refusal") status = "refused";
        }
        yield ev;
      }
      if (finished) {
        this.deps.breaker?.success(route.providerId);
        settled = true;
      }
    } catch (e) {
      if (req.signal?.aborted) {
        status = "aborted";
        // The provider reports usage only at the end of a stream, and an aborted stream never
        // gets there, so what it cost is estimated from what was sent and what arrived. Recording
        // zero here is how abandoned streams used to look free.
        usage = this.abortedUsage(req, streamed);
        estimated = true;
        throw e instanceof CallAbortedError ? e : new CallAbortedError(e);
      }
      status = e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      usage = this.failedUsage(req, e, streamed, fullReq.maxOutputTokens);
      estimated = usage.inputTokens > 0 || usage.outputTokens > 0;
      if (e instanceof ProviderError && countsAgainstProvider(e)) {
        this.deps.breaker?.failure(route.providerId);
        settled = true;
        // Only before output: once words have gone out the turn cannot be restarted elsewhere.
        if (tier === "primary" && streamed === "") handoff = e;
        else throw e;
      } else {
        throw e;
      }
    } finally {
      // The consumer abandoning the generator (an early `return`, a barge-in) lands here with the
      // status still "ok" and no `done` event seen: the same situation as an abort, recorded as one.
      if (status === "ok" && !finished) {
        status = "aborted";
        usage = this.abortedUsage(req, streamed);
        estimated = true;
      }
      if (!settled) this.deps.breaker?.release(route.providerId);
      await this.record(purpose, ctx, route, price, usage, status, started, {
        ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
        ...(estimated ? { estimated } : {}),
        tier,
        span,
      });
    }
    return handoff;
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
    const admit = this.chatAdmit(purpose, ctx, req);
    return this.guarded(purpose, ctx, await this.primaryRoute(purpose, ctx), admit, (a) =>
      this.completeOnce(purpose, ctx, req, a, schema, schemaName),
    );
  }

  private async completeOnce<T>(
    purpose: Purpose,
    ctx: CallContext,
    req: CallRequest,
    attempt: Attempt,
    schema: z.ZodType<T>,
    schemaName?: string,
  ): Promise<T> {
    const { route, provider, price, tier } = attempt;
    const fullReq = this.applyRoute(route, provider, req);
    const started = this.now();
    const span = this.startSpan(purpose, ctx, route, tier);
    // Every HTTP attempt the adapter makes reports itself here, so each one is its own ledger row:
    // the rejected strict-schema first attempt, the answer that failed validation, and the retry
    // that succeeded. An adapter that does not report (Anthropic's SDK parses internally) leaves
    // this empty and the outcome is booked as one row, as before.
    const attempts: AttemptReport[] = [];
    const observed: ChatRequest = { ...fullReq, onAttempt: (a) => attempts.push(a) };
    try {
      const res = await provider.complete(route.model, observed, schema, schemaName);
      if (attempts.length === 0) {
        await this.record(purpose, ctx, route, price, res.usage, "ok", started, { tier, span });
      } else {
        for (const [i, a] of attempts.entries())
          await this.record(purpose, ctx, route, price, a.usage, a.ok ? "ok" : "error", started, {
            latencyMs: a.latencyMs,
            tier,
            ...(i === attempts.length - 1 ? { span } : {}),
          });
      }
      return res.value;
    } catch (e) {
      if (req.signal?.aborted) {
        await this.record(purpose, ctx, route, price, this.abortedUsage(req, ""), "aborted", started, {
          estimated: true,
          tier,
          span,
        });
        throw e instanceof CallAbortedError ? e : new CallAbortedError(e);
      }
      const status: LedgerEntry["status"] =
        e instanceof ProviderError && e.code === "refusal" ? "refused" : "error";
      if (attempts.length === 0) {
        const usage = this.failedUsage(req, e, "", fullReq.maxOutputTokens);
        await this.record(purpose, ctx, route, price, usage, status, started, {
          ...(usage.inputTokens > 0 || usage.outputTokens > 0 ? { estimated: true } : {}),
          tier,
          span,
        });
      } else {
        // The last attempt carries the call's final status; earlier ones are plain errors.
        for (const [i, a] of attempts.entries())
          await this.record(
            purpose,
            ctx,
            route,
            price,
            a.usage,
            i === attempts.length - 1 && !a.ok ? status : a.ok ? "ok" : "error",
            started,
            {
              latencyMs: a.latencyMs,
              tier,
              ...(i === attempts.length - 1 ? { span } : {}),
            },
          );
      }
      throw e;
    }
  }

  /**
   * What a failed call is booked at when the provider reported nothing. A provider that rejected
   * the request outright (bad key, bad request, unsupported, rate limited) did no work and is
   * booked at zero; anything else may have run, so the prompt is booked, and for an answer that
   * came back unusable the whole output allowance, which is the most it could have cost. Booking
   * zero here is how failed calls used to look free (live run 2026-10-14, bug 7).
   */
  private failedUsage(req: CallRequest, e: unknown, streamed: string, maxOutputTokens: number): Usage {
    const code = e instanceof ProviderError ? e.code : "server";
    if (
      code === "auth" ||
      code === "bad_request" ||
      code === "not_found" ||
      code === "unsupported" ||
      code === "rate_limit"
    )
      return emptyUsage();
    return {
      inputTokens: estimateTokens((req.system ?? "") + JSON.stringify(req.messages)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: code === "parse" ? maxOutputTokens : estimateTokens(streamed),
    };
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

  /**
   * Audio to text through the `transcription` route.
   *
   * Booked in audio seconds: what the provider measured (`durationSeconds` on the transcript), or
   * what the caller knew about the recording, or, failing both, nothing (D-220). The budget check
   * before the call prices the expected minutes so a spent budget refuses audio too.
   */
  async transcribe(ctx: CallContext, input: TranscriptionInput): Promise<Transcript> {
    const purpose: Purpose = "transcription";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) throw new ProviderError(`No route configured for purpose '${purpose}'`, "unsupported", false);
    const admit: Admit = async (r, tier) => {
      const provider = await this.providerFor(ctx.companyId, r.providerId);
      if (!provider.transcribe)
        throw new ProviderError(`Provider '${r.providerId}' cannot transcribe audio`, "unsupported", false);
      const price = this.deps.prices.get(r.providerId, r.model);
      const expectedSeconds = input.durationSeconds ?? 60;
      const estimate = price ? costCents(price, { ...emptyUsage(), audioSeconds: expectedSeconds }) : 0;
      const check = await this.deps.budget.check(ctx, estimate);
      if (!check.allowed) throw await this.refuse(purpose, ctx, r, price, check);
      return { route: r, provider, price, tier };
    };
    return this.guarded(purpose, ctx, route, admit, async (a) => {
      const started = this.now();
      const span = this.startSpan(purpose, ctx, a.route, a.tier);
      let usage = emptyUsage();
      let status: LedgerEntry["status"] = "ok";
      try {
        const res = await a.provider.transcribe?.(a.route.model, input);
        if (!res) throw cannot(a.route, "transcribe audio");
        const seconds = res.transcript.durationSeconds ?? input.durationSeconds;
        usage = { ...res.usage, ...(seconds !== undefined ? { audioSeconds: seconds } : {}) };
        return res.transcript;
      } catch (e) {
        status = "error";
        throw e;
      } finally {
        await this.record(purpose, ctx, a.route, a.price, usage, status, started, { tier: a.tier, span });
      }
    });
  }

  /**
   * Streaming speech to text through the `stt_stream` route (FR-30a, D-77).
   *
   * Undefined when no route is configured, the signal `speak` and `embed` use: the live call then
   * transcribes per utterance through `transcription`, which is the rung below on the spec's chain,
   * rather than failing.
   *
   * Metered like `transcribe`: one ledger row per completed utterance in audio seconds (what the
   * provider said the utterance lasted, else the PCM actually pushed), and a row for audio that
   * never reached a final: a fatal error or a call that ended mid-utterance, booked as an
   * estimate (D-221). The budget is checked when the session opens; a session is one call, and
   * the turns it feeds are each checked on their own.
   */
  async transcribeStream(ctx: CallContext, input: SttStreamInput): Promise<SttStreamSession | undefined> {
    const purpose: Purpose = "stt_stream";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const admit: Admit = async (r, tier) => {
      const provider = await this.providerFor(ctx.companyId, r.providerId);
      if (!provider.transcribeStream || !provider.capabilities.streamingTranscription)
        throw new ProviderError(
          `Provider '${r.providerId}' cannot stream transcription`,
          "unsupported",
          false,
        );
      const price = this.deps.prices.get(r.providerId, r.model);
      // A session is open-ended; one minute is the unit a refusal is judged by.
      const estimate = price ? costCents(price, { ...emptyUsage(), audioSeconds: 60 }) : 0;
      const check = await this.deps.budget.check(ctx, estimate);
      if (!check.allowed) throw await this.refuse(purpose, ctx, r, price, check);
      return { route: r, provider, price, tier };
    };
    return this.guarded(purpose, ctx, route, admit, async (a) => {
      const opened = this.now();
      let session: SttStreamSession;
      try {
        const accepted = await a.provider.transcribeStream?.(a.route.model, input);
        if (!accepted) throw cannot(a.route, "stream transcription");
        session = accepted;
      } catch (e) {
        await this.record(purpose, ctx, a.route, a.price, emptyUsage(), "error", opened, { tier: a.tier });
        throw e;
      }
      const record = this.record.bind(this);
      const now = this.now;
      const breaker = this.deps.breaker;
      const routed = a.route;
      const price = a.price;
      const tier = a.tier;
      // PCM pushed since the last `final`: the audio an unfinished utterance has cost so far.
      let pendingBytes = 0;
      // Each utterance is timed from the end of the previous one, so latency is per utterance.
      let since = now();
      async function* metered(): AsyncIterable<SttStreamEvent> {
        try {
          for await (const ev of session.events) {
            if (ev.type === "final") {
              const reported = ev.durationSeconds;
              const seconds = reported ?? pendingBytes / STREAM_BYTES_PER_SECOND;
              const usage: Usage = { ...(ev.usage ?? emptyUsage()), audioSeconds: seconds };
              await record(purpose, ctx, routed, price, usage, "ok", since, {
                tier,
                ...(reported === undefined && pendingBytes > 0 ? { estimated: true } : {}),
              });
              pendingBytes = 0;
              since = now();
            } else if (ev.type === "error" && ev.fatal) {
              breaker?.failure(routed.providerId);
              const usage: Usage = {
                ...emptyUsage(),
                audioSeconds: pendingBytes / STREAM_BYTES_PER_SECOND,
              };
              await record(purpose, ctx, routed, price, usage, "error", since, {
                tier,
                ...(pendingBytes > 0 ? { estimated: true } : {}),
              });
              pendingBytes = 0;
            } else if (ev.type === "speech_started") {
              since = now();
            }
            yield ev;
          }
        } finally {
          // The call ended with audio the provider never finalised (hung up mid-sentence). It was
          // still sent, so it is still billed; book what was pushed.
          if (pendingBytes > 0) {
            const usage: Usage = { ...emptyUsage(), audioSeconds: pendingBytes / STREAM_BYTES_PER_SECOND };
            pendingBytes = 0;
            await record(purpose, ctx, routed, price, usage, "aborted", since, { tier, estimated: true });
          }
        }
      }
      return {
        push: (pcm) => {
          pendingBytes += pcm.byteLength;
          session.push(pcm);
        },
        close: () => {
          session.close();
        },
        events: metered(),
      } satisfies SttStreamSession;
    });
  }

  /** Embeddings through the `embedding` route, or undefined when no route is configured (callers fall back). */
  async embed(
    ctx: CallContext,
    texts: string[],
  ): Promise<{ vectors: number[][]; model: string } | undefined> {
    const purpose: Purpose = "embedding";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const admit: Admit = async (r, tier) => {
      const provider = await this.providerFor(ctx.companyId, r.providerId);
      if (!provider.embed)
        throw new ProviderError(`Provider '${r.providerId}' cannot embed text`, "unsupported", false);
      const price = this.deps.prices.get(r.providerId, r.model);
      const inputTokens = estimateTokens(texts.join(" "));
      const check = await this.deps.budget.check(ctx, price ? estimateCents(price, inputTokens, 0) : 0);
      if (!check.allowed) throw await this.refuse(purpose, ctx, r, price, check);
      return { route: r, provider, price, tier };
    };
    return this.guarded(purpose, ctx, route, admit, async (a) => {
      const started = this.now();
      const span = this.startSpan(purpose, ctx, a.route, a.tier);
      let usage = emptyUsage();
      let status: LedgerEntry["status"] = "ok";
      try {
        const res = await a.provider.embed?.(a.route.model, texts);
        if (!res) throw cannot(a.route, "embed text");
        usage = res.usage;
        return { vectors: res.vectors, model: a.route.model };
      } catch (e) {
        status = "error";
        throw e;
      } finally {
        await this.record(purpose, ctx, a.route, a.price, usage, status, started, { tier: a.tier, span });
      }
    });
  }

  /** Resolves the primary route for a purpose or says there is none. */
  private async primaryRoute(purpose: Purpose, ctx: CallContext): Promise<Route> {
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) throw new ProviderError(`No route configured for purpose '${purpose}'`, "unsupported", false);
    return route;
  }

  /** The admission step for chat and complete: provider loaded, budget checked with the prompt estimate. */
  private chatAdmit(purpose: Purpose, ctx: CallContext, req: CallRequest): Admit {
    return async (route, tier) => {
      const provider = await this.providerFor(ctx.companyId, route.providerId);
      const price = this.deps.prices.get(route.providerId, route.model);
      const inputTokens = estimateTokens((req.system ?? "") + JSON.stringify(req.messages));
      const estimate = price
        ? estimateCents(price, inputTokens, req.maxOutputTokens ?? route.maxOutputTokens)
        : 0;
      const check = await this.deps.budget.check(ctx, estimate);
      if (!check.allowed) throw await this.refuse(purpose, ctx, route, price, check);
      if (check.warnings.length) this.deps.onBudgetWarning?.(ctx, check.warnings);
      return { route, provider, price, tier };
    };
  }

  /**
   * Admits the primary route and asks the breaker for a slot on it. A circuit that is open sends
   * the call to the fallback route at once, or, with none, refuses it fast with a retryable error
   * rather than spending the participant's patience on a provider known to be down.
   */
  private async begin(purpose: Purpose, ctx: CallContext, route: Route, admit: Admit): Promise<Attempt> {
    const attempt = await admit(route, "primary");
    const breaker = this.deps.breaker;
    if (!breaker || breaker.tryAcquire(route.providerId)) return attempt;
    const fallback = await this.fallbackAttempt(purpose, ctx, attempt, admit, "circuit_open");
    if (fallback) return fallback;
    throw new ProviderError(`Provider '${route.providerId}' is temporarily unavailable`, "server", true);
  }

  /** The fallback route's attempt after the primary failed; undefined when there is none to try. */
  private async fallbackAfterFailure(
    purpose: Purpose,
    ctx: CallContext,
    failed: Attempt,
    admit: Admit,
  ): Promise<Attempt | undefined> {
    if (failed.tier === "fallback") return undefined;
    return this.fallbackAttempt(purpose, ctx, failed, admit, "error");
  }

  private async fallbackAttempt(
    purpose: Purpose,
    ctx: CallContext,
    primary: Attempt,
    admit: Admit,
    reason: FallbackNotice["reason"],
  ): Promise<Attempt | undefined> {
    const resolver = this.deps.fallbackRoutes;
    if (!resolver) return undefined;
    const route = await resolver.resolve(ctx.companyId, purpose);
    if (!route || route.providerId === primary.route.providerId) return undefined;
    let attempt: Attempt;
    try {
      attempt = await admit(route, "fallback");
    } catch (e) {
      // A spent budget is the tenant's to hear about; a fallback that is itself unusable (not
      // configured for this tenant, cannot do this purpose) leaves the original failure to speak.
      if (e instanceof BudgetExceededError) throw e;
      return undefined;
    }
    const breaker = this.deps.breaker;
    if (breaker && !breaker.tryAcquire(route.providerId)) return undefined;
    this.deps.onFallback?.({
      companyId: ctx.companyId,
      purpose,
      fromProviderId: primary.route.providerId,
      toProviderId: route.providerId,
      reason,
    });
    return attempt;
  }

  /**
   * Runs a non-streaming call against the primary route and, if the primary fails provider-side,
   * once against the fallback. `run` writes its own ledger rows, so each attempt is its own row.
   */
  private async guarded<R>(
    purpose: Purpose,
    ctx: CallContext,
    route: Route,
    admit: Admit,
    run: (attempt: Attempt) => Promise<R>,
  ): Promise<R> {
    let attempt = await this.begin(purpose, ctx, route, admit);
    for (;;) {
      try {
        const out = await run(attempt);
        this.deps.breaker?.success(attempt.route.providerId);
        return out;
      } catch (e) {
        if (!countsAgainstProvider(e)) {
          this.deps.breaker?.release(attempt.route.providerId);
          throw e;
        }
        this.deps.breaker?.failure(attempt.route.providerId);
        const next = await this.fallbackAfterFailure(purpose, ctx, attempt, admit);
        if (!next) throw e;
        attempt = next;
      }
    }
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
    // Hidden reasoning is spent from the same output allowance as the answer and is billed as
    // output. Interview turns, extraction, clustering and the rest are bounded transformations
    // that do not want it; only a route that asks for high effort keeps it. Adapters without the
    // control ignore the field.
    if (!effort || !["high", "xhigh", "max"].includes(effort)) out.reasoning = "off";
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
   *
   * Booked in characters (D-220): the unit speech is priced in. A model priced only per token
   * keeps the older approximation of four characters to an output token.
   */
  async speak(ctx: CallContext, input: SpeechInput, signal?: AbortSignal): Promise<SpeechOutput | undefined> {
    const purpose: Purpose = "tts";
    const route = await this.deps.routes.resolve(ctx.companyId, purpose);
    if (!route) return undefined;
    const usageFor = (price: ReturnType<PriceTable["get"]>): Usage => ({
      ...emptyUsage(),
      ttsCharacters: input.text.length,
      ...(price?.ttsPerMChars === undefined ? { outputTokens: Math.ceil(input.text.length / 4) } : {}),
    });
    const admit: Admit = async (r, tier) => {
      const provider = await this.providerFor(ctx.companyId, r.providerId);
      if (!provider.speak)
        throw new ProviderError(`Provider '${r.providerId}' cannot speak`, "unsupported", false);
      const price = this.deps.prices.get(r.providerId, r.model);
      const check = await this.deps.budget.check(ctx, price ? costCents(price, usageFor(price)) : 0);
      if (!check.allowed) throw await this.refuse(purpose, ctx, r, price, check);
      return { route: r, provider, price, tier };
    };
    return this.guarded(purpose, ctx, route, admit, async (a) => {
      const started = this.now();
      const span = this.startSpan(purpose, ctx, a.route, a.tier);
      try {
        const out = await a.provider.speak?.(a.route.model, input, signal);
        if (!out) throw cannot(a.route, "speak");
        await this.record(purpose, ctx, a.route, a.price, usageFor(a.price), "ok", started, {
          tier: a.tier,
          span,
        });
        return out;
      } catch (err) {
        await this.record(purpose, ctx, a.route, a.price, emptyUsage(), "error", started, {
          tier: a.tier,
          span,
        });
        throw err;
      }
    });
  }

  private elapsed(started: Date): number {
    return Math.max(0, this.now().getTime() - started.getTime());
  }

  private startSpan(purpose: Purpose, ctx: CallContext, route: Route, tier: "primary" | "fallback"): Span {
    return tracer.startSpan("model.call", {
      attributes: {
        "ai.purpose": purpose,
        "ai.provider_id": route.providerId,
        "ai.model": route.model,
        "ai.route_tier": tier,
        "tenant.id": ctx.companyId,
        ...(ctx.sessionId ? { "session.id": ctx.sessionId } : {}),
        ...(ctx.promptVersion ? { "ai.prompt_version": ctx.promptVersion } : {}),
      },
    });
  }

  private async record(
    purpose: Purpose,
    ctx: CallContext,
    route: Route,
    price: ReturnType<PriceTable["get"]>,
    usage: Usage,
    status: LedgerEntry["status"],
    started: Date,
    extras: RecordExtras = {},
  ): Promise<void> {
    const entry: LedgerEntry = {
      companyId: ctx.companyId,
      purpose,
      providerId: route.providerId,
      model: route.model,
      usage,
      latencyMs: extras.latencyMs ?? this.elapsed(started),
      status,
      costCents: price ? costCents(price, usage) : 0,
      createdAt: this.now(),
      ...(ctx.promptVersion ? { promptVersion: ctx.promptVersion } : {}),
      ...(ctx.ref ? { ref: ctx.ref } : {}),
      ...(ctx.campaignId ? { campaignId: ctx.campaignId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(extras.firstTokenMs !== undefined ? { firstTokenMs: extras.firstTokenMs } : {}),
      ...(extras.estimated ? { estimated: true } : {}),
      ...(extras.tier === "fallback" ? { routeTier: "fallback" as const } : {}),
    };
    const { span } = extras;
    try {
      await this.deps.ledger.record(entry);
    } finally {
      if (span) {
        span.setAttributes({
          "ai.status": status,
          "ai.tokens.input": usage.inputTokens,
          "ai.tokens.cache_read": usage.cacheReadTokens,
          "ai.tokens.cache_write": usage.cacheWriteTokens,
          "ai.tokens.output": usage.outputTokens,
          "ai.audio_seconds": usage.audioSeconds ?? 0,
          "ai.tts_chars": usage.ttsCharacters ?? 0,
          "ai.cost_cents": entry.costCents,
          "ai.estimated": entry.estimated === true,
          ...(entry.firstTokenMs !== undefined ? { "ai.first_token_ms": entry.firstTokenMs } : {}),
        });
        if (status === "error") span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
    }
    try {
      this.deps.observer?.recorded(entry);
    } catch {
      // A metrics sink must never fail a model call.
    }
  }
}
