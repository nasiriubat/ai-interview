import { NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

/**
 * Staff routes require an Auth.js session. Role checks (admin vs operator) happen in the
 * `/admin` layouts against `GET /me`, because the role lives in the API, not in the JWT.
 */
export default auth((req) => {
  if (req.auth?.user) return NextResponse.next();
  const url = new URL("/auth/signin", req.nextUrl.origin);
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
});

export const config = { matcher: ["/admin/:path*"] };
