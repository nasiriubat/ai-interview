import type { NodeSDK } from "@opentelemetry/sdk-node";

/**
 * Tracing (spec 12), shared by the API and the worker (D-222). Starts only when an OTLP endpoint
 * is configured, so local dev and tests pay nothing — and "nothing" includes loading it: the
 * auto-instrumentation bundle is about forty packages, measured at 40 MB of memory and 270 ms of
 * startup in the server image, so it is imported here, behind the check, rather than at the top of
 * the file where every process paid for it.
 *
 * Call it before the first import that should be instrumented is used (before `PrismaClient` is
 * constructed): auto-instrumentation patches modules as they load.
 *
 * Without an endpoint no SDK is registered, `@opentelemetry/api` hands out no-op tracers, and the
 * custom spans in the engine, the model caller and the job wrapper cost one function call each.
 */
export async function startTelemetry(
  serviceName: string,
  endpoint: string | undefined,
): Promise<NodeSDK | undefined> {
  if (!endpoint) return undefined;
  const [{ getNodeAutoInstrumentations }, { OTLPTraceExporter }, { NodeSDK: Sdk }] = await Promise.all([
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/sdk-node"),
  ]);
  const sdk = new Sdk({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });
  sdk.start();
  return sdk;
}
