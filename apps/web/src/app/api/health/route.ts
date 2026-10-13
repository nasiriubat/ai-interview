/**
 * The web container's liveness probe. It used to fetch `/`, which redirects into the admin, so
 * every 30 seconds the server resolved a redirect and rendered a page just to prove it was up.
 * This answers without touching auth, the API or React, which is all a liveness check should do.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
