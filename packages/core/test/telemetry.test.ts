import { Writable } from "node:stream";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryJobPublisher } from "../src/jobs/definitions.js";
import { runBatch } from "../src/jobs/pg-boss.js";
import {
  PromMetrics,
  currentCarrier,
  currentLogBindings,
  pinoRedact,
  pinoSerializers,
  redactPath,
  redactUrl,
  runWithLogBindings,
  scrubLogText,
  startMetricsServer,
  withLogBindings,
  withSpan,
} from "../src/telemetry/index.js";

/** A pino instance with the shared redaction options, writing into an array of parsed lines. */
function logger(options: { development?: boolean } = {}): { log: pino.Logger; lines: () => string[] } {
  const out: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    log: pino({ redact: pinoRedact(options), serializers: pinoSerializers() }, stream),
    lines: () => out,
  };
}

describe("what is never logged (D-223)", () => {
  const TOKEN = "Zk3p9xQ2mVb7LrTn4WcYd8HfGa6JeUs1";

  it("hides the token in a participant link path and drops every query string", () => {
    expect(redactUrl(`/api/v1/p/${TOKEN}/open`)).toBe("/api/v1/p/<token>/open");
    expect(redactUrl(`/api/v1/p/r/${TOKEN}`)).toBe("/api/v1/p/r/<token>");
    expect(redactUrl(`/p/${TOKEN}`)).toBe("/p/<token>");
    expect(redactUrl(`/api/participant/p/${TOKEN}/verify/confirm`)).toBe(
      "/api/participant/p/<token>/verify/confirm",
    );
    expect(redactUrl(`/api/auth/callback/email?token=${TOKEN}&email=a%40b.io`)).toBe(
      "/api/auth/callback/email?<redacted>",
    );
    // Routes that merely start with /p/ are not tokens.
    expect(redactPath("/api/v1/p/session")).toBe("/api/v1/p/session");
    expect(redactPath("/api/v1/p/session/turns")).toBe("/api/v1/p/session/turns");
    expect(redactPath("/api/v1/campaigns/abc")).toBe("/api/v1/campaigns/abc");
  });

  it("scrubs tokens and addresses out of free text", () => {
    const text = scrubLogText(
      `GET /p/${TOKEN}/open failed for ada@example.com with Bearer abcdefghij123456 ?token=s3cr3t&x=1`,
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("abcdefghij123456");
    expect(text).not.toContain("s3cr3t");
    expect(text).toMatch(/<email:[0-9a-f]{8}>/);
  });

  it("never writes a link token, message text, an address, a secret or a filename", () => {
    const { log, lines } = logger();
    log.info(
      {
        req: { method: "POST", url: `/api/v1/p/${TOKEN}/open?code=123456`, headers: { cookie: "c=1" } },
        message: { text: "I told them about the medication round on ward 7" },
        answer: "the secret answer",
        user: { email: "ada@example.com", name: "Ada" },
        to: "grace@example.com",
        provider: { apiKey: "sk-live-abc", headers: { "x-api-key": "k" } },
        attachment: { filename: "payroll-2026.pdf" },
        sessionId: "s_123",
        tenantId: "c_456",
      },
      "request",
    );
    const text = lines().join("\n");
    for (const forbidden of [
      TOKEN,
      "123456",
      "medication round",
      "the secret answer",
      "ada@example.com",
      "grace@example.com",
      "sk-live-abc",
      "x-api-key",
      "payroll-2026",
      "c=1",
    ])
      expect(text, forbidden).not.toContain(forbidden);
    // What an operator needs is still there: ids, the route, the extension, a stable stand-in for the address.
    expect(text).toContain("s_123");
    expect(text).toContain("c_456");
    expect(text).toContain("/api/v1/p/<token>/open?<redacted>");
    expect(text).toContain(".pdf");
    expect(text).toMatch(/<email:[0-9a-f]{8}>/);
  });

  it("gives the same address the same stand-in, so two lines still correlate", () => {
    const { log, lines } = logger();
    log.info({ to: "ada@example.com" }, "a");
    log.info({ user: { email: "Ada@Example.com" } }, "b");
    const hashes = lines().map((l) => /<email:([0-9a-f]{8})>/.exec(l)?.[1]);
    expect(hashes[0]).toBeDefined();
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("leaves addresses and text readable in development, and still hides tokens and secrets", () => {
    const { log, lines } = logger({ development: true });
    log.info(
      { to: "ada@example.com", message: { text: "hello" }, provider: { apiKey: "sk-live-abc" } },
      "email (console)",
    );
    const text = lines().join("\n");
    expect(text).toContain("ada@example.com");
    expect(text).toContain("hello");
    expect(text).not.toContain("sk-live-abc");
  });

  it("scrubs the message of a logged error", () => {
    const { log, lines } = logger();
    log.error({ err: new Error(`could not send to ada@example.com via /p/${TOKEN}`) }, "failed");
    const text = lines().join("\n");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain(TOKEN);
  });
});

describe("log bindings", () => {
  it("carry the tenant and session to every line written inside the scope", () => {
    const written: Record<string, unknown>[] = [];
    const base = {
      info: (_m: string, meta?: Record<string, unknown>) => void written.push(meta ?? {}),
      warn: (_m: string, meta?: Record<string, unknown>) => void written.push(meta ?? {}),
    };
    const log = withLogBindings(base);
    log.info("outside");
    runWithLogBindings({ tenantId: "t1", sessionId: "s1" }, () => {
      log.info("inside", { extra: 1 });
      runWithLogBindings({ userId: "u1" }, () => {
        log.warn("nested");
      });
    });
    expect(written[0]).toEqual({});
    expect(written[1]).toMatchObject({ tenantId: "t1", sessionId: "s1", extra: 1 });
    expect(written[2]).toMatchObject({ tenantId: "t1", sessionId: "s1", userId: "u1" });
    expect(currentLogBindings().tenantId).toBeUndefined();
  });
});

describe("metrics (D-222)", () => {
  it("renders the Prometheus text format with histograms, counters and gauges", () => {
    const m = new PromMetrics();
    m.modelCall({
      purpose: "interview_turn",
      provider: "p1",
      model: "m",
      tenant: "t1",
      status: "ok",
      latencyMs: 1800,
      firstTokenMs: 600,
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 50,
      costCents: 1.25,
    });
    m.modelCall({
      purpose: "interview_turn",
      provider: "p1",
      model: "m",
      tenant: "t1",
      status: "error",
      latencyMs: 90,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
    m.voiceFirstWord("t1", "stream", 1100);
    m.queue("analysis.run", 3, 1, 2);
    m.job("session.extract", "error", 450, true);
    m.gauge("backup_last_success_timestamp_seconds", 1_790_000_000);
    m.budgetBlocked("t1", "campaign");
    const text = m.render();

    expect(text).toContain("# TYPE aidp_turn_first_token_seconds histogram");
    // 0.6 s falls in the 0.75 bucket and every one above it, not in 0.5.
    expect(text).toContain(
      'aidp_turn_first_token_seconds_bucket{purpose="interview_turn",provider="p1",model="m",tenant="t1",le="0.5"} 0',
    );
    expect(text).toContain(
      'aidp_turn_first_token_seconds_bucket{purpose="interview_turn",provider="p1",model="m",tenant="t1",le="0.75"} 1',
    );
    expect(text).toContain(
      'aidp_turn_first_token_seconds_bucket{purpose="interview_turn",provider="p1",model="m",tenant="t1",le="+Inf"} 1',
    );
    expect(text).toContain('aidp_voice_first_word_seconds_bucket{tenant="t1",mode="stream",le="1.25"} 1');
    expect(text).toContain(
      'aidp_model_tokens_total{kind="cache_read",purpose="interview_turn",provider="p1",tenant="t1"} 20',
    );
    expect(text).toContain('aidp_provider_errors_total{provider="p1",code="error"} 1');
    expect(text).toContain('aidp_jobs_dead_lettered{queue="analysis.run"} 2');
    expect(text).toContain('aidp_job_failures_total{name="session.extract",final="true"} 1');
    expect(text).toContain("aidp_backup_last_success_timestamp_seconds 1790000000");
    expect(text).toContain('aidp_budget_blocked_total{scope="campaign",tenant="t1"} 1');
  });

  it("escapes label values", () => {
    const m = new PromMetrics();
    m.http('/p/:"x"\n', "GET", 200, 5);
    expect(m.render()).toContain('route="/p/:\\"x\\"\\n"');
  });

  it("serves the registry on an internal port, and nothing else", async () => {
    const m = new PromMetrics();
    m.voiceEvent("t1", "interruption");
    const server = await startMetricsServer(m, { port: 0, host: "127.0.0.1" });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/plain");
      expect(await ok.text()).toContain('aidp_voice_events_total{tenant="t1",event="interruption"} 1');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("a job joins its session's trace (D-222)", () => {
  const exporter = new InMemorySpanExporter();
  let contextManager: AsyncLocalStorageContextManager;

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
  });
  afterAll(() => {
    trace.disable();
    propagation.disable();
    context.disable();
  });

  it("carries the publisher's traceparent in the payload and makes the job span its child", async () => {
    exporter.reset();
    const jobs = new MemoryJobPublisher();

    // The request side: a `session.turn` span queues a follow-up job.
    await withSpan("session.turn", { "session.id": "s1" }, async () => {
      await jobs.publish("session.extract", { sessionId: "s1", companyId: "c1" });
    });
    const published = jobs.published[0]!;
    const carrier = published.payload as { traceparent?: string };
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const turn = exporter.getFinishedSpans().find((s) => s.name === "session.turn")!;
    expect(carrier.traceparent).toContain(turn.spanContext().traceId);

    // The worker side: the batch runner takes the payload through the schema and runs the handler.
    let seenBindings: Record<string, unknown> = {};
    let insideTrace = "";
    await runBatch("session.extract", [{ id: "job-1", data: published.payload, retryCount: 1 }], async () => {
      seenBindings = currentLogBindings();
      insideTrace = trace.getActiveSpan()?.spanContext().traceId ?? "";
    });

    const spans = exporter.getFinishedSpans();
    const jobSpan = spans.find((s) => s.name === "job session.extract")!;
    expect(jobSpan.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(jobSpan.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(insideTrace).toBe(turn.spanContext().traceId);
    expect(jobSpan.attributes).toMatchObject({
      "job.name": "session.extract",
      "job.id": "job-1",
      "job.attempt": 2,
      "tenant.id": "c1",
      "session.id": "s1",
    });
    // The handler's log lines carry the same ids and the trace.
    expect(seenBindings).toMatchObject({
      job: "session.extract",
      jobId: "job-1",
      attempt: 2,
      tenantId: "c1",
      sessionId: "s1",
      traceId: turn.spanContext().traceId,
    });
  });

  it("publishes no trace context when nothing is being traced, so payloads are unchanged", async () => {
    const jobs = new MemoryJobPublisher();
    expect(currentCarrier()).toEqual({});
    await jobs.publish("session.extract", { sessionId: "s2", companyId: "c1" });
    expect(jobs.published[0]?.payload).toEqual({ sessionId: "s2", companyId: "c1" });
  });
});
