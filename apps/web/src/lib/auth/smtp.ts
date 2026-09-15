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

export interface SmtpEnv {
  EMAIL_SERVER?: string | undefined;
  NODE_ENV?: string | undefined;
  NEXT_PHASE?: string | undefined;
}

/**
 * Returns the relay URL to hand to Nodemailer.
 *
 * - Set: use it, in every environment.
 * - Unset in development or test: fall back to Mailpit, which is what `docker-compose.yml` runs.
 * - Unset in production: throw, because sign-in is by magic link and a silent fallback would make
 *   the system look healthy while no one could ever log in. The one exception is `next build`,
 *   which imports this module with NODE_ENV=production on a build machine that has no relay and
 *   does not need one — Next sets NEXT_PHASE to distinguish that from actually serving traffic.
 */
export function resolveSmtpUrl(env: SmtpEnv): string {
  if (env.EMAIL_SERVER) return env.EMAIL_SERVER;
  if (env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build") {
    throw new Error(
      "EMAIL_SERVER is not set. Sign-in is by magic link, so the web app needs an SMTP relay; " +
        "set EMAIL_SMTP_URL in deploy/.env (see docs/DEPLOY.md).",
    );
  }
  return DEV_SMTP_FALLBACK;
}
