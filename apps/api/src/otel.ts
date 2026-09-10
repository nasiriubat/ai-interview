import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

/**
 * Tracing (spec 12). Starts only when an OTLP endpoint is configured, so local dev and
 * tests pay nothing. Must be imported before Fastify so HTTP and pg are instrumented.
 */
export function startTelemetry(serviceName: string, endpoint: string | undefined): NodeSDK | undefined {
  if (!endpoint) return undefined;
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
    ],
  });
  sdk.start();
  return sdk;
}
