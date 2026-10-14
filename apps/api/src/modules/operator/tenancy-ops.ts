import { Readable } from "node:stream";
import { MONTH, statementsToCsv } from "@aidp/core";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";

const Month = z.string().regex(MONTH, "Expected a month as yyyy-mm");
const Stamp = z.string().regex(/^[0-9]{8}T[0-9]{6}Z$/);

/**
 * The platform operator's tenancy operations (operations 7.5 and 7.6): the one health page, the
 * cross-tenant statement export, and a tenant's export and offboarding.
 *
 * The rows these verbs write are filed under the operator's own company (`req.companyId` on an
 * operator route), never the tenant's: offboarding removes the tenant's audit trail, and "who took
 * a copy of this tenant's data, and who removed it" has to outlive it.
 */
export async function operatorTenancyRoutes(app: App, ctx: RouteContext): Promise<void> {
  const op = guard.operator();
  const operator = ctx.services.operator;

  // Every platform signal and every tenant's utilisation, on one page (D-222).
  app.get("/operator/health", op, async () => ctx.platformHealth.snapshot());

  // The operator's invoicing spreadsheet: every tenant's frozen statement for one month.
  app.get(
    "/operator/statements/:month",
    {
      ...op,
      schema: {
        params: z.object({ month: Month }),
        querystring: z.object({ format: z.enum(["json", "csv"]).default("json") }),
      },
    },
    async (req, reply) => {
      const statements = await ctx.statements.allForMonth(req.params.month);
      if (req.query.format === "csv") {
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-disposition", `attachment; filename="statements-${req.params.month}.csv"`)
          .send(statementsToCsv(statements));
      }
      return { month: req.params.month, statements };
    },
  );

  app.post(
    "/operator/tenants/:id/export",
    {
      ...guard.operator({ config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }),
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req, reply) => {
      const out = await operator.requestExport({ userId: staff(req).userId }, req.companyId, req.params.id);
      return reply.status(202).send(out);
    },
  );

  app.get(
    "/operator/tenants/:id/exports",
    { ...op, schema: { params: z.object({ id: z.string() }) } },
    async (req) => ({
      exports: await operator.listExports(req.params.id),
    }),
  );

  app.get(
    "/operator/tenants/:id/exports/:stamp",
    {
      ...guard.operator({ config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }),
      schema: { params: z.object({ id: z.string(), stamp: Stamp }) },
    },
    async (req, reply) => {
      const { meta, body } = await operator.openExport(
        { userId: staff(req).userId },
        req.companyId,
        req.params.id,
        req.params.stamp,
      );
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="export-${meta.companyId}-${meta.stamp}.zip"`)
        .header("cache-control", "no-store")
        .send(Readable.from(body));
    },
  );

  app.post(
    "/operator/tenants/:id/offboard",
    {
      ...guard.operator({ config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }),
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          /** The tenant's name, typed by the operator. */
          confirmName: z.string().min(1),
          /** Skip the seven-day grace period. */
          immediate: z.boolean().default(false),
        }),
      },
    },
    async (req, reply) => {
      const out = await operator.requestOffboard(
        { userId: staff(req).userId },
        req.companyId,
        req.params.id,
        req.body,
      );
      return reply.status(202).send(out);
    },
  );
}
