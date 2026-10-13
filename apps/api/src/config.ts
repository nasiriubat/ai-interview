import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  PLATFORM_ENCRYPTION_KEY: z.string().min(1),
  AUTH_SECRET: z.string().min(16),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  /** Where uploaded audio and documents live. Unset keeps them in memory, which loses them. */
  UPLOAD_DIR: z.string().optional(),
  EMAIL_SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  /**
   * Outbound-connection policy for tenant-supplied addresses (provider base URLs, SMTP relays).
   * `strict` is the only mode a production process accepts. See packages/core/src/net/egress.ts.
   */
  EGRESS_MODE: z.enum(["strict", "permissive"]).default("strict"),
  /** Comma-separated hostnames a platform provider may reach on a private address (compose services). */
  EGRESS_ALLOW_HOSTS: z.string().default(""),
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
  /** Requests per minute per caller on the internal shared-secret routes. */
  RATE_LIMIT_INTERNAL_MAX: z.coerce.number().int().positive().default(120),
});
export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
