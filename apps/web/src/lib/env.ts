/** Base URL of the API, without the `/api/v1` prefix. */
export function apiOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return raw.replace(/\/+$/, "");
}

/** Base URL of the Phase 1 API surface. */
export function apiBaseUrl(): string {
  return `${apiOrigin()}/api/v1`;
}

export const PARTICIPANT_COOKIE = "aidp_participant";

/** Auth.js stores the session JWT in one of these cookies depending on the scheme. */
export const AUTHJS_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;
