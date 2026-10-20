import { type NextRequest } from "next/server";
import { forwardToApi, jsonError } from "@/lib/api/proxy";

/**
 * The "Request a pilot" form's two calls, relayed to the API's public routes (the browser never
 * talks to the API). `GET` fetches the signed ticket the form sends back; `POST` sends the request.
 * No credential is attached: the visitor has none. `forwardToApi` refuses a cross-site POST, passes
 * the visitor's address on as the rate-limit identity, and caps the body.
 */
export const dynamic = "force-dynamic";

/** The form's JSON is a few kilobytes; the API's own limit is 16 KB. */
const MAX_BODY_BYTES = 16 * 1024;

export async function GET(req: NextRequest): Promise<Response> {
  return forwardToApi(req, ["public", "pilot-requests", "ticket"], undefined);
}

export async function POST(req: NextRequest): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return jsonError(413, "too_large", "The request is too large");
  return forwardToApi(req, ["public", "pilot-requests"], undefined);
}
