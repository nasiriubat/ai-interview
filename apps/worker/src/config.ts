import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PLATFORM_ENCRYPTION_KEY: z.string().min(1),
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
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
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
