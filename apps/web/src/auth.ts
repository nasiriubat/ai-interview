import NextAuth, { type NextAuthResult } from "next-auth";
import type { Provider } from "next-auth/providers";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { authConfig } from "./auth.config";
import { apiAdapter } from "./lib/auth/adapter";
import { signInMailLocale, signInMessage } from "./lib/auth/signin-mail";
import { resolveSmtpUrl } from "./lib/auth/smtp";
import { apiBaseUrl } from "./lib/env";

/** The site's name for the sign-in email (D-431); the bundled name if the API cannot say. */
async function productName(): Promise<string> {
  try {
    const res = await fetch(`${apiBaseUrl()}/public/branding`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { productName?: unknown };
    return typeof body.productName === "string" && body.productName.trim() ? body.productName : "AIScope";
  } catch {
    return "AIScope";
  }
}

const relay = resolveSmtpUrl(process.env);

// The beta's NodemailerConfig type is not assignable to Provider under
// `exactOptionalPropertyTypes`; the runtime shape is the documented one.
const emailProvider = Nodemailer({
  server: relay,
  from: process.env.EMAIL_FROM ?? "no-reply@example.com",
  // A message that names the product and says the link works once (simulation 2026-10-15),
  // instead of Auth.js's "Sign in to <host>".
  async sendVerificationRequest({ identifier, url, expires, provider, request }) {
    const hours = Math.max(1, Math.round((expires.getTime() - Date.now()) / 3_600_000));
    const mail = signInMessage({
      url,
      productName: await productName(),
      locale: signInMailLocale(request.headers),
      hours,
    });
    const result = await createTransport(relay).sendMail({
      to: identifier,
      from: provider.from,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    const failed = [...(result.rejected as unknown[]), ...((result.pending ?? []) as unknown[])];
    if (failed.length > 0) throw new Error("The sign-in email could not be sent");
  },
}) as Provider;

const nextAuth = NextAuth({
  ...authConfig,
  adapter: apiAdapter(),
  providers: [...authConfig.providers, emailProvider],
});

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
