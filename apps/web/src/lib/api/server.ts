import "server-only";
import { cookies } from "next/headers";
import { createTransport, type Transport } from "./http";
import { participantApi, type ParticipantApi } from "./participant";
import { staffApi, type StaffApi } from "./staff";
import { apiBaseUrl, AUTHJS_COOKIES, PARTICIPANT_COOKIE } from "@/lib/env";

/** Reads the Auth.js session JWT from the request cookies (server components and route handlers). */
export async function staffTokenFromCookies(): Promise<string | undefined> {
  const jar = await cookies();
  for (const name of AUTHJS_COOKIES) {
    const v = jar.get(name)?.value;
    if (v) return v;
  }
  return undefined;
}

/** The API distinguishes participant credentials from staff JWTs by the `pt.` prefix (contract 16). */
export async function participantTokenFromCookies(): Promise<string | undefined> {
  const jar = await cookies();
  const raw = jar.get(PARTICIPANT_COOKIE)?.value;
  return raw ? `pt.${decodeURIComponent(raw)}` : undefined;
}

/** Direct transport to the API with a Bearer token. */
export function bearerTransport(token: string | undefined, extra: Record<string, string> = {}): Transport {
  return createTransport(apiBaseUrl(), () => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  }));
}

/** Public transport for unauthenticated calls (link info). */
export function publicTransport(): Transport {
  return createTransport(apiBaseUrl());
}

/** Staff API for server components: the Auth.js JWT from the cookie goes out as `Authorization: Bearer`. */
export async function staffServer(companyId?: string): Promise<StaffApi> {
  const token = await staffTokenFromCookies();
  return staffApi(bearerTransport(token, companyId ? { "X-Company-Id": companyId } : {}));
}

/** Participant API for server components: the participant token from the cookie goes out as Bearer. */
export async function participantServer(): Promise<{ api: ParticipantApi; hasToken: boolean }> {
  const token = await participantTokenFromCookies();
  return { api: participantApi(bearerTransport(token)), hasToken: Boolean(token) };
}
