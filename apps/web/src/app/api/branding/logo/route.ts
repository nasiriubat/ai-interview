import { type NextRequest } from "next/server";
import { clientAddressFrom } from "@/lib/api/client-address";
import { LOGO_ACCEPT } from "@/lib/branding-shared";
import { apiBaseUrl } from "@/lib/env";

/**
 * The platform logo, from this origin (D-433). The browser never talks to the API, and the page's
 * policy allows images from `'self'` only, so the bytes are relayed here. Only the version and the
 * validators cross; the type is passed on only when it is one of the three the API accepts, and
 * `nosniff` holds the browser to it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const v = req.nextUrl.searchParams.get("v");
  const url = `${apiBaseUrl()}/public/branding/logo${v ? `?v=${encodeURIComponent(v.slice(0, 64))}` : ""}`;
  const inm = req.headers.get("if-none-match");
  // The visitor's address, so the API's per-address limit counts visitors and not this process.
  const address = clientAddressFrom(req.headers);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(inm ? { "if-none-match": inm } : {}),
        ...(address ? { "x-forwarded-for": address } : {}),
      },
    });
  } catch {
    return new Response(null, { status: 502, headers: { "cache-control": "no-store" } });
  }
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  for (const name of ["cache-control", "etag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (upstream.status === 304) return new Response(null, { status: 304, headers });
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !(LOGO_ACCEPT as readonly string[]).includes(type)) {
    return new Response(null, {
      status: upstream.ok ? 502 : upstream.status,
      headers: { "cache-control": "no-store" },
    });
  }
  headers.set("content-type", type);
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  return new Response(upstream.body, { status: 200, headers });
}
