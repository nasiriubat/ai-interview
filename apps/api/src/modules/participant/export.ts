import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { participant } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";

/**
 * "Download my data" (GDPR Art. 15 and 20, FR-13, D-162): the participant's own session as JSON
 * or Markdown. Reachable only with the participant token, so the session it describes is the one
 * the caller holds and there is no id to change. Three a hour: it is a copy for a person, not a
 * feed.
 */
export async function participantExportRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get(
    "/p/session/export",
    {
      ...guard.participant({ config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }),
      schema: { hide: true, querystring: z.object({ format: z.enum(["json", "md"]).default("json") }) },
    },
    async (req, reply) => {
      const p = participant(req);
      const out = await ctx.services.privacy.participantExport(p.companyId, p.sessionId, req.query.format);
      return reply
        .header("content-type", out.contentType)
        .header("content-disposition", `attachment; filename="${out.filename}"`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(out.body);
    },
  );
}
