import { revalidateTag } from "next/cache";
import { type NextRequest } from "next/server";
import { forwardToApi, jsonError } from "@/lib/api/proxy";
import { staffTokenFromCookies } from "@/lib/api/server";
import { BRANDING_TAG } from "@/lib/branding-shared";

/**
 * Writes after which the cached platform name or logo may be stale (D-431): the logo itself, and
 * any settings save (which may have renamed the product). Expiring the tag lets the person who
 * made the change see it on the next page instead of a minute later.
 */
function touchesBranding(method: string, path: string[]): boolean {
  if (method === "GET" || method === "HEAD") return false;
  const route = path.join("/");
  return route === "operator/branding/logo" || route === "settings";
}

interface Ctx {
  params: Promise<{ path: string[] }>;
}

/** Staff proxy: `/api/staff/<route>` maps to `/api/v1/<route>` with the Auth.js JWT as Bearer. */
async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  if (path.length === 0 || path[0] === "p") return jsonError(404, "not_found", "Unknown staff route");
  const token = await staffTokenFromCookies();
  if (!token) return jsonError(401, "unauthenticated", "Sign in first");
  const companyId = req.headers.get("x-company-id");
  const res = await forwardToApi(req, path, token, companyId ? { "X-Company-Id": companyId } : {});
  if (res.ok && touchesBranding(req.method, path)) revalidateTag(BRANDING_TAG, { expire: 0 });
  return res;
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
