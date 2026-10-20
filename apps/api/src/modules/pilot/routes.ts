import { PilotRequestSchema, PilotTicketSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";

/** The form's JSON is a few kilobytes at most; anything larger is not a person's request. */
export const PILOT_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * The public "Request a pilot" form (`/pilot` on the web app).
 *
 * Both routes are public: the visitor has no account. The ticket is cheap and asked for once per
 * page view; the request sends an email, so it is held to five an hour per client address (an
 * anonymous caller's rate-limit bucket is its address, `lib/rate-limit.ts`).
 */
export async function pilotRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.pilot;

  app.get(
    "/public/pilot-requests/ticket",
    {
      ...guard.public({ config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } }),
      schema: { response: { 200: PilotTicketSchema } },
    },
    async (_req, reply) => reply.header("cache-control", "no-store").send(svc.ticket()),
  );

  app.post(
    "/public/pilot-requests",
    {
      ...guard.public({ config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }),
      bodyLimit: PILOT_BODY_LIMIT_BYTES,
      schema: { body: PilotRequestSchema, response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req) => {
      const ua = req.headers["user-agent"];
      return svc.submit(req.body, { ip: req.ip, userAgent: typeof ua === "string" ? ua : undefined });
    },
  );
}
