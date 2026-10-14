import { resolveSmtpEnv, SMTP_ENV_REQUIRED_MESSAGE, type SmtpEnvInput } from "@aidp/shared";

/**
 * Decides which SMTP relay the magic-link provider should use, and whether a missing one is a
 * mistake worth stopping for.
 *
 * It lives apart from `auth.ts` so the rule can be tested without importing NextAuth, the API
 * adapter and every route that transitively pulls them in. The rule is small but it has three
 * cases that are easy to get wrong in opposite directions, and getting one wrong is expensive:
 * too strict breaks `next build`, too lax black-holes every sign-in email in production.
 */
export const DEV_SMTP_FALLBACK = "smtp://localhost:1025";

export interface SmtpEnv extends SmtpEnvInput {
  /** Deprecated (D-446): the web app's old name for the relay URL, read after EMAIL_SMTP_URL. */
  EMAIL_SERVER?: string | undefined;
  NODE_ENV?: string | undefined;
  NEXT_PHASE?: string | undefined;
}

/**
 * Returns the relay to hand to Nodemailer.
 *
 * - Configured: SMTP_HOST and the other SMTP_* variables, else the deprecated EMAIL_SMTP_URL or
 *   EMAIL_SERVER. The same rule as the API and the worker (`resolveSmtpEnv`, D-445), so sign-in
 *   mail and every other mail leave through the same relay.
 * - Unset in development or test: fall back to Mailpit, which is what `docker-compose.yml` runs.
 * - Unset in production: throw, because sign-in is by magic link and a silent fallback would make
 *   the system look healthy while no one could ever log in. The one exception is `next build`,
 *   which imports this module with NODE_ENV=production on a build machine that has no relay and
 *   does not need one — Next sets NEXT_PHASE to distinguish that from actually serving traffic.
 */
export function resolveSmtpUrl(env: SmtpEnv): string {
  // An empty value is "not set" (compose passes unset variables as ""), so it falls through.
  const legacy = [env.EMAIL_SMTP_URL, env.EMAIL_SERVER].find((v) => v !== undefined && v.trim() !== "");
  const relay = resolveSmtpEnv({ ...env, ...(legacy ? { EMAIL_SMTP_URL: legacy } : {}) });
  if (relay.source !== "none") return relay.url;
  if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(SMTP_ENV_REQUIRED_MESSAGE);
  }
  return DEV_SMTP_FALLBACK;
}
