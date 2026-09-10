import { type NextRequest } from "next/server";
import { forwardToApi, jsonError } from "@/lib/api/proxy";
import { staffTokenFromCookies } from "@/lib/api/server";

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
  return forwardToApi(req, path, token, companyId ? { "X-Company-Id": companyId } : {});
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
