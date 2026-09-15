import "server-only";
import type { NextRequest } from "next/server";
import { apiBaseUrl } from "@/lib/env";

/**
 * The only request headers a browser is allowed to put in front of the API.
 *
 * An allowlist rather than a denylist, because this function is the trust boundary: everything on
 * the far side of it is the private compose network, and everything on this side was typed by
 * whoever is holding the browser. A denylist has to predict every header that should not cross,
 * which means a header added to the API later is forwardable by default — including
 * `x-internal-auth`, which is the whole of the authorization on the machine-to-machine sign-in
 * routes (D-56). It would still need the shared secret, but "an attacker must also know a secret"
 * is a weaker position than "the request cannot be made".
 *
 * Headers the API is meant to receive from the caller are set explicitly by the route handlers
 * through `extraHeaders`, so they do not need to be listed here. `x-company-id` is the example:
 * the staff route reads it and passes it on deliberately, and the API honours it only for a
 * platform operator.
 */
const FORWARDED = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/**
 * Forwards a browser request to the API with a Bearer credential attached server-side.
 * Streams the API response back (SSE included) so the browser never sees the token.
 */
export async function forwardToApi(
  req: NextRequest,
  segments: string[],
  token: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const path = segments.map(encodeURIComponent).join("/");
  const url = `${apiBaseUrl()}/${path}${req.nextUrl.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (FORWARDED.has(key.toLowerCase())) headers.set(key, value);
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    ...(body && body.byteLength > 0 ? { body } : {}),
    cache: "no-store",
    redirect: "manual",
  });

  const outHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) outHeaders.set("content-type", contentType);
  outHeaders.set("cache-control", "no-store");
  if (contentType?.includes("text/event-stream")) {
    outHeaders.set("x-accel-buffering", "no");
    outHeaders.set("connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
