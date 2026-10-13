import "server-only";
import type { NextRequest } from "next/server";
import { clientAddressFrom } from "./client-address";
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

/** Default request-body ceiling. The API's own limit is 2 MB; JSON bodies here are far smaller. */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
/** Platform maximum upload (50 MB, the catalog ceiling of files.maxSizeMb) plus multipart framing. */
export const UPLOAD_BODY_LIMIT_BYTES = 55 * 1024 * 1024;

/**
 * Request-body ceiling for an API path. Only the two upload routes may carry a file; everything
 * else is JSON and gets the small default, so one endpoint cannot be used to push megabytes
 * through the web process for a route that will reject them anyway (S6, D-87).
 */
export function bodyLimitFor(segments: string[]): number {
  const route = segments.join("/");
  if (route === "p/session/attachments" || route === "p/session/voice-turns") return UPLOAD_BODY_LIMIT_BYTES;
  return DEFAULT_BODY_LIMIT_BYTES;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}

/**
 * Wraps a body stream with a byte counter that fails the stream the moment it passes the cap, so
 * a chunked body with no declared length is stopped as it streams rather than after it has been
 * buffered. `state.exceeded` is how the caller tells our own abort from a network failure.
 */
function capped(
  stream: ReadableStream<Uint8Array>,
  max: number,
  state: { exceeded: boolean },
): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          state.exceeded = true;
          controller.error(new BodyTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Rejects a state-changing browser request that did not originate from this site. Defence in
 * depth beneath the `SameSite=Lax` cookies: `Sec-Fetch-Site` where the browser sends it, else the
 * `Origin` host against the host the request was addressed to. A request carrying neither (curl,
 * a server) cannot be riding a victim's cookies and passes.
 */
export function isSameSiteRequest(req: NextRequest): boolean {
  const method = req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Forwards a browser request to the API with a Bearer credential attached server-side.
 * Streams the API response back (SSE included) so the browser never sees the token, and streams
 * the request body out, counting it, so nothing is buffered here and nothing past the cap is read.
 */
export async function forwardToApi(
  req: NextRequest,
  segments: string[],
  token: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!isSameSiteRequest(req)) return jsonError(403, "forbidden", "Cross-site request refused");

  const path = segments.map(encodeURIComponent).join("/");
  const url = `${apiBaseUrl()}/${path}${req.nextUrl.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (FORWARDED.has(key.toLowerCase())) headers.set(key, value);
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  // The one address Caddy wrote, set explicitly rather than allowlisted: it is the rate-limit
  // identity of an anonymous caller, so it must come from here and never straight from a browser.
  const address = clientAddressFrom(req.headers);
  if (address) headers.set("x-forwarded-for", address);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  const max = bodyLimitFor(segments);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const declared = req.headers.get("content-length");
  if (hasBody && declared !== null && Number(declared) > max) {
    return jsonError(413, "too_large", "The request is too large");
  }
  const state = { exceeded: false };
  const sendsBody = hasBody && req.body !== null && declared !== "0";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      ...(sendsBody ? { body: capped(req.body, max, state), duplex: "half" } : {}),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (err) {
    if (state.exceeded) return jsonError(413, "too_large", "The request is too large");
    throw err;
  }

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
