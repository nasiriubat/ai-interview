import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { SESSION_UPDATE_AGE_SECONDS, sessionMaxAgeSeconds } from "@/lib/session-lifetime";

/**
 * Google is offered only when it is actually configured. Listing it unconditionally puts a
 * "Continue with Google" button on the sign-in page of every deployment that never set the
 * credentials, and it fails at the redirect with an Auth.js error page rather than at the click.
 * A deployment without Google signs in by magic link alone, which is the supported default.
 */
const googleProviders = process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? [Google] : [];

/**
 * The part of the Auth.js configuration that is safe to load in `proxy.ts`. The email
 * provider (Nodemailer) and the adapter are added in `auth.ts` only.
 */
export const authConfig = {
  session: { strategy: "jwt", maxAge: sessionMaxAgeSeconds(), updateAge: SESSION_UPDATE_AGE_SECONDS },
  trustHost: true,
  pages: { signIn: "/auth/signin", verifyRequest: "/auth/verify", error: "/auth/error" },
  providers: googleProviders,
  callbacks: {
    authorized: ({ auth }) => Boolean(auth?.user),
    jwt: ({ token, user }) => {
      if (user?.email) token.email = user.email;
      // Sign-in time, in seconds, set once. Auth.js re-issues the token as it ages and `iat` moves
      // with it; the API compares this instead, so "sign out everywhere" survives a refresh (D-344).
      if (user && typeof token.authAt !== "number") token.authAt = Math.floor(Date.now() / 1000);
      return token;
    },
    session: ({ session, token }) => {
      if (typeof token.email === "string") session.user.email = token.email;
      return session;
    },
  },
} satisfies NextAuthConfig;
