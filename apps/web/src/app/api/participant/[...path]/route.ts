import { type NextRequest } from "next/server";
import { forwardToApi, jsonError } from "@/lib/api/proxy";
import { TokenGrantSchema } from "@/lib/api/schemas";
import { participantTokenFromCookies } from "@/lib/api/server";
import { PARTICIPANT_COOKIE, PARTICIPANT_COOKIE_LEGACY } from "@/lib/env";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function cookieAttributes(maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/**
 * Participant proxy. `/api/participant/p/...` maps to `/api/v1/p/...` on the API.
 * - `verify/confirm` and `open` (campaign links `/p/:linkToken/open` and requirements
 *   invitations `/p/r/:token/open`, contract 18) move the participant token into the
 *   `aidp_participant` httpOnly cookie and return only `{ sessionId, resume }`.
 * - `/p/session/*` calls get `Authorization: Bearer pt.<token>` from that cookie.
 * - `DELETE /p/session` clears the cookie.
 */
async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  if (path[0] !== "p" || path.length < 2) return jsonError(404, "not_found", "Unknown participant route");

  const isSession = path[1] === "session";
  const last = path[path.length - 1];
  const issuesToken = !isSession && (last === "confirm" || last === "open") && req.method === "POST";

  const token = isSession ? await participantTokenFromCookies() : undefined;
  if (isSession && !token) return jsonError(401, "unauthenticated", "No participant session");

  const upstream = await forwardToApi(req, path, token);

  if (issuesToken && upstream.ok) {
    const parsed = TokenGrantSchema.safeParse(await upstream.json());
    if (!parsed.success) return jsonError(502, "invalid_response", "Unexpected token response");
    const { participantToken, ...rest } = parsed.data;
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    headers.append(
      "set-cookie",
      `${PARTICIPANT_COOKIE}=${encodeURIComponent(participantToken)}; ${cookieAttributes(COOKIE_MAX_AGE)}`,
    );
    // The bare-name cookie of an earlier release would otherwise shadow nothing but linger for 30
    // days next to the `__Host-` one; the new credential replaces it (D-263).
    if (PARTICIPANT_COOKIE !== PARTICIPANT_COOKIE_LEGACY)
      headers.append("set-cookie", `${PARTICIPANT_COOKIE_LEGACY}=; ${cookieAttributes(0)}`);
    return new Response(JSON.stringify(rest), { status: 200, headers });
  }

  if (isSession && path.length === 2 && req.method === "DELETE" && upstream.ok) {
    const headers = new Headers(upstream.headers);
    headers.set("set-cookie", `${PARTICIPANT_COOKIE}=; ${cookieAttributes(0)}`);
    if (PARTICIPANT_COOKIE !== PARTICIPANT_COOKIE_LEGACY)
      headers.append("set-cookie", `${PARTICIPANT_COOKIE_LEGACY}=; ${cookieAttributes(0)}`);
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  return upstream;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
