import NextAuth, { type NextAuthResult } from "next-auth";
import type { Provider } from "next-auth/providers";
import Nodemailer from "next-auth/providers/nodemailer";
import { authConfig } from "./auth.config";
import { memoryAdapter } from "./lib/auth/adapter";

// The beta's NodemailerConfig type is not assignable to Provider under
// `exactOptionalPropertyTypes`; the runtime shape is the documented one.
const emailProvider = Nodemailer({
  server: process.env.EMAIL_SERVER ?? "smtp://localhost:1025",
  from: process.env.EMAIL_FROM ?? "no-reply@example.com",
}) as unknown as Provider;

const nextAuth = NextAuth({
  ...authConfig,
  adapter: memoryAdapter(),
  providers: [...authConfig.providers, emailProvider],
});

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
