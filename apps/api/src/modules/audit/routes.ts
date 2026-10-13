import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";
import { AuditListQuery } from "./service.js";

/** The tenant's audit log (D-79). Read-only: entries are written by the actions they describe. */
export async function auditRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get("/audit", { ...guard.admin(), schema: { querystring: AuditListQuery } }, async (req) =>
    ctx.services.audit.list(req.companyId, req.query),
  );
}
