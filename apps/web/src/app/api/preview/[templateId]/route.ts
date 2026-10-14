import { type NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api/proxy";
import { staffServer } from "@/lib/api/server";
import { PARTICIPANT_COOKIE, PARTICIPANT_COOKIE_LEGACY } from "@/lib/env";

interface Ctx {
  params: Promise<{ templateId: string }>;
}

/**
 * Template preview for admins: creates the throwaway session through the staff API,
 * moves the returned participant token into the participant cookie, and opens the
 * interview screen. The token never reaches client JavaScript.
 */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { templateId } = await ctx.params;
  const api = await staffServer();
  let grant: { participantToken: string; sessionId: string };
  try {
    grant = await api.templates.preview(templateId);
  } catch {
    return jsonError(502, "preview_failed", "Could not create a preview session");
  }
  const res = NextResponse.redirect(new URL("/p/session", req.nextUrl.origin));
  res.cookies.set(PARTICIPANT_COOKIE, grant.participantToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  // An earlier release's bare-name cookie would still be read after the `__Host-` one (D-263).
  if (PARTICIPANT_COOKIE !== PARTICIPANT_COOKIE_LEGACY) res.cookies.delete(PARTICIPANT_COOKIE_LEGACY);
  return res;
}
