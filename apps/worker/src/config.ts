import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PLATFORM_ENCRYPTION_KEY: z.string().min(1),
  /** Comma-separated keys that stay readable during a rotation (D-164); empty when none. */
  PLATFORM_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  EMAIL_SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  /** Where uploaded audio and documents live. Unset keeps them in memory, which loses them. */
  UPLOAD_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  /**
   * Outbound-connection policy for tenant-supplied addresses (provider base URLs, SMTP relays).
   * `strict` is the only mode a production process accepts. See packages/core/src/net/egress.ts.
   */
  EGRESS_MODE: z.enum(["strict", "permissive"]).default("strict"),
  /** Comma-separated hostnames a platform provider may reach on a private address (compose services). */
  EGRESS_ALLOW_HOSTS: z.string().default(""),
  // Operator alerting (D-90); see apps/api/src/config.ts. Same variables, same fallbacks.
  ALERT_EMAIL: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().optional(),
  // Compose passes an unset variable through as the empty string, which is "not set" here.
  ALERT_WEBHOOK_FORMAT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["ntfy", "slack", "generic"]).optional(),
  ),
  /**
   * The shared `ops_state` volume (D-92): the backup writes `status/backup.json` there and the
   * worker writes `heartbeat/worker`. Unset in development, where neither check is meaningful.
   */
  OPS_STATE_DIR: z.string().optional(),
  /** The file the container healthcheck reads; defaults under OPS_STATE_DIR. */
  HEARTBEAT_FILE: z.string().optional(),
  /** OTLP/HTTP trace endpoint; unset leaves tracing off and costs nothing (D-222). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /**
   * Port of the Prometheus scrape endpoint, on the compose network only (D-222). Unset or 0 turns
   * it off. Compose passes an unset variable through as "", which is "not set" here.
   */
  METRICS_PORT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(65535).default(0),
  ),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * How long running jobs may take after SIGTERM before they are aborted and redelivered. Keep it
   * under the container's stop_grace_period (40 s in the compose files) or the orchestrator kills
   * the process before it can say what it abandoned.
   */
  WORKER_SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(1).max(600).default(25),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}
