import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/**
 * The part of the Auth.js configuration that is safe to load in `proxy.ts`. The email
 * provider (Nodemailer) and the adapter are added in `auth.ts` only.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/auth/signin", verifyRequest: "/auth/verify", error: "/auth/error" },
  providers: [Google],
  callbacks: {
    authorized: ({ auth }) => Boolean(auth?.user),
    jwt: ({ token, user }) => {
      if (user?.email) token.email = user.email;
      return token;
    },
    session: ({ session, token }) => {
      if (typeof token.email === "string") session.user.email = token.email;
      return session;
    },
  },
} satisfies NextAuthConfig;
