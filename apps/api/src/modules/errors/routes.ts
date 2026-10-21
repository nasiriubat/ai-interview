import {
  BrowserErrorReportSchema,
  ERROR_REPORT_MAX_BYTES,
  INTERNAL_AUTH_HEADER,
  WebErrorReportSchema,
} from "@aidp/shared";
import { deriveInternalSecret } from "@aidp/shared/internal-secret";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { unauthenticated } from "../../lib/errors.js";
import { addressBucket, internalLimit } from "../../lib/rate-limit.js";
import { secretMatches } from "../internal-auth/service.js";
import { ErrorGroupListQuery, type Reporter } from "./service.js";

/** Browser reports a client address may send per minute (D-477). A page reports one error once. */
export const BROWSER_REPORTS_PER_MINUTE = 10;

/**
 * The error log's routes (D-477).
 *
 * - `POST /public/errors`: a browser's uncaught error, through the web app's proxy. Public (a
 *   participant or a visitor has no staff credential), so it is held tightly: 8 KB, ten a minute
 *   per client address whoever is signed in, a closed schema. When the proxy attached a staff or
 *   participant credential, the report carries that tenant and id; it never carries the person.
 * - `POST /internal/errors`: the web server's own failures, by the shared secret.
 * - `/operator/errors*`: the operator's list, a group's occurrences, the badge numbers, and the
 *   two verbs, each audited.
 */
export async function errorLogRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.errorLog;
  const op = guard.operator();

  app.post(
    "/public/errors",
    {
      ...guard.public({
        config: {
          rateLimit: {
            max: BROWSER_REPORTS_PER_MINUTE,
            timeWindow: "1 minute",
            // Per address, not per principal: one signed-in tab in a loop must not report more
            // than an anonymous one, and a participant's session is not a reason for a fresh bucket.
            keyGenerator: (req: FastifyRequest) => `errors:${addressBucket(req.ip)}`,
          },
        },
      }),
      bodyLimit: ERROR_REPORT_MAX_BYTES,
      schema: { hide: true, body: BrowserErrorReportSchema },
    },
    async (req, reply) => {
      const p = req.principal;
      const ua = req.headers["user-agent"];
      const who: Reporter = {
        ...(p.kind === "staff" ? { companyId: p.companyId, userId: p.userId } : {}),
        ...(p.kind === "participant" ? { companyId: p.companyId, sessionId: p.sessionId } : {}),
        ...(typeof ua === "string" ? { userAgent: ua } : {}),
      };
      svc.recordBrowser(req.body, who);
      return reply.status(204).send();
    },
  );

  const internalSecret = deriveInternalSecret(ctx.config.AUTH_SECRET);
  app.post(
    "/internal/errors",
    {
      ...guard.internal((req) => {
        const header = req.headers[INTERNAL_AUTH_HEADER];
        if (!secretMatches(typeof header === "string" ? header : undefined, internalSecret))
          throw unauthenticated("Internal secret required");
      }, internalLimit(ctx.config)),
      bodyLimit: 16 * 1024,
      schema: { hide: true, body: WebErrorReportSchema },
    },
    async (req, reply) => {
      svc.recordWeb(req.body);
      return reply.status(204).send();
    },
  );

  app.get("/operator/errors", { ...op, schema: { querystring: ErrorGroupListQuery } }, async (req) =>
    svc.list(req.query),
  );

  app.get("/operator/errors/summary", op, async () => svc.summary());

  const Params = z.object({ id: z.string().min(1).max(64) });

  app.get("/operator/errors/:id", { ...op, schema: { params: Params } }, async (req) =>
    svc.get(req.params.id),
  );

  app.post("/operator/errors/:id/resolve", { ...op, schema: { params: Params } }, async (req) => {
    const s = staff(req);
    return { group: await svc.resolve({ userId: s.userId, companyId: s.companyId }, req.params.id) };
  });

  app.delete("/operator/errors/:id", { ...op, schema: { params: Params } }, async (req) => {
    const s = staff(req);
    await svc.remove({ userId: s.userId, companyId: s.companyId }, req.params.id);
    return { ok: true as const };
  });
}
