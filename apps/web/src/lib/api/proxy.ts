import "server-only";
import type { NextRequest } from "next/server";
import { apiBaseUrl } from "@/lib/env";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
  "cookie",
]);

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
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.delete("authorization");
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
