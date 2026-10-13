import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";

const Id = z.object({ id: z.string() });

/** Staff view of sessions, gated by the privacy setting (spec 11). */
export async function sessionRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get("/sessions/:id", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    ctx.services.sessions.get(req.companyId, req.params.id),
  );

  app.get("/sessions/:id/events", { ...guard.admin(), schema: { params: Id } }, async (req) =>
    ctx.services.sessions.events(req.companyId, req.params.id),
  );
}
