import NextAuth, { type NextAuthResult } from "next-auth";
import type { Provider } from "next-auth/providers";
import Nodemailer from "next-auth/providers/nodemailer";
import { authConfig } from "./auth.config";
import { apiAdapter } from "./lib/auth/adapter";
import { resolveSmtpUrl } from "./lib/auth/smtp";

// The beta's NodemailerConfig type is not assignable to Provider under
// `exactOptionalPropertyTypes`; the runtime shape is the documented one.
const emailProvider = Nodemailer({
  server: resolveSmtpUrl(process.env),
  from: process.env.EMAIL_FROM ?? "no-reply@example.com",
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
