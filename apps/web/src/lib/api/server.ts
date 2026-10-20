import "server-only";
import { cookies, headers } from "next/headers";
import { clientAddressFrom } from "./client-address";
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
  // Only the current name: in production that is the `__Host-` one, which a sibling subdomain
  // cannot plant, where the bare legacy name it could would fix the visitor into its session.
  const raw = jar.get(PARTICIPANT_COOKIE)?.value;
  return raw ? `pt.${decodeURIComponent(raw)}` : undefined;
}

/**
 * Adds the visitor's address (as Caddy reported it) to every call a server component makes.
 *
 * A page that renders on the server calls the API from this process, so without this the API
 * sees one peer for every visitor and rate-limits them as one (status review, finding 1). The
 * header read needs a request scope, which a server component always has; where there is none
 * (a script, a test) the call goes out without it.
 */
function withClientAddress(inner: Transport): Transport {
  return {
    fetch: async (path, init) => {
      let address: string | undefined;
      try {
        address = clientAddressFrom(await headers());
      } catch {
        address = undefined;
      }
      if (!address) return inner.fetch(path, init);
      const merged = { ...(init?.headers as Record<string, string> | undefined), "x-forwarded-for": address };
      return inner.fetch(path, { ...init, headers: merged });
    },
  };
}

/** Direct transport to the API with a Bearer token. */
export function bearerTransport(token: string | undefined, extra: Record<string, string> = {}): Transport {
  return withClientAddress(
    createTransport(apiBaseUrl(), () => ({
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    })),
  );
}

/** Public transport for unauthenticated calls (link info). */
export function publicTransport(): Transport {
  return withClientAddress(createTransport(apiBaseUrl()));
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
