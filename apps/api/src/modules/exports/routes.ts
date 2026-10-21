import { ExportBusyError, PdfTooLargeError } from "@aidp/core";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError } from "../../lib/errors.js";
import { expensiveLimit } from "../../lib/rate-limit.js";

/**
 * Downloads that are composed on request (D-211): the analysis report as a PDF. The specification
 * versions are exported from the requirements module, next to their other formats.
 */
export async function exportsRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.exports;

  app.get(
    "/analyses/:id/report.pdf",
    { ...guard.staff(expensiveLimit(ctx.config)), schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const p = staff(req);
      let file;
      try {
        file = await svc.reportPdf(req.companyId, p.role, req.params.id);
      } catch (e) {
        if (e instanceof ExportBusyError) throw new AppError("rate_limited", e.message);
        if (e instanceof PdfTooLargeError)
          throw new AppError("too_large", `${e.message}; download the Markdown instead`);
        throw e;
      }
      await ctx.services.audit.record(req.companyId, {
        actorId: p.userId,
        action: "analysis.report_export",
        targetType: "analysis",
        targetId: req.params.id,
        diff: {
          format: "pdf",
          version: file.version,
          review: file.review,
          pages: file.pages,
          ...(file.warnings.length ? { warnings: file.warnings } : {}),
        },
      });
      if (file.warnings.length) reply.header("x-export-warnings", file.warnings.join(","));
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .header("x-export-pages", String(file.pages))
        .header("cache-control", "private, no-store")
        .send(file.bytes);
    },
  );
}
