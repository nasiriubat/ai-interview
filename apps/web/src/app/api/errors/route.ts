import { type NextRequest } from "next/server";
import { clientAddressFrom } from "@/lib/api/client-address";
import { isSameSiteRequest } from "@/lib/api/proxy";
import { participantTokenFromCookies, staffTokenFromCookies } from "@/lib/api/server";
import { apiBaseUrl } from "@/lib/env";

/**
 * A browser's error report, relayed to the API's error log (D-477). Anyone may send one (a
 * participant has no account), so the relay is narrow: same-site only, 8 KB at most, and the API
 * limits each address to a few a minute. When the browser holds a credential for the page the
 * error happened on, it goes along so the report names the tenant and the staff user or interview;
 * nothing else about the person does. The API's answer is passed on without a body.
 */
export const dynamic = "force-dynamic";

const ERROR_REPORT_MAX_BYTES = 8 * 1024;

const empty = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/** The page the report is about, read loosely: only to choose which credential to attach. */
function pagePath(text: string): string {
  try {
    const body = JSON.parse(text) as { path?: unknown };
    return typeof body.path === "string" ? body.path : "";
  } catch {
    return "";
  }
}

/** A participant's page carries the participant credential; any other page the staff one. */
async function credentialFor(path: string): Promise<string | undefined> {
  return path === "/p" || path.startsWith("/p/") || path.startsWith("/p?")
    ? participantTokenFromCookies()
    : staffTokenFromCookies();
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameSiteRequest(req)) return empty(403);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > ERROR_REPORT_MAX_BYTES) return empty(413);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return empty(400);
  }
  if (new TextEncoder().encode(text).length > ERROR_REPORT_MAX_BYTES) return empty(413);

  const headers: Record<string, string> = { "content-type": "application/json" };
  const ua = req.headers.get("user-agent");
  if (ua) headers["user-agent"] = ua;
  const address = clientAddressFrom(req.headers);
  if (address) headers["x-forwarded-for"] = address;

  const send = (token: string | undefined): Promise<Response> =>
    fetch(`${apiBaseUrl()}/public/errors`, {
      method: "POST",
      headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
      body: text,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  try {
    const token = await credentialFor(pagePath(text));
    let upstream = await send(token);
    // An expired session must not lose the report: it is sent again as anonymous.
    if (upstream.status === 401 && token) upstream = await send(undefined);
    return empty(upstream.status);
  } catch {
    return empty(502);
  }
}
