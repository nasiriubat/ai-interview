/**
 * Base URL of the API, without the `/api/v1` prefix. Every API call is made from the
 * web server (server components and route handlers), so `API_URL` is read at runtime
 * and wins; `NEXT_PUBLIC_API_URL` remains for local development.
 */
export function apiOrigin(): string {
  const raw = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return raw.replace(/\/+$/, "");
}

/** Base URL of the Phase 1 API surface. */
export function apiBaseUrl(): string {
  return `${apiOrigin()}/api/v1`;
}

/** The one API path the browser reaches directly, because a WebSocket cannot go through the proxy. */
export const VOICE_LIVE_PATH = "/api/v1/p/session/live";

/**
 * Where the live voice socket lives (FR-30a).
 *
 * Every other call is proxied by the web server, which keeps the API off the internet. Next.js
 * route handlers cannot upgrade a connection, so Caddy forwards this single path to the API and
 * the browser opens it itself. Same origin in production — which is exactly what makes the browser
 * attach the `aidp_participant` cookie, so there is no token to handle here. In development the
 * web app is on :3000 and the API on :4000, so `NEXT_PUBLIC_VOICE_WS_URL` names the API instead;
 * cookies ignore the port, so the same cookie still travels.
 *
 * Browser only: `apiOrigin()` reads a server-side variable, and a public one has to be inlined at
 * build time, so this reads `NEXT_PUBLIC_*` and falls back to the page's own origin.
 */
export function voiceSocketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_VOICE_WS_URL;
  if (configured !== undefined && configured !== "") return configured.replace(/\/+$/, "");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${VOICE_LIVE_PATH}`;
}

export const PARTICIPANT_COOKIE = "aidp_participant";

/** Auth.js stores the session JWT in one of these cookies depending on the scheme. */
export const AUTHJS_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;
