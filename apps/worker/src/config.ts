import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PLATFORM_ENCRYPTION_KEY: z.string().min(1),
  EMAIL_SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  LOG_LEVEL: z.string().default("info"),
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
