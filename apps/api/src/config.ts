import { smtpRelayUrlFromEnv } from "@aidp/shared";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  /** How long turns in flight may keep streaming after SIGTERM before they are told to retry. */
  API_SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(20),
  DATABASE_URL: z.string().min(1),
  PLATFORM_ENCRYPTION_KEY: z.string().min(1),
  /** Comma-separated keys that stay readable during a rotation (D-164); empty when none. */
  PLATFORM_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  AUTH_SECRET: z.string().min(16),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  /** Where uploaded audio and documents live. Unset keeps them in memory, which loses them. */
  UPLOAD_DIR: z.string().optional(),
  // The deployment's mail relay (D-445): the same fields as the admin form. Read through
  // `resolveSmtpEnv` in loadConfig, which composes them into `smtpRelayUrl`.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_SECURITY: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Deprecated (D-446): one-URL form, read only when SMTP_HOST is not set. */
  EMAIL_SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /**
   * Port of the Prometheus scrape endpoint (D-222), on the compose network and in no proxy route.
   * Unset or 0 turns it off. Compose passes an unset variable through as "".
   */
  METRICS_PORT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(65535).default(0),
  ),
  /** The running release, shown on the operator health page. Set by compose from AIDP_VERSION. */
  AIDP_VERSION: z.string().optional(),
  /** The shared `ops_state` volume: backup status, worker heartbeat, the erasure file (D-92). */
  OPS_STATE_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  // Operator alerting (D-90). Both are optional fallbacks: the settings catalog (`ops.alertEmail`,
  // `ops.alertWebhookUrl`) wins when set, and `deploy/ops/notify.sh` reads these two directly
  // because it has to work when the database does not.
  ALERT_EMAIL: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().optional(),
  // Compose passes an unset variable through as the empty string, which is "not set" here.
  ALERT_WEBHOOK_FORMAT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["ntfy", "slack", "generic"]).optional(),
  ),
  /**
   * Outbound-connection policy for tenant-supplied addresses (provider base URLs, SMTP relays).
   * `strict` is the only mode a production process accepts. See packages/core/src/net/egress.ts.
   */
  EGRESS_MODE: z.enum(["strict", "permissive"]).default("strict"),
  /** Comma-separated hostnames a platform provider may reach on a private address (compose services). */
  EGRESS_ALLOW_HOSTS: z.string().default(""),
  /**
   * The diagram renderer (Kroki, with its Mermaid companion) used by PDF export and by the diagram
   * editor (D-210). From the environment only, never a tenant setting, and reached through the
   * egress guard, so its host must be in EGRESS_ALLOW_HOSTS when it is a compose service name. Unset
   * means no renderer: diagrams are printed as source and saved unverified. Compose passes an unset
   * variable as the empty string, which is "not set" here.
   */
  KROKI_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.url({ protocol: /^https?$/, hostname: z.regexes.hostname }).optional(),
  ),
  /**
   * Reverse proxies between the internet and this process that set X-Forwarded-For, counted from
   * this side. Caddy in front of the web app (which forwards the one address Caddy wrote) is one
   * hop; the live-voice socket reaches the API straight from Caddy, also one. Anything other than
   * the real topology makes the client address, and so every per-address rate limit, spoofable
   * (D-82). Zero means "no proxy; trust only the socket".
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /**
   * Where the admin's one-step live voice setup checks an OpenAI key and points the provider it
   * creates (D-77). Unset means OpenAI itself; set it for a regional endpoint or a proxy. The test
   * suite points it at its fake model server so no test reaches the network.
   */
  OPENAI_BASE_URL: z.url().optional(),
  // Rate limiting (NFR, spec 11 "Rate limits per participant, per tenant, per IP"). These are
  // configuration rather than settings-catalog keys: the limiter runs in an onRequest hook before
  // any tenant is known, it has to hold for anonymous and participant callers too, and a catalog
  // lookup is a database read the limiter exists to avoid. See lib/rate-limit.ts.
  /** Requests per minute per principal on every route without a tighter limit of its own. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /** Requests per minute per principal on routes that call a model or a provider. */
  RATE_LIMIT_EXPENSIVE_MAX: z.coerce.number().int().positive().default(20),
  /**
   * Requests per minute per client address on the public participant routes that resolve and open
   * an interview link (D-310). The landing and the open each have their own bucket, so this is
   * people a minute per address: 120 lets a hundred colleagues behind one office address open the
   * link in the same minute. It was 30, and the second drill turned away 60 of 90 people arriving
   * from one address in a minute. This bucket is about one client flooding; what a link may cost
   * is the job of the campaign and tenant caps (`abuse.*`).
   */
  RATE_LIMIT_PUBLIC_MAX: z.coerce.number().int().positive().default(120),
  /** Requests per minute per caller on the internal shared-secret routes. */
  RATE_LIMIT_INTERNAL_MAX: z.coerce.number().int().positive().default(120),
});
export type Config = z.infer<typeof Env> & {
  /** The resolved deployment relay, or undefined for none. Carries the password: never log it. */
  smtpRelayUrl: string | undefined;
};

/**
 * The hostnames the platform may reach on a private address: what the operator listed, plus the
 * host of the diagram renderer they named in `KROKI_URL`. The second is added here so that naming
 * a renderer is enough: an operator who lists only their model server in EGRESS_ALLOW_HOSTS has
 * not meant to turn PDF export off.
 */
export function egressAllowHosts(config: Pick<Config, "EGRESS_ALLOW_HOSTS" | "KROKI_URL">): string {
  const listed = config.EGRESS_ALLOW_HOSTS.split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const kroki = config.KROKI_URL ? new URL(config.KROKI_URL).hostname.toLowerCase() : "";
  const all = kroki && !listed.map((h) => h.toLowerCase()).includes(kroki) ? [...listed, kroki] : listed;
  return all.join(",");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  // The relay rule is shared with the worker and the web app (D-445); production requires one.
  let smtpRelayUrl: string | undefined;
  try {
    smtpRelayUrl = smtpRelayUrlFromEnv(parsed.data);
  } catch (e) {
    throw new Error(`Invalid configuration: ${(e as Error).message}`);
  }
  return { ...parsed.data, smtpRelayUrl };
}
