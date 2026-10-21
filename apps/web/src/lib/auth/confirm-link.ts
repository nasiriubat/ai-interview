/**
 * The sign-in email links to a confirmation page instead of to Auth.js's callback.
 *
 * Mail filters (Microsoft Defender's Safe Links in Microsoft 365, and others like it) open every
 * link in an incoming message to check it. Opening the callback spends the one-time token, so the
 * person who then clicks it is told the link "may have expired or been used already" (found on the
 * live server, 2026-10-21: three scanner requests from Microsoft addresses before each real click).
 * Loading the confirmation page changes nothing; the token is spent only when someone presses its
 * button, which submits a form to the callback. Scanners load pages, they do not submit forms.
 */

export const CALLBACK_PATH = "/api/auth/callback/nodemailer";
export const CONFIRM_PATH = "/auth/confirm";

/** The confirmation page's address for an Auth.js callback URL: the same origin and parameters. */
export function confirmLinkFor(callbackUrl: string): string {
  const callback = new URL(callbackUrl);
  const confirm = new URL(CONFIRM_PATH, callback.origin);
  for (const key of ["token", "email", "callbackUrl"]) {
    const value = callback.searchParams.get(key);
    if (value !== null) confirm.searchParams.set(key, value);
  }
  return confirm.toString();
}

export interface ConfirmParams {
  token: string;
  email: string;
  /** Only a path on this site, so the page cannot be used to send someone elsewhere. */
  callbackUrl?: string;
}

/** What the confirmation page may put in its form, or null when the link is not one of ours. */
export function readConfirmParams(
  params: Record<string, string | string[] | undefined>,
  origin: string,
): ConfirmParams | null {
  const one = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === "string" ? v : undefined;
  };
  const token = one("token");
  const email = one("email");
  if (!token || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null;
  if (!email || email.length > 320 || !email.includes("@")) return null;
  const callbackUrl = safeCallback(one("callbackUrl"), origin);
  return { token, email, ...(callbackUrl ? { callbackUrl } : {}) };
}

function safeCallback(value: string | undefined, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
