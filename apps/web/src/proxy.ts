import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { buildCsp, CSP_REPORT_ONLY_HEADER, newNonce, PERMISSIONS_POLICY } from "@/lib/csp";

const { auth } = NextAuth(authConfig);

/**
 * Every page request passes here (A3, D-165). Two jobs:
 *
 *  1. A fresh nonce and the Content-Security-Policy that names it, set on the request (so that
 *     Next puts the nonce on its own inline scripts and `layout.tsx` can hand it to Mermaid) and on
 *     the response. Report-only for now; promoting it is changing one header name in `lib/csp.ts`.
 *  2. Staff routes require an Auth.js session. Role checks (admin vs operator) happen in the
 *     `/admin` layouts against `GET /me`, because the role lives in the API, not in the JWT.
 *
 * Participants never touch Auth.js: a page outside `/admin` is not asked for a session.
 */
export default async function proxy(req: NextRequest, event: NextFetchEvent): Promise<Response> {
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    host: req.nextUrl.host,
    dev: process.env.NODE_ENV !== "production",
  });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(CSP_REPORT_ONLY_HEADER, csp);
  const pass = (): NextResponse => NextResponse.next({ request: { headers: requestHeaders } });

  let res: Response;
  if (req.nextUrl.pathname.startsWith("/admin")) {
    const guarded = auth((authed) => {
      if (authed.auth?.user) return pass();
      const url = new URL("/auth/signin", authed.nextUrl.origin);
      url.searchParams.set("callbackUrl", authed.nextUrl.pathname + authed.nextUrl.search);
      return NextResponse.redirect(url);
    });
    res = (await guarded(req, event as never)) ?? pass();
  } else {
    res = pass();
  }
  res.headers.set(CSP_REPORT_ONLY_HEADER, csp);
  res.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  return res;
}

/**
 * Pages only: not the static assets Next serves itself, not the API proxy routes (JSON, no
 * document to protect), and not files with an extension.
 */
export const config = { matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|.*\\..*).*)"] };
