import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { listQuery } from "../../lib/pagination.js";
import { AuditList, AuditListQuery } from "./service.js";

/** The export takes the list's search, sort and filters, and no window: it is the whole result. */
const AuditExportQuery = listQuery(AuditList).omit({ limit: true, offset: true });

/** The tenant's audit log (D-79). Read-only: entries are written by the actions they describe. */
export async function auditRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get("/audit", { ...guard.admin(), schema: { querystring: AuditListQuery } }, async (req) =>
    ctx.services.audit.list(req.companyId, req.query),
  );

  /**
   * The same log as a CSV download (D-345), narrowed by the same filters. An export of the log is
   * itself recorded in the log, with the row count and nothing of the content.
   */
  app.get(
    "/audit.csv",
    {
      ...guard.admin({ config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }),
      schema: { querystring: AuditExportQuery },
    },
    async (req, reply) => {
      const out = await ctx.services.audit.exportCsv(req.companyId, req.query);
      await ctx.services.audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: "audit.export",
        targetType: "audit",
        targetId: "",
        diff: { rows: out.rows, truncated: out.truncated },
      });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${out.filename}"`)
        .header("x-export-rows", String(out.rows))
        .header("x-export-warnings", out.truncated ? "truncated" : "")
        .header("cache-control", "private, no-store")
        .send(out.body);
    },
  );
}
