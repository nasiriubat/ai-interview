import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

/**
 * The trace context a job payload carries (D-222): the W3C `traceparent` (and `tracestate`) of the
 * span that published it. A job that runs an hour later still joins its session's trace, because
 * the operator wants one trace per interview rather than one per process.
 */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

const tracer = trace.getTracer("aidp");

/** The active span's context as a carrier; empty when no SDK is running or nothing is active. */
export function currentCarrier(): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  };
}

/** The context a carrier describes, or the root context when it carries none. */
export function contextFrom(carrier: TraceCarrier | undefined): Context {
  if (!carrier?.traceparent) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** Ids of the active span, for log lines; undefined outside a span or without an SDK. */
export function activeTraceIds(): { traceId: string; spanId: string } | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/** Runs `fn` inside a span that is active for its duration and ends with it. Errors mark the span. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { kind?: SpanKind; parent?: Context } = {},
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes, ...(options.kind !== undefined ? { kind: options.kind } : {}) },
    options.parent ?? context.active(),
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.name : "error",
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

export { SpanKind };
