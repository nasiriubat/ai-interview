/**
 * How long a staff sign-in lasts (D-265). Auth.js defaults to 30 days, which is how long a copied
 * session cookie would keep working. Eight hours is a working day; `updateAge` re-issues the
 * cookie at most hourly while the person is active, so someone using the product is not signed
 * out mid-task, and someone who left a laptop open is signed out by the next morning. The API
 * refuses an expired token (the JWT's own `exp`), and removing a user's access is immediate
 * regardless (D-161).
 *
 * `AUTH_SESSION_MAX_AGE_HOURS` overrides it, between one hour and thirty days.
 */
export const DEFAULT_SESSION_HOURS = 8;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

export function sessionMaxAgeSeconds(
  raw: string | undefined = process.env.AUTH_SESSION_MAX_AGE_HOURS,
): number {
  const hours = raw === undefined || raw.trim() === "" ? DEFAULT_SESSION_HOURS : Number(raw);
  const bounded = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : DEFAULT_SESSION_HOURS;
  return Math.round(bounded * 60 * 60);
}
