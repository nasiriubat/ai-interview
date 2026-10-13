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
  // Operator alerting (D-90); see apps/api/src/config.ts. Same variables, same fallbacks.
  ALERT_EMAIL: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().optional(),
  ALERT_WEBHOOK_FORMAT: z.enum(["ntfy", "slack", "generic"]).optional(),
  /**
   * The shared `ops_state` volume (D-92): the backup writes `status/backup.json` there and the
   * worker writes `heartbeat/worker`. Unset in development, where neither check is meaningful.
   */
  OPS_STATE_DIR: z.string().optional(),
  /** The file the container healthcheck reads; defaults under OPS_STATE_DIR. */
  HEARTBEAT_FILE: z.string().optional(),
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
