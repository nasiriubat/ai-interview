import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isApiError } from "@/lib/api/errors";
import type { Me, Role } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export type MeResult =
  { ok: true; me: Me } | { ok: false; reason: "unauthenticated" | "forbidden" | "unavailable" };

/** Resolves the signed-in staff user through `GET /me`, once per request. */
export const getMe = cache(async (): Promise<MeResult> => {
  try {
    const api = await staffServer();
    return { ok: true, me: await api.me() };
  } catch (e) {
    if (isApiError(e) && e.isUnauthenticated) return { ok: false, reason: "unauthenticated" };
    if (isApiError(e) && e.isForbidden) return { ok: false, reason: "forbidden" };
    return { ok: false, reason: "unavailable" };
  }
});

/** Redirects to sign-in when unauthenticated; returns the user otherwise (or null when the API is down). */
export async function requireMe(): Promise<Me | null> {
  const r = await getMe();
  if (!r.ok && r.reason === "unauthenticated") redirect("/auth/signin?callbackUrl=/admin");
  return r.ok ? r.me : null;
}

export function hasRole(me: Me | null, roles: readonly Role[]): boolean {
  return me !== null && roles.includes(me.user.role);
}
